package vectorize

import (
	"bytes"
	"fmt"
	"math"
	"sort"
)

// CatmullRomAlpha is the Catmull-Rom knot-parameterization exponent, pinned
// to the centripetal value.
//
// DO NOT "simplify" this to 0 (the uniform form). Uniform Catmull-Rom
// overshoots into a cusp wherever two samples sit close together — exactly
// what happens at the tight turns in a script, i.e. the places this feature
// exists to improve. The regression would look like a rendering glitch
// rather than a parameterization error, so it would be hunted for in the
// wrong file. TestCentripetalAvoidsCuspOnCloseSamples fits the same
// pathological input at both alphas and asserts the difference.
const CatmullRomAlpha = 0.5

// coincidentTolMM is how close two samples have to be before we treat them
// as the same point. Centripetal parameterization degrades gracefully as
// the gap shrinks (the tangent magnitude goes to zero rather than to
// infinity), but an exactly-zero gap is a 0/0, so duplicates are dropped
// before the fit rather than guarded inside it.
const coincidentTolMM = 1e-9

// What counts as a corner (Tier 3 #146): a vertex whose windowed turn —
// the angle between the chord arriving from cornerSupportMM back along the
// polyline and the chord leaving to cornerSupportMM ahead — is at least
// cornerMinTurnDeg. Both numbers come from a sweep over traced artwork,
// not from eyeballing; TestCornerThresholdSweep re-runs it and fails if
// the chosen values drift out of the clean band.
//
// Measured windowed turns at the 8 mm support (open_neon.png traced at
// 300 and 600 mm wide, plus rasterised smooth waves of minimum radius 8,
// 12, 16 and 24 mm traced at 0.5 and 1.0 mm/px, 12 mm stroke):
//
//   - tracer noise and smooth curves, everywhere away from a real corner:
//     at most 44.7° (open_neon @300; the tightest wave, R = 8 mm, reads
//     42.9°; the O and the P bowl read at most 35°)
//   - the weakest real corner: 61.9° (the E's chamfered bottom-left at the
//     600 mm production-default trace); the P's stem/bowl corner reads 90°
//
// The threshold sweep at this support is clean — every real corner found,
// nothing else — for every threshold from 45° to 60°; at 40° the waves and
// the small trace start firing, at 65° the E's corners start being missed.
// 55° sits 10.3° above the noisiest reading and 6.9° below the weakest
// corner. It leans toward the corner side on purpose: a missed corner just
// rounds, as every corner did before this existed, whereas a false corner
// puts a kink into a script, which is a new defect.
//
// The support is the other half of the choice. It has to be long enough
// that a one-pixel staircase step (a 90° vertex turn by itself) averages
// out, and short enough that a tight smooth turn does not read as a
// corner: a circular arc of radius R reads s/R radians, so 8 mm at 55°
// treats a turn tighter than R ≈ 8.3 mm as a corner. Across supports of
// 4, 6, 8, 10 and 12 mm the clean band was widest at 8 mm (4 mm: 40° only;
// 6 mm: 40–50°; 10 mm: 55–65°; 12 mm: 65–70°).
//
// Known limit, measured: the tracer chamfers a corner of a thick stroke,
// and the chamfer grows with the stroke in millimetres. Traced at 1200 mm
// wide, open_neon's E and N corners become two 45° half-corners about
// 9 mm apart — geometrically the same as a ~8 mm-radius curve — and stay
// rounded exactly as before; only the crisp P stem/bowl corner is split.
// No support/threshold pair separates those from the tight waves.
//
// Deliberately independent of internal/validate's sharp-bend threshold:
// that rule judges what glass can be bent, this one what the picture draws.
// Coupling one rule's knob to the other is the mistake Tier 1 #142 undid.
const (
	cornerSupportMM  = 8.0
	cornerMinTurnDeg = 55.0
)

// Cubic is one cubic Bezier segment expressed the way SVG's `C` command
// wants it: two control points and an endpoint. The start point is the
// previous segment's endpoint (or CurvePath.Start for the first).
type Cubic struct {
	C1, C2, P MMPoint
}

