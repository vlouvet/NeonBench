package validate

import (
	"fmt"
	"math"
)

// resampleUniform resamples a polyline at uniform arc-length spacing, in
// place semantics: returns a new Polyline. step is the desired spacing in mm.
func resampleUniform(pl Polyline, step float64) Polyline {
	if len(pl.Points) < 2 || step <= 0 {
		return pl
	}
	pts := pl.Points
	if pl.Closed {
		pts = append(append([]Point(nil), pts...), pts[0])
	}
	out := []Point{pts[0]}
	carry := 0.0
	for i := 1; i < len(pts); i++ {
		a := pts[i-1]
		b := pts[i]
		seg := dist(a, b)
		if seg == 0 {
			continue
		}
		dx := (b.X - a.X) / seg
		dy := (b.Y - a.Y) / seg
		travel := step - carry
		for travel < seg {
			out = append(out, Point{a.X + dx*travel, a.Y + dy*travel})
			travel += step
		}
		carry = seg - (travel - step)
	}
	if !pl.Closed {
		// Always include the final point so we don't truncate the curve's end.
		last := pts[len(pts)-1]
		if dist(out[len(out)-1], last) > step*0.5 {
			out = append(out, last)
		}
	}
	return Polyline{Points: out, Closed: pl.Closed}
}

// checkBendRadiusClustered clusters bend-radius issues so a single tight
// curve doesn't fire 30 markers along its arc. Hairpin double-backs (180°
// structural turns flanked by parallel legs, named "DB" in Blazek's
// alphabet books) are exempted from the bend-radius failure.
func checkBendRadiusClustered(polylines []Polyline, limits Limits) []Issue {
	raw := checkBendRadius(polylines, limits)
	return clusterIssues(raw, math.Max(limits.MinBendRadiusMM*1.5, 5))
}

// runDiameterMM returns the effective tube diameter for a polyline: the
// per-run override if present, else the project default from limits.
func runDiameterMM(pl Polyline, limits Limits) float64 {
	if pl.DiameterMM > 0 {
		return pl.DiameterMM
	}
	return limits.DiameterMM
}

// runBendLimitMM returns the effective minimum bend radius for a polyline.
// When the polyline carries a per-run diameter override that differs from
// the project default, the project's bend-radius limit is scaled linearly
// by the diameter ratio — this matches the wall-thinning derivation in
// docs/neon-rules/bend-radius.md (r ∝ D for a fixed wall-strain budget).
// Without an override, the project's limit is used as-is so the user's
// tube-spec customization is preserved.
func runBendLimitMM(pl Polyline, limits Limits) float64 {
	if pl.DiameterMM > 0 && limits.DiameterMM > 0 && pl.DiameterMM != limits.DiameterMM {
		return limits.MinBendRadiusMM * pl.DiameterMM / limits.DiameterMM
	}
	return limits.MinBendRadiusMM
}

// checkBendRadius scans each polyline using a 3-point discrete circumradius
// and emits an issue at any vertex where r < limit, EXCEPT where the
// vertex is the apex of a structural double-back hairpin (legitimate
// construction, not an error). When a polyline carries a per-run diameter
// override, both the limit and the hairpin look-ahead scale with it.
func checkBendRadius(polylines []Polyline, limits Limits) []Issue {
	if limits.MinBendRadiusMM <= 0 {
		return nil
	}
	var issues []Issue
	for _, pl := range polylines {
		limitMM := runBendLimitMM(pl, limits)
		if limitMM <= 0 {
			continue
		}
		// We need fairly tight sampling for stable curvature. Resample at
		// ~limit/4 spacing — capped to a sensible range.
		step := math.Max(0.5, math.Min(limitMM/4, 5))
		sampled := resampleUniform(pl, step)
		pts := sampled.Points
		n := len(pts)
		if n < 3 {
			continue
		}
		hairpinD := runDiameterMM(pl, limits)
		emitted := map[int]bool{} // suppress dense duplicate flags
		for i := 1; i < n-1; i++ {
			r := circumradius3(pts[i-1], pts[i], pts[i+1])
			if r < limitMM {
				// Skip if we just emitted within ~3 samples.
				skip := false
				for j := i - 3; j <= i; j++ {
					if emitted[j] {
						skip = true
						break
					}
				}
				if skip {
					continue
				}
				if isDoubleBackHairpin(pts, sampled.Closed, i, step, hairpinD) {
					// Legitimate 180° construction; not a bend-radius failure.
					continue
				}
				if hasUserDoubleback(pts[i], pl.DoublebackMarks, hairpinD) {
					// User explicitly marked this region as a double-back —
					// trust their intent over the geometric heuristic.
					continue
				}
				emitted[i] = true
				suffix := ""
				if pl.DiameterMM > 0 && pl.DiameterMM != limits.DiameterMM {
					suffix = fmt.Sprintf(" (run override: ø%.1fmm)", pl.DiameterMM)
				}
				issues = append(issues, Issue{
					Rule:     RuleMinBendRadius,
					Severity: SeverityError,
					Message:  fmt.Sprintf("bend radius %.1fmm below tube minimum %.1fmm%s", r, limitMM, suffix),
					XMM:      pts[i].X,
					YMM:      pts[i].Y,
				})
			}
		}
	}
	return issues
}

