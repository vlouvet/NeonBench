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

// derivedMinBendRadius computes a minimum bend radius from tube geometry
// and bend technique when the spec doesn't carry an explicit
// min_bend_radius_mm override. The formula is:
//
//	r_min = K(technique) * D² / t
//
// where D is outer tube diameter (mm), t is the wall thickness (mm), and
// K is a per-technique constant. The K table is calibrated to match the
// wall-thinning first-principles bound from
// docs/neon-rules/bend-radius.md ("first-principles derivation": for the
// outside wall to retain ≥ 80 % of its original thickness through a 90°
// bend, r ≥ 2.25·D). Picking K so that 2.25·D = K·D²/t at the typical
// shop wall thickness for that diameter yields:
//
//	ribbon:     K = 0.20  (uniform heat → tightest bend, smallest K)
//	crossfire:  K = 0.225 (concentrated heat → trade-typical)
//	hand_torch: K = 0.275 (hand-aimed flame → loosest bend, largest K)
//
// Provenance: the per-diameter min-bend-radius table is NOT published in
// either Saving Neon, Miller (1935), or Strattman NT (1997) — see
// docs/neon-rules/bend-radius.md for citations and the "supersession
// note" confirming that the trade treats bend radius as bender-craft.
// Both editions reach the same conclusion: the threshold is when the
// outside wall thins past spec, judged visually. Our K table therefore
// formalizes "what shops do" against the doc's wall-thinning derivation
// rather than citing a tabulated value that does not exist in the
// literature. The K-by-technique split is a NeonBench-internal
// engineering judgement (ribbon-heat is more uniform → less strain
// concentration → tighter bend tolerable; hand-torch is the opposite).
//
// Graceful degradation: when wallThicknessMM ≤ 0 or technique is empty
// or unknown, the helper falls back to the diameter-only 2.25·D bound,
// which is exactly what today's seed values encode (within ±0.5 mm).
// This preserves backward compatibility with specs that have not been
// re-tagged with wall-thickness metadata.
func derivedMinBendRadius(diameterMM, wallThicknessMM float64, technique string) float64 {
	if diameterMM <= 0 {
		return 0
	}
	// Fallback: diameter-only bound, doc-comment cited above. Used when
	// either input is missing OR the technique tag is unrecognised.
	if wallThicknessMM <= 0 {
		return 2.25 * diameterMM
	}
	var k float64
	switch technique {
	case "ribbon":
		k = 0.20
	case "crossfire":
		k = 0.225
	case "hand_torch":
		k = 0.275
	default:
		// Unknown / empty technique — fall back to the diameter-only
		// bound rather than guessing a K value.
		return 2.25 * diameterMM
	}
	return k * diameterMM * diameterMM / wallThicknessMM
}

