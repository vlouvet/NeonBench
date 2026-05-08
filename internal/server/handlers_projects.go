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

// Channel letter depth (NW #106) bounds, in millimeters. The shop
// industry standard is 100 mm (≈ 4 in) — Strattman NT Ch.5; Miller
// p.88. We accept 10..500 mm to cover both shallow letters (small
// signage, wall-mount) and oversized rooftop letters.
const (
	minChannelLetterDepthMM     = 10.0
	maxChannelLetterDepthMM     = 500.0
	defaultChannelLetterDepthMM = 100.0
)

// Strip overlap allowance (Tier 3 #26) bounds, in millimeters. The
// fabricator leaves this much extra metal at one end of the unfolded
// return strip so the seam can be welded or pop-riveted through
// doubled-up sheet. Default = ½ in (12.7 mm) — the trade-typical value
// (Strattman NT Ch.5). Range [0, 100] covers no-overlap (rare; some
// shops butt-weld) up to oversized 4 in overlap for heavy-gauge
// return material.
const (
	minStripOverlapMM     = 0.0
	maxStripOverlapMM     = 100.0
	defaultStripOverlapMM = 12.7
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
	// Same nil-means-default semantics as TubeEndGapMM. The renderer
	// falls back to 100 mm when this column is NULL (NW #106).
	ChannelLetterDepthMM *float64 `json:"channel_letter_depth_mm,omitempty"`
	// Strip overlap allowance (Tier 3 #26). nil means "use shop
	// default of 12.7 mm (½ in)" when drawing the shear line on the
	// unfolded return-strip page.
	StripOverlapMM *float64 `json:"strip_overlap_mm,omitempty"`
	// FacePerimeterStrictMode (Tier 3 #46): when true, the validator
	// escalates RuleFacePerimeterExceedsBlank from warning to error.
	// Pointer so omission leaves the new project at the schema-default
	// false ("warning-level"); a non-nil value writes that boolean.
	FacePerimeterStrictMode *bool `json:"face_perimeter_strict_mode,omitempty"`
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
	if msg := validateChannelLetterDepth(req.ChannelLetterDepthMM); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if msg := validateStripOverlap(req.StripOverlapMM); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	strictMode := false
	if req.FacePerimeterStrictMode != nil {
		strictMode = *req.FacePerimeterStrictMode
	}
	p, err := storage.CreateProject(r.Context(), s.db, storage.CreateProjectParams{
		Name:                    strings.TrimSpace(req.Name),
		TubeSpecID:              req.TubeSpecID,
		Units:                   req.Units,
		Customer:                customer,
		Designer:                designer,
		DueDate:                 dueDate,
		JobNumber:               jobNumber,
		TubeEndGapMM:            req.TubeEndGapMM,
		ChannelLetterDepthMM:    req.ChannelLetterDepthMM,
		StripOverlapMM:          req.StripOverlapMM,
		FacePerimeterStrictMode: strictMode,
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
	TubeEndGapMM         json.RawMessage `json:"tube_end_gap_mm,omitempty"`
	ChannelLetterDepthMM json.RawMessage `json:"channel_letter_depth_mm,omitempty"`
	// StripOverlapMM uses the same omitted/null/value PATCH semantics
	// as the two fields above. Tier 3 #26.
	StripOverlapMM json.RawMessage `json:"strip_overlap_mm,omitempty"`
	// FacePerimeterStrictMode is a two-state PATCH field (Tier 3 #46):
	// omitted → leave the column alone; bare boolean → write that
	// value. There's no "clear → fall back" semantic because the
	// column is NOT NULL DEFAULT 0; sending null is rejected as a
	// mis-typed body to keep the contract tight.
	FacePerimeterStrictMode *bool `json:"face_perimeter_strict_mode,omitempty"`
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
	depth, depthSet, msg := parseChannelLetterDepthPatch(req.ChannelLetterDepthMM)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var depthField **float64
	if depthSet {
		depthField = &depth
	}
	overlap, overlapSet, msg := parseStripOverlapPatch(req.StripOverlapMM)
	if msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	var overlapField **float64
	if overlapSet {
		overlapField = &overlap
	}
	out, err := storage.UpdateProject(r.Context(), s.db, id, storage.UpdateProjectParams{
		Name:                    req.Name,
		TubeSpecID:              req.TubeSpecID,
		Units:                   req.Units,
		Customer:                req.Customer,
		Designer:                req.Designer,
		DueDate:                 req.DueDate,
		JobNumber:               req.JobNumber,
		TubeEndGapMM:            endGapField,
		ChannelLetterDepthMM:    depthField,
		StripOverlapMM:          overlapField,
		FacePerimeterStrictMode: req.FacePerimeterStrictMode,
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

// validateChannelLetterDepth returns "" when the optional value is
// acceptable. Nil (omitted on create) is fine: the column stays NULL
// and renderers fall back to the 100 mm shop default. Non-nil values
// must fall in [10, 500] mm — covers everything from small wall-mount
// letters to oversized rooftop signage.
func validateChannelLetterDepth(v *float64) string {
	if v == nil {
		return ""
	}
	if *v < minChannelLetterDepthMM || *v > maxChannelLetterDepthMM {
		return fmt.Sprintf("channel_letter_depth_mm must be between %g and %g (got %g)",
			minChannelLetterDepthMM, maxChannelLetterDepthMM, *v)
	}
	return ""
}

// parseChannelLetterDepthPatch mirrors parseTubeEndGapPatch for the
// channel_letter_depth_mm PATCH field. Same three-state semantics:
// omitted → leave column alone; explicit null → clear; in-range
// number → write.
func parseChannelLetterDepthPatch(raw json.RawMessage) (*float64, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return nil, false, "channel_letter_depth_mm must be a number or null"
	}
	if msg := validateChannelLetterDepth(&v); msg != "" {
		return nil, false, msg
	}
	return &v, true, ""
}

// validateStripOverlap returns "" when the optional value is acceptable.
// Nil (omitted on create) is fine: the column stays NULL and renderers
// fall back to the 12.7 mm shop default. Non-nil values must fall in
// [0, 100] mm — covers no-overlap to oversized welded seams. Tier 3 #26.
func validateStripOverlap(v *float64) string {
	if v == nil {
		return ""
	}
	if *v < minStripOverlapMM || *v > maxStripOverlapMM {
		return fmt.Sprintf("strip_overlap_mm must be between %g and %g (got %g)",
			minStripOverlapMM, maxStripOverlapMM, *v)
	}
	return ""
}

// parseStripOverlapPatch mirrors parseChannelLetterDepthPatch for the
// strip_overlap_mm PATCH field. Same three-state semantics:
// omitted → leave column alone; explicit null → clear; in-range
// number → write.
func parseStripOverlapPatch(raw json.RawMessage) (*float64, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return nil, false, "strip_overlap_mm must be a number or null"
	}
	if msg := validateStripOverlap(&v); msg != "" {
		return nil, false, msg
	}
	return &v, true, ""
}