// hasUserDoubleback returns true if the vertex p is within an exemption
// radius of any user-marked double-back apex. The radius scales with the
// run's diameter so the user's click doesn't have to be pixel-perfect on
// the apex sample.
func hasUserDoubleback(p Point, marks []Point, diameterMM float64) bool {
	if len(marks) == 0 {
		return false
	}
	radius := math.Max(2*diameterMM, 10)
	for _, m := range marks {
		if dist(p, m) <= radius {
			return true
		}
	}
	return false
}

// isDoubleBackHairpin returns true if the vertex at idx is the apex of a
// structural 180° hairpin: a tight U-turn flanked by two roughly parallel
// legs that sit within a few tube diameters of each other. Recognized in
// Blazek's pattern books as "DB" — a standard construction, not a
// fabrication error.
//
// Heuristic: look K samples back and forward along the polyline. If those
// points are physically close (within ~4× tube diameter) and have tangent
// directions that are anti-parallel (cos < -0.7), the vertex is between
// two opposing legs, i.e. a hairpin apex.
func isDoubleBackHairpin(points []Point, closed bool, idx int, stepMM, tubeDiameterMM float64) bool {
	if tubeDiameterMM <= 0 {
		return false
	}
	// Look ahead by enough arc length that we're past the curve onto the
	// straight legs. ~3× tube diameter is enough for typical hairpins.
	lookMM := math.Max(3*tubeDiameterMM, 10)
	K := int(math.Ceil(lookMM / stepMM))
	n := len(points)
	if n < 2*K+1 {
		return false
	}
	prev, next := idx-K, idx+K
	if !closed {
		if prev < 0 || next >= n {
			return false
		}
	} else {
		prev = ((prev % n) + n) % n
		next = next % n
	}
	if dist(points[prev], points[next]) > 4*tubeDiameterMM {
		return false
	}
	tBefore := tangentAt(points, prev, closed)
	tAfter := tangentAt(points, next, closed)
	cos := dot(tBefore, tAfter)
	return cos < -0.7
}

// checkSegmentLength flags each subpath whose total arc length exceeds limit.
func checkSegmentLength(polylines []Polyline, limits Limits) []Issue {
	limitMM := limits.MaxSegmentLengthMM
	if limitMM <= 0 {
		return nil
	}
	var issues []Issue
	for _, pl := range polylines {
		L := pl.Length()
		if L <= limitMM {
			continue
		}
		// Anchor the issue at the polyline midpoint by arc length.
		mid := midpointByArc(pl)
		issues = append(issues, Issue{
			Rule:     RuleMaxSegmentLength,
			Severity: SeverityError,
			Message:  fmt.Sprintf("tube run %.0fmm exceeds max segment length %.0fmm — split with electrodes", L, limitMM),
			XMM:      mid.X,
			YMM:      mid.Y,
		})
	}
	return issues
}

func midpointByArc(pl Polyline) Point {
	if len(pl.Points) == 0 {
		return Point{}
	}
	half := pl.Length() / 2
	pts := pl.Points
	if pl.Closed {
		pts = append(append([]Point(nil), pts...), pts[0])
	}
	travel := 0.0
	for i := 1; i < len(pts); i++ {
		seg := dist(pts[i-1], pts[i])
		if travel+seg >= half {
			t := (half - travel) / seg
			return Point{
				pts[i-1].X + t*(pts[i].X-pts[i-1].X),
				pts[i-1].Y + t*(pts[i].Y-pts[i-1].Y),
			}
		}
		travel += seg
	}
	return pts[len(pts)-1]
}

