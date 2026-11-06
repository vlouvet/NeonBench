package validate

import (
	"math"
	"sort"
)

// arcRun is a polyline parameterised by arc length, so a rule can ask for
// "the point h mm before this one" without first snapping the run onto a
// grid. Tier 3 #180: a grid anchored at the run's start drops the drawn
// vertices, so whether a corner was measured depended on where it fell
// relative to the grid — the same 60° corner was flagged or missed as it
// slid along the run.
type arcRun struct {
	pts    []Point   // vertices, zero-length segments dropped; closed runs repeat pts[0] at the end
	cum    []float64 // cum[i] = arc length from pts[0] to pts[i]
	closed bool
}

func newArcRun(pl Polyline) arcRun {
	var pts []Point
	for _, p := range pl.Points {
		if len(pts) > 0 && dist(pts[len(pts)-1], p) == 0 {
			continue
		}
		pts = append(pts, p)
	}
	if pl.Closed && len(pts) > 1 {
		if dist(pts[len(pts)-1], pts[0]) == 0 {
			pts = pts[:len(pts)-1]
		}
		pts = append(pts, pts[0])
	}
	cum := make([]float64, len(pts))
	for i := 1; i < len(pts); i++ {
		cum[i] = cum[i-1] + dist(pts[i-1], pts[i])
	}
	return arcRun{pts: pts, cum: cum, closed: pl.Closed}
}

func (r arcRun) length() float64 {
	if len(r.cum) == 0 {
		return 0
	}
	return r.cum[len(r.cum)-1]
}

// at returns the point at arc length s. Closed runs wrap; open runs clamp
// to their endpoints, which is exact for the angle rule because a
// neighbour anywhere on a straight leg sees the same included angle.
func (r arcRun) at(s float64) Point {
	n := len(r.pts)
	if n == 0 {
		return Point{}
	}
	L := r.length()
	if n == 1 || L == 0 {
		return r.pts[0]
	}
	if r.closed {
		s = math.Mod(s, L)
		if s < 0 {
			s += L
		}
	} else if s <= 0 {
		return r.pts[0]
	} else if s >= L {
		return r.pts[n-1]
	}
	// First vertex at or beyond s; the segment is (j-1, j).
	j := sort.SearchFloat64s(r.cum, s)
	if j == 0 {
		return r.pts[0]
	}
	if j >= n {
		return r.pts[n-1]
	}
	a, b := r.pts[j-1], r.pts[j]
	seg := r.cum[j] - r.cum[j-1]
	t := (s - r.cum[j-1]) / seg
	return Point{a.X + (b.X-a.X)*t, a.Y + (b.Y-a.Y)*t}
}

// cornerArcs returns the arc-length positions of the vertices an angle can
// sit at: every interior vertex of an open run, every vertex (seam
// included) of a closed one.
func (r arcRun) cornerArcs() []float64 {
	n := len(r.pts)
	if r.closed {
		// pts[n-1] is the repeated pts[0].
		if n < 4 {
			return nil
		}
		return append([]float64(nil), r.cum[:n-1]...)
	}
	if n < 3 {
		return nil
	}
	return append([]float64(nil), r.cum[1:n-1]...)
}

// angleStations returns the arc-length positions at which the sharp-bend
// rule measures the included angle P(s-h), P(s), P(s+h). Every station is
// derived from the drawn vertices, never from the run's start, so sliding
// a feature along a run slides its stations with it — that is the whole
// phase-invariance property.
//
// The stations are each corner vertex v, the two points v±h where the
// measuring window starts and stops straddling it, and a subdivision of
// every gap between those at no more than h/4. The vertex alone is exact
// for an isolated corner on straight legs (the angle there IS the drawn
// angle, and every other s measures wider). The subdivision covers
// corners built from several close vertices — a chamfer, a flattened
// fillet — whose sharpest reading falls between vertices.
func (r arcRun) angleStations(h float64) []float64 {
	L := r.length()
	corners := r.cornerArcs()
	if len(corners) == 0 || L <= 0 || h <= 0 {
		return nil
	}
	var b []float64
	add := func(s float64) {
		if r.closed {
			s = math.Mod(s, L)
			if s < 0 {
				s += L
			}
			b = append(b, s)
			return
		}
		// Open runs have no angle at either endpoint.
		if s > 0 && s < L {
			b = append(b, s)
		}
	}
	for _, v := range corners {
		add(v)
		add(v - h)
		add(v + h)
	}
	if len(b) == 0 {
		return nil
	}
	sort.Float64s(b)
	const eps = 1e-9
	uniq := b[:1]
	for _, s := range b[1:] {
		if s-uniq[len(uniq)-1] > eps {
			uniq = append(uniq, s)
		}
	}
	maxGap := h / 4
	out := make([]float64, 0, len(uniq)*2)
	for i, s := range uniq {
		out = append(out, s)
		var next float64
		switch {
		case i+1 < len(uniq):
			next = uniq[i+1]
		case r.closed:
			next = uniq[0] + L
		default:
			continue
		}
		gap := next - s
		if k := int(math.Ceil(gap / maxGap)); k > 1 {
			for j := 1; j < k; j++ {
				out = append(out, s+gap*float64(j)/float64(k))
			}
		}
	}
	return out
}

// isDoubleBackAt runs isDoubleBackHairpin at arc length s. The detector
// counts its look-around in samples (K = ceil(look/step)), so it is handed
// a window sampled at exactly s + k·step: K samples is K·step mm wherever
// s falls, as it was on the uniform grid. One extra sample each side keeps
// the tangents at the window's ends centred, as they were mid-grid.
//
// gridSamples is the size of the run's uniform resample. The detector
// refuses runs with fewer than 2K+1 samples, and that refusal is kept so
// short runs and small closed loops behave as before.
func (r arcRun) isDoubleBackAt(s, step, tubeDiameterMM float64, gridSamples int) bool {
	if tubeDiameterMM <= 0 || step <= 0 {
		return false
	}
	lookMM := math.Max(3*tubeDiameterMM, 10)
	K := int(math.Ceil(lookMM / step))
	if K < 2 || gridSamples < 2*K+1 {
		return false
	}
	if !r.closed {
		const eps = 1e-9
		reach := float64(K) * step
		if s-reach < -eps || s+reach > r.length()+eps {
			return false
		}
	}
	win := make([]Point, 2*K+3)
	for k := -(K + 1); k <= K+1; k++ {
		win[k+K+1] = r.at(s + float64(k)*step)
	}
	return isDoubleBackHairpin(win, false, K+1, step, tubeDiameterMM)
}
