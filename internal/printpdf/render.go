package printpdf

import (
	"bytes"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/validate"
)

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
	bendsByRun := make(map[string][]designdoc.BendPoint, len(doc.Runs))
	for _, run := range doc.Runs {
		bendsByRun[run.ID] = designdoc.EffectiveBends(run, projectDiameterMM)
	}

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

			// Draw the tube geometry: alive segments solid, blockouts dashed.
			for _, run := range doc.Runs {
				for _, seg := range designdoc.RenderableSegments(run) {
					if len(seg.Indices) < 2 {
						continue
					}
					if seg.IsBlockout {
						pdf.SetDashPattern([]float64{2, 1.2}, 0)
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
					if seg.IsBlockout {
						pdf.SetDashPattern([]float64{}, 0)
					}
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

	// Bend-list summary page (only if any bends were detected).
	totalBends := 0
	for _, bs := range bendsByRun {
		totalBends += len(bs)
	}
	if totalBends > 0 {
		drawBendListPage(pdf, opts, doc, bendsByRun)
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
		// Page break: leave some margin from the footer area.
		if y > opts.Paper.HeightMM-mx-15 {
			pdf.AddPage()
			y = mx + 8
		}
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
	footerText += fmt.Sprintf("  •  Tile %d,%d of %d×%d  •  %s", col+1, row+1, cols, rows, time.Now().UTC().Format("2006-01-02"))
	pdf.SetFont("Helvetica", "", 7)
	tw := pdf.GetStringWidth(footerText)
	pdf.Text(pageW-mx-tw, footerY+1, footerText)
}
