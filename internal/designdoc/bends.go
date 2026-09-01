package designdoc

import "math"

// BendPoint mirrors the TS computeBends output: an apex along a run's live
// arc that a fabricator would heat and form. Used by the PDF print pipeline
// to overlay numbered markers and emit a bend list.
type BendPoint struct {
	LiveIndex   int     // index into the live arc
	PointIndex  int     // index into run.Polyline.Points
	X           float64 // mm
	Y           float64 // mm
	ArcLengthMM float64 // arc length from the start of the live arc
	RadiusMM    float64 // approximate local bend radius
	AngleDeg    float64 // approximate cumulative turn angle through the bend
}

const (
	bendTurnMinDeg   = 20.0
	bendClusterScale = 2.0
)

// EffectiveBends returns the bend list the renderer should actually use:
// the user-authored Run.Bends when set, or the auto-detected list from
// ComputeBends when not. Manual bends still get their angle/radius
// computed from the polyline neighborhood so the bend-list page reads
// consistent regardless of mode.
func EffectiveBends(run Run, projectDiameterMM float64) []BendPoint {
	if len(run.Bends) == 0 {
		return ComputeBends(run, projectDiameterMM)
	}
	liveIdx, _ := liveArcIndices(run)
	if len(liveIdx) < 3 {
		return nil
	}
	pts := make([][2]float64, len(liveIdx))
	for i, j := range liveIdx {
		pts[i] = run.Polyline.Points[j]
	}
	n := len(pts)
	// Tier 3 #78 — an arc is ~15.9% longer than its chord, so chord-summing
	// would place every downstream callout short along the glass.
	arcLen := make([]float64, n)
	for i := 1; i < n; i++ {
		arcLen[i] = arcLen[i-1] + run.Polyline.WalkSegmentLengthMM(liveIdx[i-1], liveIdx[i])
	}
	out := make([]BendPoint, 0, len(run.Bends))
	for _, b := range run.Bends {
		li := b.LiveIndex
		if li < 0 || li >= n {
			continue
		}
		lo, hi := max0(li-1), minN(li+1, n-1)
		a := pts[lo]
		c := pts[hi]
		// Tangent-aware: an arc leaves and rejoins its chord at half the
		// included angle, so the chord-to-chord turn is not what gets bent.
		angleRad := math.Abs(run.Polyline.VertexTurnDeg(liveIdx[lo], liveIdx[li], liveIdx[hi])) * math.Pi / 180
		r := run.Polyline.VertexArcRadiusMM(liveIdx[lo], liveIdx[li], liveIdx[hi])
		if r == 0 {
			r = circumradius(a, pts[li], c)
		}
		out = append(out, BendPoint{
			LiveIndex:   li,
			PointIndex:  liveIdx[li],
			X:           pts[li][0],
			Y:           pts[li][1],
			ArcLengthMM: arcLen[li],
			RadiusMM:    r,
			AngleDeg:    angleRad * 180 / math.Pi,
		})
	}
	return out
}

// ComputeBends walks a run's live arc and returns the apex points for each
// detected bend. The detection mirrors web/src/lib/bends.ts so the editor's
// preview and the printed pattern see the same set of bends.
func ComputeBends(run Run, projectDiameterMM float64) []BendPoint {
	liveIdx, _ := liveArcIndices(run)
	if len(liveIdx) < 3 {
		return nil
	}
	pts := make([][2]float64, len(liveIdx))
	for i, j := range liveIdx {
		pts[i] = run.Polyline.Points[j]
	}
	n := len(pts)

	// Tier 3 #78 — arc-aware, same reasoning as EffectiveBends above.
	arcLen := make([]float64, n)
	for i := 1; i < n; i++ {
		arcLen[i] = arcLen[i-1] + run.Polyline.WalkSegmentLengthMM(liveIdx[i-1], liveIdx[i])
	}

	turn := make([]float64, n)
	for i := 1; i < n-1; i++ {
		// Magnitude, not signed: detection below compares against a threshold
		// and clusters by size, so a signed value would make every right-hand
		// bend fall under it and vanish from the list.
		turn[i] = math.Abs(run.Polyline.VertexTurnDeg(liveIdx[i-1], liveIdx[i], liveIdx[i+1])) * math.Pi / 180
	}

	smoothed := make([]float64, n)
	for i := 1; i < n-1; i++ {
		var a, b, c float64
		if i > 1 {
			a = turn[i-1]
		}
		b = turn[i]
		if i < n-2 {
			c = turn[i+1]
		}
		smoothed[i] = a + b + c
	}

	turnMinRad := bendTurnMinDeg * math.Pi / 180

	var raw []BendPoint
	inBend := false
	bestI := -1
	bestVal := 0.0
	flush := func() {
		if !inBend || bestI < 0 {
			return
		}
		lo, hi := max0(bestI-1), minN(bestI+1, n-1)
		a := pts[lo]
		b := pts[bestI]
		c := pts[hi]
		// When an arc meets this vertex, its radius is the one the bender
		// forms; the chord circumradius would understate the curve.
		r := run.Polyline.VertexArcRadiusMM(liveIdx[lo], liveIdx[bestI], liveIdx[hi])
		if r == 0 {
			r = circumradius(a, b, c)
		}
		raw = append(raw, BendPoint{
			LiveIndex:   bestI,
			PointIndex:  liveIdx[bestI],
			X:           pts[bestI][0],
			Y:           pts[bestI][1],
			ArcLengthMM: arcLen[bestI],
			RadiusMM:    r,
			AngleDeg:    bestVal * 180 / math.Pi,
		})
		inBend = false
		bestI = -1
		bestVal = 0
	}
	for i := 0; i < n; i++ {
		if smoothed[i] >= turnMinRad {
			if !inBend || smoothed[i] > bestVal {
				bestI = i
				bestVal = smoothed[i]
			}
			inBend = true
		} else if inBend {
			flush()
		}
	}
	flush()

	D := projectDiameterMM
	if run.TubeDiameterMM > 0 {
		D = run.TubeDiameterMM
	}
	clusterMM := D * bendClusterScale
	merged := raw[:0]
	for _, b := range raw {
		if len(merged) > 0 {
			last := &merged[len(merged)-1]
			if b.ArcLengthMM-last.ArcLengthMM < clusterMM {
				if b.AngleDeg > last.AngleDeg {
					*last = b
				}
				continue
			}
		}
		merged = append(merged, b)
	}
	return merged
}

func dist2(a, b [2]float64) float64 {
	dx := a[0] - b[0]
	dy := a[1] - b[1]
	return math.Sqrt(dx*dx + dy*dy)
}

func circumradius(a, b, c [2]float64) float64 {
	ab := dist2(a, b)
	bc := dist2(b, c)
	ca := dist2(c, a)
	s := (ab + bc + ca) / 2
	areaSq := s * (s - ab) * (s - bc) * (s - ca)
	if areaSq <= 0 {
		return math.Inf(1)
	}
	area := math.Sqrt(areaSq)
	if area < 1e-9 {
		return math.Inf(1)
	}
	return ab * bc * ca / (4 * area)
}

func max0(i int) int {
	if i < 0 {
		return 0
	}
	return i
}

func minN(i, max int) int {
	if i > max {
		return max
	}
	return i
}
