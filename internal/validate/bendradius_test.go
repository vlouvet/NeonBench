package validate

import (
	"math"
	"testing"
)

// Tier 1 #131. The bend-radius rule used to derive both its resample step
// (limit/4) and its issue-clustering radius (1.5 × limit) from the very
// threshold it was testing against, so tightening the tube spec coarsened
// the measurement and merged distinct bends. The count therefore tracked
// how the raster had been prepared rather than what would be bent. These
// tests pin the two properties that fix has to keep:
//
//   - the count is a function of the tube spec (monotone in the limit)
//   - the count is NOT a function of vertex density on a fixed shape
//
// Deliberately no golden count is asserted against a stored fixture —
// that would freeze whatever the rule happens to do today.

// stairArcRuns builds one open run: a staircase of 90° corner arcs of the
// given radii, joined by straight legs. Each arc is a genuine bend of
// exactly that radius, and the straight legs keep the bends far enough
// apart that nothing merges. sampleMM sets the source vertex density —
// the knob `smoothing_mm` moves in the real pipeline, isolated here from
// the drawn shape.
func stairArcRuns(radii []float64, legMM, sampleMM float64) Polyline {
	var pts []Point
	p := Point{0, 0}
	heading := 0.0
	pts = append(pts, p)
	advance := func(l float64) {
		n := int(math.Max(2, math.Round(l/sampleMM)))
		for i := 1; i <= n; i++ {
			d := l * float64(i) / float64(n)
			pts = append(pts, Point{p.X + d*math.Cos(heading), p.Y + d*math.Sin(heading)})
		}
		p = Point{p.X + l*math.Cos(heading), p.Y + l*math.Sin(heading)}
	}
	turn := func(r float64) {
		cx := p.X - r*math.Sin(heading)
		cy := p.Y + r*math.Cos(heading)
		a0 := math.Atan2(p.Y-cy, p.X-cx)
		n := int(math.Max(4, math.Round((r*math.Pi/2)/sampleMM)))
		for i := 1; i <= n; i++ {
			a := a0 + (math.Pi/2)*float64(i)/float64(n)
			pts = append(pts, Point{cx + r*math.Cos(a), cy + r*math.Sin(a)})
		}
		p = pts[len(pts)-1]
		heading += math.Pi / 2
	}
	for _, r := range radii {
		advance(legMM)
		turn(r)
	}
	advance(legMM)
	return Polyline{Points: pts}
}

// regularNGon returns a closed n-gon inscribed in a circle of radius r.
func regularNGon(cx, cy, r float64, n int) Polyline {
	pts := make([]Point, 0, n)
	for i := 0; i < n; i++ {
		th := 2 * math.Pi * float64(i) / float64(n)
		pts = append(pts, Point{cx + r*math.Cos(th), cy + r*math.Sin(th)})
	}
	return Polyline{Points: pts, Closed: true}
}

var stairRadii = []float64{8, 12, 16, 20, 24, 28, 32, 36}

// TestBendRadiusIsIndependentOfVertexDensity is deliverable (1): one drawn
// shape, resampled at several vertex densities, must produce the same
// count. The sweeps that opened this row could not separate density from
// shape because smoothing_mm changes both; building the polyline directly
// does.
func TestBendRadiusIsIndependentOfVertexDensity(t *testing.T) {
	limits := Limits{DiameterMM: 12, MinBendRadiusMM: 27}
	// Five of the eight bends (r = 8, 12, 16, 20, 24) are under 27 mm.
	const want = 5
	// The measurement step is D/(2·half−1) ≈ 3.4 mm for ø12, so source
	// spacings at or below that carry the shape faithfully. Coarser input
	// than the measurement window genuinely IS a different shape and is
	// out of scope for this invariant.
	for _, sampleMM := range []float64{0.25, 0.5, 1, 2, 3} {
		pl := stairArcRuns(stairRadii, 200, sampleMM)
		got := countByRule(checkBendRadiusClustered([]Polyline{pl}, limits), RuleMinBendRadius)
		if got != want {
			t.Errorf("source vertex spacing %.2fmm (%d points): got %d bend errors, want %d — "+
				"the count is tracking vertex density, not the drawn shape",
				sampleMM, len(pl.Points), got, want)
		}
	}
}

