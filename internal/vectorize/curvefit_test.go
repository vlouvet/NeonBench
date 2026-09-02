package vectorize

import (
	"context"
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
func TestFitCurveIsG1Continuous(t *testing.T) {
	cases := map[string]MMPolyline{
		"open":   {Points: []MMPoint{{X: 0, Y: 0}, {X: 12, Y: 0}, {X: 12, Y: 12}, {X: 0, Y: 12}, {X: 3, Y: 25}}},
		"closed": circlePolyline(12, 40),
	}
	for name, pl := range cases {
		t.Run(name, func(t *testing.T) {
			cp := FitCurve(pl)
			starts := cubicStarts(cp)
			last := len(cp.Cubics) - 1
			if cp.Closed {
				last = len(cp.Cubics)
			}
			for i := 0; i < last; i++ {
				j := (i + 1) % len(cp.Cubics)
				in := cubicTangent(starts[i], cp.Cubics[i], 1)
				out := cubicTangent(starts[j], cp.Cubics[j], 0)
				if a := angleBetween(in, out) * 180 / math.Pi; a > 1e-6 {
					t.Errorf("tangent break of %.6f deg at joint %d — that is a facet", a, i)
				}
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
