package printpdf

import (
	"bytes"
	"fmt"
	"math"
	"time"

	"github.com/phpdave11/gofpdf"
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
