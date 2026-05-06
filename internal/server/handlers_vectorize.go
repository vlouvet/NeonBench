package server

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"

	"github.com/vlouvet/neonbench/internal/storage"
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

	dv, err := storage.CreateDesignVersion(r.Context(), s.db, storage.CreateDesignVersionParams{
		ProjectID: pid,
		Label:     req.Label,
		SVGData:   string(svg),
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, dv)
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
