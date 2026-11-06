package vectorize

import (
	"bytes"
	"context"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

// ---- helpers -------------------------------------------------------------

func polylineLengthMM(pl MMPolyline) float64 {
	n := len(pl.Points)
	if n < 2 {
		return 0
	}
	last := n - 1
	if pl.Closed {
		last = n
	}
	total := 0.0
	for i := 0; i < last; i++ {
		a := pl.Points[i]
		b := pl.Points[(i+1)%n]
		total += math.Hypot(b.X-a.X, b.Y-a.Y)
	}
	return total
}

// cubicStarts returns the start point of each cubic in cp.
func cubicStarts(cp CurvePath) []MMPoint {
	out := make([]MMPoint, len(cp.Cubics))
	prev := cp.Start
	for i, c := range cp.Cubics {
		out[i] = prev
		prev = c.P
	}
	return out
}

// cubicTangent is the analytic derivative of the cubic at parameter t.
func cubicTangent(p0 MMPoint, c Cubic, t float64) MMPoint {
	u := 1 - t
	return MMPoint{
		X: 3*u*u*(c.C1.X-p0.X) + 6*u*t*(c.C2.X-c.C1.X) + 3*t*t*(c.P.X-c.C2.X),
		Y: 3*u*u*(c.C1.Y-p0.Y) + 6*u*t*(c.C2.Y-c.C1.Y) + 3*t*t*(c.P.Y-c.C2.Y),
	}
}

// tangentBreakJoints returns the joints of cp where the tangent direction is
// discontinuous. Joint i is where cubic i meets cubic i+1 (for a closed path
// the last joint wraps to cubic 0), i.e. at polyline vertex i+1.
func tangentBreakJoints(cp CurvePath) []int {
	var out []int
	if len(cp.Cubics) == 0 {
		return out
	}
	starts := cubicStarts(cp)
	last := len(cp.Cubics) - 1
	if cp.Closed {
		last = len(cp.Cubics)
	}
	for i := 0; i < last; i++ {
		j := (i + 1) % len(cp.Cubics)
		in := cubicTangent(starts[i], cp.Cubics[i], 1)
		out2 := cubicTangent(starts[j], cp.Cubics[j], 0)
		if angleBetween(in, out2)*180/math.Pi > 1e-6 {
			out = append(out, i)
		}
	}
	return out
}

func equalInts(a, b []int) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

func angleBetween(a, b MMPoint) float64 {
	t1 := math.Atan2(a.Y, a.X)
	t2 := math.Atan2(b.Y, b.X)
	return math.Abs(math.Atan2(math.Sin(t2-t1), math.Cos(t2-t1)))
}

// maxDeviationMM samples the fitted path densely and returns the largest
// distance from any sample to the nearest point of the source polyline. This
// is the number a cusp blows up: an overshooting fit leaves the corridor the
// polyline defines.
func maxDeviationMM(cp CurvePath, pl MMPolyline) float64 {
	const samples = 64
	worst := 0.0
	for i, c := range cp.Cubics {
		start := cubicStarts(cp)[i]
		for s := 0; s <= samples; s++ {
			q := CubicAt(start, c, float64(s)/samples)
			if d := distToPolylineMM(q, pl); d > worst {
				worst = d
			}
		}
	}
	return worst
}

func distToPolylineMM(q MMPoint, pl MMPolyline) float64 {
	best := math.Inf(1)
	n := len(pl.Points)
	last := n - 1
	if pl.Closed {
		last = n
	}
	for i := 0; i < last; i++ {
		if d := distToSegMM(q, pl.Points[i], pl.Points[(i+1)%n]); d < best {
			best = d
		}
	}
	return best
}

func distToSegMM(p, a, b MMPoint) float64 {
	dx, dy := b.X-a.X, b.Y-a.Y
	l2 := dx*dx + dy*dy
	if l2 == 0 {
		return math.Hypot(p.X-a.X, p.Y-a.Y)
	}
	t := math.Max(0, math.Min(1, ((p.X-a.X)*dx+(p.Y-a.Y)*dy)/l2))
	return math.Hypot(p.X-(a.X+t*dx), p.Y-(a.Y+t*dy))
}

func samplePolyline(n int, f func(i int) MMPoint) []MMPoint {
	out := make([]MMPoint, n)
	for i := range out {
		out[i] = f(i)
	}
	return out
}

func circlePolyline(n int, r float64) MMPolyline {
	return MMPolyline{
		Points: samplePolyline(n, func(i int) MMPoint {
			a := 2 * math.Pi * float64(i) / float64(n)
			return MMPoint{X: r * math.Cos(a), Y: r * math.Sin(a)}
		}),
		Closed: true,
	}
}

// ---- the fit -------------------------------------------------------------

// TestFitCurveInterpolatesEverySample is the property that separates this from
// the smoothing_mm workaround. Catmull-Rom *interpolates*: every traced sample
// is still on the curve, so the smoothed centerline runs down the letterform.
// A fit that merely approximated would let the tube drift off the artwork —
// invisibly, which is worse than the faceting it replaced.
func TestFitCurveInterpolatesEverySample(t *testing.T) {
	cases := map[string]MMPolyline{
		"open":   {Points: []MMPoint{{X: 0, Y: 0}, {X: 10, Y: 4}, {X: 22, Y: -3}, {X: 30, Y: 9}, {X: 41, Y: 9}}},
		"closed": circlePolyline(9, 37),
		"tight":  {Points: []MMPoint{{X: 0, Y: 0}, {X: 20, Y: 0}, {X: 20.14, Y: 0.14}, {X: 20, Y: 20}}},
	}
	for name, pl := range cases {
		t.Run(name, func(t *testing.T) {
			cp := FitCurve(pl)
			wantSegs := len(pl.Points) - 1
			if pl.Closed {
				wantSegs = len(pl.Points)
			}
			if len(cp.Cubics) != wantSegs {
				t.Fatalf("got %d cubics, want one per segment (%d)", len(cp.Cubics), wantSegs)
			}
			if cp.Start != pl.Points[0] {
				t.Errorf("start %v != first sample %v", cp.Start, pl.Points[0])
			}
			// Each sample must be hit exactly, as a curve endpoint — and the
			// evaluated cubic must agree, so this cannot pass on a struct
			// field that the Bezier arithmetic ignores.
			starts := cubicStarts(cp)
			for i, c := range cp.Cubics {
				want := pl.Points[(i+1)%len(pl.Points)]
				if math.Hypot(c.P.X-want.X, c.P.Y-want.Y) > 1e-12 {
					t.Errorf("cubic %d endpoint %v != sample %v", i, c.P, want)
				}
				if got := CubicAt(starts[i], c, 1); math.Hypot(got.X-want.X, got.Y-want.Y) > 1e-12 {
					t.Errorf("cubic %d evaluated at t=1 gives %v, want sample %v", i, got, want)
				}
				if got := CubicAt(starts[i], c, 0); math.Hypot(got.X-starts[i].X, got.Y-starts[i].Y) > 1e-12 {
					t.Errorf("cubic %d evaluated at t=0 gives %v, want %v", i, got, starts[i])
				}
			}
		})
	}
}

// TestCentripetalAvoidsCuspOnCloseSamples is why CatmullRomAlpha is 0.5.
//
// The input is the pathological case the constant's comment describes: a tight
// turn where two samples sit much closer together than their neighbours —
// precisely what a traced script produces at a tight turn. Both fits are built
// from the same points, and the test asserts the tolerance band the
// centripetal fit stays inside AND that the uniform fit provably leaves it, so
// a future "simplification" to alpha = 0 fails here rather than shipping as a
// rendering glitch someone hunts for in the renderer.
func TestCentripetalAvoidsCuspOnCloseSamples(t *testing.T) {
	// Measured on this input: centripetal 0.19 mm, uniform 1.77 mm.
	const (
		centripetalMaxDevMM = 0.5 // comfortably above the measured 0.19
		uniformMinDevMM     = 1.0 // comfortably below the measured 1.77
	)
	const gap = 0.2
	pl := MMPolyline{Points: []MMPoint{
		{X: 0, Y: 0},
		{X: 20, Y: 0},
		{X: 20 + gap*0.7, Y: gap * 0.7}, // the close pair, at the turn
		{X: 20, Y: 20},
	}}

	centripetal := maxDeviationMM(FitCurve(pl), pl)
	if centripetal > centripetalMaxDevMM {
		t.Errorf("centripetal (alpha=%v) deviates %.4f mm, want <= %.2f mm",
			CatmullRomAlpha, centripetal, centripetalMaxDevMM)
	}

	// Negative control: the same fit with the uniform parameterization must
	// FAIL the band. If this stops failing, the band stopped meaning anything.
	uniform := maxDeviationMM(fitCurveAlpha(pl, 0), pl)
	if uniform < uniformMinDevMM {
		t.Errorf("uniform (alpha=0) deviates only %.4f mm, want >= %.2f mm — "+
			"the negative control has gone vacuous and this test no longer "+
			"documents why alpha is %v", uniform, uniformMinDevMM, CatmullRomAlpha)
	}
	t.Logf("max deviation from the polyline: centripetal %.4f mm, uniform %.4f mm", centripetal, uniform)

	// Uniform's failure mode is a length blow-up too: it loops out and back.
	polyLen := polylineLengthMM(pl)
	if got := fitCurveAlpha(pl, 0).Length() / polyLen; got < 1.05 {
		t.Errorf("uniform fit length ratio %.4f — expected the cusp to inflate it past 1.05", got)
	}
	if got := FitCurve(pl).Length() / polyLen; got > 1.02 {
		t.Errorf("centripetal fit length ratio %.4f — expected within 2%% of the polyline", got)
	}

	// CatmullRomAlpha itself is pinned: the value is load-bearing, not a knob.
	if CatmullRomAlpha != 0.5 {
		t.Fatalf("CatmullRomAlpha is %v; centripetal means 0.5", CatmullRomAlpha)
	}
}

// TestFitCurveIsG1Continuous pins the property that actually removes faceting:
// a facet IS a tangent-direction discontinuity, and Catmull-Rom's shared knot
// tangent removes every one of them. Measured on the OPEN fixture the traced
// polyline has 368 direction breaks (worst 104 deg) and the fit has none.
//
// Since Tier 3 #146 the guarantee is per span: FitCurve breaks the tangent at
// a detected corner on purpose, and is G1 at every other joint. The "open"
// input here was written for #133 and happens to be three genuine corners
// (90°, 90°, 103°, on 12–13 mm legs) — exactly what #146 exists to keep
// sharp — so it is asserted both ways: the plain spline (fitCurveAlpha) must
// still be G1 at every joint, as #133 required, and FitCurve must break at
// exactly those three joints and nowhere else.
func TestFitCurveIsG1Continuous(t *testing.T) {
	cases := map[string]struct {
		pl         MMPolyline
		wantBreaks []int // joints FitCurve must break at; every other joint is G1
	}{
		"open": {
			pl:         MMPolyline{Points: []MMPoint{{X: 0, Y: 0}, {X: 12, Y: 0}, {X: 12, Y: 12}, {X: 0, Y: 12}, {X: 3, Y: 25}}},
			wantBreaks: []int{0, 1, 2},
		},
		"closed": {pl: circlePolyline(12, 40)},
	}
	for name, tc := range cases {
		t.Run(name, func(t *testing.T) {
			// The spline on its own: G1 everywhere, unchanged from #133.
			if got := tangentBreakJoints(fitCurveAlpha(tc.pl, CatmullRomAlpha)); len(got) != 0 {
				t.Errorf("plain Catmull-Rom fit breaks its tangent at joints %v — that is a facet", got)
			}
			// FitCurve: breaks at the corners, G1 at every other joint.
			got := tangentBreakJoints(FitCurve(tc.pl))
			if !equalInts(got, tc.wantBreaks) {
				t.Errorf("FitCurve breaks its tangent at joints %v, want exactly %v "+
					"(a break anywhere else is a facet; a missing one is a rounded corner)", got, tc.wantBreaks)
			}
		})
	}
}

// TestFitCurveLengthIsNotMateriallyChanged: a fit that shortcut corners would
// under-report glass if anyone ever measured the smoothed path.
func TestFitCurveLengthIsNotMateriallyChanged(t *testing.T) {
	cases := map[string]MMPolyline{
		"circle-8":  circlePolyline(8, 50),
		"circle-32": circlePolyline(32, 50),
		"zigzag": {Points: []MMPoint{
			{X: 0, Y: 0}, {X: 10, Y: 6}, {X: 20, Y: 0}, {X: 30, Y: 6}, {X: 40, Y: 0}, {X: 50, Y: 6},
		}},
		"sine": {Points: samplePolyline(41, func(i int) MMPoint {
			x := float64(i) * 5
			return MMPoint{X: x, Y: 30 * math.Sin(x/40)}
		})},
	}
	for name, pl := range cases {
		t.Run(name, func(t *testing.T) {
			ratio := FitCurve(pl).Length() / polylineLengthMM(pl)
			// A smooth interpolant through sparse samples is slightly LONGER
			// than the chords it replaces (it bows outward where the polyline
			// cuts across); the failure being guarded is a fit that comes out
			// materially shorter, i.e. one that cut corners.
			if ratio < 0.99 || ratio > 1.03 {
				t.Errorf("smoothed/polyline length ratio %.4f, want within [0.99, 1.03]", ratio)
			}
		})
	}
}

// TestFitCurveDegenerateInputs: none of these may panic, and each has a
// defined answer.
func TestFitCurveDegenerateInputs(t *testing.T) {
	t.Run("empty", func(t *testing.T) {
		if cp := FitCurve(MMPolyline{}); len(cp.Cubics) != 0 {
			t.Errorf("empty polyline produced %d cubics", len(cp.Cubics))
		}
	})
	t.Run("single point", func(t *testing.T) {
		cp := FitCurve(MMPolyline{Points: []MMPoint{{X: 3, Y: 4}}})
		if len(cp.Cubics) != 0 {
			t.Errorf("one sample produced %d cubics", len(cp.Cubics))
		}
		if cp.Start != (MMPoint{X: 3, Y: 4}) {
			t.Errorf("start %v", cp.Start)
		}
	})
	t.Run("two points smooth to themselves", func(t *testing.T) {
		a := MMPoint{X: 5, Y: -2}
		b := MMPoint{X: 25, Y: 13}
		cp := FitCurve(MMPolyline{Points: []MMPoint{a, b}})
		if len(cp.Cubics) != 1 {
			t.Fatalf("got %d cubics, want 1", len(cp.Cubics))
		}
		// The straight chord as a cubic: controls at the 1/3 points.
		want1 := MMPoint{X: a.X + (b.X-a.X)/3, Y: a.Y + (b.Y-a.Y)/3}
		want2 := MMPoint{X: b.X - (b.X-a.X)/3, Y: b.Y - (b.Y-a.Y)/3}
		if math.Hypot(cp.Cubics[0].C1.X-want1.X, cp.Cubics[0].C1.Y-want1.Y) > 1e-9 ||
			math.Hypot(cp.Cubics[0].C2.X-want2.X, cp.Cubics[0].C2.Y-want2.Y) > 1e-9 {
			t.Errorf("two-point fit is not the straight chord: %+v", cp.Cubics[0])
		}
		if got, want := cp.Length(), math.Hypot(b.X-a.X, b.Y-a.Y); math.Abs(got-want) > 1e-9 {
			t.Errorf("length %.9f, want the chord length %.9f", got, want)
		}
	})
	t.Run("coincident samples", func(t *testing.T) {
		p := MMPoint{X: 7, Y: 7}
		cp := FitCurve(MMPolyline{Points: []MMPoint{p, p, p}})
		if len(cp.Cubics) != 0 {
			t.Errorf("three coincident samples produced %d cubics", len(cp.Cubics))
		}
		// A duplicate in the middle of a real run collapses to the two
		// distinct samples, not to a NaN.
		cp = FitCurve(MMPolyline{Points: []MMPoint{{X: 0, Y: 0}, {X: 0, Y: 0}, {X: 10, Y: 0}}})
		if len(cp.Cubics) != 1 {
			t.Fatalf("got %d cubics, want 1 after dedupe", len(cp.Cubics))
		}
		for _, v := range []float64{cp.Cubics[0].C1.X, cp.Cubics[0].C1.Y, cp.Cubics[0].C2.X, cp.Cubics[0].C2.Y} {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				t.Fatalf("coincident samples produced a non-finite control point: %+v", cp.Cubics[0])
			}
		}
	})
	t.Run("closed loop with duplicated closing point", func(t *testing.T) {
		pl := MMPolyline{Points: []MMPoint{
			{X: 0, Y: 0}, {X: 10, Y: 0}, {X: 10, Y: 10}, {X: 0, Y: 10}, {X: 0, Y: 0},
		}, Closed: true}
		cp := FitCurve(pl)
		if len(cp.Cubics) != 4 {
			t.Fatalf("got %d cubics, want 4 (the duplicate closing point must be dropped)", len(cp.Cubics))
		}
		if end := cp.Cubics[len(cp.Cubics)-1].P; end != cp.Start {
			t.Errorf("closed fit ends at %v, not back at the start %v", end, cp.Start)
		}
	})
	t.Run("closed with only two distinct points falls back to open", func(t *testing.T) {
		cp := FitCurve(MMPolyline{Points: []MMPoint{{X: 0, Y: 0}, {X: 5, Y: 0}}, Closed: true})
		if cp.Closed {
			t.Error("a two-point run cannot be a closed loop")
		}
		if len(cp.Cubics) != 1 {
			t.Errorf("got %d cubics, want 1", len(cp.Cubics))
		}
	})
}

