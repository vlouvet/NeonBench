package printpdf

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/validate"
)

// ErrNoStripsToRender is returned by RenderFromDoc when StripsOnly is
// set on a doc that has no channel-letter face runs (Tier 3 #50). The
// handler translates this to HTTP 422 with a short user-facing message
// so the hidden print iframe shows something instead of silently
// spooling an empty job. Sentinel; errors.Is works directly.
var ErrNoStripsToRender = errors.New("no return strips in this design (StripsOnly requires at least one channel-letter face run)")

// Options bundle the user-facing knobs for a print job.
type Options struct {
	Paper              Paper
	Landscape          bool
	MarginMM           float64 // page margin (default 10mm)
	OverlapMM          float64 // bleed/overlap between tiles (default 10mm)
	StrokeMM           float64 // outline pen width (default 0.5mm)
	ProjectName        string
	DesignVersionLabel string
	TubeSpecName       string
	// TubeEndGapMM is the project's tube-end-gap setting (NW #135).
	// Zero means "not set; show nothing in the footer". V1 surfaces
	// this as informational text only — Tier 3 #27 will turn it into
	// a validation rule once a frame/substrate model exists.
	TubeEndGapMM float64
	// ChannelLetterDepthMM is the project's default depth for any
	// run flagged as a channel-letter face (NW #106). Drives the
	// height of the unfolded "return strip" page emitted per face
	// run. Zero falls back to 100 mm at emission time. Per-run
	// overrides on the design doc (Run.ChannelLetterDepthMM) win
	// over this value (Tier 3 #26).
	ChannelLetterDepthMM float64
	// StripOverlapMM is the project's strip-overlap allowance in
	// millimeters (Tier 3 #26). The renderer draws a dashed shear
	// line at the right end of each unfolded return strip; the
	// fabricator shears at this line so the doubled-back metal
	// forms the seam. Zero falls back to 12.7 mm (½ in) at
	// emission time.
	StripOverlapMM float64
	// StripsOnly, when true, suppresses the main pattern pages and
	// the bend-list summary page from RenderFromDoc, emitting ONLY
	// the per-run channel-letter return-strip pages and any
	// raceway-grouped strip pages (Tier 3 #50). Operators flip this
	// on after the front-face glass is bent and they only want to
	// print the metal-strip patterns. Has no effect on Render
	// (SVG-only path) — that path doesn't emit strip pages anyway.
	// When true and the design has zero face-flagged runs the
	// renderer returns ErrNoStripsToRender so the handler can return
	// a 422 with a clear "no return strips in this design" message
	// (a zero-page PDF is technically invalid; failing loud lets the
	// caller's iframe surface the error).
	StripsOnly bool
}

// DefaultOptions returns conservative paper-template defaults.
func DefaultOptions() Options {
	return Options{
		Paper:     PaperLetter,
		Landscape: false,
		MarginMM:  10,
		OverlapMM: 10,
		StrokeMM:  0.5,
	}
}

