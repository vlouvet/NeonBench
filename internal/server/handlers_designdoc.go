package server

import (
	"encoding/json"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
)

type createDesignVersionFromDocReq struct {
	BasedOnVID int64          `json:"based_on_vid,omitempty"`
	Label      string         `json:"label,omitempty"`
	Doc        designdoc.Doc  `json:"design_doc"`
}

// handleCreateDesignVersion accepts an edited design doc, renders SVG from
// it, runs validation, and persists as a new design_version with the next
// version_no for the project. This is how the editor saves edits.
func (s *apiServer) handleCreateDesignVersion(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}

	var req createDesignVersionFromDocReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Doc.Version == 0 {
		writeError(w, http.StatusBadRequest, "design_doc is required")
		return
	}
	if len(req.Doc.Runs) == 0 {
		writeError(w, http.StatusBadRequest, "design_doc has no runs")
		return
	}
	if req.BasedOnVID != 0 {
		v, err := storage.GetDesignVersion(r.Context(), s.db, req.BasedOnVID)
		if err != nil {
			writeStorageError(w, err)
			return
		}
		if v.ProjectID != pid {
			writeError(w, http.StatusBadRequest, "based_on_vid belongs to a different project")
			return
		}
	}

	svg := designdoc.ToSVG(&req.Doc)
	docJSON, err := json.Marshal(&req.Doc)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	reportJSON := s.runValidation(r, pid, svg)

	dv, err := storage.CreateDesignVersion(r.Context(), s.db, storage.CreateDesignVersionParams{
		ProjectID:            pid,
		Label:                req.Label,
		SVGData:              string(svg),
		DesignDocJSON:        string(docJSON),
		ValidationReportJSON: reportJSON,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, dv)
}
