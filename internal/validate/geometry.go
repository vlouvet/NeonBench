package validate

import "math"

type Point struct {
	X, Y float64
}

func dot(a, b Point) float64 { return a.X*b.X + a.Y*b.Y }

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
//
// DiameterMM is the per-run tube-diameter override, parsed from the SVG
// path's data-tube-diameter-mm attribute. Zero means no override and rules
// fall back to the project tube spec.
type Polyline struct {
	Points     []Point
	Closed     bool
	DiameterMM float64
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

// tangentAt returns a unit-length tangent direction at sample j, using a
// centered finite difference. Falls back to forward/backward at the ends.
// For closed polylines, ends wrap.
func tangentAt(points []Point, j int, closed bool) Point {
	n := len(points)
	if n < 2 {
		return Point{1, 0}
	}
	var prev, next int
	switch {
	case closed:
		prev = (j - 1 + n) % n
		next = (j + 1) % n
	case j == 0:
		prev, next = 0, 1
	case j == n-1:
		prev, next = n-2, n-1
	default:
		prev, next = j-1, j+1
	}
	dx := points[next].X - points[prev].X
	dy := points[next].Y - points[prev].Y
	d := math.Hypot(dx, dy)
	if d == 0 {
		return Point{1, 0}
	}
	return Point{dx / d, dy / d}
}
