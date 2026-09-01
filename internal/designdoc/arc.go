package designdoc

import "math"

// Circular-arc geometry for Tier 3 #78 segments. Every consumer — the SVG
// writer, the PDF and EPS pages, the DXF emitter, the bend list and the
// takeoff — derives its numbers here, so there is exactly one definition of
// what "this segment is an arc" means geometrically.

// Arc describes the circle a single arc segment rides on.
type Arc struct {
	CX, CY     float64 // centre
	RadiusMM   float64
	StartAngle float64 // radians, atan2 convention, at the segment's first vertex
	EndAngle   float64 // radians, at the second vertex
	SweepCCW   bool    // true when the arc runs counter-clockwise from start to end
	IncludedMM float64 // arc length
}

// arcIncludedAngle is the arc's included angle, fixed by ArcBulge alone:
// θ = 4·atan(bulge).
func arcIncludedAngle() float64 { return 4 * math.Atan(ArcBulge) }

// ArcFor returns the circle through p0 and p1 that bows out by ArcBulge.
//
// Side convention: the arc always bulges toward the chord direction rotated a
// quarter turn to (-dy, dx). Fixing the side keeps the operation a pure toggle
// — converting the same segment twice cannot walk the curve across the chord —
// at the cost of not being able to choose which way it bows. Flipping is a
// follow-up.
//
// Returns ok=false for a degenerate (zero-length) chord, where no circle is
// defined and the caller should treat the segment as a straight line.
func ArcFor(p0, p1 [2]float64) (Arc, bool) {
	dx := p1[0] - p0[0]
	dy := p1[1] - p0[1]
	chord := math.Hypot(dx, dy)
	if chord <= 0 {
		return Arc{}, false
	}
	theta := arcIncludedAngle()
	// r = chord / (2 sin(θ/2)); with bulge 0.5 this is 0.625·chord.
	radius := chord / (2 * math.Sin(theta/2))
	// Unit normal, chord direction rotated to (-dy, dx). The apex sits this
	// way from the midpoint; the centre sits the opposite way.
	nx := -dy / chord
	ny := dx / chord
	mx := (p0[0] + p1[0]) / 2
	my := (p0[1] + p1[1]) / 2
	// Centre-to-midpoint distance: r − sagitta, i.e. r·cos(θ/2).
	d := radius * math.Cos(theta/2)
	cx := mx - d*nx
	cy := my - d*ny
	return Arc{
		CX:         cx,
		CY:         cy,
		RadiusMM:   radius,
		StartAngle: math.Atan2(p0[1]-cy, p0[0]-cx),
		EndAngle:   math.Atan2(p1[1]-cy, p1[0]-cx),
		// The apex was placed on the +normal side, which puts the sweep from
		// start to end in the increasing-angle direction about that centre.
		SweepCCW:   true,
		IncludedMM: radius * theta,
	}, true
}

// ArcSegmentLengthMM is the length of one segment, honouring its type. This is
// the number the bend list and the takeoff care about: an arc is ~15.9% longer
// than the chord it replaces, and billing or cutting to the chord would come
// up short on every curved segment.
func ArcSegmentLengthMM(p0, p1 [2]float64, isArc bool) float64 {
	if !isArc {
		return math.Hypot(p1[0]-p0[0], p1[1]-p0[1])
	}
	a, ok := ArcFor(p0, p1)
	if !ok {
		return 0
	}
	return a.IncludedMM
}

// arcSampleCount picks how finely to flatten an arc for consumers that can
// only draw or measure straight lines. Fixed angular resolution rather than a
// fixed count: the sagitta error of a chord subtending φ is r(1−cos(φ/2)), so
// holding φ constant holds the error proportional to the radius, which is the
// behaviour a pattern at any scale wants.
const arcSampleStepRad = 5 * math.Pi / 180

func arcSampleCount() int {
	n := int(math.Ceil(arcIncludedAngle() / arcSampleStepRad))
	if n < 8 {
		n = 8
	}
	return n
}

