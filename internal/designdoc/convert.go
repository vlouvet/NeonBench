package designdoc

import (
	"bytes"
	"fmt"
	"strconv"

	"github.com/vlouvet/neonbench/internal/validate"
)

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
		buf.WriteString(`<path fill="black" fill-rule="evenodd" stroke="none" d="`)
		for j, p := range run.Polyline.Points {
			cmd := "L"
			if j == 0 {
				cmd = "M"
			}
			fmt.Fprintf(&buf, "%s%s %s ", cmd, fmtFloat(p[0]), fmtFloat(p[1]))
		}
		if run.Polyline.Closed {
			buf.WriteByte('Z')
		}
		buf.WriteString(`"/>`)
		buf.WriteByte('\n')
	}
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}

// fmtFloat trims trailing zeros so the SVG isn't bloated by 14 decimals on
// every coordinate.
func fmtFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