// TestBendRadiusCountIsMonotoneInLimit is deliverable (4), and the
// assertion whose absence let the flat 41/40/40/41 row exist. Raising
// min_bend_radius_mm on a fixed doc may only sweep more bends into
// failure; it may never report fewer.
func TestBendRadiusCountIsMonotoneInLimit(t *testing.T) {
	pl := stairArcRuns(stairRadii, 200, 1)
	prev := -1
	prevLimit := 0.0
	for limit := 6.0; limit <= 44; limit += 2 {
		got := countByRule(
			checkBendRadiusClustered([]Polyline{pl}, Limits{DiameterMM: 12, MinBendRadiusMM: limit}),
			RuleMinBendRadius)
		if prev >= 0 && got < prev {
			t.Errorf("limit %.0fmm reported %d errors but the looser limit %.0fmm reported %d — "+
				"a stricter tube spec must never report fewer bend errors",
				limit, got, prevLimit, prev)
		}
		prev, prevLimit = got, limit
	}
	// And it must actually move: a monotone-but-constant count would pass
	// the check above while reproducing the defect.
	loose := countByRule(
		checkBendRadiusClustered([]Polyline{pl}, Limits{DiameterMM: 12, MinBendRadiusMM: 10}),
		RuleMinBendRadius)
	tight := countByRule(
		checkBendRadiusClustered([]Polyline{pl}, Limits{DiameterMM: 12, MinBendRadiusMM: 40}),
		RuleMinBendRadius)
	if !(tight > loose) {
		t.Errorf("count did not respond to the limit at all: %d at 10mm vs %d at 40mm", loose, tight)
	}
}

// TestBendRadiusCountRespondsToSeededTubeSpecs walks the four tube specs
// the app actually ships (migrations 0002/0004) over one fixed design.
// This is the sweep from the gaps doc, with a shape whose right answer is
// known: the count must rise with the tube.
func TestBendRadiusCountRespondsToSeededTubeSpecs(t *testing.T) {
	pl := stairArcRuns(stairRadii, 200, 1)
	cases := []struct {
		name         string
		diameter     float64
		limit        float64
		wantExactly  int
		wantAtLeast  int
	}{
		{"8mm clear", 8, 18, 3, 0},   // r = 8, 12, 16 are under 18
		{"10mm clear", 10, 22, 4, 0}, // + r = 20
		{"12mm clear", 12, 27, 5, 0}, // + r = 24
		{"15mm clear", 15, 34, 7, 0}, // + r = 28, 32
	}
	prev := -1
	for _, c := range cases {
		got := countByRule(
			checkBendRadiusClustered([]Polyline{pl},
				Limits{DiameterMM: c.diameter, MinBendRadiusMM: c.limit}),
			RuleMinBendRadius)
		if got != c.wantExactly {
			t.Errorf("%s (ø%.0f, limit %.0fmm): got %d bend errors, want %d",
				c.name, c.diameter, c.limit, got, c.wantExactly)
		}
		if prev >= 0 && got <= prev {
			t.Errorf("%s reported %d, not more than the previous spec's %d — "+
				"the count is not responding to the tube spec", c.name, got, prev)
		}
		prev = got
	}
}

// TestBendRadiusMeasuresKnownArcRadius is the spec's "run built from an
// arc of known radius" case: comfortably above the limit is clean,
// comfortably below is exactly one issue, and the reported radius is the
// real one rather than a sampling artifact.
func TestBendRadiusMeasuresKnownArcRadius(t *testing.T) {
	limits := Limits{DiameterMM: 12, MinBendRadiusMM: 27}
	for _, c := range []struct {
		radius float64
		want   int
	}{
		{40, 0}, // well above the 27mm limit
		{18, 1}, // well below it
	} {
		pl := regularNGon(0, 0, c.radius, 360)
		issues := checkBendRadiusClustered([]Polyline{pl}, limits)
		if got := countByRule(issues, RuleMinBendRadius); got != c.want {
			t.Fatalf("closed r=%.0fmm loop against a 27mm limit: got %d issues, want %d (%+v)",
				c.radius, got, c.want, issues)
		}
	}
	// The measured radius must be the loop's actual radius, not a
	// function of how finely it was sampled.
	pl := regularNGon(0, 0, 18, 360)
	step, half := bendMeasureGeometry(pl, limits)
	sampled := resampleUniform(pl, step)
	radii := bendRadiiOverWindow(sampled.Points, sampled.Closed, half)
	for i, r := range radii {
		if math.IsInf(r, 1) {
			continue
		}
		if math.Abs(r-18) > 0.5 {
			t.Errorf("sample %d measured r = %.2fmm on a true 18mm loop", i, r)
			break
		}
	}
}

