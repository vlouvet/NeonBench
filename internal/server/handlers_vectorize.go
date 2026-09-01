package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/validate"
	"github.com/vlouvet/neonbench/internal/vectorize"
)

type vectorizeReq struct {
	AssetID       int64   `json:"asset_id"`
	TargetWidthMM float64 `json:"target_width_mm"`
	Threshold     int     `json:"threshold,omitempty"` // 0..255
	SmoothingMM   float64 `json:"smoothing_mm,omitempty"`
	MinSpurMM     float64 `json:"min_spur_mm,omitempty"`
	Label         string  `json:"label,omitempty"`

	// Pre-binarize bitmap adjustments. All optional; pointers so we can
	// distinguish "not sent" from "explicit zero" for the integer fields
	// that have meaningful zero values (Brightness 0 = no change).
	RotationDeg *float64 `json:"rotation_deg,omitempty"`
	Crop        *cropReq `json:"crop,omitempty"`
	Brightness  *int     `json:"brightness,omitempty"`
	Contrast    *float64 `json:"contrast,omitempty"`
}

// cropReq is the JSON shape for a source-pixel crop rectangle.
type cropReq struct {
	X int `json:"x"`
	Y int `json:"y"`
	W int `json:"w"`
	H int `json:"h"`
}

func (s *apiServer) handleVectorize(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}

	var req vectorizeReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.AssetID == 0 {
		writeError(w, http.StatusBadRequest, "asset_id is required")
		return
	}
	if req.TargetWidthMM <= 0 {
		writeError(w, http.StatusBadRequest, "target_width_mm must be > 0")
		return
	}
	if req.Threshold < 0 || req.Threshold > 255 {
		writeError(w, http.StatusBadRequest, "threshold must be 0..255")
		return
	}
	if req.RotationDeg != nil {
		if *req.RotationDeg < vectorize.MinRotationDeg || *req.RotationDeg > vectorize.MaxRotationDeg {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("rotation_deg must be %g..%g", vectorize.MinRotationDeg, vectorize.MaxRotationDeg))
			return
		}
	}
	if req.Brightness != nil {
		if *req.Brightness < vectorize.MinBrightness || *req.Brightness > vectorize.MaxBrightness {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("brightness must be %d..%d", vectorize.MinBrightness, vectorize.MaxBrightness))
			return
		}
	}
	if req.Contrast != nil {
		if *req.Contrast < vectorize.MinContrast || *req.Contrast > vectorize.MaxContrast {
			writeError(w, http.StatusBadRequest,
				fmt.Sprintf("contrast must be %g..%g", vectorize.MinContrast, vectorize.MaxContrast))
			return
		}
	}
	if req.Crop != nil {
		if req.Crop.W <= 0 || req.Crop.H <= 0 {
			writeError(w, http.StatusBadRequest, "crop w and h must be > 0")
			return
		}
		if req.Crop.X < 0 || req.Crop.Y < 0 {
			writeError(w, http.StatusBadRequest, "crop x and y must be >= 0")
			return
		}
	}

	asset, err := storage.GetAsset(r.Context(), s.db, req.AssetID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if asset.ProjectID != pid {
		writeError(w, http.StatusBadRequest, "asset does not belong to project")
		return
	}
	if asset.Kind != storage.AssetKindSource {
		writeError(w, http.StatusBadRequest, "asset is not a source image")
		return
	}

	path := filepath.Join(s.dataDir, "assets", fmt.Sprintf("%d", pid), asset.Filename)
	data, err := os.ReadFile(path)
	if err != nil {
		writeStorageError(w, fmt.Errorf("read source asset: %w", err))
		return
	}

	var svg []byte
	switch asset.MIME {
	case "image/png", "image/jpeg":
		threshold := uint8(req.Threshold)
		if threshold == 0 {
			threshold = 128
		}
		// Pull the project tube spec for the spur-prune sizing — the
		// skeleton-graph extractor uses the diameter to scale "what
		// counts as a real branch vs a Zhang-Suen spur".
		project, err := storage.GetProject(r.Context(), s.db, pid)
		if err != nil {
			writeStorageError(w, err)
			return
		}
		spec, err := storage.GetTubeSpec(r.Context(), s.db, project.TubeSpecID)
		if err != nil {
			writeStorageError(w, err)
			return
		}
		vreq := vectorize.Request{
			SourceBytes:       data,
			TargetWidthMM:     req.TargetWidthMM,
			Threshold:         threshold,
			SmoothingMM:       req.SmoothingMM,
			MinSpurMM:         req.MinSpurMM,
			DefaultDiameterMM: spec.DiameterMM,
		}
		if req.RotationDeg != nil {
			vreq.RotationDeg = *req.RotationDeg
		}
		if req.Brightness != nil {
			vreq.Brightness = *req.Brightness
		}
		if req.Contrast != nil {
			vreq.Contrast = *req.Contrast
		}
		if req.Crop != nil {
			vreq.Crop = &vectorize.Crop{X: req.Crop.X, Y: req.Crop.Y, W: req.Crop.W, H: req.Crop.H}
		}
		res, err := vectorize.VectorizeRaster(r.Context(), vreq)
		if err != nil {
			writeError(w, http.StatusUnprocessableEntity, "vectorize failed: "+err.Error())
			return
		}
		svg = res.SVG
	case "image/svg+xml":
		// Pass-through: persist the SVG as-is. Normalization to mm space comes later.
		svg = data
	default:
		writeError(w, http.StatusUnsupportedMediaType, "unsupported asset MIME for vectorize: "+asset.MIME)
		return
	}

	// Generate the structured design doc from the SVG so the editor (Phase 2)
	// has something to load. Failure here is non-fatal — the SVG is still
	// usable for validation, preview, and print.
	docJSON := s.generateDesignDoc(r, pid, svg)
	// nil doc: a freshly vectorized SVG models no raceways, so there is
	// nothing for the doc-level rules to look at.
	reportJSON := s.runValidation(r, pid, svg, nil)

	dv, err := storage.CreateDesignVersion(r.Context(), s.db, storage.CreateDesignVersionParams{
		ProjectID:            pid,
		Label:                req.Label,
		SVGData:              string(svg),
		DesignDocJSON:        docJSON,
		ValidationReportJSON: reportJSON,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, dv)
}

// generateDesignDoc converts an SVG into the structured design doc model
// used by the editor. Returns "" on error (logged) — the design version is
// still creatable without a doc; the editor will fall back to lazy
// regeneration.
func (s *apiServer) generateDesignDoc(r *http.Request, projectID int64, svg []byte) string {
	project, err := storage.GetProject(r.Context(), s.db, projectID)
	if err != nil {
		slog.Warn("designdoc: load project", "err", err)
		return ""
	}
	spec, err := storage.GetTubeSpec(r.Context(), s.db, project.TubeSpecID)
	if err != nil {
		slog.Warn("designdoc: load tube spec", "err", err)
		return ""
	}
	doc, err := designdoc.FromSVG(svg, spec.DiameterMM)
	if err != nil {
		slog.Warn("designdoc: convert", "err", err)
		return ""
	}
	b, err := json.Marshal(doc)
	if err != nil {
		slog.Warn("designdoc: marshal", "err", err)
		return ""
	}
	return string(b)
}

// runValidation loads the project's tube spec, validates the SVG, and
// returns the report as JSON. Errors are logged but not surfaced — a missing
// report on a design version is non-fatal (the user can re-run validation).
//
// AUDIT CHECKLIST (Tier 3 #44 / #46): every field on validate.Limits
// MUST be forwarded from the tube spec OR the project here. The
// validator's optional rules (min_lead_in, sharp_bend_angle, derived
// bend radius from wall + technique, face-perimeter strict mode)
// silently fall back to defaults when their fields are zero — a
// forgotten copy here means the user's spec/project value is dropped
// on the floor with no error. When a new field is added to
// validate.Limits, update BOTH this construction site AND the parallel
// one in handlers_designdoc.go's handleValidateDoc. Run the audit with:
//
//	grep -rn 'validate.Limits{' internal/server/
//
// Today's full set (9 fields): DiameterMM, MinBendRadiusMM,
// MaxSegmentLengthMM, MinSpacingMM, MinLeadInMM, SharpBendAngleDeg,
// WallThicknessMM, BendTechnique, FacePerimeterStrict. The four
// pointer-typed columns on storage.TubeSpec (MinLeadInMM,
// SharpBendAngleDeg, WallThicknessMM, BendTechnique) flow through as
// zero values when nil, which is the documented "use derived default"
// sentinel — see internal/validate/types.go Limits doc-comment.
// FacePerimeterStrict comes from the project (Tier 3 #46), not the
// tube spec — strict mode is a per-project policy, not a tube-spec
// dimensional input.
// The doc parameter (Tier 2 #104) is optional: pass the design doc when the
// caller has one so the doc-level raceway rules run too, or nil when only an
// SVG exists (the vectorize path). See validateDocGeometry.
func (s *apiServer) runValidation(r *http.Request, projectID int64, svg []byte, doc *designdoc.Doc) string {
	project, err := storage.GetProject(r.Context(), s.db, projectID)
	if err != nil {
		slog.Warn("validate: load project", "err", err)
		return ""
	}
	spec, err := storage.GetTubeSpec(r.Context(), s.db, project.TubeSpecID)
	if err != nil {
		slog.Warn("validate: load tube spec", "err", err)
		return ""
	}
	limits := validate.Limits{
		DiameterMM:          spec.DiameterMM,
		MinBendRadiusMM:     spec.MinBendRadiusMM,
		MaxSegmentLengthMM:  spec.MaxSegmentLengthMM,
		MinSpacingMM:        spec.MinSpacingMM,
		FacePerimeterStrict: project.FacePerimeterStrictMode,
	}
	if spec.MinLeadInMM != nil {
		limits.MinLeadInMM = *spec.MinLeadInMM
	}
	if spec.SharpBendAngleDeg != nil {
		limits.SharpBendAngleDeg = *spec.SharpBendAngleDeg
	}
	if spec.WallThicknessMM != nil {
		limits.WallThicknessMM = *spec.WallThicknessMM
	}
	if spec.BendTechnique != nil {
		limits.BendTechnique = *spec.BendTechnique
	}
	report, err := validateDocGeometry(svg, doc, limits)
	if err != nil {
		slog.Warn("validate: run", "err", err)
		return ""
	}
	b, err := json.Marshal(report)
	if err != nil {
		slog.Warn("validate: marshal report", "err", err)
		return ""
	}
	return string(b)
}

func (s *apiServer) handleRevalidate(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	updated, err := s.revalidateOne(r, vid)
	if err != nil {
		if errors.Is(err, errValidationFailed) {
			writeError(w, http.StatusInternalServerError, "validation failed; see server logs")
			return
		}
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

// errValidationFailed is the sentinel returned by revalidateOne when
// runValidation produced an empty report (the cause is already logged
// inside runValidation). Callers can map this to a 500 in the
// single-version handler or "skip and continue" in the fan-out.
var errValidationFailed = errors.New("validation produced empty report")

// revalidateOne loads a design version, re-runs the project's validator
// against its stored SVG, and writes the fresh report. It is the shared
// per-version primitive used by handleRevalidate (one explicit click) and
// revalidateAllForTubeSpec (fan-out after a tube-spec edit). On a
// missing/corrupt SVG the sentinel errValidationFailed is returned so the
// fan-out can keep going; storage failures bubble up untouched.
func (s *apiServer) revalidateOne(r *http.Request, vid int64) (storage.DesignVersion, error) {
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		return storage.DesignVersion{}, err
	}
	// Revalidating a stored version: decode its design doc when it has one,
	// so a re-run picks up the raceway rules the same way the live editor
	// does. A version saved before the doc format existed (SVG-only import)
	// has no doc and validates exactly as it always did.
	var doc *designdoc.Doc
	if v.DesignDocJSON != nil && *v.DesignDocJSON != "" {
		var parsed designdoc.Doc
		if err := json.Unmarshal([]byte(*v.DesignDocJSON), &parsed); err != nil {
			slog.Warn("revalidate: parse design doc", "vid", vid, "err", err)
		} else {
			doc = &parsed
		}
	}
	reportJSON := s.runValidation(r, v.ProjectID, []byte(v.SVGData), doc)
	if reportJSON == "" {
		return storage.DesignVersion{}, errValidationFailed
	}
	return storage.UpdateDesignVersionReport(r.Context(), s.db, vid, reportJSON)
}

func (s *apiServer) handleListDesignVersions(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}
	versions, err := storage.ListDesignVersions(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if versions == nil {
		versions = []storage.DesignVersion{}
	}
	writeJSON(w, http.StatusOK, versions)
}

func (s *apiServer) handleLatestDesignVersion(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}
	v, err := storage.LatestDesignVersion(r.Context(), s.db, pid)
	if err != nil {
		if errors.Is(err, storage.ErrNotFound) {
			writeJSON(w, http.StatusOK, nil)
			return
		}
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, v)
}

func (s *apiServer) handleGetDesignVersion(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	writeJSON(w, http.StatusOK, v)
}

type updateDesignVersionReq struct {
	// Label is required (the only mutable field here). An empty / whitespace
	// string clears the label to NULL — "(no label)". A nil pointer means the
	// client omitted the field, which is a 400 rather than a silent no-op.
	Label *string `json:"label"`
}

// handleUpdateDesignVersion renames an existing design version (Bug #05). The
// label was previously settable only at create time, so versions accumulated
// as "(no label)" with no way to fix them.
func (s *apiServer) handleUpdateDesignVersion(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	var req updateDesignVersionReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Label == nil {
		writeError(w, http.StatusBadRequest, "label is required")
		return
	}
	// Confirm the version belongs to this project before mutating so a stale
	// URL can't reach across projects (mirrors GET / DELETE).
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	updated, err := storage.UpdateDesignVersionLabel(r.Context(), s.db, vid, strings.TrimSpace(*req.Label))
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
}

func (s *apiServer) handleDeleteDesignVersion(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	// Confirm the version belongs to this project before deleting so a
	// stale URL can't reach across projects.
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	if err := storage.DeleteDesignVersion(r.Context(), s.db, vid); err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
