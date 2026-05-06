package designdoc

import (
	"bytes"
	"fmt"
	"math"
	"strconv"

	"github.com/vlouvet/neonbench/internal/validate"
)

func sqrt(x float64) float64 { return math.Sqrt(x) }

// FromSVG parses an SVG document and returns the structured design doc. Each
// disjoint subpath becomes a Run with no electrodes assigned.
//
// defaultDiameterMM is stored on each run as a starting tube diameter. The
// editor will allow per-run override later.
func FromSVG(svgData []byte, defaultDiameterMM float64) (*Doc, error) {
	polylines, bbox, _, err := validate.ExtractMMPolylines(svgData)
	if err != nil {
		return nil, fmt.Errorf("parse svg: %w", err)
	}
	runs := make([]Run, len(polylines))
	for i, pl := range polylines {
		pts := make([][2]float64, len(pl.Points))
		for j, p := range pl.Points {
			pts[j] = [2]float64{p.X, p.Y}
		}
		runs[i] = Run{
			ID:             fmt.Sprintf("run-%d", i+1),
			Polyline:       Polyline{Points: pts, Closed: pl.Closed},
			TubeDiameterMM: defaultDiameterMM,
		}
	}
	// Convert bbox [minX, minY, maxX, maxY] → [x, y, w, h].
	view := [4]float64{bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]}
	return &Doc{Version: SchemaVersion, ViewBoxMM: view, Runs: runs}, nil
}

// ToSVG renders a Doc back to a normalized SVG: width/height in millimeters,
// viewBox in mm-canonical coordinates, no nested transforms, one <path> per
// run. This SVG is what gets sent to the validator, the print pipeline, and
// the inline preview.
//
// Closed runs with exactly two electrodes are emitted as the LIVE arc only
// (the half of the loop the tube physically exists on), per the run's
// direction. Validation and PDF print therefore see only the real tube.
func ToSVG(doc *Doc) []byte {
	var buf bytes.Buffer
	w, h := doc.ViewBoxMM[2], doc.ViewBoxMM[3]
	if w <= 0 {
		w = 1
	}
	if h <= 0 {
		h = 1
	}
	fmt.Fprintf(&buf,
		`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="%smm" height="%smm" viewBox="%s %s %s %s">`,
		fmtFloat(w), fmtFloat(h),
		fmtFloat(doc.ViewBoxMM[0]), fmtFloat(doc.ViewBoxMM[1]),
		fmtFloat(w), fmtFloat(h))
	buf.WriteByte('\n')
	for _, run := range doc.Runs {
		if len(run.Polyline.Points) < 2 {
			continue
		}
		indices, closed := liveArcIndices(run)
		buf.WriteString(`<path fill="black" fill-rule="evenodd" stroke="none" d="`)
		for j, idx := range indices {
			cmd := "L"
			if j == 0 {
				cmd = "M"
			}
			p := run.Polyline.Points[idx]
			fmt.Fprintf(&buf, "%s%s %s ", cmd, fmtFloat(p[0]), fmtFloat(p[1]))
		}
		if closed {
			buf.WriteByte('Z')
		}
		buf.WriteString(`"/>`)
		buf.WriteByte('\n')
	}
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}

// liveArcIndices returns the polyline indices that make up the run's live
// tube — i.e. the actual physical tube path. For closed runs with two
// electrodes, the loop is split at the electrodes and only one arc is live;
// the other half exists only as design intent. For everything else, the
// whole polyline is live.
func liveArcIndices(run Run) (indices []int, closed bool) {
	n := len(run.Polyline.Points)
	if n == 0 {
		return nil, false
	}
	if !run.Polyline.Closed || len(run.Electrodes) != 2 {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out, run.Polyline.Closed
	}
	a := run.Electrodes[0].PointIndex
	b := run.Electrodes[1].PointIndex
	if a < 0 || a >= n || b < 0 || b >= n {
		// Defensive: invalid electrode indices fall back to whole loop.
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out, true
	}
	dir := run.Direction
	if dir == "" {
		dir = defaultDirection(run)
	}
	if dir == "backward" {
		return arcBackward(a, b, n), false
	}
	return arcForward(a, b, n), false
}

func arcForward(a, b, n int) []int {
	out := []int{a}
	for i := (a + 1) % n; ; i = (i + 1) % n {
		out = append(out, i)
		if i == b {
			break
		}
	}
	return out
}

func arcBackward(a, b, n int) []int {
	out := []int{a}
	for i := (a - 1 + n) % n; ; i = (i - 1 + n) % n {
		out = append(out, i)
		if i == b {
			break
		}
	}
	return out
}

func defaultDirection(run Run) string {
	if !run.Polyline.Closed || len(run.Electrodes) != 2 {
		return "forward"
	}
	n := len(run.Polyline.Points)
	a := run.Electrodes[0].PointIndex
	b := run.Electrodes[1].PointIndex
	fwdLen := arcLengthOf(arcForward(a, b, n), run.Polyline.Points)
	bwdLen := arcLengthOf(arcBackward(a, b, n), run.Polyline.Points)
	if bwdLen > fwdLen {
		return "backward"
	}
	return "forward"
}

func arcLengthOf(indices []int, points [][2]float64) float64 {
	var total float64
	for i := 1; i < len(indices); i++ {
		dx := points[indices[i]][0] - points[indices[i-1]][0]
		dy := points[indices[i]][1] - points[indices[i-1]][1]
		total += sqrt(dx*dx + dy*dy)
	}
	return total
}

// fmtFloat trims trailing zeros so the SVG isn't bloated by 14 decimals on
// every coordinate.
func fmtFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
