package printpdf

import (
	"fmt"
	"sort"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// racewayMember is one run mounted on the raceway, reduced to where it sits
// along the box.
type racewayMember struct {
	ID     string
	MinXMM float64
	MaxXMM float64
}

// racewayMembers returns the runs mounted on this raceway, left to right.
//
// Channel-letter FACE runs are preferred when the design has any, because
// those are the letters the installer positions. Falling back to every tagged
// run matters for a design built with "Split tubes at raceway" and no face
// outlines: there the tube pieces themselves are what the box has to reach.
// Marking both would double up — after a split, each letter's face and its
// glass carry the same id.
//
// Extents are ARC-AWARE (FlatPoints): a bow taken from raw vertices clips the
// curve, and the mark would land inside the letter it is supposed to bound.
func racewayMembers(doc *designdoc.Doc, racewayID string) []racewayMember {
	var faces, all []racewayMember
	for i := range doc.Runs {
		run := &doc.Runs[i]
		if run.RacewayID != racewayID {
			continue
		}
		pts := run.Polyline.FlatPoints()
		if len(pts) == 0 {
			continue
		}
		m := racewayMember{ID: run.ID, MinXMM: pts[0][0], MaxXMM: pts[0][0]}
		for _, p := range pts {
			if p[0] < m.MinXMM {
				m.MinXMM = p[0]
			}
			if p[0] > m.MaxXMM {
				m.MaxXMM = p[0]
			}
		}
		all = append(all, m)
		if run.IsChannelLetterFace {
			faces = append(faces, m)
		}
	}
	out := all
	if len(faces) > 0 {
		out = faces
	}
	sort.Slice(out, func(i, j int) bool { return out[i].MinXMM < out[j].MinXMM })
	return out
}

// emitRacewayPage draws the dimensioned plan view of one raceway box
// (Tier 2 #104 / NW #133).
//
// This is what the fabricator cuts the extrusion to and what the installer
// positions the letters along — the same role emitReturnStrip already plays
// for the letter walls, for the one component of the assembly that was
// previously absent from every printed artifact.
//
// On the page:
//   - the box itself, drawn to scale, with overall length and height called
//     out and the depth stated (a plan view cannot show depth)
//   - each member letter's span ticked along the box with its run id, so the
//     letters can be laid out on the raceway in the shop rather than levelled
//     on a lift
//   - a butt-splice line every RacewaySpliceMM, because sections ship at
//     10 ft or shorter
//
// A raceway with no length is skipped rather than drawn as a line: an
// un-fitted box is a box nobody has sized yet, and a page showing 0 mm would
// look like a measurement.
func emitRacewayPage(pdf *gofpdf.Fpdf, opts Options, rw designdoc.Raceway, doc *designdoc.Doc) {
	if rw.LengthMM <= 0 {
		return
	}
	pdf.AddPage()

	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	mx := opts.MarginMM
	contentW := pageW - 2*mx
	contentH := pageH - 2*mx

	heightMM := rw.EffectiveHeightMM()
	depthMM := rw.EffectiveDepthMM()
	members := racewayMembers(doc, rw.ID)

	// Header.
	pdf.SetFont("Helvetica", "B", 14)
	pdf.Text(mx, mx+8, fmt.Sprintf("Raceway — %s", rw.ID))
	pdf.SetFont("Helvetica", "", 10)
	subhdr := fmt.Sprintf("%s — %s", opts.ProjectName, opts.DesignVersionLabel)
	if subhdr != " — " {
		pdf.Text(mx, mx+14, subhdr)
	}
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(mx, mx+20, fmt.Sprintf(
		"Length %.1f mm  ·  Height %.1f mm  ·  Depth %.1f mm  ·  %d letter%s  ·  x %.1f…%.1f mm",
		rw.LengthMM, heightMM, depthMM, len(members), pluralize(len(members)),
		rw.XMM, rw.XMM+rw.LengthMM))

	const headerHeightMM = 34
	// Two lanes' worth of headroom: member spans alternate between them so
	// that two letters at the same X — which is exactly what a raceway split
	// leaves behind, one piece above the line and one below — do not print
	// their labels on top of each other.
	const memberLabelMM = 16
	const memberLaneMM = 6
	const footerMM = 26
	boxAreaW := contentW
	boxAreaH := contentH - headerHeightMM - memberLabelMM - footerMM
	if boxAreaH < 10 {
		boxAreaH = 10
	}
	scale := 1.0
	if rw.LengthMM > boxAreaW {
		scale = boxAreaW / rw.LengthMM
	}
	if heightMM*scale > boxAreaH {
		scale = boxAreaH / heightMM
	}

	boxW := rw.LengthMM * scale
	boxH := heightMM * scale
	boxX := mx
	boxY := mx + headerHeightMM + memberLabelMM

	if scale < 1 {
		pdf.SetFont("Helvetica", "I", 9)
		pdf.Text(mx, mx+26, fmt.Sprintf("Drawing scale 1:%.0f — labels show actual mm values", 1/scale))
		pdf.SetFont("Helvetica", "", 9)
	}

	// The box.
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(opts.StrokeMM)
	pdf.Rect(boxX, boxY, boxW, boxH, "D")

	// Member letters: a span bar above the box plus its id. The bar is the
	// letter's own X extent, so an operator can measure from the raceway end
	// to the first letter without re-deriving anything.
	pdf.SetFont("Helvetica", "", 7)
	pdf.SetLineWidth(0.3)
	for i, m := range members {
		x0 := boxX + (m.MinXMM-rw.XMM)*scale
		x1 := boxX + (m.MaxXMM-rw.XMM)*scale
		y := boxY - 4 - float64(i%2)*memberLaneMM
		pdf.Line(x0, y, x1, y)
		pdf.Line(x0, y, x0, boxY)
		pdf.Line(x1, y, x1, boxY)
		label := fmt.Sprintf("%s  %.0f mm", m.ID, m.MinXMM-rw.XMM)
		tw := pdf.GetStringWidth(label)
		mid := (x0 + x1) / 2
		pdf.Text(mid-tw/2, y-2.5, label)
	}

	// Butt-splice lines. Sections ship at RacewaySpliceMM or shorter, so a
	// long box arrives in pieces and the seams belong on the drawing rather
	// than in a note the shop has to act on from memory.
	splices := rw.SpliceCount()
	pdf.SetFont("Helvetica", "I", 7)
	pdf.SetDashPattern([]float64{2, 2}, 0)
	pdf.SetLineWidth(0.45)
	for i := 1; i <= splices; i++ {
		atMM := float64(i) * designdoc.RacewaySpliceMM
		if atMM >= rw.LengthMM {
			break
		}
		x := boxX + atMM*scale
		pdf.Line(x, boxY-1, x, boxY+boxH+1)
		label := fmt.Sprintf("splice %.0f mm", atMM)
		tw := pdf.GetStringWidth(label)
		pdf.Text(x-tw/2, boxY+boxH+4, label)
	}
	pdf.SetDashPattern([]float64{}, 0)
	pdf.SetLineWidth(opts.StrokeMM)

	// Overall length dimension under the box.
	dimY := boxY + boxH + 10
	pdf.SetFont("Helvetica", "", 8)
	pdf.SetLineWidth(0.3)
	pdf.Line(boxX, dimY, boxX+boxW, dimY)
	pdf.Line(boxX, dimY-2, boxX, dimY+2)
	pdf.Line(boxX+boxW, dimY-2, boxX+boxW, dimY+2)
	lenLabel := fmt.Sprintf("%.1f mm overall", rw.LengthMM)
	tw := pdf.GetStringWidth(lenLabel)
	pdf.Text(boxX+boxW/2-tw/2, dimY-1, lenLabel)

	// Height dimension to the right of the box.
	hx := boxX + boxW + 4
	if hx < pageW-mx-2 {
		pdf.Line(hx, boxY, hx, boxY+boxH)
		pdf.Line(hx-2, boxY, hx+2, boxY)
		pdf.Line(hx-2, boxY+boxH, hx+2, boxY+boxH)
		pdf.Text(hx+1, boxY+boxH/2, fmt.Sprintf("%.1f mm", heightMM))
	}
	pdf.SetLineWidth(opts.StrokeMM)

	// Footer: the numbers that do not fit on a plan view, and the provenance
	// warning. The operator should know these defaults are commercial
	// practice from supplier pages rather than a trade-textbook rule.
	footerY := dimY + 8
	pdf.SetFont("Helvetica", "", 8)
	pdf.Text(boxX, footerY, fmt.Sprintf(
		"Depth (front to wall): %.1f mm. Sections ship at %.0f mm or shorter — %d butt splice%s.",
		depthMM, designdoc.RacewaySpliceMM, splices, pluralize(splices)))
	footerY += 4.5
	pdf.SetFont("Helvetica", "I", 7)
	pdf.Text(boxX, footerY,
		"Defaults are 8 in x 8 in, the neon-era standard: a 159 mm transformer cannot sit across a 5 in box.")
	footerY += 4
	pdf.Text(boxX, footerY,
		"Ends are drawn FLUSH with the outermost letters — no source states an overhang. See docs/neon-rules/raceway.md.")
}