// TestFitCurveDoesNotModifyItsInput — the fit is a pure function, and the
// polyline it is handed is the fabrication geometry.
func TestFitCurveDoesNotModifyItsInput(t *testing.T) {
	pl := MMPolyline{Points: []MMPoint{{X: 0, Y: 0}, {X: 10, Y: 3}, {X: 21, Y: -4}, {X: 30, Y: 0}}}
	before := append([]MMPoint(nil), pl.Points...)
	cp := FitCurve(pl)
	if len(pl.Points) != len(before) {
		t.Fatalf("input length changed: %d → %d", len(before), len(pl.Points))
	}
	for i := range before {
		if pl.Points[i] != before[i] {
			t.Errorf("input point %d mutated: %v → %v", i, before[i], pl.Points[i])
		}
	}
	// Mutating the output must not reach back into the input.
	cp.Cubics[0].P = MMPoint{X: 999, Y: 999}
	if pl.Points[1] != before[1] {
		t.Error("output shares storage with the input polyline")
	}
}

// ---- emission ------------------------------------------------------------

// TestEmitCurvesSVGEmitsCubicsNotArcs is load-bearing: internal/validate's
// path parser does not implement `A`, it approximates one as a straight line
// and warns, so arc-based smoothing would make downstream validation of this
// output silently wrong.
func TestEmitCurvesSVGEmitsCubicsNotArcs(t *testing.T) {
	paths := []CurvePath{FitCurve(circlePolyline(8, 50))}
	svg := string(EmitCurvesSVG(paths, 200, 200))
	if !strings.Contains(svg, "C") {
		t.Error("emitted no cubic")
	}
	if strings.ContainsAny(svg, "Aa") && strings.Contains(svg, `d="`) {
		// only inspect the path data, not the surrounding markup
		for _, d := range pathDataOf(svg) {
			if strings.ContainsAny(d, "Aa") {
				t.Errorf("path data contains an elliptical arc command: %q", d)
			}
			if strings.ContainsAny(d, "Ll") {
				t.Errorf("path data contains a line command: %q", d)
			}
		}
	}

	// The validator must read it back without an unsupported-path warning.
	polys, _, issues, err := validate.ExtractMMPolylines([]byte(svg))
	if err != nil {
		t.Fatalf("validator could not parse the curves SVG: %v", err)
	}
	if len(polys) != 1 {
		t.Errorf("validator read %d polylines, want 1", len(polys))
	}
	for _, iss := range issues {
		if iss.Rule == validate.RuleUnsupportedPath {
			t.Errorf("validator flagged the curves SVG as unsupported: %s", iss.Message)
		}
	}
}

