package validate

import (
	"encoding/xml"
	"fmt"
	"io"
	"math"
	"strconv"
	"strings"
)

// ExtractMMPolylines parses an SVG document and returns all path geometry as
// flattened polylines in millimeter coordinates. Exported for use by sibling
// packages (e.g. printpdf) that need the same SVG → mm pipeline.
func ExtractMMPolylines(svgData []byte) ([]Polyline, [4]float64, []Issue, error) {
	return extractMMPolylines(svgData)
}

// extractMMPolylines parses an SVG document and returns all path geometry as
// flattened polylines in millimeter coordinates. issues collects any
// non-fatal warnings (unsupported commands, missing dimensions).
//
// Coordinate handling:
//   - The <svg> width/height attributes establish the document's physical
//     size. We support "Nmm", "Nmm" with whitespace, "Npt" (1 pt = 25.4/72
//     mm), or unitless (assumed user units, mapped to mm via viewBox).
//   - The viewBox provides the user-space coordinate system; coordinates in
//     the document are converted to mm by the ratio width_mm / viewBox_width.
//   - Transforms on ancestor elements compose, with the root SVG getting an
//     implicit user-space-to-mm scaling.
func extractMMPolylines(svgData []byte) ([]Polyline, [4]float64, []Issue, error) {
	dec := xml.NewDecoder(strings.NewReader(string(svgData)))
	dec.Strict = false

	var (
		polylines []Polyline
		issues    []Issue
		bbox      = [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
		stack     []Matrix
		rootSet   bool
	)

	push := func(parent Matrix, attrs []xml.Attr) {
		t := parent
		for _, a := range attrs {
			if a.Name.Local == "transform" {
				m, err := ParseSVGTransform(a.Value)
				if err == nil {
					t = t.Compose(m)
				} else {
					issues = append(issues, Issue{Rule: RuleUnsupportedPath, Severity: SeverityWarning, Message: "transform parse failed: " + err.Error()})
				}
				break
			}
		}
		stack = append(stack, t)
	}
	pop := func() {
		if len(stack) > 0 {
			stack = stack[:len(stack)-1]
		}
	}
	current := func() Matrix {
		if len(stack) == 0 {
			return Identity()
		}
		return stack[len(stack)-1]
	}

	for {
		tok, err := dec.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, bbox, issues, fmt.Errorf("xml: %w", err)
		}
		switch t := tok.(type) {
		case xml.StartElement:
			if t.Name.Local == "svg" && !rootSet {
				rootSet = true
				rootM, err := rootSVGMatrix(t.Attr)
				if err != nil {
					issues = append(issues, Issue{Rule: RuleUnsupportedPath, Severity: SeverityWarning, Message: err.Error()})
					rootM = Identity()
				}
				// Compose with any transform attribute on the root <svg>.
				for _, a := range t.Attr {
					if a.Name.Local == "transform" {
						if extra, err := ParseSVGTransform(a.Value); err == nil {
							rootM = rootM.Compose(extra)
						}
						break
					}
				}
				stack = append(stack, rootM)
				continue
			}
			push(current(), t.Attr)
			if t.Name.Local == "path" {
				dAttr := ""
				var diameterMM float64
				var dbMarks []Point
				var isChannelLetterFace bool
				for _, a := range t.Attr {
					switch a.Name.Local {
					case "d":
						dAttr = a.Value
					case "data-tube-diameter-mm":
						if v, err := strconv.ParseFloat(strings.TrimSpace(a.Value), 64); err == nil && v > 0 {
							diameterMM = v
						}
					case "data-doubleback-mm":
						dbMarks = parseDoublebackMarks(a.Value)
					case "data-channel-letter-face":
						// Any non-empty truthy value flags the path as a
						// face. Canonical emit is "1"; we also accept
						// "true" / "yes" defensively for hand-edited
						// SVGs.
						v := strings.TrimSpace(strings.ToLower(a.Value))
						if v == "1" || v == "true" || v == "yes" {
							isChannelLetterFace = true
						}
					}
				}
				if dAttr == "" {
					continue
				}
				ps, iss := ParseAndFlatten(dAttr, current())
				if diameterMM > 0 {
					for i := range ps {
						ps[i].DiameterMM = diameterMM
					}
				}
				if len(dbMarks) > 0 {
					for i := range ps {
						ps[i].DoublebackMarks = dbMarks
					}
				}
				if isChannelLetterFace {
					for i := range ps {
						ps[i].IsChannelLetterFace = true
					}
				}
				polylines = append(polylines, ps...)
				issues = append(issues, iss...)
				for _, pl := range ps {
					for _, pt := range pl.Points {
						if pt.X < bbox[0] {
							bbox[0] = pt.X
						}
						if pt.Y < bbox[1] {
							bbox[1] = pt.Y
						}
						if pt.X > bbox[2] {
							bbox[2] = pt.X
						}
						if pt.Y > bbox[3] {
							bbox[3] = pt.Y
						}
					}
				}
			}
		case xml.EndElement:
			pop()
		}
	}

	if math.IsInf(bbox[0], 1) {
		bbox = [4]float64{0, 0, 0, 0}
	}
	return polylines, bbox, issues, nil
}

