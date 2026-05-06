package vectorize

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
)

// MMPoint is a polyline vertex in millimeter coordinates.
type MMPoint struct{ X, Y float64 }

// MMPolyline is a polyline in mm — what we hand to the SVG emitter and
// to validate.ExtractMMPolylines downstream callers don't need to know.
type MMPolyline struct {
	Points []MMPoint
	Closed bool
}

// pixelsToMM converts a pixel polyline to mm coordinates. Closed
// polylines come in with the start point repeated at the end (the graph
// walker emits them that way); we drop the duplicate and set Closed.
func pixelsToMM(pix []point, mmPerPx float64) MMPolyline {
	if len(pix) == 0 {
		return MMPolyline{}
	}
	closed := false
	pts := pix
	if len(pts) >= 3 && pts[0] == pts[len(pts)-1] {
		closed = true
		pts = pts[:len(pts)-1]
	}
	out := make([]MMPoint, len(pts))
	for i, p := range pts {
		out[i] = MMPoint{X: float64(p.X) * mmPerPx, Y: float64(p.Y) * mmPerPx}
	}
	return MMPolyline{Points: out, Closed: closed}
}

// RDPSimplify runs Ramer-Douglas-Peucker on a polyline with the given
// epsilon (in mm). Endpoints are always kept for open polylines; closed
// polylines first anchor on the point furthest from the centroid so the
// run isn't simplified away into nothing.
func RDPSimplify(pl MMPolyline, epsilonMM float64) MMPolyline {
	if epsilonMM <= 0 || len(pl.Points) < 3 {
		return pl
	}
	if pl.Closed {
		return rdpClosed(pl, epsilonMM)
	}
	keep := make([]bool, len(pl.Points))
	keep[0] = true
	keep[len(keep)-1] = true
	rdpRecurse(pl.Points, 0, len(pl.Points)-1, epsilonMM, keep)
	return collectKept(pl, keep)
}

func rdpClosed(pl MMPolyline, eps float64) MMPolyline {
	n := len(pl.Points)
	if n < 4 {
		return pl
	}
	// Anchor: the point furthest from the centroid. Re-run RDP on the
	// rotated open polyline pinned at that anchor, then re-close.
	var cx, cy float64
	for _, p := range pl.Points {
		cx += p.X
		cy += p.Y
	}
	cx /= float64(n)
	cy /= float64(n)
	anchor := 0
	bestD := -1.0
	for i, p := range pl.Points {
		dx := p.X - cx
		dy := p.Y - cy
		d := dx*dx + dy*dy
		if d > bestD {
			bestD = d
			anchor = i
		}
	}
	rotated := make([]MMPoint, n+1)
	for i := 0; i < n; i++ {
		rotated[i] = pl.Points[(anchor+i)%n]
	}
	rotated[n] = rotated[0] // duplicate to close
	keep := make([]bool, len(rotated))
	keep[0] = true
	keep[len(keep)-1] = true
	rdpRecurse(rotated, 0, len(rotated)-1, eps, keep)
	out := make([]MMPoint, 0, n)
	for i, k := range keep {
		if !k {
			continue
		}
		if i == len(rotated)-1 {
			continue // drop the closing duplicate
		}
		out = append(out, rotated[i])
	}
	if len(out) < 3 {
		return pl
	}
	return MMPolyline{Points: out, Closed: true}
}

func rdpRecurse(pts []MMPoint, i, j int, eps float64, keep []bool) {
	if j-i < 2 {
		return
	}
	maxD := 0.0
	maxK := -1
	for k := i + 1; k < j; k++ {
		d := perpDistMM(pts[k], pts[i], pts[j])
		if d > maxD {
			maxD = d
			maxK = k
		}
	}
	if maxK >= 0 && maxD > eps {
		keep[maxK] = true
		rdpRecurse(pts, i, maxK, eps, keep)
		rdpRecurse(pts, maxK, j, eps, keep)
	}
}

func collectKept(pl MMPolyline, keep []bool) MMPolyline {
	out := make([]MMPoint, 0, len(pl.Points))
	for i, k := range keep {
		if k {
			out = append(out, pl.Points[i])
		}
	}
	return MMPolyline{Points: out, Closed: pl.Closed}
}

func perpDistMM(p, a, b MMPoint) float64 {
	dx := b.X - a.X
	dy := b.Y - a.Y
	len2 := dx*dx + dy*dy
	if len2 == 0 {
		dx2 := p.X - a.X
		dy2 := p.Y - a.Y
		return math.Sqrt(dx2*dx2 + dy2*dy2)
	}
	num := math.Abs(dy*p.X - dx*p.Y + b.X*a.Y - b.Y*a.X)
	return num / math.Sqrt(len2)
}

// EmitSVG renders the polylines into an SVG document with width/height in
// mm and a viewBox in mm so the existing validate/svg.go reader treats
// the coordinate system as identity-mapping to millimeters.
func EmitSVG(polys []MMPolyline, widthMM, heightMM float64) []byte {
	var buf bytes.Buffer
	fmt.Fprintf(&buf,
		`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="%smm" height="%smm" viewBox="0 0 %s %s">`,
		fmtFloat(widthMM), fmtFloat(heightMM), fmtFloat(widthMM), fmtFloat(heightMM))
	buf.WriteByte('\n')
	buf.WriteString(`<g fill="none" stroke="black" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round">`)
	buf.WriteByte('\n')
	for _, pl := range polys {
		if len(pl.Points) < 2 {
			continue
		}
		buf.WriteString(`<path d="`)
		for i, p := range pl.Points {
			cmd := "L"
			if i == 0 {
				cmd = "M"
			}
			fmt.Fprintf(&buf, "%s%s %s ", cmd, fmtFloat(p.X), fmtFloat(p.Y))
		}
		if pl.Closed {
			buf.WriteByte('Z')
		}
		buf.WriteString(`"/>`)
		buf.WriteByte('\n')
	}
	buf.WriteString(`</g>`)
	buf.WriteByte('\n')
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}

func fmtFloat(v float64) string { return strconv.FormatFloat(v, 'f', 3, 64) }
