package validate

// flattenCubic recursively subdivides a cubic Bezier until each segment is
// flat to within tol (in the same units as the points), appending sample
// points (excluding p0) to out.
func flattenCubic(out *[]Point, p0, p1, p2, p3 Point, tol float64) {
	if cubicIsFlat(p0, p1, p2, p3, tol) {
		*out = append(*out, p3)
		return
	}
	p01 := mid(p0, p1)
	p12 := mid(p1, p2)
	p23 := mid(p2, p3)
	p012 := mid(p01, p12)
	p123 := mid(p12, p23)
	p0123 := mid(p012, p123)
	flattenCubic(out, p0, p01, p012, p0123, tol)
	flattenCubic(out, p0123, p123, p23, p3, tol)
}

func mid(a, b Point) Point {
	return Point{(a.X + b.X) / 2, (a.Y + b.Y) / 2}
}

func cubicIsFlat(p0, p1, p2, p3 Point, tol float64) bool {
	d1 := pointLineDistSq(p1, p0, p3)
	d2 := pointLineDistSq(p2, p0, p3)
	t := tol * tol
	return d1 <= t && d2 <= t
}

func pointLineDistSq(p, a, b Point) float64 {
	dx := b.X - a.X
	dy := b.Y - a.Y
	if dx == 0 && dy == 0 {
		ddx := p.X - a.X
		ddy := p.Y - a.Y
		return ddx*ddx + ddy*ddy
	}
	t := ((p.X-a.X)*dx + (p.Y-a.Y)*dy) / (dx*dx + dy*dy)
	cx := a.X + t*dx
	cy := a.Y + t*dy
	ddx := p.X - cx
	ddy := p.Y - cy
	return ddx*ddx + ddy*ddy
}

// flattenQuadratic converts the quadratic to an equivalent cubic and reuses
// flattenCubic.
func flattenQuadratic(out *[]Point, p0, p1, p2 Point, tol float64) {
	c1 := Point{p0.X + (2.0/3.0)*(p1.X-p0.X), p0.Y + (2.0/3.0)*(p1.Y-p0.Y)}
	c2 := Point{p2.X + (2.0/3.0)*(p1.X-p2.X), p2.Y + (2.0/3.0)*(p1.Y-p2.Y)}
	flattenCubic(out, p0, c1, c2, p2, tol)
}