// CurvePath is a smooth rendering of one MMPolyline: the same vertices,
// joined by cubics instead of straight lines.
//
// This is a picture, not a fabrication input. The MMPolyline it was fitted
// from remains the geometry the bender works from; nothing here may enter a
// designdoc.Doc. See FitCurve's doc comment.
type CurvePath struct {
	Start  MMPoint
	Cubics []Cubic
	Closed bool
}

// FitCurve fits centripetal Catmull-Rom cubics through every vertex of pl
// and returns them as Bezier segments.
//
// The fit *interpolates*: every input sample is an endpoint of some cubic,
// so the smoothed centerline still runs down the letterform. That is the
// difference between this and raising `smoothing_mm` until the faceting
// disappears — the latter also walks the centerline off the letterform,
// trading a visible defect for an invisible one.
//
// pl is not modified; the returned CurvePath shares no storage with it.
//
// End condition for open polylines: the phantom neighbours are reflections
// of the second/second-to-last vertex through the endpoint
// (P-1 = 2*P0 - P1). Duplicating the endpoint instead — the other common
// choice — puts a zero-length gap at the end, and under centripetal
// parameterization a zero gap is exactly the 0^alpha = 0 knot spacing that
// makes the tangent formula divide by zero. Reflection also has the
// property that a two-point polyline, and any run of evenly-spaced
// collinear points, fits to itself exactly. Closed polylines wrap instead,
// with no phantom points and a cubic for the closing segment.
//
// Corners (Tier 3 #146): an interpolating spline cannot hold a tangent
// discontinuity, so fitted straight through, a real 90° corner rounds off
// by several millimetres. FitCurve therefore detects corner vertices
// (detectCorners) and fits each span between them independently: the end
// condition above is applied at a corner exactly as at an open end, so the
// two spans meeting there are separate curves and the join is a genuine
// tangent break. Inside a span the fit — and its G1 guarantee — is
// unchanged, and a polyline with no corners fits exactly as it did before
// corner detection existed. Every sample is still interpolated and there is
// still one cubic per polyline segment, in the same order.
func FitCurve(pl MMPolyline) CurvePath {
	pts := dedupeAdjacent(pl.Points, pl.Closed)
	closed := pl.Closed && len(pts) >= 3
	corners := detectCorners(pts, closed, cornerSupportMM, cornerMinTurnDeg)
	return fitSpans(pts, closed, CatmullRomAlpha, corners)
}

// fitCurveAlpha is the plain Catmull-Rom fit — no corner detection — with
// the knot exponent left open, so tests can build the uniform (alpha = 0)
// fit and show what it does. Production code calls FitCurve; alpha is not
// a tunable knob.
//
// IF A CORNER IS ROUNDING, ALPHA IS NOT THE FIX. It is the visible
// parameter and changing it here is a one-character edit, which is why
// this is written down: alpha only sets the knot spacing, and the
// parameterisation is continuous for every value of it, so no alpha can
// produce a tangent break. Lowering it toward 0 reintroduces the cusp
// overshoot at tight turns (TestCentripetalAvoidsCuspOnCloseSamples)
// while leaving the corner exactly as round. Corners are handled by
// segmenting the polyline — see detectCorners and cornerMinTurnDeg.
func fitCurveAlpha(pl MMPolyline, alpha float64) CurvePath {
	pts := dedupeAdjacent(pl.Points, pl.Closed)
	closed := pl.Closed && len(pts) >= 3
	return fitSpans(pts, closed, alpha, nil)
}