// TestBendMeasurementIgnoresTheLimit is the root-cause guard. The
// measurement's own parameters must not consult min_bend_radius_mm —
// that self-reference is what made a stricter spec measure more coarsely
// and cancel itself out. Same shape, same tube, two wildly different
// limits: the measured radii must be byte-for-byte identical.
func TestBendMeasurementIgnoresTheLimit(t *testing.T) {
	pl := stairArcRuns(stairRadii, 200, 1)
	measure := func(limit float64) []float64 {
		limits := Limits{DiameterMM: 12, MinBendRadiusMM: limit}
		step, half := bendMeasureGeometry(pl, limits)
		sampled := resampleUniform(pl, step)
		return bendRadiiOverWindow(sampled.Points, sampled.Closed, half)
	}
	a, b := measure(5), measure(150)
	if len(a) != len(b) {
		t.Fatalf("sample count changed with the limit: %d vs %d — the measurement is still "+
			"derived from the threshold it is compared against", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Fatalf("measured radius at sample %d changed with the limit: %v vs %v", i, a[i], b[i])
		}
	}
}

// TestBendRadiusNegativeControlThreePointCircumradius is the negative
// control CLAUDE.md asks for: it constructs the estimator the rule used
// to use and asserts it FAILS the density invariant. Without this, the
// passing tests above could be passing for the wrong reason.
func TestBendRadiusNegativeControlThreePointCircumradius(t *testing.T) {
	// One drawn shape — a 40mm circle, comfortably above a 27mm limit —
	// at two vertex densities.
	const limit = 27.0
	minCircumradius := func(pl Polyline, step float64) float64 {
		s := resampleUniform(pl, step)
		m := math.Inf(1)
		for i := 1; i < len(s.Points)-1; i++ {
			if r := circumradius3(s.Points[i-1], s.Points[i], s.Points[i+1]); r < m {
				m = r
			}
		}
		return m
	}
	coarse := minCircumradius(regularNGon(0, 0, 40, 16), 5)
	fine := minCircumradius(regularNGon(0, 0, 40, 360), 5)
	if !(coarse < limit && fine >= limit) {
		t.Fatalf("negative control did not reproduce the old defect: coarse=%.2f fine=%.2f "+
			"(expected the 3-point circumradius to flag the coarse sampling of the same "+
			"40mm circle and clear the fine one)", coarse, fine)
	}
	// The window estimator sees the same shape both ways.
	pl16, pl360 := regularNGon(0, 0, 40, 16), regularNGon(0, 0, 40, 360)
	limits := Limits{DiameterMM: 12, MinBendRadiusMM: limit}
	got16 := countByRule(checkBendRadiusClustered([]Polyline{pl16}, limits), RuleMinBendRadius)
	got360 := countByRule(checkBendRadiusClustered([]Polyline{pl360}, limits), RuleMinBendRadius)
	if got16 != 0 || got360 != 0 {
		t.Errorf("window estimator flagged a 40mm circle against a 27mm limit: "+
			"16-gon=%d, 360-gon=%d, want 0 and 0", got16, got360)
	}
}

// TestBendRadiusDoesNotExemptTightClosedLoops pins the hairpin-detector
// half of the fix. A small closed bowl satisfies every condition the
// old double-back heuristic tested — near-antipodal samples, close
// together, anti-parallel tangents — so it was exempted as "structural
// construction" and reported zero errors. Probed on ø12 tube: closed
// loops of radius 20mm and 24mm both came back clean against a 40mm
// limit. A bowl is exactly what this rule is for.
func TestBendRadiusDoesNotExemptTightClosedLoops(t *testing.T) {
	limits := Limits{DiameterMM: 12, MinBendRadiusMM: 40}
	for _, r := range []float64{8, 12, 16, 20, 24, 28, 32, 36} {
		pl := regularNGon(0, 0, r, 360)
		if got := countByRule(checkBendRadiusClustered([]Polyline{pl}, limits), RuleMinBendRadius); got != 1 {
			t.Errorf("closed loop r=%.0fmm against a 40mm limit: got %d issues, want 1 "+
				"(a bowl is not a double-back)", r, got)
		}
	}
}

