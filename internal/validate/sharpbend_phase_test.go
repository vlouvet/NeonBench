package validate

import (
	"fmt"
	"math"
	"strings"
	"testing"
)

// Tier 3 #180: the sharp-bend warning must be phase-invariant. Sliding a
// corner along a run must never change whether it is flagged. The old
// rule measured angles only at the points of a uniform resample anchored
// at the run's start, so a 60° corner on a 12 mm tube was flagged at 10,
// 11, 15 and 20 mm along the run and missed at 12, 12.5 and 17.5 mm.

// legacyGridSharpBendAngles is checkSharpBendAngles as it stood before
// #180, kept verbatim as the negative control: the phase sweep below must
// FAIL against it, or the sweep is not testing anything.
func legacyGridSharpBendAngles(polylines []Polyline, limits Limits) []Issue {
	thresholdDeg := effectiveSharpBendAngleDeg(limits)
	if thresholdDeg <= 0 {
		return nil
	}
	var issues []Issue
	for _, pl := range polylines {
		step := 1.0
		if limits.MinBendRadiusMM > 0 {
			step = math.Max(0.5, math.Min(limits.MinBendRadiusMM/4, 5))
		}
		sampled := resampleUniform(pl, step)
		pts := sampled.Points
		n := len(pts)
		if n < 3 {
			continue
		}
		hairpinD := runDiameterMM(pl, limits)
		first, last := 1, n-1
		if sampled.Closed {
			first, last = 0, n
		}
		for idx := first; idx < last; idx++ {
			var aIdx, cIdx int
			if sampled.Closed {
				aIdx = (idx - 1 + n) % n
				cIdx = (idx + 1) % n
				if idx == n-1 && pts[0] == pts[n-1] {
					continue
				}
			} else {
				aIdx = idx - 1
				cIdx = idx + 1
			}
			ang := interiorAngleDeg(pts[aIdx], pts[idx], pts[cIdx])
			if ang > thresholdDeg {
				continue
			}
			if isDoubleBackHairpin(pts, sampled.Closed, idx, step, hairpinD) {
				continue
			}
			if hasUserDoubleback(pts[idx], pl.DoublebackMarks, hairpinD) {
				continue
			}
			issues = append(issues, Issue{
				Rule:     RuleSharpBendAngle,
				Severity: SeverityWarning,
				Message: fmt.Sprintf(
					"sharp bend %.0f° (≤ %.0f°) — concentrates stress at the apex; consider a wider sweep",
					ang, thresholdDeg),
				XMM: pts[idx].X,
				YMM: pts[idx].Y,
			})
		}
	}
	radius := 5.0
	if limits.MinBendRadiusMM > 0 {
		radius = math.Max(limits.MinBendRadiusMM*1.5, 5)
	}
	return clusterIssues(issues, radius)
}

type sharpBendRule func([]Polyline, Limits) []Issue

// cornerRun is an open run: a straight lead of `offset` mm along +X, a
// corner with the given included angle at (offset, 0), then a 60 mm leg.
// cw mirrors the second leg below the axis (a right-hand turn).
func cornerRun(offset, includedDeg float64, cw bool) Polyline {
	heading := math.Pi - includedDeg*math.Pi/180
	if cw {
		heading = -heading
	}
	return Polyline{Points: []Point{
		{0, 0},
		{offset, 0},
		{offset + 60*math.Cos(heading), 60 * math.Sin(heading)},
	}}
}

// sweepOffsets is 0.25 mm to 30 mm in 0.25 mm steps: finer than every
// resample step the rule uses, and it includes 12, 12.5 and 17.5 mm.
func sweepOffsets() []float64 {
	var out []float64
	for i := 1; i <= 120; i++ {
		out = append(out, float64(i)*0.25)
	}
	return out
}

