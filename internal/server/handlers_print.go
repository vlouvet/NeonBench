package server

import (
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/printpdf"
	"github.com/vlouvet/neonbench/internal/storage"
)

func (s *apiServer) handlePrintPDF(w http.ResponseWriter, r *http.Request) {
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
	tubeSpec, err := storage.GetTubeSpec(r.Context(), s.db, project.TubeSpecID)
	if err != nil {
		writeStorageError(w, err)
		return
	}

	opts := printpdf.DefaultOptions()
	if name := r.URL.Query().Get("paper"); name != "" {
		if p, found := printpdf.PaperByName(name); found {
			opts.Paper = p
		} else {
			writeError(w, http.StatusBadRequest, "unknown paper: "+name+
				" (try: letter, legal, tabloid, a4, a3, a2)")
			return
		}
	}
	if r.URL.Query().Get("landscape") == "1" {
		opts.Landscape = true
	}
	opts.ProjectName = project.Name
	if v.Label != nil {
		opts.DesignVersionLabel = fmt.Sprintf("v%d — %s", v.VersionNo, *v.Label)
	} else {
		opts.DesignVersionLabel = fmt.Sprintf("v%d", v.VersionNo)
	}
	opts.TubeSpecName = tubeSpec.Name
	// Tube end gap (NW #135) — informational footer only. NULL on the
	// project means "shop default of 6.35 mm" (Miller App I §126); use
	// the explicit override when present, fall back otherwise. Either
	// way the footer shows a value so the bender / installer sees the
	// active end-gap target on the printed pattern.
	if project.TubeEndGapMM != nil {
		opts.TubeEndGapMM = *project.TubeEndGapMM
	} else {
		opts.TubeEndGapMM = defaultTubeEndGapMM
	}
	// Channel-letter depth (NW #106) — drives the height of any
	// return-strip pages emitted per face-marked run. NULL on the
	// project means "use shop default of 100 mm" (Strattman NT Ch.5).
	if project.ChannelLetterDepthMM != nil {
		opts.ChannelLetterDepthMM = *project.ChannelLetterDepthMM
	} else {
		opts.ChannelLetterDepthMM = defaultChannelLetterDepthMM
	}

	var data []byte
	if v.DesignDocJSON != nil && *v.DesignDocJSON != "" {
		var doc designdoc.Doc
		if err := json.Unmarshal([]byte(*v.DesignDocJSON), &doc); err == nil && len(doc.Runs) > 0 {
			data, err = printpdf.RenderFromDoc(&doc, opts, tubeSpec.DiameterMM)
		} else {
			data, err = printpdf.Render([]byte(v.SVGData), opts)
		}
	} else {
		data, err = printpdf.Render([]byte(v.SVGData), opts)
	}
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, "render pdf: "+err.Error())
		return
	}
	filename := fmt.Sprintf("%s_v%d.pdf", safeFilename(project.Name), v.VersionNo)
	w.Header().Set("content-type", "application/pdf")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", len(data)))
	_, _ = w.Write(data)
}

func safeFilename(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9', c == '-', c == '_':
			out = append(out, c)
		case c == ' ':
			out = append(out, '_')
		}
	}
	if len(out) == 0 {
		return "design"
	}
	return string(out)
}