// indexedPoint is a polyline sample tagged with its origin so the spacing
// rule can ignore arc-length neighbors on the same polyline.
type indexedPoint struct {
	pl  int
	idx int
	pt  Point
}

type plSampledShape struct {
	points []Point
	closed bool
}

// isOpenEndpoint reports whether the resampled index is at the start or
// end of an OPEN polyline. Closed polylines have no endpoints (the loop
// is continuous), so they're never welds.
func isOpenEndpoint(s plSampledShape, idx int) bool {
	if s.closed {
		return false
	}
	return idx == 0 || idx == len(s.points)-1
}

// checkSpacing flags pairs of points closer than limitMM that don't lie on
// the same continuous, mostly-straight section of a polyline. Uses a
// uniform spatial grid to keep the pairwise check ~O(N).
//
// Same-polyline filtering: we compare arc length to straight-line distance;
// if arc/geom is small (< arcRatioThreshold), the polyline didn't fold
// back, so the points are on the same tube section.
//
// Crossing demotion: when two close points come from polylines whose local
// tangents are roughly perpendicular (|cos θ| < 0.5, i.e. > 60° angle),
// the tubes are crossing rather than running parallel. Crossings are
// expected in real layouts (e.g. one tube flying over another) and are
// hidden with block-out paint; we demote these to a warning under the
// crossing_needs_blockout rule rather than a hard spacing error.
//
// After detection, nearby flags get clustered to keep the marker count sane.
func checkSpacing(polylines []Polyline, limits Limits) []Issue {
	limitMM := limits.MinSpacingMM
	if limitMM <= 0 {
		return nil
	}
	const sampleStep = 1.0 // mm
	const arcRatioThreshold = 3.0
	const crossingCosThreshold = 0.5 // |cos θ| < 0.5 ⇒ angle > 60° ⇒ crossing

	plSampled := make([]plSampledShape, len(polylines))

	var pts []indexedPoint
	for plIdx, pl := range polylines {
		s := resampleUniform(pl, sampleStep)
		plSampled[plIdx] = plSampledShape{points: s.Points, closed: s.Closed}
		for i, p := range s.Points {
			pts = append(pts, indexedPoint{plIdx, i, p})
		}
	}
	if len(pts) == 0 {
		return nil
	}

	cell := limitMM
	type key struct{ x, y int }
	grid := map[key][]int{}
	for i, p := range pts {
		k := key{int(math.Floor(p.pt.X / cell)), int(math.Floor(p.pt.Y / cell))}
		grid[k] = append(grid[k], i)
	}

	// Junction zones: any open-polyline endpoint that sits close (≤ 3mm)
	// to a different polyline marks a tube weld. Pairs of points that
	// both fall inside any junction zone (within ~max(tube diameter, 8mm)
	// of the endpoint) are physical neighbors of the same weld, not
	// "two parallel tubes" — skip them in the spacing check.
	type junctionZone struct {
		x, y, r2 float64
	}
	// Tubes diverging from a weld stay below 18mm spacing for some
	// distance after the junction; exempt 2.5× the tube diameter so a
	// small fan-out from a junction isn't flagged as "tubes too close".
	weldRadius := math.Max(limits.DiameterMM*2.5, limits.MinSpacingMM)
	weldRadius2 := weldRadius * weldRadius
	var zones []junctionZone
	for plIdx, s := range plSampled {
		if s.closed || len(s.points) == 0 {
			continue
		}
		for _, idx := range []int{0, len(s.points) - 1} {
			ep := s.points[idx]
			// Find any sample on a DIFFERENT polyline within 3mm.
			gx := int(math.Floor(ep.X / cell))
			gy := int(math.Floor(ep.Y / cell))
			welded := false
			for dx := -1; dx <= 1 && !welded; dx++ {
				for dy := -1; dy <= 1 && !welded; dy++ {
					for _, j := range grid[key{gx + dx, gy + dy}] {
						q := pts[j]
						if q.pl == plIdx {
							continue
						}
						if dist(ep, q.pt) <= 3.0 {
							welded = true
							break
						}
					}
				}
			}
			if welded {
				zones = append(zones, junctionZone{ep.X, ep.Y, weldRadius2})
			}
		}
	}

	inJunctionZone := func(p Point) bool {
		for _, z := range zones {
			dx := p.X - z.x
			dy := p.Y - z.y
			if dx*dx+dy*dy <= z.r2 {
				return true
			}
		}
		return false
	}

	arcLengthSame := func(plIdx, i, j int) float64 {
		s := plSampled[plIdx]
		n := len(s.points)
		d := abs(i - j)
		if s.closed && n-d < d {
			d = n - d
		}
		return float64(d) * sampleStep
	}

	var issues []Issue
	emitted := map[int]bool{}
	for i, p := range pts {
		if emitted[i] {
			continue
		}
		kx := int(math.Floor(p.pt.X / cell))
		ky := int(math.Floor(p.pt.Y / cell))
		for dx := -1; dx <= 1; dx++ {
			for dy := -1; dy <= 1; dy++ {
				for _, j := range grid[key{kx + dx, ky + dy}] {
					if j <= i {
						continue
					}
					q := pts[j]
					d := dist(p.pt, q.pt)
					if d >= limitMM {
						continue
					}
					if p.pl == q.pl {
						arc := arcLengthSame(p.pl, p.idx, q.idx)
						if d < 1e-6 || arc/d < arcRatioThreshold {
							continue
						}
					} else if inJunctionZone(p.pt) && inJunctionZone(q.pt) {
						// Both samples fall inside a tube weld at a
						// junction. Adjacent tube ends meeting at a weld
						// aren't "two parallel tubes 0mm apart".
						continue
					}
					tp := tangentAt(plSampled[p.pl].points, p.idx, plSampled[p.pl].closed)
					tq := tangentAt(plSampled[q.pl].points, q.idx, plSampled[q.pl].closed)
					cos := math.Abs(dot(tp, tq))
					rule := RuleMinSpacing
					sev := SeverityError
					msg := fmt.Sprintf("tubes %.1fmm apart, below minimum spacing %.1fmm", d, limitMM)
					if cos < crossingCosThreshold {
						rule = RuleCrossingNeedsBlockout
						sev = SeverityWarning
						msg = fmt.Sprintf("tubes cross at %.0f° — needs block-out paint coverage", math.Acos(cos)*180/math.Pi)
					}
					issues = append(issues, Issue{
						Rule:     rule,
						Severity: sev,
						Message:  msg,
						XMM:      (p.pt.X + q.pt.X) / 2,
						YMM:      (p.pt.Y + q.pt.Y) / 2,
					})
					emitted[i] = true
					emitted[j] = true
					goto nextPoint
				}
			}
		}
	nextPoint:
	}
	return clusterIssues(issues, limitMM*1.5)
}