func pathDataOf(svg string) []string {
	var out []string
	rest := svg
	for {
		i := strings.Index(rest, `d="`)
		if i < 0 {
			return out
		}
		rest = rest[i+3:]
		j := strings.Index(rest, `"`)
		if j < 0 {
			return out
		}
		out = append(out, rest[:j])
		rest = rest[j+1:]
	}
}

// ---- pipeline wiring -----------------------------------------------------

// TestCurvesAreAdditiveAndDoNotTouchThePolyline is the contract of Tier 2 #133:
// the polyline vectorize already returns stays the geometry the bender works
// from. Asking for curves must not move a single byte of it.
//
// Result.SVG is not just an output — it is what internal/server hands to
// generateDesignDoc, so a curve emitted into it would change the bend geometry.
// That is the exact opposite of this row's contract, hence the byte comparison.
func TestCurvesAreAdditiveAndDoNotTouchThePolyline(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "open_neon.png"))
	if err != nil {
		t.Fatalf("read test image: %v", err)
	}
	base := Request{SourceBytes: data, TargetWidthMM: 600, Threshold: 128, DefaultDiameterMM: 12}

	plain, err := VectorizeRaster(context.Background(), base)
	if err != nil {
		t.Fatalf("vectorize (default): %v", err)
	}
	withCurves := base
	withCurves.Curves = true
	curved, err := VectorizeRaster(context.Background(), withCurves)
	if err != nil {
		t.Fatalf("vectorize (curves): %v", err)
	}

	if string(plain.SVG) != string(curved.SVG) {
		t.Error("asking for curves changed the polyline SVG — that SVG becomes the design doc the bender works from")
	}
	if len(plain.Curves) != 0 || len(plain.CurvesSVG) != 0 {
		t.Error("the default path emitted curves; a caller that does not ask must get exactly what it gets today")
	}
	if len(plain.Polylines) != len(curved.Polylines) {
		t.Fatalf("polyline count changed: %d → %d", len(plain.Polylines), len(curved.Polylines))
	}
	for i := range plain.Polylines {
		a, b := plain.Polylines[i], curved.Polylines[i]
		if a.Closed != b.Closed || len(a.Points) != len(b.Points) {
			t.Fatalf("polyline %d shape changed", i)
		}
		for j := range a.Points {
			if a.Points[j] != b.Points[j] {
				t.Fatalf("polyline %d point %d moved: %v → %v", i, j, a.Points[j], b.Points[j])
			}
		}
	}

	// And the two documents are cleanly separated: the fabrication SVG is all
	// line segments, the picture is all cubics.
	poly := string(curved.SVG)
	curves := string(curved.CurvesSVG)
	if strings.Contains(poly, "C") {
		t.Error("the polyline SVG contains a cubic")
	}
	if len(curved.Curves) != len(curved.Polylines) {
		t.Errorf("got %d curve paths for %d polylines", len(curved.Curves), len(curved.Polylines))
	}
	nL, nC := strings.Count(poly, "L"), strings.Count(curves, "C")
	if nL == 0 || nC == 0 {
		t.Fatalf("expected both documents to be non-trivial, got L=%d C=%d", nL, nC)
	}
	for _, d := range pathDataOf(curves) {
		if strings.ContainsAny(d, "LlAa") {
			t.Errorf("curves path data is not all-cubic: %q", d)
		}
	}
	t.Logf("same trace: polyline SVG has %d L commands, curves SVG has %d C commands", nL, nC)

	// Total glass length is materially unchanged.
	var polyLen, curveLen float64
	for i := range curved.Polylines {
		polyLen += polylineLengthMM(curved.Polylines[i])
		curveLen += curved.Curves[i].Length()
	}
	delta := curveLen/polyLen - 1
	if math.Abs(delta) > 0.02 {
		t.Errorf("smoothed length differs by %.3f%%, want within 2%%", delta*100)
	}
	t.Logf("length: polyline %.3f mm, curves %.3f mm (%.4f%%)", polyLen, curveLen, delta*100)
}

