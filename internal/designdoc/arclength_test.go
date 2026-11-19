package designdoc

import (
	"math"
	"testing"
)

// Tier 3 #178 — one measure of arc length on both sides: r*theta.
//
// These constants are shared, digit for digit, with web/src/lib/
// arcLengthSplit.test.ts and the runLengthMM block in docOps.test.ts. The
// editor's runLengthMM (what the auto-split and the overlong badge use) and
// LengthMM here (what the takeoff, the PDF and the DXF use) must both land on
// them, so a change to either side that drifts from the other fails one suite.
const (
	rThetaOpenArc100MM        = 115.91190225020152 // 250*atan(0.5)
	rThetaClosedSquare3ArcsMM = 447.73570675060455 // 3 arcs + one 100mm line
	rThetaOpenArc900MM        = 1043.2071202518136 // 2250*atan(0.5)
)

func flatChordSumMM(p *Polyline) float64 {
	pts := p.FlatPoints()
	total := 0.0
	for i := 1; i < len(pts); i++ {
		total += math.Hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
	}
	return total
}

func TestLengthMMSharedRThetaFixtures(t *testing.T) {
	cases := []struct {
		name string
		pl   Polyline
		want float64
	}{
		{"open arc, 100mm chord", Polyline{
			Points: [][2]float64{{0, 0}, {100, 0}}, SegmentTypes: []string{SegmentArc},
		}, rThetaOpenArc100MM},
		{"flipped arc, 100mm chord", Polyline{
			Points: [][2]float64{{0, 0}, {100, 0}}, SegmentTypes: []string{SegmentArcR},
		}, rThetaOpenArc100MM},
		{"closed square, three arcs", Polyline{
			Points:       [][2]float64{{0, 0}, {100, 0}, {100, 100}, {0, 100}},
			Closed:       true,
			SegmentTypes: []string{SegmentArc, SegmentArc, SegmentArc, SegmentLine},
		}, rThetaClosedSquare3ArcsMM},
		{"open arc, 900mm chord", Polyline{
			Points: [][2]float64{{0, 0}, {900, 0}}, SegmentTypes: []string{SegmentArc},
		}, rThetaOpenArc900MM},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.pl.LengthMM(); math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("LengthMM = %.12f, want %.12f", got, tc.want)
			}
			// Negative control: the 5° flattening, which the editor summed
			// before #178, is measurably short of the fixture, so a revert to
			// it on either side fails rather than hiding in a loose tolerance.
			if gap := tc.want - flatChordSumMM(&tc.pl); gap < 0.03 {
				t.Errorf("5° flattening is only %.6fmm short of r*theta; the fixture cannot tell them apart", gap)
			}
		})
	}
}
