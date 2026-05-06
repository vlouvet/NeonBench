package validate

import "math"

type Point struct {
	X, Y float64
}

func dist(a, b Point) float64 {
	dx := a.X - b.X
	dy := a.Y - b.Y
	return math.Sqrt(dx*dx + dy*dy)
}

// circumradius3 returns the radius of the circle through three points, or
// +Inf if they are collinear or coincident.
func circumradius3(a, b, c Point) float64 {
	ab := dist(a, b)
	bc := dist(b, c)
	ca := dist(c, a)
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

// Polyline is a sequence of points in millimeter coordinates representing a
// flattened subpath.
type Polyline struct {
	Points []Point
	Closed bool
}

// Length returns the total arc length of the polyline.
func (p *Polyline) Length() float64 {
	var total float64
	for i := 1; i < len(p.Points); i++ {
		total += dist(p.Points[i-1], p.Points[i])
	}
	if p.Closed && len(p.Points) > 1 {
		total += dist(p.Points[len(p.Points)-1], p.Points[0])
	}
	return total
}
