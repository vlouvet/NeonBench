package server

// Vector-graphics export endpoints — SVG / EPS / AI flavors of the
// existing geometry export pipeline. Sister file to handlers_dxf.go;
// the DXF handler is the bender's CAM input, these three handlers
// target graphic-design suites (Illustrator, CorelDRAW, Inkscape).
//
// Endpoints (Tier 3 #80):
//
//	GET /api/projects/{id}/design_versions/{vid}/export.svg
//	GET /api/projects/{id}/design_versions/{vid}/export.eps
//	GET /api/projects/{id}/design_versions/{vid}/export.ai
//
// All three accept ?mirror=1 (matching the PDF + DXF convention from
// Tier 2 #73), which flips the design horizontally about the bbox's
// vertical midline. Default mirror=0.
//
// AI = EPS bytes served with the .ai content-disposition and the
// "application/postscript" content-type. Modern Illustrator (CS+)
// opens .ai files that are actually EPS without complaint — the
// historical AI native binary format converged on PDF, and any
// version of Illustrator from this century happily ingests an
// EPS-shaped .ai. Synthesising the real binary AI format would
// require shipping a PDF library purely to support a "modern AI =
// PDF wrapper" emitter; the value-add over EPS-as-AI is minimal for
// the line-art neon patterns we care about (no gradients, no
// transparency, no embedded raster). Documented in the spec; the
// frontend dropdown tooltip cites this trade-off.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/printeps"
	"github.com/vlouvet/neonbench/internal/printsvg"
	"github.com/vlouvet/neonbench/internal/storage"
)

// resolveVectorExport loads the project + design version + parsed
// designdoc. Returns ok=false if any precondition fails (404 / 422
// already written to the response). Shared by all three handlers so
// the per-format wrappers stay one-liner thin.
func (s *apiServer) resolveVectorExport(w http.ResponseWriter, r *http.Request) (storage.Project, storage.DesignVersion, designdoc.Doc, bool) {
	var (
		emptyProject storage.Project
		emptyVersion storage.DesignVersion
		emptyDoc     designdoc.Doc
	)
	pid, ok := pathID(w, r, "id")
	if !ok {
		return emptyProject, emptyVersion, emptyDoc, false
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return emptyProject, emptyVersion, emptyDoc, false
	}
	project, err := storage.GetProject(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return emptyProject, emptyVersion, emptyDoc, false
	}
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return emptyProject, emptyVersion, emptyDoc, false
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return emptyProject, emptyVersion, emptyDoc, false
	}

	// Like the DXF handler, we require a structured design_doc — we
	// don't fall back to SVGData parsing because legacy versions that
	// predate the editor have no run polylines for us to re-emit.
	if v.DesignDocJSON == nil || *v.DesignDocJSON == "" {
		writeError(w, http.StatusUnprocessableEntity,
			"design version has no structured design_doc — re-save in the editor before exporting vector graphics")
		return emptyProject, emptyVersion, emptyDoc, false
	}
	var doc designdoc.Doc
	if err := json.Unmarshal([]byte(*v.DesignDocJSON), &doc); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "parse design_doc: "+err.Error())
		return emptyProject, emptyVersion, emptyDoc, false
	}
	return project, v, doc, true
}

// handleExportSVG emits the design as an mm-units SVG with per-run
// groups and dedicated annotation layers (see printsvg).
func (s *apiServer) handleExportSVG(w http.ResponseWriter, r *http.Request) {
	project, v, doc, ok := s.resolveVectorExport(w, r)
	if !ok {
		return
	}
	opts := printsvg.Options{Mirror: r.URL.Query().Get("mirror") == "1"}
	var buf bytes.Buffer
	if err := printsvg.EmitSVGWithOptions(&buf, &doc, opts); err != nil {
		writeError(w, http.StatusInternalServerError, "render svg: "+err.Error())
		return
	}
	data := buf.Bytes()
	filename := fmt.Sprintf("%s_v%d.svg", safeFilename(project.Name), v.VersionNo)
	w.Header().Set("content-type", "image/svg+xml")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", len(data)))
	_, _ = w.Write(data)
}

// handleExportEPS emits the design as Encapsulated PostScript (see
// printeps).
func (s *apiServer) handleExportEPS(w http.ResponseWriter, r *http.Request) {
	data, project, v, ok := s.renderEPSBytes(w, r)
	if !ok {
		return
	}
	filename := fmt.Sprintf("%s_v%d.eps", safeFilename(project.Name), v.VersionNo)
	w.Header().Set("content-type", "application/postscript")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", len(data)))
	_, _ = w.Write(data)
}

// handleExportAI emits the same EPS bytes with an .ai filename and
// the standard application/postscript content-type. See package-level
// rationale on why we don't synthesize the real AI native format.
func (s *apiServer) handleExportAI(w http.ResponseWriter, r *http.Request) {
	data, project, v, ok := s.renderEPSBytes(w, r)
	if !ok {
		return
	}
	filename := fmt.Sprintf("%s_v%d.ai", safeFilename(project.Name), v.VersionNo)
	// content-type stays application/postscript: the AI extension is
	// purely the consumer-facing convention. Modern Illustrator sniffs
	// the magic bytes (%!PS-Adobe-...) regardless of the
	// content-type header, but downstream proxies / browser save
	// dialogs may use the type for icon resolution.
	w.Header().Set("content-type", "application/postscript")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", len(data)))
	_, _ = w.Write(data)
}

// renderEPSBytes resolves the project / version / doc and renders
// the EPS into a byte slice. Shared between handleExportEPS and
// handleExportAI so the two endpoints emit identical drawing
// content. The returned ok=false case has already written the error
// response.
func (s *apiServer) renderEPSBytes(w http.ResponseWriter, r *http.Request) ([]byte, storage.Project, storage.DesignVersion, bool) {
	project, v, doc, ok := s.resolveVectorExport(w, r)
	if !ok {
		return nil, project, v, false
	}
	opts := printeps.Options{Mirror: r.URL.Query().Get("mirror") == "1"}
	var buf bytes.Buffer
	if err := printeps.EmitEPSWithOptions(&buf, &doc, opts); err != nil {
		writeError(w, http.StatusInternalServerError, "render eps: "+err.Error())
		return nil, project, v, false
	}
	return buf.Bytes(), project, v, true
}
