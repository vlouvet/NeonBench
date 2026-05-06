package validate

import (
	"fmt"
	"strconv"
	"strings"
	"unicode"
)

// flattenTolerance is the chord-deviation tolerance for Bezier flattening,
// expressed in the same units as the input points (typically millimeters by
// the time we get here).
const flattenTolerance = 0.05 // 0.05mm — well below typical tube diameter

// ParseAndFlatten parses an SVG path "d" attribute, applies the matrix to
// every coordinate, and returns one polyline per subpath. unsupported is
// populated with rule="unsupported_path" issues for any commands we don't
// implement (e.g. arcs).
func ParseAndFlatten(d string, m Matrix) ([]Polyline, []Issue) {
	p := newPathParser(d)
	var (
		out          []Polyline
		current      Polyline
		pen          Point
		subStart     Point
		lastCubic    *Point // for S/s
		lastQuad     *Point // for T/t
		issues       []Issue
		prevCmd      byte
	)

	flush := func(closed bool) {
		if len(current.Points) >= 2 {
			current.Closed = closed
			out = append(out, current)
		}
		current = Polyline{}
	}
	emitPoint := func(world Point) {
		current.Points = append(current.Points, m.Apply(world))
	}

	for {
		cmd, ok := p.nextCommand(prevCmd)
		if !ok {
			break
		}
		prevCmd = cmd
		abs := unicode.IsUpper(rune(cmd))
		switch cmd {
		case 'M', 'm':
			x, y, ok1 := p.nextPair()
			if !ok1 {
				issues = append(issues, Issue{Rule: RuleUnsupportedPath, Severity: SeverityWarning, Message: "M command missing coordinates"})
				return out, issues
			}
			if !abs {
				x += pen.X
				y += pen.Y
			}
			flush(false)
			pen = Point{x, y}
			subStart = pen
			emitPoint(pen)
			lastCubic = nil
			lastQuad = nil
			// Subsequent pairs in the same M/m act as L/l.
			for p.peekIsNumber() {
				x, y, _ = p.nextPair()
				if !abs {
					x += pen.X
					y += pen.Y
				}
				pen = Point{x, y}
				emitPoint(pen)
				lastCubic = nil
				lastQuad = nil
			}
		case 'L', 'l':
			for p.peekIsNumber() {
				x, y, _ := p.nextPair()
				if !abs {
					x += pen.X
					y += pen.Y
				}
				pen = Point{x, y}
				emitPoint(pen)
				lastCubic = nil
				lastQuad = nil
			}
		case 'H', 'h':
			for p.peekIsNumber() {
				x, ok1 := p.nextNumber()
				if !ok1 {
					break
				}
				if !abs {
					x += pen.X
				}
				pen = Point{x, pen.Y}
				emitPoint(pen)
				lastCubic = nil
				lastQuad = nil
			}
		case 'V', 'v':
			for p.peekIsNumber() {
				y, ok1 := p.nextNumber()
				if !ok1 {
					break
				}
				if !abs {
					y += pen.Y
				}
				pen = Point{pen.X, y}
				emitPoint(pen)
				lastCubic = nil
				lastQuad = nil
			}
		case 'C', 'c':
			for p.peekIsNumber() {
				x1, y1, ok1 := p.nextPair()
				x2, y2, ok2 := p.nextPair()
				x, y, ok3 := p.nextPair()
				if !(ok1 && ok2 && ok3) {
					break
				}
				if !abs {
					x1 += pen.X
					y1 += pen.Y
					x2 += pen.X
					y2 += pen.Y
					x += pen.X
					y += pen.Y
				}
				p1 := Point{x1, y1}
				p2 := Point{x2, y2}
				p3 := Point{x, y}
				flattenAndEmit(&current, m, pen, p1, p2, p3, false)
				lastCubic = &p2
				lastQuad = nil
				pen = p3
			}
		case 'S', 's':
			for p.peekIsNumber() {
				x2, y2, ok1 := p.nextPair()
				x, y, ok2 := p.nextPair()
				if !(ok1 && ok2) {
					break
				}
				if !abs {
					x2 += pen.X
					y2 += pen.Y
					x += pen.X
					y += pen.Y
				}
				var p1 Point
				if lastCubic != nil {
					p1 = Point{2*pen.X - lastCubic.X, 2*pen.Y - lastCubic.Y}
				} else {
					p1 = pen
				}
				p2 := Point{x2, y2}
				p3 := Point{x, y}
				flattenAndEmit(&current, m, pen, p1, p2, p3, false)
				lastCubic = &p2
				lastQuad = nil
				pen = p3
			}
		case 'Q', 'q':
			for p.peekIsNumber() {
				x1, y1, ok1 := p.nextPair()
				x, y, ok2 := p.nextPair()
				if !(ok1 && ok2) {
					break
				}
				if !abs {
					x1 += pen.X
					y1 += pen.Y
					x += pen.X
					y += pen.Y
				}
				p1 := Point{x1, y1}
				p2 := Point{x, y}
				flattenAndEmit(&current, m, pen, p1, Point{}, p2, true)
				lastQuad = &p1
				lastCubic = nil
				pen = p2
			}
		case 'T', 't':
			for p.peekIsNumber() {
				x, y, ok1 := p.nextPair()
				if !ok1 {
					break
				}
				if !abs {
					x += pen.X
					y += pen.Y
				}
				var p1 Point
				if lastQuad != nil {
					p1 = Point{2*pen.X - lastQuad.X, 2*pen.Y - lastQuad.Y}
				} else {
					p1 = pen
				}
				p2 := Point{x, y}
				flattenAndEmit(&current, m, pen, p1, Point{}, p2, true)
				lastQuad = &p1
				lastCubic = nil
				pen = p2
			}
		case 'A', 'a':
			// Arc support is non-trivial; flag as unsupported and skip the
			// args so the parser can continue.
			for p.peekIsNumber() {
				_, _, _ = p.nextPair() // rx,ry
				_, _ = p.nextNumber()  // x-axis-rotation
				_, _ = p.nextNumber()  // large-arc-flag
				_, _ = p.nextNumber()  // sweep-flag
				x, y, ok1 := p.nextPair()
				if !ok1 {
					break
				}
				if !abs {
					x += pen.X
					y += pen.Y
				}
				// Approximate as a line so the path stays connected.
				pen = Point{x, y}
				emitPoint(pen)
				lastCubic = nil
				lastQuad = nil
			}
			pp := m.Apply(pen)
			issues = append(issues, Issue{
				Rule:     RuleUnsupportedPath,
				Severity: SeverityWarning,
				Message:  "elliptical arc (A) approximated as a straight line; results may be inaccurate",
				XMM:      pp.X,
				YMM:      pp.Y,
			})
		case 'Z', 'z':
			if len(current.Points) > 0 {
				// Close: line back to subpath start.
				if dist(pen, subStart) > 1e-6 {
					emitPoint(subStart)
				}
				flush(true)
			}
			pen = subStart
			lastCubic = nil
			lastQuad = nil
		default:
			pp := m.Apply(pen)
			issues = append(issues, Issue{
				Rule:     RuleUnsupportedPath,
				Severity: SeverityWarning,
				Message:  fmt.Sprintf("unsupported path command %q", cmd),
				XMM:      pp.X,
				YMM:      pp.Y,
			})
			// Try to skip past the args by consuming numbers until next command.
			for p.peekIsNumber() {
				_, _ = p.nextNumber()
			}
		}
	}
	flush(false)
	return out, issues
}