// fitSpans fits Catmull-Rom cubics through pts (already de-duplicated),
// treating every vertex flagged in corners as a span boundary: at a corner
// the neighbour on the far side is ignored and replaced by the same
// reflected phantom an open end uses, so each span is fitted as if it were
// its own open polyline. corners may be nil (no corners).
func fitSpans(pts []MMPoint, closed bool, alpha float64, corners []bool) CurvePath {
	isCorner := func(i int) bool { return corners != nil && corners[i] }
	out := CurvePath{Closed: closed}
	if len(pts) == 0 {
		return out
	}
	out.Start = pts[0]
	if len(pts) < 2 {
		return out
	}

	n := len(pts)
	segs := n - 1
	if closed {
		segs = n
	}
	out.Cubics = make([]Cubic, 0, segs)
	for i := 0; i < segs; i++ {
		p1 := pts[i]
		p2 := pts[(i+1)%n]
		var p0, p3 MMPoint
		if closed {
			p0 = pts[(i-1+n)%n]
			p3 = pts[(i+2)%n]
		} else {
			if i == 0 {
				p0 = reflectPt(p1, p2) // phantom: 2*p1 - p2
			} else {
				p0 = pts[i-1]
			}
			if i+2 <= n-1 {
				p3 = pts[i+2]
			} else {
				p3 = reflectPt(p2, p1) // phantom: 2*p2 - p1
			}
		}
		// A corner ends the span: same phantom as an open end.
		if isCorner(i) {
			p0 = reflectPt(p1, p2)
		}
		if isCorner((i + 1) % n) {
			p3 = reflectPt(p2, p1)
		}
		m1, m2 := catmullRomTangents(p0, p1, p2, p3, alpha)
		out.Cubics = append(out.Cubics, Cubic{
			C1: MMPoint{X: p1.X + m1.X/3, Y: p1.Y + m1.Y/3},
			C2: MMPoint{X: p2.X - m2.X/3, Y: p2.Y - m2.Y/3},
			P:  p2,
		})
	}
	return out
}

// catmullRomTangents returns the Catmull-Rom tangents at p1 and p2 for the
// segment p1→p2, using knot spacing |dP|^alpha (alpha = 0.5 is centripetal,
// alpha = 0 is uniform).
//
//	m1 = (p2-p1) + t12 * ( (p1-p0)/t01 - (p2-p0)/(t01+t12) )
//	m2 = (p2-p1) + t12 * ( (p3-p2)/t23 - (p3-p1)/(t12+t23) )
func catmullRomTangents(p0, p1, p2, p3 MMPoint, alpha float64) (m1, m2 MMPoint) {
	t01 := knotSpan(p0, p1, alpha)
	t12 := knotSpan(p1, p2, alpha)
	t23 := knotSpan(p2, p3, alpha)
	chord := subPt(p2, p1)
	if t12 <= 0 {
		// Coincident segment endpoints: a zero-length segment has no
		// direction to carry, so both tangents are zero and the cubic
		// collapses to the point. dedupeAdjacent normally prevents this.
		return MMPoint{}, MMPoint{}
	}
	if t01 <= 0 {
		m1 = chord
	} else {
		m1 = addPt(chord, scalePt(subPt(scalePt(subPt(p1, p0), 1/t01), scalePt(subPt(p2, p0), 1/(t01+t12))), t12))
	}
	if t23 <= 0 {
		m2 = chord
	} else {
		m2 = addPt(chord, scalePt(subPt(scalePt(subPt(p3, p2), 1/t23), scalePt(subPt(p3, p1), 1/(t12+t23))), t12))
	}
	return m1, m2
}

// arcLengths returns cum with cum[k] = the arc length from pts[0] to vertex
// k; for a closed polyline it has one extra entry, the full loop length
// back to pts[0].
func arcLengths(pts []MMPoint, closed bool) []float64 {
	n := len(pts)
	segs := n - 1
	if closed {
		segs = n
	}
	if segs < 0 {
		segs = 0
	}
	cum := make([]float64, segs+1)
	for k := 0; k < segs; k++ {
		a, b := pts[k], pts[(k+1)%n]
		cum[k+1] = cum[k] + math.Hypot(b.X-a.X, b.Y-a.Y)
	}
	return cum
}

