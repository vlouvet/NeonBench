package validate

import (
	"fmt"
	"math"
	"strconv"
	"strings"
)

// Matrix is a 2D affine transform: x' = A*x + C*y + E ; y' = B*x + D*y + F.
type Matrix struct {
	A, B, C, D, E, F float64
}

func Identity() Matrix { return Matrix{1, 0, 0, 1, 0, 0} }

func (m Matrix) Apply(p Point) Point {
	return Point{m.A*p.X + m.C*p.Y + m.E, m.B*p.X + m.D*p.Y + m.F}
}

// AverageScale returns the geometric mean of the absolute scale factors in
// the matrix's two basis vectors. Useful for scaling tolerances or radii.
func (m Matrix) AverageScale() float64 {
	sx := math.Hypot(m.A, m.B)
	sy := math.Hypot(m.C, m.D)
	return math.Sqrt(sx * sy)
}

// Compose returns m * n, i.e. the transform that applies n then m.
func (m Matrix) Compose(n Matrix) Matrix {
	return Matrix{
		A: m.A*n.A + m.C*n.B,
		B: m.B*n.A + m.D*n.B,
		C: m.A*n.C + m.C*n.D,
		D: m.B*n.C + m.D*n.D,
		E: m.A*n.E + m.C*n.F + m.E,
		F: m.B*n.E + m.D*n.F + m.F,
	}
}

func translateM(tx, ty float64) Matrix { return Matrix{1, 0, 0, 1, tx, ty} }
func scaleM(sx, sy float64) Matrix     { return Matrix{sx, 0, 0, sy, 0, 0} }
func rotateM(deg float64) Matrix {
	r := deg * math.Pi / 180
	c, s := math.Cos(r), math.Sin(r)
	return Matrix{c, s, -s, c, 0, 0}
}

// ParseSVGTransform parses a transform attribute value such as
// "translate(10,20) scale(2) rotate(15)". The transforms compose left-to-right
// (matching the SVG spec: the leftmost is applied last to the point).
func ParseSVGTransform(s string) (Matrix, error) {
	out := Identity()
	for {
		s = strings.TrimSpace(s)
		if s == "" {
			break
		}
		paren := strings.Index(s, "(")
		end := strings.Index(s, ")")
		if paren < 0 || end < 0 {
			return out, fmt.Errorf("malformed transform: %q", s)
		}
		op := strings.TrimSpace(s[:paren])
		args := strings.FieldsFunc(s[paren+1:end], func(r rune) bool {
			return r == ',' || r == ' ' || r == '\t'
		})
		nums := make([]float64, len(args))
		for i, a := range args {
			v, err := strconv.ParseFloat(a, 64)
			if err != nil {
				return out, fmt.Errorf("transform arg %q: %w", a, err)
			}
			nums[i] = v
		}
		var m Matrix
		switch op {
		case "translate":
			tx := nums[0]
			ty := 0.0
			if len(nums) > 1 {
				ty = nums[1]
			}
			m = translateM(tx, ty)
		case "scale":
			sx := nums[0]
			sy := sx
			if len(nums) > 1 {
				sy = nums[1]
			}
			m = scaleM(sx, sy)
		case "rotate":
			if len(nums) == 1 {
				m = rotateM(nums[0])
			} else if len(nums) == 3 {
				cx, cy := nums[1], nums[2]
				m = translateM(cx, cy).Compose(rotateM(nums[0])).Compose(translateM(-cx, -cy))
			} else {
				return out, fmt.Errorf("rotate needs 1 or 3 args, got %d", len(nums))
			}
		case "matrix":
			if len(nums) != 6 {
				return out, fmt.Errorf("matrix needs 6 args, got %d", len(nums))
			}
			m = Matrix{nums[0], nums[1], nums[2], nums[3], nums[4], nums[5]}
		case "skewX", "skewY":
			r := nums[0] * math.Pi / 180
			t := math.Tan(r)
			if op == "skewX" {
				m = Matrix{1, 0, t, 1, 0, 0}
			} else {
				m = Matrix{1, t, 0, 1, 0, 0}
			}
		default:
			return out, fmt.Errorf("unsupported transform op: %s", op)
		}
		out = out.Compose(m)
		s = strings.TrimSpace(s[end+1:])
	}
	return out, nil
}