// FlattenSegment returns the points to walk from p0 to p1, EXCLUDING p0 and
// including p1, so callers can concatenate segments without duplicating
// vertices. A line segment yields just p1.
func FlattenSegment(p0, p1 [2]float64, isArc bool) [][2]float64 {
	if !isArc {
		return [][2]float64{p1}
	}
	a, ok := ArcFor(p0, p1)
	if !ok {
		return [][2]float64{p1}
	}
	n := arcSampleCount()
	sweep := a.EndAngle - a.StartAngle
	// Normalise to the short way round in the sweep direction; the included
	// angle is always < 180° at bulge 0.5, so this cannot pick the long arc.
	for sweep <= -math.Pi {
		sweep += 2 * math.Pi
	}
	for sweep > math.Pi {
		sweep -= 2 * math.Pi
	}
	out := make([][2]float64, 0, n)
	for i := 1; i <= n; i++ {
		ang := a.StartAngle + sweep*float64(i)/float64(n)
		out = append(out, [2]float64{
			a.CX + a.RadiusMM*math.Cos(ang),
			a.CY + a.RadiusMM*math.Sin(ang),
		})
	}
	// Land exactly on the declared endpoint rather than within a rounding of
	// it, so a flattened run still closes on its neighbours.
	out[len(out)-1] = p1
	return out
}

// FlatPoints returns the polyline as straight segments only, expanding every
// arc. Returns the original slice (not a copy) when there are no arcs, so the
// common case costs nothing.
//
// NOTE: the returned indices do NOT line up with Points once an arc is
// expanded. Anything that resolves an electrode, bend, blockout or annotation
// index must walk Points and consult SegmentType per segment instead — see
// how the SVG writer does it.
func (p *Polyline) FlatPoints() [][2]float64 {
	if !p.HasArcs() || len(p.Points) < 2 {
		return p.Points
	}
	out := make([][2]float64, 0, len(p.Points)*arcSampleCount())
	out = append(out, p.Points[0])
	for i := 0; i < len(p.Points)-1; i++ {
		out = append(out, FlattenSegment(p.Points[i], p.Points[i+1], p.SegmentType(i) == SegmentArc)...)
	}
	if p.Closed {
		last := len(p.Points) - 1
		out = append(out, FlattenSegment(p.Points[last], p.Points[0], p.SegmentType(last) == SegmentArc)...)
	}
	return out
}

// LengthMM is the polyline's true length, arcs included.
func (p *Polyline) LengthMM() float64 {
	total := 0.0
	for i := 0; i < len(p.Points)-1; i++ {
		total += ArcSegmentLengthMM(p.Points[i], p.Points[i+1], p.SegmentType(i) == SegmentArc)
	}
	if p.Closed && len(p.Points) > 1 {
		last := len(p.Points) - 1
		total += ArcSegmentLengthMM(p.Points[last], p.Points[0], p.SegmentType(last) == SegmentArc)
	}
	return total
}

// CubicSegment is one cubic Bezier: the two control points and the endpoint.
// The start point is wherever the pen already is.
type CubicSegment struct {
	C1X, C1Y float64
	C2X, C2Y float64
	X, Y     float64
}

// arcCubicPieces is how many cubics approximate one arc. At bulge 0.5 the
// included angle is ~106°, so two pieces of ~53° each keep the radial error
// near 3e-5 of the radius — about a micron on a 62mm radius.
const arcCubicPieces = 2

