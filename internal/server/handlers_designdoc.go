package server

import (
	"encoding/json"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/validate"
)

type createDesignVersionFromDocReq struct {
	BasedOnVID int64         `json:"based_on_vid,omitempty"`
	Label      string        `json:"label,omitempty"`
	Doc        designdoc.Doc `json:"design_doc"`
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
	// AUDIT CHECKLIST (Tier 3 #44 / #46): every field on validate.Limits
	// MUST be forwarded from the tube spec OR the project here. See the
	// parallel construction in handlers_vectorize.go runValidation for
	// the canonical doc-comment; any new validate.Limits field must be
	// wired in BOTH places. Pointer fields on storage.TubeSpec flow
	// through as zero when nil, which the validator interprets as "use
	// derived default". FacePerimeterStrict comes from the project, not
	// the tube spec — strict mode is per-project policy.
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
	report, err := validateDocGeometry(svg, &req.Doc, limits)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "validate: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, report)
}

// validateDocGeometry is the whole validation pass for a DESIGN DOC: the SVG
// rules every entry point runs, plus the doc-level rules that cannot be seen
// through SVG at all.
//
// The raceway rules (Tier 2 #104) are the reason this exists. A raceway is a
// box, not a path — it never reaches the SVG, so ValidateSVG structurally
// cannot check it. Any caller holding a doc should go through here; a caller
// holding only an SVG (the vectorize path) passes nil and gets exactly
// today's report.
func validateDocGeometry(svg []byte, doc *designdoc.Doc, limits validate.Limits) (*validate.Report, error) {
	report, err := validate.ValidateSVG(svg, limits)
	if err != nil {
		return nil, err
	}
	if doc != nil {
		report.Issues = append(report.Issues, validate.CheckRaceways(designdoc.RacewayInputs(doc))...)
	}
	return report, nil
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
	reportJSON := s.runValidation(r, pid, svg, &req.Doc)

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