// ---- corners (Tier 3 #146) -------------------------------------------------

// openNeonCornersPx are the real corners of open_neon.png's traced
// centerline, in raster pixels (the image is 1200 x 500), located by reading
// the traced polylines. The artwork is heavy block sans: these are every
// place the centerline genuinely turns a corner. Junctions are not listed —
// the tracer ends polylines there, so they are never interior vertices —
// except the P's stem/bowl T, where one polyline runs through and turns 90°.
// The O and the round side of the P bowl have no corners.
var openNeonCornersPx = []struct {
	name string
	px   MMPoint
}{
	{"P stem/bowl", MMPoint{X: 448, Y: 260}},
	{"P top-left", MMPoint{X: 450, Y: 150}},
	{"E top-left", MMPoint{X: 676, Y: 150}},
	{"E bottom-left", MMPoint{X: 676, Y: 348}},
	{"N top-left", MMPoint{X: 872, Y: 186}},
	{"N bottom-right", MMPoint{X: 1026, Y: 314}},
}

// cornerMatchPx is how close (in raster pixels) a detected corner must be to
// a listed one. The tracer chamfers a thick corner across several pixels and
// the detector keeps whichever chamfer vertex turns hardest.
const cornerMatchPx = 14

func traceOpenNeon(t *testing.T, widthMM float64) (*Result, float64) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "open_neon.png"))
	if err != nil {
		t.Fatalf("read test image: %v", err)
	}
	res, err := VectorizeRaster(context.Background(), Request{
		SourceBytes: data, TargetWidthMM: widthMM, Threshold: 128, DefaultDiameterMM: 12,
	})
	if err != nil {
		t.Fatalf("vectorize: %v", err)
	}
	return res, widthMM / float64(res.WidthPx)
}