// clusterIssues collapses issues of the same rule whose locations fall
// within `radius` of each other into a single representative issue.
// Prevents thousands of marker spam in the UI for one physical region.
func clusterIssues(issues []Issue, radius float64) []Issue {
	if len(issues) == 0 || radius <= 0 {
		return issues
	}
	var out []Issue
	used := make([]bool, len(issues))
	for i := range issues {
		if used[i] {
			continue
		}
		head := issues[i]
		used[i] = true
		count := 1
		for j := i + 1; j < len(issues); j++ {
			if used[j] || issues[j].Rule != head.Rule {
				continue
			}
			if dist(Point{head.XMM, head.YMM}, Point{issues[j].XMM, issues[j].YMM}) <= radius {
				used[j] = true
				count++
			}
		}
		if count > 1 {
			head.Message = fmt.Sprintf("%s (%d nearby)", head.Message, count)
		}
		out = append(out, head)
	}
	return out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// checkCapHeight emits a warning when the design's bbox height exceeds the
// threshold above which Miller (1935 p.125) recommends multi-blank
// construction with internal welds. The bbox height is a proxy for "cap
// height" — for designs with mixed-height content this overstates, but
// for v1 it's a useful signal to surface.
const spliceRecommendedHeightMM = 305.0 // 12 in (Miller p.125)

func checkCapHeight(bbox [4]float64) []Issue {
	h := bbox[3] - bbox[1]
	if h < spliceRecommendedHeightMM {
		return nil
	}
	return []Issue{{
		Rule:     RuleSpliceRecommended,
		Severity: SeverityWarning,
		Message:  fmt.Sprintf("design height %.0fmm ≥ %.0fmm — Miller (1935 p.125) recommends multi-blank construction with internal welds for tall letters", h, spliceRecommendedHeightMM),
		XMM:      (bbox[0] + bbox[2]) / 2,
		YMM:      (bbox[1] + bbox[3]) / 2,
	}}
}