// windowedTurns returns, for every vertex of pts, the turn angle in
// radians (unsigned, 0..π) between the chord arriving at it from the point
// supportMM back along the polyline and the chord leaving it to the point
// supportMM ahead. A vertex without a full supportMM of polyline on both
// sides (near an open end, or on a closed loop shorter than 2*supportMM)
// gets NaN: its turn cannot be told apart from tracer noise, so it is
// never a corner.
//
// Why a windowed turn and not the turn at the vertex: the tracer's
// centerline is a pixel staircase, and a one-pixel step is a 90° vertex
// turn — on open_neon.png the traced polyline turns at 368 vertices, dozens
// of them by exactly 90°, and only six of them are corners. Measured over a
// support of a few millimetres a staircase averages out to its true
// direction while a real corner still reads as its full angle.
func windowedTurns(pts []MMPoint, closed bool, supportMM float64) []float64 {
	n := len(pts)
	out := make([]float64, n)
	for i := range out {
		out[i] = math.NaN()
	}
	if n < 3 {
		return out
	}
	cum := arcLengths(pts, closed)
	total := cum[len(cum)-1]
	if closed && total <= 2*supportMM {
		return out
	}
	// at returns the point at arc position s (0 <= s <= total).
	at := func(s float64) MMPoint {
		k := sort.SearchFloat64s(cum, s) // first k with cum[k] >= s
		if k == 0 {
			return pts[0]
		}
		a, b := pts[k-1], pts[k%n]
		span := cum[k] - cum[k-1]
		if span <= 0 {
			return b
		}
		t := (s - cum[k-1]) / span
		return MMPoint{X: a.X + t*(b.X-a.X), Y: a.Y + t*(b.Y-a.Y)}
	}
	for i := 0; i < n; i++ {
		s := cum[i]
		back, fwd := s-supportMM, s+supportMM
		if closed {
			back = math.Mod(back+total, total)
			fwd = math.Mod(fwd, total)
		} else if back < 0 || fwd > total {
			continue
		}
		in := subPt(pts[i], at(back))
		outv := subPt(at(fwd), pts[i])
		t1 := math.Atan2(in.Y, in.X)
		t2 := math.Atan2(outv.Y, outv.X)
		out[i] = math.Abs(math.Atan2(math.Sin(t2-t1), math.Cos(t2-t1)))
	}
	return out
}

// detectCorners marks the vertices of pts (already de-duplicated) where the
// polyline has a real corner: a windowed turn (see windowedTurns) of at
// least minTurnDeg, measured over supportMM each side. A corner smeared
// across several samples — the tracer often chamfers one corner into two
// or three small steps — would clear the threshold at each of them, so
// only the strongest vertex within supportMM of arc length is kept: one
// corner, one split. Open-polyline endpoints are never marked; they are
// span ends already.
//
// The returned slice is nil when there are no corners, which fitSpans
// treats exactly like the plain fit.
func detectCorners(pts []MMPoint, closed bool, supportMM, minTurnDeg float64) []bool {
	turns := windowedTurns(pts, closed, supportMM)
	minTurn := minTurnDeg * math.Pi / 180
	var cand []int
	for i, a := range turns {
		if !math.IsNaN(a) && a >= minTurn {
			cand = append(cand, i)
		}
	}
	if len(cand) == 0 {
		return nil
	}
	// Strongest first; ties go to the lower index so the result does not
	// depend on sort stability.
	sort.Slice(cand, func(x, y int) bool {
		if turns[cand[x]] != turns[cand[y]] {
			return turns[cand[x]] > turns[cand[y]]
		}
		return cand[x] < cand[y]
	})
	n := len(pts)
	cum := arcLengths(pts, closed)
	total := cum[len(cum)-1]
	arcDist := func(i, j int) float64 {
		d := math.Abs(cum[i] - cum[j])
		if closed {
			d = math.Min(d, total-d)
		}
		return d
	}
	corners := make([]bool, n)
	var kept []int
	for _, c := range cand {
		ok := true
		for _, k := range kept {
			if arcDist(c, k) < supportMM {
				ok = false
				break
			}
		}
		if ok {
			kept = append(kept, c)
			corners[c] = true
		}
	}
	return corners
}

func knotSpan(a, b MMPoint, alpha float64) float64 {
	d := math.Hypot(b.X-a.X, b.Y-a.Y)
	if d <= coincidentTolMM {
		return 0
	}
	if alpha == 0 {
		return 1 // uniform parameterization: every knot span is 1
	}
	return math.Pow(d, alpha)
}