// TestBendRadiusStillExemptsRealDoubleBacks is the other side of that
// coin: tightening the hairpin detector must not start flagging the
// documented DB construction. Two parallel legs joined by a tight
// semicircle — Blazek's "DB", standard in E, F, G, R.
func TestBendRadiusStillExemptsRealDoubleBacks(t *testing.T) {
	const D = 12.0
	const legLen = 120.0
	const sep = 20.0
	var pts []Point
	for i := 0; i <= 240; i++ {
		pts = append(pts, Point{-legLen + float64(i)*legLen/240, 0})
	}
	r := sep / 2
	for i := 1; i <= 60; i++ {
		th := math.Pi * float64(i) / 60
		pts = append(pts, Point{r * math.Sin(th), r - r*math.Cos(th)})
	}
	for i := 1; i <= 240; i++ {
		pts = append(pts, Point{-float64(i) * legLen / 240, sep})
	}
	pl := Polyline{Points: pts, DiameterMM: D}
	limits := Limits{DiameterMM: D, MinBendRadiusMM: 27}
	if got := countByRule(checkBendRadiusClustered([]Polyline{pl}, limits), RuleMinBendRadius); got != 0 {
		t.Errorf("hairpin double-back flagged as a bend-radius error (got %d issues); "+
			"the DB exemption regressed", got)
	}
	// Negative control: the same U-turn with the exemption's precondition
	// removed — legs far enough apart that it is a genuine tight bend and
	// not a double-back — must still be caught.
	var wide []Point
	for i := 0; i <= 240; i++ {
		wide = append(wide, Point{-legLen + float64(i)*legLen/240, 0})
	}
	rw := 60.0
	for i := 1; i <= 180; i++ {
		th := math.Pi * float64(i) / 180
		wide = append(wide, Point{rw * math.Sin(th), rw - rw*math.Cos(th)})
	}
	for i := 1; i <= 240; i++ {
		wide = append(wide, Point{-float64(i) * legLen / 240, 2 * rw})
	}
	wpl := Polyline{Points: wide, DiameterMM: D}
	if got := countByRule(
		checkBendRadiusClustered([]Polyline{wpl}, Limits{DiameterMM: D, MinBendRadiusMM: 80}),
		RuleMinBendRadius); got == 0 {
		t.Error("a 60mm U-turn against an 80mm limit was not flagged — the exemption is too broad")
	}
}

// TestBendRadiusUsesDerivedLimitWhenSpecOmitsIt closes the gap logged as
// a Tier 3 follow-up in internal/server/integration_test.go: the rule
// used to early-return on limits.MinBendRadiusMM <= 0, so the Tier 3 #31
// wall-thinning derivation in runBendLimitMM could never be reached
// through checkBendRadius. Now the per-run limit decides.
func TestBendRadiusUsesDerivedLimitWhenSpecOmitsIt(t *testing.T) {
	// ø12, 1.2mm wall, crossfire → 0.225 · 144 / 1.2 = 27mm derived.
	limits := Limits{DiameterMM: 12, WallThicknessMM: 1.2, BendTechnique: "crossfire"}
	tight := regularNGon(0, 0, 18, 360)
	if got := countByRule(checkBendRadiusClustered([]Polyline{tight}, limits), RuleMinBendRadius); got != 1 {
		t.Errorf("18mm loop against a 27mm derived limit: got %d issues, want 1 "+
			"(the derived limit is still unreachable)", got)
	}
	loose := regularNGon(0, 0, 45, 360)
	if got := countByRule(checkBendRadiusClustered([]Polyline{loose}, limits), RuleMinBendRadius); got != 0 {
		t.Errorf("45mm loop against a 27mm derived limit: got %d issues, want 0", got)
	}
}

// TestBendRadiusHeatZoneMatchesTheCitedRule pins the constant against the
// source it claims to come from. docs/neon-rules/bend-radius.md, quoting
// Strattman NT Fig. 7.20, gives a heat-zone length of 2 × tube ø for a
// right-angle bend and derives the implied radius of a clean 90° formed
// over it as arc/(π/2) ≈ 1.27·D. A hard 90° corner in the artwork must
// measure exactly that.
func TestBendRadiusHeatZoneMatchesTheCitedRule(t *testing.T) {
	const D = 12.0
	var pts []Point
	for x := -100.0; x < 0; x += 0.25 {
		pts = append(pts, Point{x, 0})
	}
	for y := 0.0; y <= 100; y += 0.25 {
		pts = append(pts, Point{0, y})
	}
	pl := Polyline{Points: pts, DiameterMM: D}
	limits := Limits{DiameterMM: D, MinBendRadiusMM: 27}
	step, half := bendMeasureGeometry(pl, limits)
	sampled := resampleUniform(pl, step)
	radii := bendRadiiOverWindow(sampled.Points, sampled.Closed, half)
	best := math.Inf(1)
	for _, r := range radii {
		if r < best {
			best = r
		}
	}
	want := bendHeatZoneDiameters * D / (math.Pi / 2) // ≈ 1.273 · D = 15.3mm
	if math.Abs(best-want) > 0.5 {
		t.Errorf("a hard 90° corner measured %.2fmm; the cited heat-zone rule (%.1f × ø%.0f "+
			"formed through 90°) gives %.2fmm", best, bendHeatZoneDiameters, D, want)
	}
	// And it must fail a 27mm tube: 15.3 < 27.
	if got := countByRule(checkBendRadiusClustered([]Polyline{pl}, limits), RuleMinBendRadius); got != 1 {
		t.Errorf("a hard 90° corner in ø12 tube: got %d issues, want 1", got)
	}
}