// ArcCubics expresses the arc from p0 to p1 as cubic Beziers.
//
// Cubics rather than an SVG `A` command, which would be the obvious choice:
// the validator's path parser (internal/validate/pathd.go) does NOT implement
// elliptical arcs. It approximates `A` as a straight line to the endpoint and
// raises an unsupported_path warning. Emitting arcs would therefore have had
// the validator measure the chord — wrong length, wrong bend radius — while
// warning about it on every curve. Its cubic flattener is adaptive and exact
// enough, so cubics get every SVG consumer the real curve for free.
//
// `reversed` traverses the same circle from p1 to p0, which is what a live-arc
// walk that runs backwards around a closed run needs.
func ArcCubics(p0, p1 [2]float64, reversed bool) []CubicSegment {
	a, ok := ArcFor(p0, p1)
	if !ok {
		return nil
	}
	start, end := a.StartAngle, a.EndAngle
	if reversed {
		start, end = end, start
	}
	sweep := end - start
	for sweep <= -math.Pi {
		sweep += 2 * math.Pi
	}
	for sweep > math.Pi {
		sweep -= 2 * math.Pi
	}
	phi := sweep / arcCubicPieces
	// Control-point distance for a cubic spanning phi radians of a unit
	// circle, scaled by the radius.
	k := 4.0 / 3.0 * math.Tan(phi/4) * a.RadiusMM
	out := make([]CubicSegment, 0, arcCubicPieces)
	for i := 0; i < arcCubicPieces; i++ {
		a0 := start + phi*float64(i)
		a1 := a0 + phi
		p0x := a.CX + a.RadiusMM*math.Cos(a0)
		p0y := a.CY + a.RadiusMM*math.Sin(a0)
		p3x := a.CX + a.RadiusMM*math.Cos(a1)
		p3y := a.CY + a.RadiusMM*math.Sin(a1)
		out = append(out, CubicSegment{
			C1X: p0x - k*math.Sin(a0), C1Y: p0y + k*math.Cos(a0),
			C2X: p3x + k*math.Sin(a1), C2Y: p3y - k*math.Cos(a1),
			X: p3x, Y: p3y,
		})
	}
	// Land exactly on the declared endpoint.
	tgt := p1
	if reversed {
		tgt = p0
	}
	out[len(out)-1].X = tgt[0]
	out[len(out)-1].Y = tgt[1]
	return out
}

// SegmentIndexBetween resolves which segment joins two adjacent walk
// positions, and whether the walk crosses it backwards. Walks can run either
// direction around a closed run, and an arc traversed backwards is the same
// circle with the sweep flipped — so callers cannot just use the lower index.
//
// Returns ok=false when the two positions are not adjacent, which callers
// should treat as a straight line (it is a jump, not a segment).
func SegmentIndexBetween(a, b, n int, closed bool) (seg int, reversed, ok bool) {
	if n < 2 {
		return 0, false, false
	}
	switch {
	case b == a+1:
		return a, false, true
	case b == a-1:
		return b, true, true
	case closed && a == n-1 && b == 0:
		return a, false, true
	case closed && a == 0 && b == n-1:
		return b, true, true
	}
	return 0, false, false
}

// WalkSegmentLengthMM is the true glass length between two ADJACENT positions
// on a walk over this polyline, honouring an arc crossed in either direction.
// Non-adjacent positions fall back to the straight distance, which is what a
// jump between subpaths should measure.
//
// Every index-walking length consumer — the takeoff's live-arc and blockout
// sums, the PDF's cumulative bend positions — goes through here, so "how long
// is this step" has one answer instead of one per call site.
func (p *Polyline) WalkSegmentLengthMM(a, b int) float64 {
	n := len(p.Points)
	if a < 0 || b < 0 || a >= n || b >= n {
		return 0
	}
	isArc := false
	if seg, _, ok := SegmentIndexBetween(a, b, n, p.Closed); ok {
		isArc = p.SegmentType(seg) == SegmentArc
	}
	return ArcSegmentLengthMM(p.Points[a], p.Points[b], isArc)
}

