package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/vlouvet/neonbench/internal/storage"
)

// Job Manager metadata length caps. Customer is the most generous because
// "DBA" client names get long; designer is a single shop person; job_number
// is whatever invoicing system the shop uses.
const (
	maxCustomerLen  = 200
	maxDesignerLen  = 100
	maxJobNumberLen = 50
)

// Tube end gap (NW #135) bounds, in millimeters. Negative values are
// nonsense; 100 mm is a generous ceiling that comfortably covers GTO
// cable terminations and any realistic shop's clearance preference.
// The most-cited shop default is ¼ in / 6.35 mm per Miller App I §126
// (see docs/neon-rules/spacing.md). The default is what the print PDF
// footer / detail page display when the project leaves the column
// NULL — we render *some* value rather than nothing because the
// bender wants to know the active target either way.
const (
	minTubeEndGapMM     = 0.0
	maxTubeEndGapMM     = 100.0
	defaultTubeEndGapMM = 6.35
)

type createProjectReq struct {
	Name       string `json:"name"`
	TubeSpecID int64  `json:"tube_spec_id"`
	Units      string `json:"units,omitempty"`
	Customer   string `json:"customer,omitempty"`
	Designer   string `json:"designer,omitempty"`
	DueDate    string `json:"due_date,omitempty"`
	JobNumber  string `json:"job_number,omitempty"`
	// Pointer so an explicit `null` (or omission) leaves the column
	// NULL — the API surface treats "no value" as "use shop default".
	TubeEndGapMM *float64 `json:"tube_end_gap_mm,omitempty"`
}