// dedupeAdjacent drops samples that repeat their predecessor. For a closed
// polyline the wrap-around pair is checked too, so a caller that left the
// start point duplicated at the end does not get a zero-length closing
// cubic. The input slice is never modified.
func dedupeAdjacent(pts []MMPoint, closed bool) []MMPoint {
	if len(pts) == 0 {
		return nil
	}
	out := make([]MMPoint, 0, len(pts))
	out = append(out, pts[0])
	for _, p := range pts[1:] {
		if coincidentPt(p, out[len(out)-1]) {
			continue
		}
		out = append(out, p)
	}
	for closed && len(out) > 1 && coincidentPt(out[len(out)-1], out[0]) {
		out = out[:len(out)-1]
	}
	return out
}

func coincidentPt(a, b MMPoint) bool {
	return math.Hypot(a.X-b.X, a.Y-b.Y) <= coincidentTolMM
}

// reflectPt returns the mirror of q through p (2*p - q).
func reflectPt(p, q MMPoint) MMPoint { return MMPoint{X: 2*p.X - q.X, Y: 2*p.Y - q.Y} }

func subPt(a, b MMPoint) MMPoint           { return MMPoint{X: a.X - b.X, Y: a.Y - b.Y} }
func addPt(a, b MMPoint) MMPoint           { return MMPoint{X: a.X + b.X, Y: a.Y + b.Y} }
func scalePt(a MMPoint, k float64) MMPoint { return MMPoint{X: a.X * k, Y: a.Y * k} }

// CubicAt evaluates the cubic Bezier from p0 through c at parameter t.
func CubicAt(p0 MMPoint, c Cubic, t float64) MMPoint {
	u := 1 - t
	a := u * u * u
	b := 3 * u * u * t
	cc := 3 * u * t * t
	d := t * t * t
	return MMPoint{
		X: a*p0.X + b*c.C1.X + cc*c.C2.X + d*c.P.X,
		Y: a*p0.Y + b*c.C1.Y + cc*c.C2.Y + d*c.P.Y,
	}
}

// Length returns the arc length of the fitted path, measured by uniform
// subdivision of each cubic. Used to check that smoothing does not shortcut
// corners: a fit that cut corners would under-report glass.
func (cp CurvePath) Length() float64 {
	const stepsPerCubic = 64
	total := 0.0
	prev := cp.Start
	for _, c := range cp.Cubics {
		start := prev
		for s := 1; s <= stepsPerCubic; s++ {
			q := CubicAt(start, c, float64(s)/stepsPerCubic)
			total += math.Hypot(q.X-prev.X, q.Y-prev.Y)
			prev = q
		}
		prev = c.P
	}
	return total
}

// EmitCurvesSVG renders fitted curve paths into an SVG document with the
// same mm width/height/viewBox convention as EmitSVG.
//
// Cubics, never `A`. internal/validate's path parser does not implement
// elliptical arcs — it approximates them as a straight line and warns
// (see pathd.go, RuleUnsupportedPath) — so an arc-based smoothing would
// make any downstream validation of this output silently wrong. `C` is
// understood everywhere in this codebase.
func EmitCurvesSVG(paths []CurvePath, widthMM, heightMM float64) []byte {
	var buf bytes.Buffer
	fmt.Fprintf(&buf,
		`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="%smm" height="%smm" viewBox="0 0 %s %s">`,
		fmtFloat(widthMM), fmtFloat(heightMM), fmtFloat(widthMM), fmtFloat(heightMM))
	buf.WriteByte('\n')
	buf.WriteString(`<g fill="none" stroke="black" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round">`)
	buf.WriteByte('\n')
	for _, cp := range paths {
		if len(cp.Cubics) == 0 {
			continue
		}
		buf.WriteString(`<path d="`)
		fmt.Fprintf(&buf, "M%s %s ", fmtFloat(cp.Start.X), fmtFloat(cp.Start.Y))
		for _, c := range cp.Cubics {
			fmt.Fprintf(&buf, "C%s %s %s %s %s %s ",
				fmtFloat(c.C1.X), fmtFloat(c.C1.Y),
				fmtFloat(c.C2.X), fmtFloat(c.C2.Y),
				fmtFloat(c.P.X), fmtFloat(c.P.Y))
		}
		if cp.Closed {
			buf.WriteByte('Z')
		}
		buf.WriteString(`"/>`)
		buf.WriteByte('\n')
	}
	buf.WriteString(`</g>`)
	buf.WriteByte('\n')
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}