// smoothWaveRaster draws a 12 mm stroke along a sine wave whose tightest
// turn (at each crest) has radius minRadiusMM, at the given resolution, and
// returns it as a PNG. Real script is what the detector must leave alone,
// and a wave lets the tightest turn be dialled in rather than guessed.
func smoothWaveRaster(minRadiusMM, mmPerPx float64) []byte {
	const (
		wMM, hMM   = 640.0, 300.0
		strokeMM   = 12.0
		wavelength = 160.0
	)
	amp := wavelength * wavelength / (4 * math.Pi * math.Pi * minRadiusMM) // crest radius = λ²/(4π²A)
	W, H := int(wMM/mmPerPx), int(hMM/mmPerPx)
	img := image.NewGray(image.Rect(0, 0, W, H))
	for i := range img.Pix {
		img.Pix[i] = 255
	}
	r := strokeMM / 2 / mmPerPx
	for x := 30.0; x <= wMM-30; x += mmPerPx / 4 {
		cx := x / mmPerPx
		cy := (hMM/2 + amp*math.Sin(2*math.Pi*x/wavelength)) / mmPerPx
		for py := int(cy - r - 1); py <= int(cy+r+1); py++ {
			for px := int(cx - r - 1); px <= int(cx+r+1); px++ {
				if px < 0 || py < 0 || px >= W || py >= H {
					continue
				}
				if math.Hypot(float64(px)+0.5-cx, float64(py)+0.5-cy) <= r {
					img.SetGray(px, py, color.Gray{})
				}
			}
		}
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		panic(err)
	}
	return buf.Bytes()
}

func traceBytes(t *testing.T, data []byte, widthMM float64) []MMPolyline {
	t.Helper()
	res, err := VectorizeRaster(context.Background(), Request{
		SourceBytes: data, TargetWidthMM: widthMM, Threshold: 128, DefaultDiameterMM: 12,
	})
	if err != nil {
		t.Fatalf("vectorize: %v", err)
	}
	return res.Polylines
}

