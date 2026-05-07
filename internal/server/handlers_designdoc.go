package server

import (
	"encoding/json"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/validate"
)

type createDesignVersionFromDocReq struct {
	BasedOnVID int64          `json:"based_on_vid,omitempty"`
	Label      string         `json:"label,omitempty"`
	Doc        designdoc.Doc  `json:"design_doc"`
}

type validateDocReq struct {
	Doc designdoc.Doc `json:"design_doc"`
}

// handleValidateDoc validates an in-flight design doc without writing a
// design version. The editor uses this to live-validate edits while the
// user is working: render SVG → run validation → return the report.
func (s *apiServer) handleValidateDoc(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
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

	var req validateDocReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.Doc.Version == 0 {
		writeError(w, http.StatusBadRequest, "design_doc is required")
		return
	}

	svg := designdoc.ToSVG(&req.Doc)
	report, err := validate.ValidateSVG(svg, validate.Limits{
		DiameterMM:         spec.DiameterMM,
		MinBendRadiusMM:    spec.MinBendRadiusMM,
		MaxSegmentLengthMM: spec.MaxSegmentLengthMM,
		MinSpacingMM:       spec.MinSpacingMM,
	})
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validate: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
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
	// A blank design doc (zero runs) is legal: it's the bootstrap version
	// for the "design from a blank file" workflow. The validator and SVG
	// renderer both already handle empty doc inputs gracefully (renderer
	// emits an empty <svg>, validator returns a report with zero runs and
	// no issues).
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
