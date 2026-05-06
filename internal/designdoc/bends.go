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

	arcLen := make([]float64, n)
	for i := 1; i < n; i++ {
		arcLen[i] = arcLen[i-1] + dist2(pts[i-1], pts[i])
	}

	turn := make([]float64, n)
	for i := 1; i < n-1; i++ {
		turn[i] = vertexTurn(pts[i-1], pts[i], pts[i+1])
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
		a := pts[max0(bestI-1)]
		b := pts[bestI]
		c := pts[minN(bestI+1, n-1)]
		r := circumradius(a, b, c)
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

func vertexTurn(a, b, c [2]float64) float64 {
	ax := b[0] - a[0]
	ay := b[1] - a[1]
	bx := c[0] - b[0]
	by := c[1] - b[1]
	la := math.Hypot(ax, ay)
	lb := math.Hypot(bx, by)
	if la == 0 || lb == 0 {
		return 0
	}
	cos := (ax*bx + ay*by) / (la * lb)
	if cos > 1 {
		cos = 1
	}
	if cos < -1 {
		cos = -1
	}
	return math.Acos(cos)
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