// flattenAndEmit transforms control points into world coords using m and
// flattens. We pass the matrix through so flattening tolerance is applied in
// the post-transform (mm) coordinate space.
func flattenAndEmit(pl *Polyline, m Matrix, p0, p1, p2, p3 Point, isQuadratic bool) {
	wp0 := m.Apply(p0)
	wp1 := m.Apply(p1)
	wp3 := m.Apply(p3)
	if isQuadratic {
		flattenQuadratic(&pl.Points, wp0, wp1, wp3, flattenTolerance)
		return
	}
	wp2 := m.Apply(p2)
	flattenCubic(&pl.Points, wp0, wp1, wp2, wp3, flattenTolerance)
}

// pathParser is a small lexer over an SVG path "d" string.
type pathParser struct {
	s   string
	pos int
}

func newPathParser(s string) *pathParser { return &pathParser{s: s} }

func (p *pathParser) skipWS() {
	for p.pos < len(p.s) {
		c := p.s[p.pos]
		if c == ' ' || c == '\t' || c == '\n' || c == '\r' || c == ',' {
			p.pos++
			continue
		}
		break
	}
}

// nextCommand returns the next path command character. If the next token is a
// number rather than a letter, the previous command implicitly repeats —
// except 'M'/'m', which switches to 'L'/'l' for repeats per the SVG spec.
func (p *pathParser) nextCommand(prev byte) (byte, bool) {
	p.skipWS()
	if p.pos >= len(p.s) {
		return 0, false
	}
	c := p.s[p.pos]
	if isLetter(c) {
		p.pos++
		return c, true
	}
	if isNumberStart(c) && prev != 0 {
		// Implicit repeat of previous command. Per spec, M→L, m→l.
		switch prev {
		case 'M':
			return 'L', true
		case 'm':
			return 'l', true
		}
		return prev, true
	}
	return 0, false
}

func (p *pathParser) peekIsNumber() bool {
	p.skipWS()
	if p.pos >= len(p.s) {
		return false
	}
	return isNumberStart(p.s[p.pos])
}

func (p *pathParser) nextNumber() (float64, bool) {
	p.skipWS()
	start := p.pos
	if p.pos < len(p.s) && (p.s[p.pos] == '+' || p.s[p.pos] == '-') {
		p.pos++
	}
	sawDigit := false
	for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
		p.pos++
		sawDigit = true
	}
	if p.pos < len(p.s) && p.s[p.pos] == '.' {
		p.pos++
		for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
			p.pos++
			sawDigit = true
		}
	}
	if p.pos < len(p.s) && (p.s[p.pos] == 'e' || p.s[p.pos] == 'E') {
		p.pos++
		if p.pos < len(p.s) && (p.s[p.pos] == '+' || p.s[p.pos] == '-') {
			p.pos++
		}
		for p.pos < len(p.s) && p.s[p.pos] >= '0' && p.s[p.pos] <= '9' {
			p.pos++
		}
	}
	if !sawDigit {
		return 0, false
	}
	v, err := strconv.ParseFloat(p.s[start:p.pos], 64)
	if err != nil {
		return 0, false
	}
	return v, true
}

func (p *pathParser) nextPair() (float64, float64, bool) {
	x, ok1 := p.nextNumber()
	if !ok1 {
		return 0, 0, false
	}
	y, ok2 := p.nextNumber()
	if !ok2 {
		return 0, 0, false
	}
	return x, y, true
}

func isLetter(c byte) bool { return strings.ContainsRune("MmLlHhVvCcSsQqTtAaZz", rune(c)) }

func isNumberStart(c byte) bool {
	return (c >= '0' && c <= '9') || c == '.' || c == '+' || c == '-'
}
