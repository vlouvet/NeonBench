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

// checkBendRadiusClustered is retained as the name ValidateSVG calls.
// Grouping now happens inside checkBendRadius (one issue per contiguous
// too-tight stretch of a run), because the old post-hoc distance cluster
// used a radius of 1.5 × the limit — which made a stricter tube spec MERGE
// physically distinct bends and report FEWER errors. See the Tier 1 #131
// finding in specs/done/tier1-131-bend-radius-measurement-validity.md.
func checkBendRadiusClustered(polylines []Polyline, limits Limits) []Issue {
	return checkBendRadius(polylines, limits)
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

// bendHeatZoneDiameters is the length of glass a bender heats to form a
// right-angle bend, expressed in tube diameters: 2 × tube ø.
//
// Source: Strattman NT Fig. 7.20 ("Steps to making a basic angle bend"),
// transcribed in docs/neon-rules/bend-radius.md under "Heat-zone length
// rule". The same note derives the bend radius implied by that heat zone:
// a clean 90° turn formed over 2·D of heated glass has radius
// arc/(π/2) = 2D/1.571 ≈ 1.27·D. That identity — radius = arc length ÷
// turn angle — is exactly the estimator below, which is why the heat zone
// is the right measurement window.
const bendHeatZoneDiameters = 2.0

// bendWindowHalfSamples is how many resample steps sit either side of the
// sample under test, so the measurement window spans 2 × this many steps.
// Combined with bendHeatZoneDiameters it fixes the resample spacing at
// D/4 — fine enough to land a sample near any real feature, coarse enough
// that the walk stays cheap.
const bendWindowHalfSamples = 4

// bendFallbackDiameterMM is used only when neither the project spec nor a
// per-run override supplies a tube diameter. The tube_specs column is NOT
// NULL and the API validates 1..100, so this cannot happen through the
// app; it exists so a hand-built Limits in a test or an external caller
// still measures something physical rather than dividing by zero.
const bendFallbackDiameterMM = 12.0

// bendMeasureGeometry returns the resample spacing and half-window sample
// count for a polyline. BOTH derive from the tube diameter alone. Nothing
// here may depend on limits.MinBendRadiusMM: the whole Tier 1 #131 defect
// was that the measurement's own parameters were derived from the
// threshold it was being compared against, so tightening the threshold
// also coarsened the measurement and the two cancelled.
func bendMeasureGeometry(pl Polyline, limits Limits) (stepMM float64, half int) {
	stepMM, half, _ = bendMeasureParams(pl, limits)
	return stepMM, half
}

// bendMeasureParams also returns the effective tube diameter the window
// and the gentle-bend floor are both sized from, so the two cannot drift.
func bendMeasureParams(pl Polyline, limits Limits) (stepMM float64, half int, diameterMM float64) {
	d := runDiameterMM(pl, limits)
	if d <= 0 {
		d = bendFallbackDiameterMM
	}
	diameterMM = d
	half = bendWindowHalfSamples
	windowMM := bendHeatZoneDiameters * d
	// The measured window spans from the midpoint of segment i-half to the
	// midpoint of segment i+half-1 — that is 2*half-1 steps, not 2*half.
	// Sizing the step off the wrong one biases every radius by
	// 2*half/(2*half-1): probed at half=4 on a true r=25mm circle it read
	// 28.55mm, a 14% over-estimate, enough to clear a 27mm limit.
	return windowMM / float64(2*half-1), half, d
}

// bendSweepRadiusMM is where a curve stops being a discrete bend and
// becomes a ribbon-burner sweep: 150 mm. Curves gentler than this are one
// continuous heat along the pattern rather than a formed bend, so they
// are not segmented into separate bends for reporting.
//
// Source: docs/neon-rules/bend-radius.md — "for ribbon-burner curved
// bends in tall letters, the practical curvature radius observed in
// Miller's worked example bottoms out around 150 mm (6 in) for a 12-mm
// tube" (an 18-inch "O", Miller p. 118).
//
// Deliberately NOT scaled by tube diameter. How a design divides into
// bends is a property of the drawing; two shops quoting the same artwork
// in ø8 and ø15 must see the same bends and differ only in the verdict on
// each. A ø-scaled floor was tried and inverted the headline result:
// probed on the OPEN raster fixture at 6 mm smoothing it reported 9, 7,
// 6, 5 errors across ø8/10/12/15 — falling as the tube got harder to
// bend, because the bigger floor merged more of the letterform into
// fewer bends.
const bendSweepRadiusMM = 150.0

// gentleBendRadiusMM is the loosest curve still counted as a bend.
func gentleBendRadiusMM(float64) float64 {
	return bendSweepRadiusMM
}

// wrapPi folds an angle into (-π, π].
func wrapPi(a float64) float64 {
	for a <= -math.Pi {
		a += 2 * math.Pi
	}
	for a > math.Pi {
		a -= 2 * math.Pi
	}
	return a
}

// bendRadiiOverWindow returns, for each sample of the resampled polyline,
// the bend radius measured at design scale: the arc length of the
// heat-zone window centred on that sample divided by the net turn of the
// tangent across it (r = L / Δθ). Samples where the window runs off the
// end of an open run — or where the turn is negligible — come back +Inf.
//
// This estimator, not a 3-point circumradius, is what makes the number
// mean "bend radius". A circumradius through three consecutive samples
// measures the corner *as drawn*, so it reports the sampling density: on
// a 90° corner the answer is 0.75 × the resample step and on the same
// corner sampled twice as finely it halves. Net turn over a fixed
// physical window is a property of the shape alone — a corner and a
// smooth arc that turn through the same angle over the same length of
// glass get the same answer, which is also true of the glass.
//
// It is deliberately blind to detail finer than the window: sub-millimetre
// vectorizer staircase noise contributes turns that cancel to ~0, and an
// S-bend whose two halves fit inside one heat zone cancels too (see the
// finding's "known limits" — sharp_bend_angle still fires on those).
func bendRadiiOverWindow(pts []Point, closed bool, half int) []float64 {
	n := len(pts)
	out := make([]float64, n)
	for i := range out {
		out[i] = math.Inf(1)
	}
	// Segment count: a closed run has one more segment than an open one
	// (the seam from the last point back to the first).
	segs := n - 1
	if closed {
		segs = n
	}
	if segs < 2*half {
		return out
	}
	dirs := make([]float64, segs)
	segLen := make([]float64, segs)
	for k := 0; k < segs; k++ {
		a, b := pts[k], pts[(k+1)%n]
		dirs[k] = math.Atan2(b.Y-a.Y, b.X-a.X)
		segLen[k] = dist(a, b)
	}
	lo, hi := half, n-1-half
	if closed {
		lo, hi = 0, n-1
	}
	for i := lo; i <= hi; i++ {
		var turn, arc float64
		// Walk segments i-half .. i+half-1. A vertex turn sits between two
		// segments, so the arc length that turn acts over runs from the
		// midpoint of the first segment to the midpoint of the last —
		// hence the half weights on the ends. Weighting whole segments
		// against one fewer turn is what produced the 14% bias above.
		for t := 0; t < 2*half; t++ {
			k := i - half + t
			if closed {
				k = ((k % segs) + segs) % segs
			}
			if t == 0 || t == 2*half-1 {
				arc += segLen[k] / 2
			} else {
				arc += segLen[k]
			}
			if t > 0 {
				prev := i - half + t - 1
				if closed {
					prev = ((prev % segs) + segs) % segs
				}
				turn += wrapPi(dirs[k] - dirs[prev])
			}
		}
		turn = math.Abs(turn)
		// A turn this small over a whole heat zone is a straight leg; the
		// radius is effectively infinite and dividing by it is noise.
		if turn < 1e-9 || arc <= 0 {
			continue
		}
		out[i] = arc / turn
	}
	return out
}

// checkBendRadius measures, for every sample of every run, the bend radius
// the bender would actually have to form — arc length over net turn across
// one heat zone (2 × tube ø) — and emits ONE issue per contiguous stretch
// that comes out below the tube's minimum, located at the worst sample in
// that stretch.
//
// Structural double-back hairpins (180° turns flanked by parallel legs,
// "DB" in Blazek's alphabet books) and user-marked double-backs are exempt:
// they are construction, not error.
//
// Two properties this rule now has and did not before, both pinned by
// tests in rules_test.go:
//
//   - The measurement never consults the threshold, so the set of failing
//     samples grows monotonically as min_bend_radius_mm rises.
//   - Resampling the same drawn shape at a different vertex density does
//     not change the answer, so the count reports the design rather than
//     how the raster was prepared.
func checkBendRadius(polylines []Polyline, limits Limits) []Issue {
	var issues []Issue
	for _, pl := range polylines {
		limitMM := runBendLimitMM(pl, limits)
		if limitMM <= 0 {
			continue
		}
		stepMM, half, measureD := bendMeasureParams(pl, limits)
		if stepMM <= 0 {
			continue
		}
		sampled := resampleUniform(pl, stepMM)
		pts := sampled.Points
		n := len(pts)
		if n < 2*half+1 {
			continue
		}
		radii := bendRadiiOverWindow(pts, sampled.Closed, half)
		hairpinD := runDiameterMM(pl, limits)

		// Segment the run into BENDS before applying the limit, and do it
		// with a threshold the limit cannot move. Grouping by "is this
		// sample failing" instead would make the grouping limit-dependent:
		// as the limit rises, neighbouring failures merge, and the reported
		// count falls again. Probed on the OPEN raster fixture at ø12,
		// sweeping the limit 10→60 mm under failure-grouping: 0, 3, 4, 6,
		// 6, 9, 8, 8, 6, 6, 6 — non-monotone, the original defect wearing
		// a different hat. Segmenting on curvature first makes the group
		// set a property of the drawn shape, so the count can only rise.
		floorMM := math.Max(gentleBendRadiusMM(measureD), limitMM)
		curving := make([]bool, n)
		exempt := make([]bool, n)
		for i := 0; i < n; i++ {
			curving[i] = radii[i] < floorMM
			exempt[i] = isDoubleBackHairpin(pts, sampled.Closed, i, stepMM, hairpinD) ||
				hasUserDoubleback(pts[i], pl.DoublebackMarks, hairpinD)
		}

		suffix := ""
		if pl.DiameterMM > 0 && pl.DiameterMM != limits.DiameterMM {
			suffix = fmt.Sprintf(" (run override: ø%.1fmm)", pl.DiameterMM)
		}
		// Two curving stretches less than half a heat zone apart are one
		// bend — the bender forms them in a single heating. The gap is
		// physical (D/2), never a function of the limit.
		for _, g := range contiguousGroups(curving, sampled.Closed, half) {
			// The exemption is a property of the BEND, not of a sample. A
			// double-back's apex is recognised as a hairpin, but samples a
			// few millimetres either side of it sit off-centre in the
			// look-around window and are not — so a per-sample test let the
			// shoulders of an exempted DB fire as two errors flanking the
			// apex it had just excused. If any sample in the stretch is a
			// recognised (or user-marked) double-back, the whole stretch is
			// that construction.
			skip := false
			for _, i := range g {
				if exempt[i] {
					skip = true
					break
				}
			}
			if skip {
				continue
			}
			worst, worstR := g[0], radii[g[0]]
			for _, i := range g {
				if radii[i] < worstR {
					worst, worstR = i, radii[i]
				}
			}
			// One issue per bend, judged on the tightest point the bender
			// has to reach in it.
			if worstR >= limitMM {
				continue
			}
			issues = append(issues, Issue{
				Rule:     RuleMinBendRadius,
				Severity: SeverityError,
				Message: fmt.Sprintf("bend radius %.1fmm below tube minimum %.1fmm%s",
					worstR, limitMM, suffix),
				XMM: pts[worst].X,
				YMM: pts[worst].Y,
			})
		}
	}
	return issues
}

// contiguousGroups splits a per-sample boolean mask into runs of true
// indices, bridging gaps of up to maxGap false samples. For a closed
// polyline a group spanning the seam (index 0 adjacent to index n-1) is
// joined into one, so a tight bend that happens to sit where the loop was
// cut still reports as one bend rather than two.
func contiguousGroups(mask []bool, closed bool, maxGap int) [][]int {
	n := len(mask)
	var groups [][]int
	var cur []int
	gap := 0
	for i := 0; i < n; i++ {
		if mask[i] {
			cur = append(cur, i)
			gap = 0
			continue
		}
		if len(cur) == 0 {
			continue
		}
		gap++
		if gap > maxGap {
			groups = append(groups, cur)
			cur = nil
			gap = 0
		}
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	if closed && len(groups) > 1 {
		first, last := groups[0], groups[len(groups)-1]
		// Count the false samples that separate the last group's tail from
		// the first group's head around the seam.
		seamGap := (n - 1 - last[len(last)-1]) + first[0]
		if seamGap <= maxGap {
			groups[0] = append(last, first...)
			groups = groups[:len(groups)-1]
		}
	}
	return groups
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
// points are physically close (within ~4× tube diameter), have tangent
// directions that are anti-parallel (cos < -0.7), AND the flanks are
// substantially straighter than the apex, the vertex is between two
// opposing legs, i.e. a hairpin apex.
//
// The flank-straightness test is load-bearing, not belt-and-braces. The
// first three conditions are ALL satisfied by a small closed loop — an
// "o" bowl a few tube diameters across puts two near-antipodal samples
// close together with anti-parallel tangents, exactly like a U-turn — so
// without it the rule silently exempted the tight bowls it exists to
// catch. Probed on ø12 tube: closed loops of radius 20 mm and 24 mm were
// both exempted as double-backs and reported zero bend errors at a 40 mm
// limit. A real double-back turns through ~180° at the apex and then runs
// straight; a bowl keeps turning at the same rate all the way round, so
// its outer quarters carry ~half the total turn against a hairpin's ~none.
func isDoubleBackHairpin(points []Point, closed bool, idx int, stepMM, tubeDiameterMM float64) bool {
	if tubeDiameterMM <= 0 {
		return false
	}
	// Look ahead by enough arc length that we're past the curve onto the
	// straight legs. ~3× tube diameter is enough for typical hairpins.
	lookMM := math.Max(3*tubeDiameterMM, 10)
	K := int(math.Ceil(lookMM / stepMM))
	n := len(points)
	if n < 2*K+1 || K < 2 {
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
	if cos := dot(tBefore, tAfter); cos >= -0.7 {
		return false
	}
	// Flanks straighter than the apex: the outer quarter of the look-around
	// window on each side must carry well under a quarter of the total turn.
	total := math.Abs(turnBetween(points, closed, idx-K, idx+K))
	if total < 1e-9 {
		return false
	}
	half := K / 2
	flank := math.Abs(turnBetween(points, closed, idx-K, idx-half)) +
		math.Abs(turnBetween(points, closed, idx+half, idx+K))
	return flank < 0.25*total
}

// turnBetween returns the signed net turn of the tangent walking forward
// from sample `from` to sample `to`. Indices are unwrapped — negative and
// past-the-end values are folded around the seam for closed polylines and
// clamped for open ones.
func turnBetween(points []Point, closed bool, from, to int) float64 {
	n := len(points)
	segs := n - 1
	if closed {
		segs = n
	}
	if segs < 2 || to <= from {
		return 0
	}
	if !closed {
		if from < 0 {
			from = 0
		}
		if to > segs {
			to = segs
		}
		if to <= from {
			return 0
		}
	}
	dirAt := func(k int) float64 {
		if closed {
			k = ((k % segs) + segs) % segs
		}
		a, b := points[k], points[(k+1)%n]
		return math.Atan2(b.Y-a.Y, b.X-a.X)
	}
	total := 0.0
	for k := from + 1; k < to; k++ {
		total += wrapPi(dirAt(k) - dirAt(k-1))
	}
	return total
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
					"run-end lead-in %.1fmm below recommended minimum %.1fmm — the straight section at this run end (where an electrode will sit) is too short; short lead-ins crack at the seal under handling and thermal cycling",
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
		// spacing: tied to the bend-radius limit when present, else a
		// sensible mm value that survives short straight legs.
		//
		// This USED to be shared with checkBendRadius and the comment here
		// said so. It no longer is — Tier 1 #131 moved that rule off any
		// limit-derived spacing, because deriving the measurement from the
		// threshold it is compared against makes a stricter spec measure
		// more coarsely and cancel itself out. This rule has the same
		// shape of problem (its cluster radius below is 1.5 × the limit
		// too) but it is a warning about interior ANGLE, which is
		// scale-free in a way a radius is not, so it is left alone here
		// rather than changed in a bend-radius PR. Filed as a follow-up;
		// do not "restore consistency" by copying the old heuristic back.
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

// ---------------------------------------------------------------------------
// Tier 2 #104 / NW #133 — raceway rules
// ---------------------------------------------------------------------------

// RacewayInput is one modelled raceway box, reduced to the numbers the two
// rules below need. The caller assembles it — see designdoc.RacewayInputs —
// because internal/validate cannot import internal/designdoc (designdoc
// imports validate, and the dependency only runs one way).
//
// MemberMinXMM / MemberMaxXMM are the ARC-AWARE X extent of the runs carrying
// this raceway's id: an extent taken from raw vertices clips the bow of an
// arc, and a rule built on it would clear a box that is actually short.
type RacewayInput struct {
	ID       string
	XMM      float64 // left edge, world mm
	LengthMM float64
	YMM      float64 // the guideline's Y — used to place the marker
	// Extent of the member runs. Meaningless unless HasMembers.
	MemberMinXMM float64
	MemberMaxXMM float64
	HasMembers   bool
	// TransformerCount is derived from electrode pairs on the member runs.
	TransformerCount int
	// TransformerLengthMM is the case length of one transformer. Zero falls
	// back to RacewayTransformerLengthMM.
	TransformerLengthMM float64
}

// Raceway rule limits. Both numbers come from docs/neon-rules/raceway.md,
// whose source class is supplier pages and a trade forum rather than the
// trade textbooks every other rule in this file cites — which is exactly why
// BOTH raceway rules are warnings. A shop running a different box or a
// different transformer must not be blocked by our defaults.
const (
	// RacewayTransformerLengthMM is the measured case length of a 10 kV /
	// 30 mA electronic neon transformer (6¼ in). This is the twin of
	// designdoc.TransformerLengthMM; TestTransformerLengthTwinsAgree in
	// internal/designdoc pins the two together.
	RacewayTransformerLengthMM = 159.0

	// RacewayTransformerClearanceMM is the gap allowed beside each
	// transformer for GTO routing and for a hand to reach in.
	//
	// PROVENANCE: this one is a NeonBench engineering judgement, not a
	// citation. No source gives a spacing figure; what the sources DO say is
	// that hand access is the reason the box is as big as it is (SignMonkey
	// via Graphics Pro: "enough room to get his hands inside to make
	// connections"). 1 in per unit is the smallest allowance consistent with
	// that, and it only ever produces a warning.
	RacewayTransformerClearanceMM = 25.4

	// racewaySpanToleranceMM absorbs float noise from the arc flattener so a
	// box fitted to its own runs does not immediately warn that it fails to
	// span them. Well below any dimension a fabricator can hold.
	racewaySpanToleranceMM = 0.05
)

// CheckRaceways runs the two raceway rules over every modelled box.
//
// Both are WARNINGS. See the const block above: these are current commercial
// practice from a weaker source class than the rest of docs/neon-rules/, so
// they inform the operator rather than blocking the job.
func CheckRaceways(inputs []RacewayInput) []Issue {
	if len(inputs) == 0 {
		return nil
	}
	var issues []Issue
	for _, rw := range inputs {
		issues = append(issues, checkRacewaySpan(rw)...)
		issues = append(issues, checkRacewayTransformerFit(rw)...)
	}
	return issues
}

// checkRacewaySpan flags a raceway that does not reach its own runs.
//
// This is the rule that catches an auto-fit that was never re-run after the
// letters moved: the tubes are tagged for a box that no longer spans them, so
// the outermost letter has nothing to bolt to.
func checkRacewaySpan(rw RacewayInput) []Issue {
	if !rw.HasMembers || rw.LengthMM <= 0 {
		return nil
	}
	left := rw.XMM
	right := rw.XMM + rw.LengthMM
	overLeft := left - rw.MemberMinXMM   // > 0 → runs stick out to the left
	overRight := rw.MemberMaxXMM - right // > 0 → runs stick out to the right
	if overLeft <= racewaySpanToleranceMM && overRight <= racewaySpanToleranceMM {
		return nil
	}
	var where string
	var markerX float64
	switch {
	case overLeft > racewaySpanToleranceMM && overRight > racewaySpanToleranceMM:
		where = fmt.Sprintf("%.0fmm past the left end and %.0fmm past the right", overLeft, overRight)
		markerX = (rw.MemberMinXMM + rw.MemberMaxXMM) / 2
	case overLeft > racewaySpanToleranceMM:
		where = fmt.Sprintf("%.0fmm past the left end", overLeft)
		markerX = rw.MemberMinXMM
	default:
		where = fmt.Sprintf("%.0fmm past the right end", overRight)
		markerX = rw.MemberMaxXMM
	}
	return []Issue{{
		Rule:     RuleRacewaySpan,
		Severity: SeverityWarning,
		Message: fmt.Sprintf(
			"raceway %s does not span its runs — glass reaches %s (box %.0fmm from x=%.0f, runs %.0f…%.0f). Re-run auto-fit if the letters moved.",
			rw.ID, where, rw.LengthMM, rw.XMM, rw.MemberMinXMM, rw.MemberMaxXMM),
		XMM: markerX,
		YMM: rw.YMM,
	}}
}

// checkRacewayTransformerFit flags a raceway too short to hold the
// transformers the design implies.
//
// A transformer is 159mm long and lies ALONG the run — it does not fit across
// the box (docs/neon-rules/raceway.md, "Cross-section"), so the constraint is
// on length, not on depth. Four letters wanting four transformers in a 900mm
// raceway do not go together, and today that is discovered on a lift.
func checkRacewayTransformerFit(rw RacewayInput) []Issue {
	if rw.TransformerCount <= 0 || rw.LengthMM <= 0 {
		return nil
	}
	unit := rw.TransformerLengthMM
	if unit <= 0 {
		unit = RacewayTransformerLengthMM
	}
	needed := float64(rw.TransformerCount) * (unit + RacewayTransformerClearanceMM)
	if needed <= rw.LengthMM+racewaySpanToleranceMM {
		return nil
	}
	suffix := "s"
	if rw.TransformerCount == 1 {
		suffix = ""
	}
	return []Issue{{
		Rule:     RuleRacewayTransformerFit,
		Severity: SeverityWarning,
		Message: fmt.Sprintf(
			"raceway %s is %.0fmm long but %d transformer%s need %.0fmm laid along it (%.0fmm each + %.1fmm clearance)",
			rw.ID, rw.LengthMM, rw.TransformerCount, suffix, needed, unit, RacewayTransformerClearanceMM),
		XMM: rw.XMM + rw.LengthMM/2,
		YMM: rw.YMM,
	}}
}
