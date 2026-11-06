package printpdf

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/takeoff"
)

// Tier 3 #178 — the return-strip page prints a face's strip length, and the
// takeoff bills return-strip footage for the same face. They used to measure
// it two ways (the page by r*theta, the takeoff by summing the 5° flattening),
// so the bill came up ~0.03% short of what the page told the fabricator to
// cut. Both now measure r*theta; this pins them to each other.
func TestReturnStripFootageMatchesPrintedPerimeter(t *testing.T) {
	faces := []designdoc.Run{
		{ID: "arcs", IsChannelLetterFace: true, Polyline: designdoc.Polyline{
			Points:       [][2]float64{{0, 0}, {300, 0}, {300, 300}, {0, 300}},
			Closed:       true,
			SegmentTypes: []string{designdoc.SegmentArc, designdoc.SegmentArcR, designdoc.SegmentArc, designdoc.SegmentLine},
		}},
		{ID: "open", IsChannelLetterFace: true, Polyline: designdoc.Polyline{
			Points:       [][2]float64{{0, 500}, {600, 500}, {600, 900}},
			SegmentTypes: []string{designdoc.SegmentArc, designdoc.SegmentLine},
		}},
	}
	// A plain run must not contribute strip, or the comparison would pass
	// by coincidence on a doc where every run is a face.
	plain := designdoc.Run{ID: "tube", Polyline: designdoc.Polyline{
		Points: [][2]float64{{0, 1000}, {400, 1000}}, SegmentTypes: []string{designdoc.SegmentArc},
	}}
	doc := &designdoc.Doc{Version: 1, ViewBoxMM: [4]float64{0, 0, 1000, 1200}, Runs: append(faces, plain)}

	printed, flattened := 0.0, 0.0
	for _, f := range faces {
		printed += returnStripPerimeterMM(f)
		flattened += flatSumMM(f.Polyline.FlatPoints(), f.Polyline.Closed)
	}

	tk := takeoff.Compute(doc, takeoff.Spec{DiameterMM: 12}, takeoff.DefaultYield(), takeoff.DefaultLabourModel(), takeoff.Inputs{})
	billed := tk.Summary.ReturnStripFt * takeoff.MMPerFoot

	// ReturnStripFt is rounded to 4 decimal places of a foot, ~0.03mm.
	tol := 0.00005*takeoff.MMPerFoot + 1e-9
	if math.Abs(billed-printed) > tol {
		t.Errorf("takeoff bills %.4fmm of return strip, the page prints %.4fmm", billed, printed)
	}
	// Negative control: the old measure is far enough off that this tolerance
	// would have caught it.
	if math.Abs(billed-flattened) <= 5*tol {
		t.Fatalf("5° flattening %.4f is within %.4f of the bill %.4f; the test cannot tell the measures apart",
			flattened, 5*tol, billed)
	}
}

func flatSumMM(pts [][2]float64, closed bool) float64 {
	total := 0.0
	for i := 1; i < len(pts); i++ {
		total += distMM(pts[i-1], pts[i])
	}
	if closed && len(pts) > 2 {
		total += distMM(pts[len(pts)-1], pts[0])
	}
	return total
}