// cornerPoints returns the vertices detectCorners marks across pls, using
// the same de-duplication FitCurve applies.
func cornerPoints(pls []MMPolyline, supportMM, minTurnDeg float64) []MMPoint {
	var out []MMPoint
	for _, pl := range pls {
		pts := dedupeAdjacent(pl.Points, pl.Closed)
		corners := detectCorners(pts, pl.Closed && len(pts) >= 3, supportMM, minTurnDeg)
		for i := range pts {
			if corners != nil && corners[i] {
				out = append(out, pts[i])
			}
		}
	}
	return out
}

// localDeviationMM is maxDeviationMM restricted to the part of the fitted
// path within radiusMM of c: how far the curve leaves the polyline AT a
// corner, as opposed to anywhere along the run.
func localDeviationMM(cp CurvePath, pl MMPolyline, c MMPoint, radiusMM float64) float64 {
	const samples = 64
	worst := 0.0
	starts := cubicStarts(cp)
	for i, cu := range cp.Cubics {
		for s := 0; s <= samples; s++ {
			q := CubicAt(starts[i], cu, float64(s)/samples)
			if math.Hypot(q.X-c.X, q.Y-c.Y) > radiusMM {
				continue
			}
			if d := distToPolylineMM(q, pl); d > worst {
				worst = d
			}
		}
	}
	return worst
}

// TestCornerSurvivesTheFit is the headline of Tier 3 #146: a corner the
// artwork actually contains must come out of the smooth fit as a corner.
func TestCornerSurvivesTheFit(t *testing.T) {
	t.Run("synthetic 90 degree corner", func(t *testing.T) {
		// Two 100 mm legs meeting square, sampled every 50 mm — about the
		// spacing RDP leaves on a traced straight stroke.
		var pts []MMPoint
		for x := 0.0; x <= 100; x += 50 {
			pts = append(pts, MMPoint{X: x, Y: 0})
		}
		for y := 50.0; y <= 100; y += 50 {
			pts = append(pts, MMPoint{X: 100, Y: y})
		}
		pl := MMPolyline{Points: pts}
		before := maxDeviationMM(fitCurveAlpha(pl, CatmullRomAlpha), pl)
		after := maxDeviationMM(FitCurve(pl), pl)
		t.Logf("synthetic 90° corner, 50 mm samples: deviation %.3f mm without corner detection, %.6f mm with", before, after)
		// Negative control: the plain spline really does round this corner.
		if before < 3 {
			t.Fatalf("plain fit deviates only %.3f mm — the fixture no longer exercises a rounded corner", before)
		}
		// Each leg is an evenly-sampled straight span, which the fit
		// reproduces exactly once the corner is split.
		if after > 1e-9 {
			t.Errorf("corner-split fit deviates %.6f mm from a square corner, want 0", after)
		}
		breaks := tangentBreakJoints(FitCurve(pl))
		if !equalInts(breaks, []int{1}) {
			t.Errorf("tangent breaks at joints %v, want exactly [1] (the corner vertex)", breaks)
		}
	})

	t.Run("traced P stem/bowl corner", func(t *testing.T) {
		// The ~3.6 mm the row was filed for: open_neon.png at the 600 mm
		// production default, P bowl loop, where the bowl's bottom bar meets
		// the stem at a crisp 90°. Measured: 3.106 mm at the corner (3.556 mm
		// anywhere on the loop) without corner detection; 0.170 mm at the
		// corner (0.558 mm anywhere on the loop, which is staircase wobble on
		// the round side, not the corner) with it.
		res, mmPerPx := traceOpenNeon(t, 600)
		c := MMPoint{X: openNeonCornersPx[0].px.X * mmPerPx, Y: openNeonCornersPx[0].px.Y * mmPerPx}
		const radiusMM = 10
		found := false
		for _, pl := range res.Polylines {
			if distToPolylineMM(c, pl) > cornerMatchPx*mmPerPx || len(pl.Points) < 10 {
				continue
			}
			found = true
			before := localDeviationMM(fitCurveAlpha(pl, CatmullRomAlpha), pl, c, radiusMM)
			after := localDeviationMM(FitCurve(pl), pl, c, radiusMM)
			t.Logf("P stem/bowl corner: deviation at the corner %.3f mm before, %.3f mm after; "+
				"anywhere on the loop %.3f mm before, %.3f mm after",
				before, after, maxDeviationMM(fitCurveAlpha(pl, CatmullRomAlpha), pl), maxDeviationMM(FitCurve(pl), pl))
			if before < 2.5 {
				t.Fatalf("plain fit deviates only %.3f mm at the corner — negative control gone; the trace changed", before)
			}
			if after > 0.5 {
				t.Errorf("corner-split fit still deviates %.3f mm at the corner, want <= 0.5 mm", after)
			}
		}
		if !found {
			t.Fatal("no traced polyline passes through the P stem/bowl corner")
		}
	})
}