func (s *apiServer) handleListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := storage.ListProjects(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if projects == nil {
		projects = []storage.Project{}
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *apiServer) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req createProjectReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.TubeSpecID == 0 {
		writeError(w, http.StatusBadRequest, "tube_spec_id is required")
		return
	}
	if _, err := storage.GetTubeSpec(r.Context(), s.db, req.TubeSpecID); err != nil {
		writeStorageError(w, err)
		return
	}
	if req.Units != "" && req.Units != "mm" && req.Units != "in" {
		writeError(w, http.StatusBadRequest, "units must be 'mm' or 'in'")
		return
	}
	customer := strings.TrimSpace(req.Customer)
	designer := strings.TrimSpace(req.Designer)
	dueDate := strings.TrimSpace(req.DueDate)
	jobNumber := strings.TrimSpace(req.JobNumber)
	if msg := validateJobFields(customer, designer, dueDate, jobNumber); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if msg := validateTubeEndGap(req.TubeEndGapMM); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	p, err := storage.CreateProject(r.Context(), s.db, storage.CreateProjectParams{
		Name:         strings.TrimSpace(req.Name),
		TubeSpecID:   req.TubeSpecID,
		Units:        req.Units,
		Customer:     customer,
		Designer:     designer,
		DueDate:      dueDate,
		JobNumber:    jobNumber,
		TubeEndGapMM: req.TubeEndGapMM,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *apiServer) handleGetProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	p, err := storage.GetProject(r.Context(), s.db, id)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type updateProjectReq struct {
	Name       *string `json:"name,omitempty"`
	TubeSpecID *int64  `json:"tube_spec_id,omitempty"`
	Units      *string `json:"units,omitempty"`
	Customer   *string `json:"customer,omitempty"`
	Designer   *string `json:"designer,omitempty"`
	DueDate    *string `json:"due_date,omitempty"`
	JobNumber  *string `json:"job_number,omitempty"`
	// Raw so we can distinguish three PATCH states: omitted (don't
	// touch), explicit `null` (clear → fall back to shop default), and
	// a JSON number (write that value). A bare `*float64` collapses
	// "absent" and "null" into the same nil and we'd lose the
	// "clear me" gesture.
	TubeEndGapMM json.RawMessage `json:"tube_end_gap_mm,omitempty"`
}

func (s *apiServer) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var req updateProjectReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.TubeSpecID != nil {
		if _, err := storage.GetTubeSpec(r.Context(), s.db, *req.TubeSpecID); err != nil {
			writeError(w, http.StatusBadRequest, "tube_spec_id does not exist")
			return
		}
	}
	if req.Units != nil && *req.Units != "mm" && *req.Units != "in" {
		writeError(w, http.StatusBadRequest, "units must be \"mm\" or \"in\"")
		return
	}
	if req.Name != nil && *req.Name == "" {
		writeError(w, http.StatusBadRequest, "name cannot be empty")
		return
	}
	// Trim Job Manager fields in place. A non-nil empty string is the
	// frontend's "clear this field" signal — preserved through to storage,
	// which converts "" → NULL.
	if req.Customer != nil {
		v := strings.TrimSpace(*req.Customer)
		req.Customer = &v
	}
	if req.Designer != nil {
		v := strings.TrimSpace(*req.Designer)
		req.Designer = &v
	}
	if req.DueDate != nil {
		v := strings.TrimSpace(*req.DueDate)
		req.DueDate = &v
	}
	if req.JobNumber != nil {
		v := strings.TrimSpace(*req.JobNumber)
		req.JobNumber = &v
	}
	if msg := validateJobFields(
		strDeref(req.Customer),
		strDeref(req.Designer),
		strDeref(req.DueDate),
		strDeref(req.JobNumber),
	); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	endGap, endGapSet, msg := parseTubeEndGapPatch(req.TubeEndGapMM)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var endGapField **float64
	if endGapSet {
		endGapField = &endGap
	}
	out, err := storage.UpdateProject(r.Context(), s.db, id, storage.UpdateProjectParams{
		Name:         req.Name,
		TubeSpecID:   req.TubeSpecID,
		Units:        req.Units,
		Customer:     req.Customer,
		Designer:     req.Designer,
		DueDate:      req.DueDate,
		JobNumber:    req.JobNumber,
		TubeEndGapMM: endGapField,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *apiServer) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if err := storage.DeleteProject(r.Context(), s.db, id); err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := r.PathValue(name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid "+name)
		return 0, false
	}
	return id, true
}

// validateJobFields returns "" if the four trimmed metadata fields are
// acceptable, or a human-readable error message otherwise. All four are
// optional; empty strings always pass.
func validateJobFields(customer, designer, dueDate, jobNumber string) string {
	if len(customer) > maxCustomerLen {
		return "customer must be at most 200 characters"
	}
	if len(designer) > maxDesignerLen {
		return "designer must be at most 100 characters"
	}
	if len(jobNumber) > maxJobNumberLen {
		return "job_number must be at most 50 characters"
	}
	if dueDate != "" {
		// Strict YYYY-MM-DD; time.Parse will reject e.g. "2026-13-40"
		// and zero-padding errors, which is what we want.
		if _, err := time.Parse("2006-01-02", dueDate); err != nil {
			return "due_date must be a valid YYYY-MM-DD date"
		}
	}
	return ""
}

func strDeref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}

// validateTubeEndGap returns "" if the optional value is acceptable.
// Nil (omitted on create) is always fine: the column stays NULL and
// renderers fall back to the shop default. Otherwise the value must be
// in [0, 100] mm.
func validateTubeEndGap(v *float64) string {
	if v == nil {
		return ""
	}
	if *v < minTubeEndGapMM || *v > maxTubeEndGapMM {
		return fmt.Sprintf("tube_end_gap_mm must be between %g and %g (got %g)",
			minTubeEndGapMM, maxTubeEndGapMM, *v)
	}
	return ""
}

// parseTubeEndGapPatch interprets the raw JSON for tube_end_gap_mm in
// a PATCH body. It returns:
//   - (nil, false, "") when the field was omitted entirely;
//   - (nil, true,  "") when the field was explicitly `null` (clear it);
//   - (&v,  true,  "") when the field was a valid number in range;
//   - (nil, false, "<msg>") on any parse / validation failure.
func parseTubeEndGapPatch(raw json.RawMessage) (*float64, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return nil, false, "tube_end_gap_mm must be a number or null"
	}
	if msg := validateTubeEndGap(&v); msg != "" {
		return nil, false, msg
	}
	return &v, true, ""
}