// Render produces a 1:1-scale print PDF of the SVG's geometry. If the
// design exceeds a single sheet, it is tiled across pages with overlap
// markers, registration crosses, a scale bar, and tile labels.
func Render(svg []byte, opts Options) ([]byte, error) {
	if opts.Paper.WidthMM == 0 {
		opts.Paper = PaperLetter
	}
	if opts.MarginMM <= 0 {
		opts.MarginMM = 10
	}
	if opts.OverlapMM < 0 {
		opts.OverlapMM = 0
	}
	if opts.StrokeMM <= 0 {
		opts.StrokeMM = 0.5
	}

	polylines, bbox, _, err := validate.ExtractMMPolylines(svg)
	if err != nil {
		return nil, fmt.Errorf("parse svg: %w", err)
	}

	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	contentW := pageW - 2*opts.MarginMM
	contentH := pageH - 2*opts.MarginMM
	if contentW <= 0 || contentH <= 0 {
		return nil, fmt.Errorf("margins exceed paper size")
	}

	designW := bbox[2] - bbox[0]
	designH := bbox[3] - bbox[1]
	if designW <= 0 || designH <= 0 {
		return nil, fmt.Errorf("design has zero area")
	}

	// Tiles overlap by OverlapMM, so the effective unique area per tile is
	// (contentW - overlap) × (contentH - overlap).
	stepW := contentW - opts.OverlapMM
	stepH := contentH - opts.OverlapMM
	if stepW <= 0 {
		stepW = contentW
	}
	if stepH <= 0 {
		stepH = contentH
	}
	cols := int(math.Ceil(designW / stepW))
	rows := int(math.Ceil(designH / stepH))
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}

	orient := "P"
	if opts.Landscape {
		orient = "L"
	}
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: orient,
		UnitStr:        "mm",
		SizeStr:        "",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCreator("NeonBench", false)
	pdf.SetTitle(opts.ProjectName, false)

	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			pdf.AddPage()

			tileX := bbox[0] + float64(c)*stepW
			tileY := bbox[1] + float64(r)*stepH

			// Save graphics state, clip to content area.
			pdf.ClipRect(opts.MarginMM, opts.MarginMM, contentW, contentH, false)
			pdf.SetDrawColor(0, 0, 0)
			pdf.SetLineWidth(opts.StrokeMM)

			// Draw polylines transformed: world (mm) -> page (mm)
			// page_x = (world_x - tileX) + margin
			// page_y = (world_y - tileY) + margin
			for _, pl := range polylines {
				if len(pl.Points) < 2 {
					continue
				}
				start := pl.Points[0]
				pdf.MoveTo(start.X-tileX+opts.MarginMM, start.Y-tileY+opts.MarginMM)
				for i := 1; i < len(pl.Points); i++ {
					p := pl.Points[i]
					pdf.LineTo(p.X-tileX+opts.MarginMM, p.Y-tileY+opts.MarginMM)
				}
				if pl.Closed {
					pdf.LineTo(start.X-tileX+opts.MarginMM, start.Y-tileY+opts.MarginMM)
				}
				pdf.DrawPath("D") // stroke only
			}

			pdf.ClipEnd()

			drawTileOverlay(pdf, opts, pageW, pageH, contentW, contentH, c, r, cols, rows)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("write pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// RenderFromDoc renders a structured design doc as a 1:1 print pattern.
// In addition to the polylines that the SVG-based Render emits, this
// pipeline knows about runs, electrodes, blockouts, and bends — so the
// bender's pattern can show numbered bend apex markers, electrode
// positions, and a bend-list summary page at the back.
func RenderFromDoc(doc *designdoc.Doc, opts Options, projectDiameterMM float64) ([]byte, error) {
	if opts.Paper.WidthMM == 0 {
		opts.Paper = PaperLetter
	}
	if opts.MarginMM <= 0 {
		opts.MarginMM = 10
	}
	if opts.OverlapMM < 0 {
		opts.OverlapMM = 0
	}
	if opts.StrokeMM <= 0 {
		opts.StrokeMM = 0.5
	}

	// StripsOnly fail-fast: refuse to emit a zero-page PDF. Walk runs
	// once before any geometry / paper math; if no run is a channel-
	// letter face, return the typed sentinel so the handler maps to
	// HTTP 422. We don't enforce the same check in the SVG-only Render
	// path: that path never emits strip pages, so calling it with
	// StripsOnly is meaningless either way; the handler steers
	// StripsOnly requests at the doc-bearing path.
	if opts.StripsOnly {
		anyFace := false
		for _, run := range doc.Runs {
			if run.IsChannelLetterFace && len(run.Polyline.Points) >= 2 {
				anyFace = true
				break
			}
		}
		if !anyFace {
			return nil, ErrNoStripsToRender
		}
	}

	bbox := docBBox(doc)
	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	contentW := pageW - 2*opts.MarginMM
	contentH := pageH - 2*opts.MarginMM
	if contentW <= 0 || contentH <= 0 {
		return nil, fmt.Errorf("margins exceed paper size")
	}
	designW := bbox[2] - bbox[0]
	designH := bbox[3] - bbox[1]
	if designW <= 0 || designH <= 0 {
		return nil, fmt.Errorf("design has zero area")
	}

	stepW := contentW - opts.OverlapMM
	stepH := contentH - opts.OverlapMM
	if stepW <= 0 {
		stepW = contentW
	}
	if stepH <= 0 {
		stepH = contentH
	}
	cols := int(math.Ceil(designW / stepW))
	rows := int(math.Ceil(designH / stepH))
	if cols < 1 {
		cols = 1
	}
	if rows < 1 {
		rows = 1
	}

	orient := "P"
	if opts.Landscape {
		orient = "L"
	}
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: orient,
		UnitStr:        "mm",
		SizeStr:        "",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCreator("NeonBench", false)
	pdf.SetTitle(opts.ProjectName, false)

	// Pre-compute bends per run so the apex numbers we draw on the tiles
	// match the bend list page at the back.
	// Tier 3 #60 — jumpers are 2-vertex splice tubes with no bends
	// to enumerate; we skip them at compute time so the bend-apex
	// pass and the summary page agree (and so a doc that's purely
	// "primary run + jumper" doesn't emit a bend-list page with one
	// "(no bends)" row).
	bendsByRun := make(map[string][]designdoc.BendPoint, len(doc.Runs))
	for _, run := range doc.Runs {
		if run.Kind == "jumper" {
			continue
		}
		bendsByRun[run.ID] = designdoc.EffectiveBends(run, projectDiameterMM)
	}

	// StripsOnly skips the main tile pages entirely — the operator only
	// wants the metal-strip pages, post-fabrication. The strip pages
	// themselves are still emitted below by the unchanged emit calls.
	if !opts.StripsOnly {
		for r := 0; r < rows; r++ {
			for c := 0; c < cols; c++ {
				pdf.AddPage()
				tileX := bbox[0] + float64(c)*stepW
				tileY := bbox[1] + float64(r)*stepH
				toPage := func(x, y float64) (float64, float64) {
					return x - tileX + opts.MarginMM, y - tileY + opts.MarginMM
				}

				pdf.ClipRect(opts.MarginMM, opts.MarginMM, contentW, contentH, false)
				pdf.SetDrawColor(0, 0, 0)
				pdf.SetLineWidth(opts.StrokeMM)

				// Draw the tube geometry: alive segments solid,
				// blockouts dashed, jumpers dashed + labeled.
				// Tier 3 #60 (NW #125) — jumpers are short splice
				// tubes between two primary runs; rendering them
				// dashed (≤2 mm dash, 1 mm gap per spec) keeps them
				// visually distinct from primary runs on the print
				// pattern, and a centered "JUMPER" label at the
				// midpoint tells the bender what they are at a glance.
				for _, run := range doc.Runs {
					isJumper := run.Kind == "jumper"
					for _, seg := range designdoc.RenderableSegments(run) {
						if len(seg.Indices) < 2 {
							continue
						}
						if seg.IsBlockout || isJumper {
							pdf.SetDashPattern([]float64{2, 1}, 0)
						}
						start := run.Polyline.Points[seg.Indices[0]]
						sx, sy := toPage(start[0], start[1])
						pdf.MoveTo(sx, sy)
						for i := 1; i < len(seg.Indices); i++ {
							p := run.Polyline.Points[seg.Indices[i]]
							px, py := toPage(p[0], p[1])
							pdf.LineTo(px, py)
						}
						if seg.Closed {
							pdf.LineTo(sx, sy)
						}
						pdf.DrawPath("D")
						if seg.IsBlockout || isJumper {
							pdf.SetDashPattern([]float64{}, 0)
						}
					}
					if isJumper && len(run.Polyline.Points) >= 2 {
						// Midpoint label "JUMPER" — 6 pt Helvetica,
						// stroke-free, world-mm midpoint of the
						// 2-vertex polyline. Per spec we don't bother
						// orienting along the jumper axis (jumpers are
						// short — the axis-aligned label reads fine).
						p1 := run.Polyline.Points[0]
						p2 := run.Polyline.Points[len(run.Polyline.Points)-1]
						mx, my := toPage((p1[0]+p2[0])/2, (p1[1]+p2[1])/2)
						pdf.SetFont("Helvetica", "", 6)
						label := "JUMPER"
						lw := pdf.GetStringWidth(label)
						// 1 mm vertical offset from the midpoint so
						// the label doesn't sit directly on the dashed
						// line — readable at 1:1.
						pdf.Text(mx-lw/2, my-1, label)
					}
				}

				// Electrodes: small open circle with a centered cross.
				for _, run := range doc.Runs {
					for _, e := range run.Electrodes {
						if e.PointIndex < 0 || e.PointIndex >= len(run.Polyline.Points) {
							continue
						}
						p := run.Polyline.Points[e.PointIndex]
						ex, ey := toPage(p[0], p[1])
						drawElectrodeMark(pdf, ex, ey)
					}
				}

				// Numbered bend apex labels (and a small dot at the apex).
				pdf.SetFont("Helvetica", "B", 7)
				for _, run := range doc.Runs {
					for i, b := range bendsByRun[run.ID] {
						bx, by := toPage(b.X, b.Y)
						pdf.SetLineWidth(0.2)
						pdf.Circle(bx, by, 1.6, "D")
						pdf.SetLineWidth(opts.StrokeMM)
						label := fmt.Sprintf("%s.%d", shortRunID(run.ID), i+1)
						pdf.Text(bx+2, by-1, label)
					}
				}

				// Doc-level dimensions: line + perpendicular ticks + measured label.
				pdf.SetLineWidth(0.3)
				for _, d := range doc.Dimensions {
					ax, ay := toPage(d.X1, d.Y1)
					bx, by := toPage(d.X2, d.Y2)
					pdf.Line(ax, ay, bx, by)
					dx := bx - ax
					dy := by - ay
					length := math.Hypot(dx, dy)
					if length > 0 {
						px := -dy / length * 1.5
						py := dx / length * 1.5
						pdf.Line(ax-px, ay-py, ax+px, ay+py)
						pdf.Line(bx-px, by-py, bx+px, by+py)
					}
					measured := math.Hypot(d.X2-d.X1, d.Y2-d.Y1)
					note := fmt.Sprintf("%.1fmm", measured)
					if d.Note != "" {
						note += " · " + d.Note
					}
					pdf.SetFont("Helvetica", "", 8)
					pdf.Text((ax+bx)/2+1, (ay+by)/2-1, note)
				}
				pdf.SetLineWidth(opts.StrokeMM)

				// Doc-level text labels: small dot + text to the right.
				pdf.SetFont("Helvetica", "", 9)
				for _, l := range doc.Labels {
					lx, ly := toPage(l.X, l.Y)
					pdf.SetLineWidth(0.3)
					pdf.Circle(lx, ly, 0.7, "F")
					pdf.SetLineWidth(opts.StrokeMM)
					pdf.Text(lx+2, ly-1, l.Text)
				}

				pdf.ClipEnd()
				drawTileOverlay(pdf, opts, pageW, pageH, contentW, contentH, c, r, cols, rows)
			}
		}
	} // end if !opts.StripsOnly — main pattern + tile overlays skipped when stripping.

	// Channel-letter return-strip pages (NW #106): one extra page per
	// face-marked run, sandwiched between the tile pages and the
	// bend-list summary so the operator can flip from face-pattern to
	// return-strip in printed order. Depth falls back to the shop
	// default when the project's column is NULL — the renderer always
	// has *some* value to draw with.
	//
	// Tier 3 #26 polish:
	//   - Per-run ChannelLetterDepthMM overrides the project default
	//     for that run (lets one project mix tall and shallow returns).
	//   - Runs sharing a non-empty RacewayID are emitted as ONE
	//     combined raceway strip in declaration order (Strattman
	//     raceway construction); ungrouped face runs continue to get
	//     one strip page each. Raceway pages render *after* the
	//     per-run pages so the operator's stack is "individual letters
	//     first, then any shared raceway".
	projectDepth := opts.ChannelLetterDepthMM
	if projectDepth <= 0 {
		projectDepth = 100
	}
	groups := groupByRaceway(doc.Runs)
	for _, run := range doc.Runs {
		if !run.IsChannelLetterFace {
			continue
		}
		if len(run.Polyline.Points) < 2 {
			continue
		}
		if run.RacewayID != "" {
			// Handled by the raceway emitter below.
			continue
		}
		emitReturnStrip(pdf, opts, run, runDepthMM(run, projectDepth))
	}
	for _, gid := range groups.OrderedIDs {
		runs := groups.ByID[gid]
		if len(runs) == 0 {
			continue
		}
		emitRacewayStrip(pdf, opts, gid, runs, projectDepth)
	}

	// Bend-list summary page (only if any bends were detected). The
	// bend list is about the main runs, not the metal strips — when
	// StripsOnly is on we skip it (the operator already has the bend
	// list from the original print run).
	if !opts.StripsOnly {
		totalBends := 0
		for _, bs := range bendsByRun {
			totalBends += len(bs)
		}
		if totalBends > 0 {
			drawBendListPage(pdf, opts, doc, bendsByRun)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("write pdf: %w", err)
	}
	return buf.Bytes(), nil
}

func docBBox(doc *designdoc.Doc) [4]float64 {
	if doc.ViewBoxMM[2] > 0 && doc.ViewBoxMM[3] > 0 {
		return [4]float64{
			doc.ViewBoxMM[0],
			doc.ViewBoxMM[1],
			doc.ViewBoxMM[0] + doc.ViewBoxMM[2],
			doc.ViewBoxMM[1] + doc.ViewBoxMM[3],
		}
	}
	bb := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, run := range doc.Runs {
		for _, p := range run.Polyline.Points {
			if p[0] < bb[0] {
				bb[0] = p[0]
			}
			if p[1] < bb[1] {
				bb[1] = p[1]
			}
			if p[0] > bb[2] {
				bb[2] = p[0]
			}
			if p[1] > bb[3] {
				bb[3] = p[1]
			}
		}
	}
	if math.IsInf(bb[0], 1) {
		return [4]float64{0, 0, 0, 0}
	}
	return bb
}

// drawElectrodeMark draws a small unfilled circle with a centered "+" so the
// bender can locate the tube end. ~3mm diameter — visible at 1:1 without
// crowding the tube line.
func drawElectrodeMark(pdf *gofpdf.Fpdf, x, y float64) {
	pdf.SetLineWidth(0.4)
	pdf.Circle(x, y, 1.5, "D")
	pdf.Line(x-1.2, y, x+1.2, y)
	pdf.Line(x, y-1.2, x, y+1.2)
}

// shortRunID strips the "run-" prefix to keep on-page bend labels compact
// (e.g. "1.3" instead of "run-1.3").
func shortRunID(id string) string {
	const prefix = "run-"
	if len(id) > len(prefix) && id[:len(prefix)] == prefix {
		return id[len(prefix):]
	}
	return id
}

// drawBendListPage emits a final page listing each run's bends in order
// with arc-length offset and turn angle, plus electrode count, total tube
// length, and any per-run color/diameter overrides.
func drawBendListPage(pdf *gofpdf.Fpdf, opts Options, doc *designdoc.Doc, bendsByRun map[string][]designdoc.BendPoint) {
	pdf.AddPage()
	mx := opts.MarginMM
	pdf.SetFont("Helvetica", "B", 14)
	pdf.Text(mx, mx+8, "Bend list")
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(mx, mx+14, fmt.Sprintf("%s — %s", opts.ProjectName, opts.DesignVersionLabel))

	y := mx + 22
	pdf.SetFont("Helvetica", "B", 10)
	for _, run := range doc.Runs {
		// Tier 3 #60 — jumpers are 2-vertex splice tubes; the bend
		// list is about primary runs and would emit "(no bends auto-
		// detected)" rows that just clutter the summary. Skip them
		// entirely.
		if run.Kind == "jumper" {
			continue
		}
		bends := bendsByRun[run.ID]
		title := fmt.Sprintf("%s · %d pts · %d electrode%s · %d bend%s",
			run.ID,
			len(run.Polyline.Points),
			len(run.Electrodes), pluralize(len(run.Electrodes)),
			len(bends), pluralize(len(bends)),
		)
		if run.TubeDiameterMM > 0 {
			title += fmt.Sprintf(" · ø%.1fmm", run.TubeDiameterMM)
		}
		if run.Color != "" {
			title += " · " + run.Color
		}
		pdf.SetFont("Helvetica", "B", 10)
		pdf.Text(mx, y, title)
		y += 5
		pdf.SetFont("Helvetica", "", 9)
		if note := strings.TrimSpace(run.Notes); note != "" {
			pdf.SetFont("Helvetica", "I", 9)
			for _, ln := range strings.Split(note, "\n") {
				pdf.Text(mx+4, y, "    "+ln)
				y += 4
			}
			pdf.SetFont("Helvetica", "", 9)
			y += 1
		}
		if len(bends) == 0 {
			pdf.Text(mx+4, y, "  (no bends auto-detected; smooth curves below 20°)")
			y += 6
		} else {
			for i, b := range bends {
				radius := "-"
				if !math.IsInf(b.RadiusMM, 0) && !math.IsNaN(b.RadiusMM) && b.RadiusMM > 0 {
					radius = fmt.Sprintf("%.1fmm", b.RadiusMM)
				}
				line := fmt.Sprintf("  %s.%d   arc %6.1fmm   turn %3.0f°   r %s",
					shortRunID(run.ID), i+1, b.ArcLengthMM, b.AngleDeg, radius)
				pdf.Text(mx+4, y, line)
				y += 5
			}
			y += 2
		}
		// Tier 3 #62 — per-run "Housings" subsection. Lists every
		// electrode that has a configured housing (HousingType != "")
		// with its bore diameter and mounting elevation. Skipped when
		// no electrode has a housing set, so designs that haven't been
		// tagged with housings yet keep the bend list compact.
		if housings := housingsForRun(run); len(housings) > 0 {
			pdf.SetFont("Helvetica", "B", 9)
			pdf.Text(mx+4, y, "Housings:")
			y += 5
			pdf.SetFont("Helvetica", "", 9)
			for _, h := range housings {
				pdf.Text(mx+4, y, "  "+h)
				y += 5
			}
			y += 2
		}
		// Page break: leave some margin from the footer area.
		if y > opts.Paper.HeightMM-mx-15 {
			pdf.AddPage()
			y = mx + 8
		}
	}
}

// housingsForRun returns one display string per electrode that has a
// configured housing on this run, in electrode order ("E1: ...",
// "E2: ..."). Electrodes with HousingType == "" are skipped, so the
// caller can short-circuit the whole "Housings" section when the
// returned slice is empty. Stock-shell labels mirror the frontend
// HOUSING_LIBRARY (Strattman NT Ch.3 Table 3.4); the bore is read from
// the library when stock and from the doc when custom — same
// authoritative-source split docOps.setElectrodeHousing enforces.
func housingsForRun(run designdoc.Run) []string {
	var out []string
	for i, e := range run.Electrodes {
		if e.HousingType == "" {
			continue
		}
		label, bore := housingDimsForType(e.HousingType, e.BoreDiameterMM)
		line := fmt.Sprintf("E%d - %s (bore %.1f mm", i+1, label, bore)
		if e.ElevationMM > 0 {
			line += fmt.Sprintf(", elev %.1f mm", e.ElevationMM)
		}
		line += ")"
		out = append(out, line)
	}
	return out
}

// housingDimsForType resolves a (HousingType, BoreDiameterMM) pair to
// the printed label + bore. Stock shells override the doc-supplied bore
// (the library is authoritative); custom uses the doc value. Mirrors
// web/src/lib/housingLibrary.ts; if a third stock shell is added there
// it should be added here too. Mismatches are picked up by the round-
// trip integration test rather than by a code-level guard, so the two
// tables can drift if a future task forgets to update both — keep them
// in sync.
func housingDimsForType(housingType string, customBoreMM float64) (label string, boreMM float64) {
	switch housingType {
	case "shell-15":
		return "15-shell (3/8\" x 1-5/16\")", 9.5
	case "shell-19":
		return "19-shell (1/2\" x 1-5/8\")", 12.7
	case "custom":
		return "Custom", customBoreMM
	default:
		return housingType, customBoreMM
	}
}

func pluralize(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// drawTileOverlay adds registration crosses at the four printable-area
// corners, a scale bar, and a footer that identifies the tile/project.
func drawTileOverlay(pdf *gofpdf.Fpdf, opts Options, pageW, pageH, contentW, contentH float64, col, row, cols, rows int) {
	mx := opts.MarginMM
	my := opts.MarginMM

	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.2)

	// Registration crosses at corners (just inside the content area).
	const crossArm = 5.0
	corners := []struct{ x, y float64 }{
		{mx, my},
		{mx + contentW, my},
		{mx, my + contentH},
		{mx + contentW, my + contentH},
	}
	for _, p := range corners {
		pdf.Line(p.x-crossArm, p.y, p.x+crossArm, p.y)
		pdf.Line(p.x, p.y-crossArm, p.x, p.y+crossArm)
	}

	// 100mm scale bar bottom-left of the content area.
	scaleStart := mx
	scaleY := pageH - my/2 - 4
	scaleLen := 100.0
	pdf.SetLineWidth(0.5)
	pdf.Line(scaleStart, scaleY, scaleStart+scaleLen, scaleY)
	for i := 0; i <= 10; i++ {
		x := scaleStart + float64(i)*10
		pdf.Line(x, scaleY-1.5, x, scaleY+1.5)
	}
	pdf.SetFont("Helvetica", "", 8)
	pdf.Text(scaleStart, scaleY-2, "0")
	pdf.Text(scaleStart+50-3, scaleY-2, "50mm")
	pdf.Text(scaleStart+100-7, scaleY-2, "100mm")
	pdf.Text(scaleStart+105, scaleY+1, "(verify scale: should measure 100mm)")

	// Footer right side: project / version / tube spec / tile coordinates.
	footerY := pageH - my/2 - 4
	footerText := fmt.Sprintf("NeonBench  •  %s", opts.ProjectName)
	if opts.DesignVersionLabel != "" {
		footerText += "  •  " + opts.DesignVersionLabel
	}
	if opts.TubeSpecName != "" {
		footerText += "  •  " + opts.TubeSpecName
	}
	if opts.TubeEndGapMM > 0 {
		// Tube end gap (NW #135) — distance from tube end to channel
		// letter / substrate edge. Informational footer only in V1.
		footerText += fmt.Sprintf("  •  End gap %.2fmm", opts.TubeEndGapMM)
	}
	footerText += fmt.Sprintf("  •  Tile %d,%d of %d×%d  •  %s", col+1, row+1, cols, rows, time.Now().UTC().Format("2006-01-02"))
	pdf.SetFont("Helvetica", "", 7)
	tw := pdf.GetStringWidth(footerText)
	pdf.Text(pageW-mx-tw, footerY+1, footerText)
}