// parseDoublebackMarks pulls the space-separated "x,y x,y …" pairs out of
// the data-doubleback-mm attribute. Bad pairs are silently dropped — this
// is editor metadata, not a parse-critical attribute.
func parseDoublebackMarks(s string) []Point {
	var out []Point
	for _, pair := range strings.Fields(s) {
		comma := strings.IndexByte(pair, ',')
		if comma <= 0 || comma == len(pair)-1 {
			continue
		}
		xs, ys := pair[:comma], pair[comma+1:]
		x, errX := strconv.ParseFloat(xs, 64)
		y, errY := strconv.ParseFloat(ys, 64)
		if errX != nil || errY != nil {
			continue
		}
		out = append(out, Point{X: x, Y: y})
	}
	return out
}

// rootSVGMatrix builds the user-space-to-mm matrix from the root <svg>
// element's width, height, and viewBox attributes.
func rootSVGMatrix(attrs []xml.Attr) (Matrix, error) {
	var widthAttr, heightAttr, vbAttr string
	for _, a := range attrs {
		switch a.Name.Local {
		case "width":
			widthAttr = a.Value
		case "height":
			heightAttr = a.Value
		case "viewBox":
			vbAttr = a.Value
		}
	}

	widthMM, hasW := parseLengthMM(widthAttr)
	heightMM, hasH := parseLengthMM(heightAttr)

	var vbX, vbY, vbW, vbH float64
	hasVB := false
	if vbAttr != "" {
		fields := strings.FieldsFunc(vbAttr, func(r rune) bool { return r == ' ' || r == ',' || r == '\t' })
		if len(fields) == 4 {
			parse := func(s string) (float64, error) { return strconv.ParseFloat(s, 64) }
			x, e1 := parse(fields[0])
			y, e2 := parse(fields[1])
			w, e3 := parse(fields[2])
			h, e4 := parse(fields[3])
			if e1 == nil && e2 == nil && e3 == nil && e4 == nil {
				vbX, vbY, vbW, vbH = x, y, w, h
				hasVB = true
			}
		}
	}

	// Decision tree:
	//   1. width+height in mm AND viewBox → scale viewBox to mm
	//   2. viewBox only → assume user units == mm (best-effort)
	//   3. width+height in mm only → identity (path coords already in mm)
	//   4. nothing → identity, return warning
	switch {
	case hasW && hasH && hasVB:
		sx := widthMM / vbW
		sy := heightMM / vbH
		return translateM(0, 0).Compose(scaleM(sx, sy)).Compose(translateM(-vbX, -vbY)), nil
	case hasVB:
		return translateM(-vbX, -vbY), nil
	case hasW && hasH:
		return Identity(), nil
	default:
		return Identity(), fmt.Errorf("svg root has no width/height/viewBox; coordinates assumed to be in mm")
	}
}

// parseLengthMM converts an SVG length string to millimeters, returning
// (value, true) on success.
func parseLengthMM(s string) (float64, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	// Strip a unit suffix.
	num := s
	unit := ""
	for i := len(s) - 1; i >= 0; i-- {
		c := s[i]
		if (c >= '0' && c <= '9') || c == '.' {
			num = s[:i+1]
			unit = strings.TrimSpace(s[i+1:])
			break
		}
	}
	v, err := strconv.ParseFloat(num, 64)
	if err != nil {
		return 0, false
	}
	switch strings.ToLower(unit) {
	case "", "mm":
		return v, true
	case "cm":
		return v * 10, true
	case "in":
		return v * 25.4, true
	case "pt":
		return v * 25.4 / 72, true
	case "pc":
		return v * 25.4 / 6, true
	case "px":
		// Per SVG: 1px = 1/96 inch.
		return v * 25.4 / 96, true
	default:
		return 0, false
	}
}