// runBendLimitMM returns the effective minimum bend radius for a polyline.
// When the polyline carries a per-run diameter override that differs from
// the project default, the project's bend-radius limit is scaled linearly
// by the diameter ratio — this matches the wall-thinning derivation in
// docs/neon-rules/bend-radius.md (r ∝ D for a fixed wall-strain budget).
// Without an override, the project's limit is used as-is so the user's
// tube-spec customization is preserved.
//
// When the project's stored MinBendRadiusMM is zero (no explicit
// override on the spec), the limit falls through to the
// wall-thinning-derived value computed by derivedMinBendRadius. The
// derivation uses the spec's WallThicknessMM and BendTechnique when
// they're populated; otherwise it gracefully degrades to the
// diameter-only 2.25·D bound. Tier 3 #31.
func runBendLimitMM(pl Polyline, limits Limits) float64 {
	base := limits.MinBendRadiusMM
	if base <= 0 {
		base = derivedMinBendRadius(limits.DiameterMM, limits.WallThicknessMM, limits.BendTechnique)
	}
	if pl.DiameterMM > 0 && limits.DiameterMM > 0 && pl.DiameterMM != limits.DiameterMM {
		return base * pl.DiameterMM / limits.DiameterMM
	}
	return base
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

// effectiveMinLeadInMM returns the lead-in length to enforce for a given
// polyline. Per-spec override (limits.MinLeadInMM > 0) wins; otherwise
// fall back to 2 × diameter (Miller App I §126 working minimum), using
// the per-run diameter override when present.
func effectiveMinLeadInMM(pl Polyline, limits Limits) float64 {
	if limits.MinLeadInMM > 0 {
		return limits.MinLeadInMM
	}
	d := runDiameterMM(pl, limits)
	if d <= 0 {
		return 0
	}
	return 2 * d
}

// effectiveSharpBendAngleDeg returns the interior-angle threshold below
// which a vertex is flagged as a sharp bend. limits.SharpBendAngleDeg
// wins when set; otherwise the trade-standard 85° applies.
func effectiveSharpBendAngleDeg(limits Limits) float64 {
	if limits.SharpBendAngleDeg > 0 {
		return limits.SharpBendAngleDeg
	}
	return 85.0
}

// interiorAngleDeg returns the interior angle (in degrees) at vertex b,
// formed by the two adjacent segments b→a and b→c. Coincident neighbors
// return 180° (a straight passthrough — i.e. "no bend here") so degenerate
// repeated points don't synthesize false positives.
func interiorAngleDeg(a, b, c Point) float64 {
	ux, uy := a.X-b.X, a.Y-b.Y
	vx, vy := c.X-b.X, c.Y-b.Y
	uLen := math.Hypot(ux, uy)
	vLen := math.Hypot(vx, vy)
	if uLen == 0 || vLen == 0 {
		return 180
	}
	cos := (ux*vx + uy*vy) / (uLen * vLen)
	// Clamp against floating-point drift so acos doesn't return NaN.
	if cos > 1 {
		cos = 1
	} else if cos < -1 {
		cos = -1
	}
	return math.Acos(cos) * 180 / math.Pi
}

// straightThresholdDeg is the interior-angle threshold above which a vertex
// is treated as "still part of the straight lead-in" rather than a real
// bend. Set just below 180° so noise from path-flattening sampling doesn't
// abort the lead-in walk on a clearly-straight shaft.
const straightThresholdDeg = 170.0

// checkMinLeadIn enforces the minimum straight tube length between an
// electrode and the first bend on a run. The validator only sees the live
// arc (designdoc.ToSVG strips the dead arc on closed runs), so OPEN
// polyline endpoints are the electrode positions for this rule. Closed
// polylines have no electrodes by definition and are skipped.
//
// Walks forward from each endpoint, accumulating arc length until either
// (a) a vertex with interior angle < straightThresholdDeg is reached
// (the first real bend), or (b) the polyline runs out (a perfectly
// straight tube — no bend, no issue). If the accumulated length is below
// the limit, an issue is emitted at the electrode position.
func checkMinLeadIn(polylines []Polyline, limits Limits) []Issue {
	var issues []Issue
	for _, pl := range polylines {
		if pl.Closed {
			continue
		}
		pts := pl.Points
		n := len(pts)
		if n < 2 {
			continue
		}
		limitMM := effectiveMinLeadInMM(pl, limits)
		if limitMM <= 0 {
			continue
		}
		hairpinD := runDiameterMM(pl, limits)
		// Two endpoints to evaluate; walk inward from each.
		endpoints := []struct {
			start int
			step  int
		}{
			{0, 1},
			{n - 1, -1},
		}
		for _, ep := range endpoints {
			length := 0.0
			bendFound := false
			i := ep.start
			prev := i
			for {
				next := i + ep.step
				if next < 0 || next >= n {
					break
				}
				length += dist(pts[prev], pts[next])
				// Check the interior angle at `next` (the vertex we just
				// stepped onto). It needs neighbors on both sides; if
				// `next` is the far endpoint, there's no vertex to
				// inspect — the tube is one straight shaft, no bend.
				farIdx := next + ep.step
				if farIdx < 0 || farIdx >= n {
					break
				}
				ang := interiorAngleDeg(pts[i], pts[next], pts[farIdx])
				if ang < straightThresholdDeg {
					bendFound = true
					// Suppress the warning if this first bend is itself
					// the apex of a documented hairpin double-back —
					// the user has explicitly opted into that geometry.
					if hasUserDoubleback(pts[next], pl.DoublebackMarks, hairpinD) {
						bendFound = false
					}
					break
				}
				prev = next
				i = next
			}
			if !bendFound {
				continue
			}
			if length >= limitMM {
				continue
			}
			issues = append(issues, Issue{
				Rule:     RuleMinLeadIn,
				Severity: SeverityWarning,
				Message: fmt.Sprintf(
					"electrode lead-in %.1fmm below recommended minimum %.1fmm — short lead-ins crack at the seal under handling and thermal cycling",
					length, limitMM),
				XMM: pts[ep.start].X,
				YMM: pts[ep.start].Y,
			})
		}
	}
	return issues
}

// checkSharpBendAngles flags interior vertices whose included angle is at
// or below the configured threshold (default 85°). Hairpin double-back
// apices — both the geometric heuristic and user-marked ones — are
// exempted because a U-turn is, by definition, a 180°-flip whose apex
// sweeps through angles well below the threshold.
//
// Operates on resampled points (so the hairpin detector has the spacing
// it expects) but reports issues at the resampled vertex coordinate, then
// clusters so a tight curve doesn't produce a swarm of markers.
func checkSharpBendAngles(polylines []Polyline, limits Limits) []Issue {
	thresholdDeg := effectiveSharpBendAngleDeg(limits)
	if thresholdDeg <= 0 {
		return nil
	}
	var issues []Issue
	for _, pl := range polylines {
		// Resample so the hairpin detector's K-step look-around has stable
		// spacing. Use the same step heuristic as checkBendRadius for
		// consistency: tied to the bend-radius limit when present, else
		// a sensible mm value that survives short straight legs.
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
		// Closed polyline: every vertex (including the seam at index 0
		// and n-1) is interior. Open polyline: skip the two endpoints.
		first, last := 1, n-1
		if sampled.Closed {
			first, last = 0, n
		}
		for idx := first; idx < last; idx++ {
			var aIdx, cIdx int
			if sampled.Closed {
				aIdx = (idx - 1 + n) % n
				cIdx = (idx + 1) % n
				// Skip the duplicated closing point, if any.
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
	// Cluster nearby same-rule flags so a single tight bend doesn't fire
	// multiple markers along its arc.
	radius := 5.0
	if limits.MinBendRadiusMM > 0 {
		radius = math.Max(limits.MinBendRadiusMM*1.5, 5)
	}
	return clusterIssues(issues, radius)
}

// blankLengthMM is the standard sheet-metal coil width fabricators use
// to roll channel-letter return strips. 1168 mm ≈ 46 in (Strattman NT
// Ch.5: "blank coils ship in 46-inch widths and the strip is sheared
// off the side"). A face polyline whose perimeter exceeds this value
// can't be wrapped from a single blank — the operator has to either
// upsize the coil (rare; the supplier doesn't always carry > 46-in
// stock) or seam two pieces together. The rule below warns when this
// will be necessary so the user can plan the seam location. Tier 3 #26.
const blankLengthMM = 1168.0

// checkFacePerimeter walks the polylines and emits an issue for any
// face-flagged polyline whose perimeter exceeds the standard blank
// length. Non-face polylines are skipped entirely (live tube paths
// don't go through a sheet-metal blank).
//
// Severity is configurable per project (Tier 3 #46): when
// limits.FacePerimeterStrict is true the issue is emitted as
// SeverityError ("hard stop — face won't fit on a single coil");
// otherwise it stays SeverityWarning so shops with documented seam
// practice can splice through and accept the design. Default false
// preserves the historical warning-level behaviour and keeps existing
// reports byte-identical post-migration. The marker location uses the
// run's centroid (average of polyline points) — close enough for the
// canvas overlay; a perfectly accurate seam-suggestion point would
// require knowing the operator's preferred seam axis.
func checkFacePerimeter(polylines []Polyline, limits Limits) []Issue {
	var issues []Issue
	severity := SeverityWarning
	if limits.FacePerimeterStrict {
		severity = SeverityError
	}
	for _, pl := range polylines {
		if !pl.IsChannelLetterFace {
			continue
		}
		perim := pl.Length()
		if perim <= blankLengthMM {
			continue
		}
		// Centroid of the polyline points. Acceptable approximation;
		// the validator's marker just needs to land near the run.
		var sx, sy float64
		var n int
		for _, p := range pl.Points {
			sx += p.X
			sy += p.Y
			n++
		}
		var cx, cy float64
		if n > 0 {
			cx = sx / float64(n)
			cy = sy / float64(n)
		}
		issues = append(issues, Issue{
			Rule:     RuleFacePerimeterExceedsBlank,
			Severity: severity,
			Message: fmt.Sprintf(
				"face perimeter %.0fmm exceeds standard %dmm blank — needs documented seam",
				perim, int(blankLengthMM)),
			XMM: cx,
			YMM: cy,
		})
	}
	return issues
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