// cornerPhaseViolations returns every offset at which `rule` does not
// report exactly `want` sharp-bend issues for the corner.
func cornerPhaseViolations(rule sharpBendRule, limits Limits, includedDeg float64, cw bool, want int) []float64 {
	var bad []float64
	for _, off := range sweepOffsets() {
		got := countByRule(rule([]Polyline{cornerRun(off, includedDeg, cw)}, limits), RuleSharpBendAngle)
		if got != want {
			bad = append(bad, off)
		}
	}
	return bad
}

var phaseSweepLimits = []struct {
	name   string
	limits Limits
}{
	// The configuration #180 was reported against: step 5 mm.
	{"D12_r25_step5", Limits{DiameterMM: 12, MinBendRadiusMM: 25, SharpBendAngleDeg: 85}},
	{"D12_r40_step5", Limits{DiameterMM: 12, MinBendRadiusMM: 40, SharpBendAngleDeg: 85}},
	{"D12_r8_step2", Limits{DiameterMM: 12, MinBendRadiusMM: 8, SharpBendAngleDeg: 85}},
	{"D12_noRadius_step1", Limits{DiameterMM: 12, SharpBendAngleDeg: 85}},
}

// TestSharpBendAnglePhaseInvariant is the #180 property: for every corner
// angle on both sides of the threshold, turning either way, and every
// resample step the rule can pick, the flag count is the same wherever
// along the run the corner lands.
func TestSharpBendAnglePhaseInvariant(t *testing.T) {
	cases := []struct {
		includedDeg float64
		want        int
	}{
		{60, 1},
		{84, 1}, // just inside the 85° threshold
		{86, 0}, // just outside it
		{120, 0},
	}
	for _, lc := range phaseSweepLimits {
		for _, c := range cases {
			for _, cw := range []bool{false, true} {
				name := fmt.Sprintf("%s/%.0fdeg/cw=%v", lc.name, c.includedDeg, cw)
				t.Run(name, func(t *testing.T) {
					if bad := cornerPhaseViolations(checkSharpBendAngles, lc.limits, c.includedDeg, cw, c.want); len(bad) > 0 {
						t.Errorf("want %d sharp_bend_angle issue(s) at every offset; wrong at %v mm", c.want, bad)
					}
				})
			}
		}
	}
}

// TestSharpBendAnglePhaseSweepFailsOnLegacyGrid is the negative control:
// the same sweep run against the pre-#180 rule must find violations, and
// must find the three misses #180 was filed with. If this ever passes
// cleanly the sweep has stopped being able to see the bug.
func TestSharpBendAnglePhaseSweepFailsOnLegacyGrid(t *testing.T) {
	limits := phaseSweepLimits[0].limits
	bad := cornerPhaseViolations(legacyGridSharpBendAngles, limits, 60, false, 1)
	if len(bad) == 0 {
		t.Fatal("legacy grid rule passed the phase sweep; the sweep cannot detect the #180 defect")
	}
	missed := map[float64]bool{}
	for _, off := range bad {
		missed[off] = true
	}
	for _, off := range []float64{12, 12.5, 17.5} {
		if !missed[off] {
			t.Errorf("legacy grid rule should miss the 60° corner at %.1f mm (the #180 report); misses: %v", off, bad)
		}
	}
	for _, off := range []float64{10, 11, 15, 20} {
		if missed[off] {
			t.Errorf("legacy grid rule should flag the 60° corner at %.1f mm (the #180 report); misses: %v", off, bad)
		}
	}
	// And the fixed rule flags every one of them.
	for _, off := range []float64{10, 11, 12, 12.5, 15, 17.5, 20} {
		if got := countByRule(checkSharpBendAngles([]Polyline{cornerRun(off, 60, false)}, limits), RuleSharpBendAngle); got != 1 {
			t.Errorf("fixed rule: 60° corner at %.1f mm gave %d issues, want 1", off, got)
		}
	}
}

