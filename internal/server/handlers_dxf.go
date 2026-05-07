package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/printdxf"
	"github.com/vlouvet/neonbench/internal/storage"
)

// handlePrintDXF emits an AutoCAD R12 ASCII DXF for the requested design
// version. Mirrors handlePrintPDF's shape: same path-id parsing, same
// project/version-mismatch guard, same filename sanitizer.
//
// V1 scope: geometry only. The DXF is the bender feed; the PDF remains
// the human-facing pattern. Annotations as DXF text/circle entities are
// a Tier 3 follow-up.
//
// Unlike the PDF handler we do NOT fall back to parsing v.SVGData if
// design_doc_json is absent: legacy versions saved before the editor
// landed have no run polylines to emit. Those clients should re-save
// (or use the PDF route, which has the SVG fallback).
func (s *apiServer) handlePrintDXF(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	project, err := storage.GetProject(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
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

	if v.DesignDocJSON == nil || *v.DesignDocJSON == "" {
		writeError(w, http.StatusUnprocessableEntity,
			"design version has no structured design_doc — re-save in the editor before exporting DXF")
		return
	}
	var doc designdoc.Doc
	if err := json.Unmarshal([]byte(*v.DesignDocJSON), &doc); err != nil {
		writeError(w, http.StatusUnprocessableEntity, "parse design_doc: "+err.Error())
		return
	}

	var buf bytes.Buffer
	if err := printdxf.EmitDXF(&buf, &doc); err != nil {
		writeError(w, http.StatusInternalServerError, "render dxf: "+err.Error())
		return
	}
	data := buf.Bytes()

	filename := fmt.Sprintf("%s_v%d.dxf", safeFilename(project.Name), v.VersionNo)
	w.Header().Set("content-type", "application/dxf")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", len(data)))
	_, _ = w.Write(data)
}
