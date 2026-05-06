package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/validate"
	"github.com/vlouvet/neonbench/internal/vectorize"
)

type vectorizeReq struct {
	AssetID       int64   `json:"asset_id"`
	TargetWidthMM float64 `json:"target_width_mm"`
	Threshold     int     `json:"threshold,omitempty"` // 0..255
	TurnPolicy    string  `json:"turn_policy,omitempty"`
	Turdsize      int     `json:"turdsize,omitempty"`
	Alphamax      float64 `json:"alphamax,omitempty"`
	Opttolerance  float64 `json:"opttolerance,omitempty"`
	Label         string  `json:"label,omitempty"`
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
		params := vectorize.DefaultPotraceParams(req.TargetWidthMM)
		if req.TurnPolicy != "" {
			params.TurnPolicy = req.TurnPolicy
		}
		if req.Turdsize > 0 {
			params.Turdsize = req.Turdsize
		}
		if req.Alphamax > 0 {
			params.Alphamax = req.Alphamax
		}
		if req.Opttolerance > 0 {
			params.Opttolerance = req.Opttolerance
		}
		res, err := vectorize.VectorizeRaster(r.Context(), vectorize.Request{
			SourceBytes:   data,
			TargetWidthMM: req.TargetWidthMM,
			Threshold:     threshold,
			Potrace:       params,
		})
		if err != nil {
			if errors.Is(err, vectorize.ErrPotraceMissing) {
				writeError(w, http.StatusFailedDependency,
					"potrace not installed. Install via: brew install potrace (macOS), "+
						"choco install potrace (Windows), or apt install potrace (Linux).")
				return
			}
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
	reportJSON := s.runValidation(r, pid, svg)

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
func (s *apiServer) runValidation(r *http.Request, projectID int64, svg []byte) string {
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
	report, err := validate.ValidateSVG(svg, validate.Limits{
		DiameterMM:         spec.DiameterMM,
		MinBendRadiusMM:    spec.MinBendRadiusMM,
		MaxSegmentLengthMM: spec.MaxSegmentLengthMM,
		MinSpacingMM:       spec.MinSpacingMM,
	})
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
	reportJSON := s.runValidation(r, pid, []byte(v.SVGData))
	if reportJSON == "" {
		writeError(w, http.StatusInternalServerError, "validation failed; see server logs")
		return
	}
	updated, err := storage.UpdateDesignVersionReport(r.Context(), s.db, vid, reportJSON)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, updated)
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
