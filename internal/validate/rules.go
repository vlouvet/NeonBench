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
// curve doesn't fire 30 markers along its arc.
func checkBendRadiusClustered(polylines []Polyline, limitMM float64) []Issue {
	raw := checkBendRadius(polylines, limitMM)
	return clusterIssues(raw, math.Max(limitMM*1.5, 5))
}

// checkBendRadius scans each polyline using a 3-point discrete circumradius
// and emits an issue at any vertex where r < limit.
func checkBendRadius(polylines []Polyline, limitMM float64) []Issue {
	if limitMM <= 0 {
		return nil
	}
	var issues []Issue
	for _, pl := range polylines {
		// We need fairly tight sampling for stable curvature. Resample at
		// ~limit/4 spacing — capped to a sensible range.
		step := math.Max(0.5, math.Min(limitMM/4, 5))
		sampled := resampleUniform(pl, step)
		pts := sampled.Points
		n := len(pts)
		if n < 3 {
			continue
		}
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
				emitted[i] = true
				issues = append(issues, Issue{
					Rule:     RuleMinBendRadius,
					Severity: SeverityError,
					Message:  fmt.Sprintf("bend radius %.1fmm below tube minimum %.1fmm", r, limitMM),
					XMM:      pts[i].X,
					YMM:      pts[i].Y,
				})
			}
		}
	}
	return issues
}

// checkSegmentLength flags each subpath whose total arc length exceeds limit.
func checkSegmentLength(polylines []Polyline, limitMM float64) []Issue {
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

// checkSpacing flags pairs of points closer than limitMM that don't lie on
// the same continuous, mostly-straight section of a polyline. Uses a
// uniform spatial grid to keep the pairwise check ~O(N).
//
// Same-polyline filtering is the subtle part: we want to flag two parallel
// sides of a "U" turn (genuinely two close tubes), but not two consecutive
// samples on the same gently-curving run. We compare arc length to
// straight-line distance: if arc/geom is small (< arcRatioThreshold), the
// polyline didn't fold back, so the points are on the same tube section.
// After detection, nearby flags get clustered to keep the marker count sane.
func checkSpacing(polylines []Polyline, limitMM float64) []Issue {
	if limitMM <= 0 {
		return nil
	}
	const sampleStep = 1.0 // mm
	const arcRatioThreshold = 3.0

	type plSamples struct {
		points []Point
		closed bool
	}
	plSampled := make([]plSamples, len(polylines))

	var pts []indexedPoint
	for plIdx, pl := range polylines {
		s := resampleUniform(pl, sampleStep)
		plSampled[plIdx] = plSamples{points: s.Points, closed: s.Closed}
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
					}
					issues = append(issues, Issue{
						Rule:     RuleMinSpacing,
						Severity: SeverityError,
						Message:  fmt.Sprintf("tubes %.1fmm apart, below minimum spacing %.1fmm", d, limitMM),
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
