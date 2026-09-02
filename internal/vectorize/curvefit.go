package vectorize

import (
	"bytes"
	"fmt"
	"math"
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
func FitCurve(pl MMPolyline) CurvePath {
	return fitCurveAlpha(pl, CatmullRomAlpha)
}

// fitCurveAlpha is FitCurve with the knot exponent left open, so tests can
// build the uniform (alpha = 0) fit and show what it does. Production code
// calls FitCurve; alpha is not a tunable knob.
func fitCurveAlpha(pl MMPolyline, alpha float64) CurvePath {
	pts := dedupeAdjacent(pl.Points, pl.Closed)
	closed := pl.Closed && len(pts) >= 3
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