// TestCornerDetectorLeavesSmoothCurvesAlone: the detector must not fire on a
// script. Smooth traced curves — the O, the U golden, and rasterised waves —
// must come out with no corners and therefore G1 at every joint, exactly as
// #133 fitted them.
func TestCornerDetectorLeavesSmoothCurvesAlone(t *testing.T) {
	check := func(t *testing.T, pls []MMPolyline) {
		t.Helper()
		if len(pls) == 0 {
			t.Fatal("trace produced no polylines")
		}
		for i, pl := range pls {
			if c := cornerPoints([]MMPolyline{pl}, cornerSupportMM, cornerMinTurnDeg); len(c) != 0 {
				t.Errorf("polyline %d: detector fired at %v on a smooth curve", i, c)
			}
			if b := tangentBreakJoints(FitCurve(pl)); len(b) != 0 {
				t.Errorf("polyline %d: tangent breaks at joints %v on a smooth curve", i, b)
			}
			if !equalCurves(FitCurve(pl), fitCurveAlpha(pl, CatmullRomAlpha)) {
				t.Errorf("polyline %d: with no corners FitCurve must equal the plain #133 fit exactly", i)
			}
		}
	}
	t.Run("open_neon O", func(t *testing.T) {
		res, _ := traceOpenNeon(t, 600)
		var o []MMPolyline
		for _, pl := range res.Polylines {
			if pl.Closed && pl.Points[0].X < 200 { // the O is the only closed loop left of x = 200 mm
				o = append(o, pl)
			}
		}
		if len(o) != 1 {
			t.Fatalf("found %d O loops, want 1", len(o))
		}
		check(t, o)
	})
	t.Run("curve_u golden", func(t *testing.T) {
		data, err := os.ReadFile(filepath.Join("testdata", "goldens", "curve_u.png"))
		if err != nil {
			t.Fatal(err)
		}
		check(t, traceBytes(t, data, 160))
	})
	for _, r := range []float64{12, 16, 24} {
		for _, m := range []float64{0.5, 1.0} {
			t.Run(fmt.Sprintf("wave R=%gmm @%gmm/px", r, m), func(t *testing.T) {
				check(t, traceBytes(t, smoothWaveRaster(r, m), 640))
			})
		}
	}
}

func equalCurves(a, b CurvePath) bool {
	if a.Start != b.Start || a.Closed != b.Closed || len(a.Cubics) != len(b.Cubics) {
		return false
	}
	for i := range a.Cubics {
		if a.Cubics[i] != b.Cubics[i] {
			return false
		}
	}
	return true
}

// TestOpenNeonTangentBreaksAreTheArtworksCorners is #133's tangent-break count
// carried forward honestly. #133 measured 368 breaks in the traced polyline
// and 0 in the fit. open_neon.png is block lettering, not a script: it has
// six real corners, so after #146 the right count is six — one at each, and
// none anywhere else. A seventh break is tracer noise leaking through as
// faceting; a fifth is a corner rounded off again.
func TestOpenNeonTangentBreaksAreTheArtworksCorners(t *testing.T) {
	res, mmPerPx := traceOpenNeon(t, 600)
	polyBreaks := 0
	hits := make([]int, len(openNeonCornersPx))
	total := 0
	for pi, pl := range res.Polylines {
		n := len(pl.Points)
		for i := 0; i < n; i++ {
			if !pl.Closed && (i == 0 || i == n-1) {
				continue
			}
			a, b, c := pl.Points[(i-1+n)%n], pl.Points[i], pl.Points[(i+1)%n]
			if angleBetween(subPt(b, a), subPt(c, b)) > 1e-9 {
				polyBreaks++
			}
		}
		cp := FitCurve(pl)
		for _, j := range tangentBreakJoints(cp) {
			total++
			v := cp.Cubics[j].P // the vertex at joint j
			matched := false
			for k, gc := range openNeonCornersPx {
				if math.Hypot(v.X/mmPerPx-gc.px.X, v.Y/mmPerPx-gc.px.Y) <= cornerMatchPx {
					hits[k]++
					matched = true
				}
			}
			if !matched {
				t.Errorf("polyline %d: tangent break at (%.1f, %.1f) mm is not a corner of the artwork", pi, v.X, v.Y)
			}
		}
	}
	for k, h := range hits {
		if h != 1 {
			t.Errorf("%s: %d tangent breaks, want exactly 1", openNeonCornersPx[k].name, h)
		}
	}
	if polyBreaks != 368 {
		t.Errorf("traced polyline has %d direction breaks, #133 measured 368 — the trace changed, re-measure", polyBreaks)
	}
	t.Logf("open_neon: traced polyline has %d direction breaks; the smooth fit has %d, one per real corner", polyBreaks, total)
}