// SegmentTangents returns unit direction vectors for travel along a segment:
// `leaving` at p0 and `arriving` at p1. For a line both are the chord
// direction. For an arc they differ from the chord by half the included angle
// — ~53° at bulge 0.5 — which is why a bend list built from raw chords
// misreports every vertex where an arc meets a line.
func SegmentTangents(p0, p1 [2]float64, isArc bool) (leaving, arriving [2]float64) {
	dx := p1[0] - p0[0]
	dy := p1[1] - p0[1]
	c := math.Hypot(dx, dy)
	if c <= 0 {
		return [2]float64{1, 0}, [2]float64{1, 0}
	}
	ux, uy := dx/c, dy/c
	if !isArc {
		return [2]float64{ux, uy}, [2]float64{ux, uy}
	}
	// The arc bows toward (-dy, dx), so it leaves the chord rotated that way
	// by θ/2 and rejoins rotated the other way by the same amount.
	h := arcIncludedAngle() / 2
	rot := func(x, y, ang float64) [2]float64 {
		s, c := math.Sin(ang), math.Cos(ang)
		return [2]float64{x*c - y*s, x*s + y*c}
	}
	return rot(ux, uy, h), rot(ux, uy, -h)
}

// VertexTurnDeg is the signed direction change the glass makes at vertex i of
// a walk, in degrees — positive counter-clockwise. `prev`, `at` and `next` are
// walk positions, so an arc on either side contributes its tangent rather than
// its chord.
func (p *Polyline) VertexTurnDeg(prev, at, next int) float64 {
	n := len(p.Points)
	if n < 3 || prev < 0 || at < 0 || next < 0 || prev >= n || at >= n || next >= n {
		return 0
	}
	inDir := p.walkTangent(prev, at, false)
	outDir := p.walkTangent(at, next, true)
	ang := math.Atan2(
		inDir[0]*outDir[1]-inDir[1]*outDir[0],
		inDir[0]*outDir[0]+inDir[1]*outDir[1],
	)
	return ang * 180 / math.Pi
}

// walkTangent gives the travel direction for the step a→b: the leaving
// tangent when `leaving` is true, otherwise the arriving one. Reversing an arc
// swaps and negates the two tangents, which is what walking a closed run
// backwards through a curve requires.
func (p *Polyline) walkTangent(a, b int, leaving bool) [2]float64 {
	n := len(p.Points)
	seg, reversed, ok := SegmentIndexBetween(a, b, n, p.Closed)
	isArc := ok && p.SegmentType(seg) == SegmentArc
	if !isArc {
		dx := p.Points[b][0] - p.Points[a][0]
		dy := p.Points[b][1] - p.Points[a][1]
		c := math.Hypot(dx, dy)
		if c <= 0 {
			return [2]float64{1, 0}
		}
		return [2]float64{dx / c, dy / c}
	}
	s0 := p.Points[seg]
	s1 := p.Points[(seg+1)%n]
	lv, ar := SegmentTangents(s0, s1, true)
	if reversed {
		// Travelling s1→s0: the arriving tangent, negated, is what we leave
		// s1 on; the leaving tangent, negated, is what we arrive at s0 on.
		lv, ar = [2]float64{-ar[0], -ar[1]}, [2]float64{-lv[0], -lv[1]}
	}
	if leaving {
		return lv
	}
	return ar
}

// VertexArcRadiusMM is the radius the glass actually forms at a walk vertex
// when an arc meets it. The tighter side wins when arcs arrive from both.
//
// Returns 0 when neither side is an arc, which tells the caller to fall back
// to the three-point circumradius it already computes. Reporting the
// circumradius of the chords at an arc junction would understate the curve the
// bender forms — the number goes onto the bend list, where it is the radius
// they set the jig to.
func (p *Polyline) VertexArcRadiusMM(prev, at, next int) float64 {
	n := len(p.Points)
	best := 0.0
	consider := func(a, b int) {
		seg, _, ok := SegmentIndexBetween(a, b, n, p.Closed)
		if !ok || p.SegmentType(seg) != SegmentArc {
			return
		}
		arc, ok := ArcFor(p.Points[seg], p.Points[(seg+1)%n])
		if !ok {
			return
		}
		if best == 0 || arc.RadiusMM < best {
			best = arc.RadiusMM
		}
	}
	consider(prev, at)
	consider(at, next)
	return best
}
