package printpdf

import (
	"fmt"
	"math"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// returnStripBendMark describes a single bend tick along the unfolded
// return strip. For a closed face polyline, every vertex of the
// polyline contributes a tick. For an open polyline, only the
// "interior" vertices (everything except index 0 and len-1) contribute
// — the first and last vertices are the strip's left and right edges
// where the operator starts and stops.
type returnStripBendMark struct {
	// VertexIndex is the original polyline vertex this tick corresponds
	// to. Useful for cross-referencing in tests / future debugging.
	VertexIndex int
	// ArcLengthMM is the cumulative perimeter from the start vertex up
	// to (and including) this vertex. The strip's left edge is at 0
	// and the right edge is at the total perimeter.
	ArcLengthMM float64
	// AngleDeg is the signed interior turn angle at this vertex in
	// degrees. Positive means the strip bends "inward" (toward the
	// face's interior — the typical bend direction). Negative means
	// the corner is concave on the silhouette and the bend goes the
	// other way (think the inside corners of an "M").
	AngleDeg float64
}

// polylinePerimeterMM returns the total walk distance along the
// polyline. For closed polylines we also count the implicit closing
// edge from the last point back to the first.
//
// The function is a small standalone helper so it can be unit-tested
// in isolation (TestPerimeter) before being wired into PDF emission.
func polylinePerimeterMM(points [][2]float64, closed bool) float64 {
	if len(points) < 2 {
		return 0
	}
	total := 0.0
	for i := 0; i < len(points)-1; i++ {
		total += distMM(points[i], points[i+1])
	}
	if closed {
		total += distMM(points[len(points)-1], points[0])
	}
	return total
}

// distMM is the Euclidean distance between two mm-space points.
func distMM(a, b [2]float64) float64 {
	dx := b[0] - a[0]
	dy := b[1] - a[1]
	return math.Hypot(dx, dy)
}

// returnStripBendMarks walks the polyline and produces the list of
// bend ticks for the unfolded return strip.
//
// Closed polylines: every vertex is a bend, including the start
// vertex (whose incoming edge is the closing edge from points[n-1]
// back to points[0]). Mark count = len(points).
//
// Open polylines: bends occur only at the interior vertices (indices
// 1..n-2). The endpoints are the strip's left and right edges, not
// fold lines, so they do not get a tick. Mark count = len(points) - 2
// (or 0 if len < 3).
//
// Sign convention for AngleDeg: positive = the strip bends inward
// (toward the face's interior, the typical direction for a return
// box). Negative = concave corner on the silhouette, so the bend
// goes outward. The convention assumes the face polyline is wound
// in the "natural" direction the operator traces it; a face polyline
// wound the opposite direction will simply produce signs reversed
// from what they'd see, which the operator can interpret either way.
// Takes the polyline, not just its points, so an arc segment contributes its
// true length and its endpoint TANGENTS (Tier 3 #78). Flattening instead would
// have been simpler and wrong twice over: one arc would become ~22 vertices,
// so the strip would print two dozen 5° bend marks where the bender makes one
// smooth curve, and each mark would sit at the wrong distance.
func returnStripBendMarks(pl *designdoc.Polyline, closed bool) []returnStripBendMark {
	points := pl.Points
	if len(points) < 2 {
		return nil
	}

	// Pre-compute cumulative arc length at every vertex, walking
	// from points[0] in order. cum[i] = perimeter from points[0] to
	// points[i] along the polyline.
	cum := make([]float64, len(points))
	for i := 1; i < len(points); i++ {
		cum[i] = cum[i-1] + pl.WalkSegmentLengthMM(i-1, i)
	}

	var marks []returnStripBendMark
	if closed {
		for i := 0; i < len(points); i++ {
			prev := (i - 1 + len(points)) % len(points)
			next := (i + 1) % len(points)
			marks = append(marks, returnStripBendMark{
				VertexIndex: i,
				ArcLengthMM: cum[i],
				AngleDeg:    pl.VertexTurnDeg(prev, i, next),
			})
		}
		return marks
	}
	// Open polyline: interior vertices only.
	for i := 1; i < len(points)-1; i++ {
		marks = append(marks, returnStripBendMark{
			VertexIndex: i,
			ArcLengthMM: cum[i],
			AngleDeg:    pl.VertexTurnDeg(i-1, i, i+1),
		})
	}
	return marks
}

// emitReturnStrip draws an unfolded return-strip page for one
// channel-letter face run. Layout:
//
//   - Header: "Return strip — Run {id}" + cap height + perimeter
//   - The strip itself: a rectangle of width=perimeter mm × height=depth mm,
//     fitted into the page's content area (1:1 if it fits, otherwise
//     scaled uniformly with a "scale 1:N" callout).
//   - At every bend mark, a vertical tick from one long edge to the
//     other, labelled with the cumulative arc length and the signed
//     interior turn angle.
//   - Footer: operator note about the bends, total length, and a
//     warning if the polyline is open.
//
// The actual mm value is always printed next to each tick regardless
// of any uniform scale factor — operators measure with rulers
// against the printed labels, not the scaled drawing.
func emitReturnStrip(pdf *gofpdf.Fpdf, opts Options, run designdoc.Run, depthMM float64) {
	pdf.AddPage()

	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	mx := opts.MarginMM
	contentW := pageW - 2*mx
	contentH := pageH - 2*mx

	closed := run.Polyline.Closed
	// Arc-aware: the perimeter is the glass length, and the bbox has to see
	// the flattened curve because an arc bulges outside its endpoints' hull.
	perimeter := run.Polyline.LengthMM()
	marks := returnStripBendMarks(&run.Polyline, closed)

	// Cap height = bbox height of the polyline. Useful sanity-check
	// for the operator (matches the lettering size on the front face).
	bb := pointsBBox(run.Polyline.FlatPoints())
	capHeight := bb[3] - bb[1]

	// Header text.
	pdf.SetFont("Helvetica", "B", 14)
	pdf.Text(mx, mx+8, fmt.Sprintf("Return strip — Run %s", run.ID))
	pdf.SetFont("Helvetica", "", 10)
	subhdr := fmt.Sprintf("%s — %s", opts.ProjectName, opts.DesignVersionLabel)
	if subhdr != " — " {
		pdf.Text(mx, mx+14, subhdr)
	}
	pdf.SetFont("Helvetica", "", 9)
	stats := fmt.Sprintf("Cap height %.1f mm  ·  Perimeter %.1f mm  ·  Depth %.1f mm  ·  %d bend mark%s",
		capHeight, perimeter, depthMM, len(marks), pluralize(len(marks)))
	pdf.Text(mx, mx+20, stats)

	// Compute the scale that fits a perimeter × depth strip into the
	// available content area below the header. We reserve ~30 mm for
	// the header and ~20 mm for tick labels above + footer below.
	const headerHeightMM = 30
	const tickLabelMM = 8 // space above the strip for arc/angle labels
	const footerMM = 18   // space below for operator notes
	stripAreaW := contentW
	stripAreaH := contentH - headerHeightMM - tickLabelMM - footerMM
	if stripAreaH < depthMM {
		stripAreaH = depthMM
	}
	scale := 1.0
	if perimeter > stripAreaW {
		scale = stripAreaW / perimeter
	}
	if depthMM*scale > stripAreaH {
		scale = stripAreaH / depthMM
	}

	stripWidthOnPage := perimeter * scale
	stripHeightOnPage := depthMM * scale
	stripX := mx
	stripY := mx + headerHeightMM + tickLabelMM

	if scale < 1 {
		pdf.SetFont("Helvetica", "I", 9)
		pdf.Text(mx, mx+25, fmt.Sprintf("Drawing scale 1:%.0f — labels show actual mm values", 1/scale))
		pdf.SetFont("Helvetica", "", 9)
	}

	// Strip rectangle.
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(opts.StrokeMM)
	pdf.Rect(stripX, stripY, stripWidthOnPage, stripHeightOnPage, "D")

	// Bend ticks. Each tick is a full vertical line across the strip.
	pdf.SetFont("Helvetica", "", 7)
	pdf.SetLineWidth(0.3)
	for _, m := range marks {
		x := stripX + m.ArcLengthMM*scale
		// Skip ticks at exactly the strip's left edge — that's the
		// start vertex on a closed polyline (arc length 0) and the
		// edge of the strip is its own visual tick.
		if m.ArcLengthMM <= 0.001 {
			pdf.SetFont("Helvetica", "B", 7)
			pdf.Text(x+0.5, stripY-2, fmt.Sprintf("0.0 mm | %+.0f°", m.AngleDeg))
			pdf.SetFont("Helvetica", "", 7)
			continue
		}
		pdf.Line(x, stripY, x, stripY+stripHeightOnPage)
		label := fmt.Sprintf("%.1f mm | %+.0f°", m.ArcLengthMM, m.AngleDeg)
		// Center the label horizontally on the tick.
		tw := pdf.GetStringWidth(label)
		pdf.Text(x-tw/2, stripY-2, label)
	}
	pdf.SetLineWidth(opts.StrokeMM)

	// Strip-overlap shear line (Tier 3 #26): a configurable per-project
	// allowance the fabricator leaves at the right end so the seam can
	// be doubled-back welded or pop-riveted. Drawn as a dashed vertical
	// line `overlapMM` from the right edge with a "shear here" label.
	// We pick the right end (not left or both) by trade convention —
	// the operator works left to right unrolling the strip; the seam
	// at the right end gets the doubled metal. The footer carries the
	// active value too so the printed pattern is self-describing.
	overlapMM := opts.StripOverlapMM
	if overlapMM <= 0 {
		overlapMM = 12.7
	}
	if overlapMM*scale < stripWidthOnPage {
		shearX := stripX + stripWidthOnPage - overlapMM*scale
		pdf.SetDashPattern([]float64{2, 2}, 0)
		pdf.SetLineWidth(0.45)
		pdf.Line(shearX, stripY-2, shearX, stripY+stripHeightOnPage+2)
		pdf.SetDashPattern([]float64{}, 0)
		pdf.SetLineWidth(opts.StrokeMM)
		pdf.SetFont("Helvetica", "I", 7)
		shearLabel := fmt.Sprintf("shear here · %.1f mm overlap", overlapMM)
		pdf.Text(shearX+1, stripY+stripHeightOnPage-2, shearLabel)
	}

	// Footer.
	footerY := stripY + stripHeightOnPage + 6
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(stripX, footerY,
		fmt.Sprintf("Bend at each tick. Total length: %.1f mm. Shear at the dashed line for %.1f mm overlap.",
			perimeter, overlapMM))
	if !closed {
		pdf.SetFont("Helvetica", "B", 9)
		pdf.SetTextColor(160, 0, 0)
		pdf.Text(stripX, footerY+5,
			"Note: face polyline is open — return strip will not close. Verify intent.")
		pdf.SetTextColor(0, 0, 0)
		pdf.SetFont("Helvetica", "", 9)
	}
}

// pointsBBox returns [minX, minY, maxX, maxY] for a polyline.
// Returns the zero box if the slice is empty.
func pointsBBox(points [][2]float64) [4]float64 {
	if len(points) == 0 {
		return [4]float64{}
	}
	bb := [4]float64{points[0][0], points[0][1], points[0][0], points[0][1]}
	for _, p := range points[1:] {
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
	return bb
}