// TestCornerThresholdSweep re-runs the measurement cornerMinTurnDeg was chosen
// from, so the choice is pinned to data rather than to a comment. Real
// corners: open_neon.png traced at 300 and 600 mm wide. Things that must not
// fire: rasterised smooth waves (crest radius 8–24 mm, 0.5 and 1.0 mm/px)
// and the curve_u golden. See the constants' comment for the numbers.
func TestCornerThresholdSweep(t *testing.T) {
	type cornered struct {
		name    string
		pls     []MMPolyline
		corners []MMPoint
		tolMM   float64
	}
	var real []cornered
	for _, w := range []float64{300, 600} {
		res, m := traceOpenNeon(t, w)
		var gt []MMPoint
		for _, c := range openNeonCornersPx {
			gt = append(gt, MMPoint{X: c.px.X * m, Y: c.px.Y * m})
		}
		real = append(real, cornered{fmt.Sprintf("open_neon@%gmm", w), res.Polylines, gt, cornerMatchPx * m})
	}
	smooth := map[string][]MMPolyline{}
	for _, r := range []float64{8, 12, 16, 24} {
		for _, m := range []float64{0.5, 1.0} {
			smooth[fmt.Sprintf("wave R=%g @%g", r, m)] = traceBytes(t, smoothWaveRaster(r, m), 640)
		}
	}
	data, err := os.ReadFile(filepath.Join("testdata", "goldens", "curve_u.png"))
	if err != nil {
		t.Fatal(err)
	}
	smooth["curve_u"] = traceBytes(t, data, 160)

	// misses and false corners at threshold th.
	score := func(th float64) (misses, falses int) {
		for _, set := range real {
			hit := make([]bool, len(set.corners))
			for _, p := range cornerPoints(set.pls, cornerSupportMM, th) {
				ok := false
				for k, c := range set.corners {
					if math.Hypot(p.X-c.X, p.Y-c.Y) <= set.tolMM {
						hit[k], ok = true, true
					}
				}
				if !ok {
					falses++
				}
			}
			for _, h := range hit {
				if !h {
					misses++
				}
			}
		}
		for _, pls := range smooth {
			falses += len(cornerPoints(pls, cornerSupportMM, th))
		}
		return misses, falses
	}

	clean := map[float64]bool{}
	for th := 30.0; th <= 70; th += 5 {
		m, f := score(th)
		clean[th] = m == 0 && f == 0
		t.Logf("support %g mm, threshold %2.0f°: %d real corners missed, %d false corners", cornerSupportMM, th, m, f)
	}
	if m, f := score(cornerMinTurnDeg); m != 0 || f != 0 {
		t.Errorf("at the chosen %g°: %d corners missed, %d false corners — want a clean result", cornerMinTurnDeg, m, f)
	}
	// The band the comment claims, and that it has edges: the sweep must
	// actually go dirty on both sides, or it is not measuring anything.
	for th := 45.0; th <= 60; th += 5 {
		if !clean[th] {
			t.Errorf("threshold %g° is not clean; the documented clean band is 45–60°", th)
		}
	}
	if clean[40] {
		t.Error("40° is clean — tracer noise no longer fires below the band, so the margin claimed for it is unmeasured")
	}
	if clean[65] {
		t.Error("65° is clean — real corners are no longer missed above the band, so the margin claimed for it is unmeasured")
	}

	// The raw readings behind the margins: the noisiest windowed turn away
	// from any corner, and the weakest real corner's strongest reading.
	toDeg := 180 / math.Pi
	noise, weakest := 0.0, math.Inf(1)
	scan := func(pls []MMPolyline, corners []MMPoint, tol float64) {
		for _, pl := range pls {
			pts := dedupeAdjacent(pl.Points, pl.Closed)
			turns := windowedTurns(pts, pl.Closed && len(pts) >= 3, cornerSupportMM)
			for i, a := range turns {
				if math.IsNaN(a) {
					continue
				}
				near := false
				for _, c := range corners {
					if math.Hypot(pts[i].X-c.X, pts[i].Y-c.Y) <= tol+cornerSupportMM {
						near = true
					}
				}
				if !near {
					noise = math.Max(noise, a*toDeg)
				}
			}
		}
	}
	for _, set := range real {
		scan(set.pls, set.corners, set.tolMM)
		for _, c := range set.corners {
			best := 0.0
			for _, pl := range set.pls {
				pts := dedupeAdjacent(pl.Points, pl.Closed)
				turns := windowedTurns(pts, pl.Closed && len(pts) >= 3, cornerSupportMM)
				for i, a := range turns {
					if !math.IsNaN(a) && math.Hypot(pts[i].X-c.X, pts[i].Y-c.Y) <= set.tolMM {
						best = math.Max(best, a*toDeg)
					}
				}
			}
			weakest = math.Min(weakest, best)
		}
	}
	for _, pls := range smooth {
		scan(pls, nil, 0)
	}
	t.Logf("noisiest reading away from a corner %.1f°, weakest real corner %.1f°, chosen %g° (margins %.1f° / %.1f°)",
		noise, weakest, cornerMinTurnDeg, cornerMinTurnDeg-noise, weakest-cornerMinTurnDeg)
	if cornerMinTurnDeg-noise < 5 || weakest-cornerMinTurnDeg < 5 {
		t.Errorf("margin under 5° (noise %.1f°, weakest corner %.1f°, threshold %g°)", noise, weakest, cornerMinTurnDeg)
	}
}

// TestWindowedTurnIgnoresPixelStaircase: the reason the turn is windowed. A
// one-pixel staircase is a 90° turn at every vertex, which is what the
// traced polyline is made of; over the support it is a straight line.
func TestWindowedTurnIgnoresPixelStaircase(t *testing.T) {
	// A 1:4 staircase at 0.5 mm/px — the slope of the N's diagonal.
	var pts []MMPoint
	x, y := 0.0, 0.0
	for k := 0; k < 30; k++ {
		pts = append(pts, MMPoint{X: x, Y: y})
		x += 2
		pts = append(pts, MMPoint{X: x, Y: y})
		y += 0.5
	}
	worstVertex := 0.0
	for i := 1; i+1 < len(pts); i++ {
		worstVertex = math.Max(worstVertex, angleBetween(subPt(pts[i], pts[i-1]), subPt(pts[i+1], pts[i]))*180/math.Pi)
	}
	if worstVertex < 89 {
		t.Fatalf("fixture is not a staircase: worst vertex turn %.1f°", worstVertex)
	}
	if c := detectCorners(pts, false, cornerSupportMM, cornerMinTurnDeg); c != nil {
		t.Errorf("staircase with %.0f° vertex turns detected as corners", worstVertex)
	}
	// And a clockwise corner is found as well as a counter-clockwise one:
	// the turn is a magnitude (CLAUDE.md bug class 5).
	for _, sign := range []float64{1, -1} {
		var l []MMPoint
		for v := 0.0; v <= 40; v += 2 {
			l = append(l, MMPoint{X: v, Y: 0})
		}
		for v := 2.0; v <= 40; v += 2 {
			l = append(l, MMPoint{X: 40, Y: sign * v})
		}
		c := detectCorners(l, false, cornerSupportMM, cornerMinTurnDeg)
		n := 0
		for i := range l {
			if c != nil && c[i] {
				n++
				if l[i] != (MMPoint{X: 40, Y: 0}) {
					t.Errorf("sign %v: corner at %v, want (40, 0)", sign, l[i])
				}
			}
		}
		if n != 1 {
			t.Errorf("sign %v: %d corners, want 1", sign, n)
		}
	}
}
