package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"

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
	// strips_only=1 (Tier 3 #50) suppresses the main pattern + bend-list
	// pages; only the per-run channel-letter return-strip pages and any
	// raceway-grouped strip pages are emitted. Operators flip this on
	// post-fabrication when the front face is already bent and they
	// just need to bend the metal strip. A request with strips_only=1
	// against a doc with zero face-flagged runs returns 422 — see
	// printpdf.ErrNoStripsToRender for the rationale.
	if r.URL.Query().Get("strips_only") == "1" {
		opts.StripsOnly = true
	}
	// mirror=0 opts out of the trade-default mirrored print (Tier 2
	// #73). The trade default is MIRRORED — the bender works against
	// the back of the glass tube while reading the printed pattern,
	// so the geometry must be flipped left-to-right relative to the
	// front-facing design. Operators wanting a front-facing print for
	// marketing renders or design review pass ?mirror=0; absence of
	// the parameter (or any other value) preserves the mirrored
	// trade default. Pointer-bool semantics here match the rest of
	// the print-options surface — see printpdf.Options.Mirror.
	if r.URL.Query().Get("mirror") == "0" {
		mirrorOff := false
		opts.Mirror = &mirrorOff
	}
	// rotate=90 / rotate=fit (Tier 2 #93). Absent (or explicitly empty)
	// means no rotation, which is what makes this parameter absent-safe:
	// a caller that never mentions it gets the exact PDF NeonBench
	// produced before the option existed. Any other value is a 400
	// rather than a silently-ignored typo — `?rotate=fitt` producing an
	// un-rotated 6-sheet print with no complaint is the failure mode
	// worth spending an error code on.
	rotate := r.URL.Query().Get("rotate")
	if !printpdf.ValidRotate(rotate) {
		writeError(w, http.StatusBadRequest, "unknown rotate: "+rotate+
			" (try: 90, fit)")
		return
	}
	opts.Rotate = rotate
	// copies=N (Tier 2 #93 step-and-repeat). Validated and clamped HERE
	// rather than in the renderer so bad input is a 400 instead of a 200
	// with a surprising PDF — the same contract the `paper` param above
	// follows. Non-numeric, zero, negative and above-MaxCopies all fail
	// the same way; N copies of the full page set is the only success.
	if raw := r.URL.Query().Get("copies"); raw != "" {
		n, convErr := strconv.Atoi(raw)
		if convErr != nil || n < 1 || n > printpdf.MaxCopies {
			writeError(w, http.StatusBadRequest, fmt.Sprintf(
				"copies must be a whole number between 1 and %d", printpdf.MaxCopies))
			return
		}
		opts.Copies = n
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
	// Strip overlap allowance (Tier 3 #26) — drawn as a dashed shear
	// line on each unfolded return-strip page. NULL on the project
	// means "use shop default of 12.7 mm (½ in)".
	if project.StripOverlapMM != nil {
		opts.StripOverlapMM = *project.StripOverlapMM
	} else {
		opts.StripOverlapMM = defaultStripOverlapMM
	}

	var data []byte
	// Render dispatch: if the saved version has a structured design_doc,
	// the doc-bearing renderer wins (it knows about runs, electrodes,
	// strip pages, bend list). Otherwise fall back to the SVG-only path.
	// Pre-Tier-3-#50 this block shadowed `err` inside the `if-init` and
	// silently swallowed render errors — see the explicit local `dataErr`
	// below for the fix. Without it, RenderFromDoc's ErrNoStripsToRender
	// (or any other error) never reaches the outer `if err != nil`,
	// producing a 200 with zero bytes — a stale PDF spool to the iframe.
	var dataErr error
	if v.DesignDocJSON != nil && *v.DesignDocJSON != "" {
		var doc designdoc.Doc
		if jsonErr := json.Unmarshal([]byte(*v.DesignDocJSON), &doc); jsonErr == nil && len(doc.Runs) > 0 {
			data, dataErr = printpdf.RenderFromDoc(&doc, opts, tubeSpec.DiameterMM)
		} else {
			data, dataErr = printpdf.Render([]byte(v.SVGData), opts)
		}
	} else {
		data, dataErr = printpdf.Render([]byte(v.SVGData), opts)
	}
	if err := dataErr; err != nil {
		// Map the strips-only "no faces" sentinel to a clear 422 so the
		// hidden print iframe shows an error page rather than spooling
		// an empty PDF. All other render errors fall through with the
		// same message format we shipped pre-Tier-3-#50.
		if errors.Is(err, printpdf.ErrNoStripsToRender) {
			writeError(w, http.StatusUnprocessableEntity,
				"no return strips in this design — uncheck \"Strip pages only\" or flag a run as a channel-letter face")
			return
		}
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