// TestSharpBendAngleMarkerSitsOnApex pins that the marker, not just the
// count, is phase-invariant: it lands on the drawn corner and reports the
// drawn angle wherever the corner falls.
func TestSharpBendAngleMarkerSitsOnApex(t *testing.T) {
	for _, lc := range phaseSweepLimits {
		for _, off := range sweepOffsets() {
			issues := checkSharpBendAngles([]Polyline{cornerRun(off, 60, false)}, lc.limits)
			iss, ok := firstByRule(issues, RuleSharpBendAngle)
			if !ok {
				t.Fatalf("%s: no issue at offset %.2f", lc.name, off)
			}
			if d := dist(Point{iss.XMM, iss.YMM}, Point{off, 0}); d > 1e-6 {
				t.Errorf("%s offset %.2f: marker at (%.3f, %.3f), %.3f mm off the apex", lc.name, off, iss.XMM, iss.YMM, d)
			}
			if !strings.HasPrefix(iss.Message, "sharp bend 60°") {
				t.Errorf("%s offset %.2f: message %q, want the drawn 60°", lc.name, off, iss.Message)
			}
		}
	}
}

// TestSharpBendAngleClosedSeamPhaseInvariant slides the seam of a closed
// equilateral triangle along one edge. The seam is where the old grid was
// anchored, so on a closed run it is the phase; all three 60° corners
// must be flagged wherever it sits.
func TestSharpBendAngleClosedSeamPhaseInvariant(t *testing.T) {
	const side = 60.0
	a := Point{0, 0}
	b := Point{side, 0}
	c := Point{side / 2, side * math.Sqrt(3) / 2}
	for _, lc := range phaseSweepLimits {
		if lc.limits.MinBendRadiusMM*1.5 >= side {
			continue // cluster radius would merge the corners; that is #142's business
		}
		var bad []float64
		for i := 1; i < 240; i++ {
			t0 := float64(i) / 240 // seam position along edge c→a
			seam := Point{c.X + (a.X-c.X)*t0, c.Y + (a.Y-c.Y)*t0}
			pl := Polyline{Points: []Point{seam, a, b, c}, Closed: true}
			if got := countByRule(checkSharpBendAngles([]Polyline{pl}, lc.limits), RuleSharpBendAngle); got != 3 {
				bad = append(bad, t0*side)
			}
		}
		if len(bad) > 0 {
			t.Errorf("%s: want 3 issues wherever the seam sits; wrong with the seam %v mm along the edge", lc.name, bad)
		}
	}
}

// TestSharpBendAngleHairpinExemptionPhaseInvariant slides the hairpin from
// TestSharpBendAngleExemptsHairpinApex along its run. The double-back
// detector counts its look-around in samples, so it is the part of the
// rule most exposed to where the grid falls; its exemption must hold at
// every offset.
func TestSharpBendAngleHairpinExemptionPhaseInvariant(t *testing.T) {
	const D = 12.0
	const sep = 20.0
	limits := Limits{DiameterMM: D, MinBendRadiusMM: 25, SharpBendAngleDeg: 85}
	var bad []float64
	for _, lead := range sweepOffsets() {
		var pts []Point
		// Leg 1 from (-100-lead, 0) to (0, 0); the extra lead slides the apex.
		pts = append(pts, Point{-100 - lead, 0})
		for i := 1; i <= 10; i++ {
			pts = append(pts, Point{-100 + float64(i)*10, 0})
		}
		r := sep / 2
		for i := 1; i <= 10; i++ {
			th := math.Pi * float64(i) / 10
			pts = append(pts, Point{r * math.Sin(th), r - r*math.Cos(th)})
		}
		for i := 1; i <= 10; i++ {
			pts = append(pts, Point{-float64(i) * 10, sep})
		}
		pl := Polyline{Points: pts, DiameterMM: D}
		if got := countByRule(checkSharpBendAngles([]Polyline{pl}, limits), RuleSharpBendAngle); got != 0 {
			bad = append(bad, lead)
		}
	}
	if len(bad) > 0 {
		t.Errorf("hairpin apex should be exempt at every offset; flagged with extra lead %v mm", bad)
	}
}
