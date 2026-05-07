//go:build ignore

// regen-vectorize-goldens regenerates the PNG fixtures and golden JSON files
// under internal/vectorize/testdata/goldens/ used by TestVectorizeGoldens.
//
// Two phases:
//
//  1. Draw 6 small synthetic-glyph PNG fixtures from primitives (rectangles,
//     filled polygons, line strokes). All fixtures are <=256x256 px so the
//     repo doesn't bloat and tests stay fast.
//  2. Run the current vectorize pipeline against each fixture with the
//     fixture's captured params and write out a sibling .golden.json.
//
// Run from the repo root:
//
//	go run scripts/regen-vectorize-goldens.go
//
// The script is intentionally outside the package build (// +build ignore)
// so it doesn't ship in the binary or grow the test binary's size.
//
// For a pure golden refresh (PNGs unchanged, pipeline tweaked), prefer:
//
//	go test ./internal/vectorize -run TestVectorizeGoldens -update
//
// Manually inspect the golden diff before committing — a small drift is
// expected after intentional pipeline changes; a large drift wants review.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/png"
	"log"
	"math"
	"os"
	"path/filepath"

	"github.com/vlouvet/neonbench/internal/vectorize"
)

const goldensDir = "internal/vectorize/testdata/goldens"

// fixtureSpec is everything we need to re-emit one fixture + its golden:
// the deterministic drawing routine plus the pipeline params it should be
// vectorized with.
type fixtureSpec struct {
	Name             string
	Width, Height    int
	TargetWidthMM    float64
	Threshold        uint8
	SmoothingMM      float64
	MinSpurMM        float64
	DefaultDiamterMM float64
	Draw             func(*image.Gray)
}

func main() {
	if err := os.MkdirAll(goldensDir, 0o755); err != nil {
		log.Fatalf("mkdir goldens: %v", err)
	}

	specs := allFixtures()
	for _, s := range specs {
		pngPath := filepath.Join(goldensDir, s.Name+".png")
		gPath := filepath.Join(goldensDir, s.Name+".golden.json")
		img := drawFixture(s)
		if err := writePNG(pngPath, img); err != nil {
			log.Fatalf("write %s: %v", pngPath, err)
		}
		raw, err := os.ReadFile(pngPath)
		if err != nil {
			log.Fatalf("read %s: %v", pngPath, err)
		}
		res, err := vectorize.VectorizeRaster(context.Background(), vectorize.Request{
			SourceBytes:       raw,
			TargetWidthMM:     s.TargetWidthMM,
			Threshold:         s.Threshold,
			SmoothingMM:       s.SmoothingMM,
			MinSpurMM:         s.MinSpurMM,
			DefaultDiameterMM: s.DefaultDiamterMM,
		})
		if err != nil {
			log.Fatalf("vectorize %s: %v", s.Name, err)
		}
		golden := buildGolden(s, res)
		if err := writeGolden(gPath, golden); err != nil {
			log.Fatalf("write %s: %v", gPath, err)
		}
		fmt.Printf("regen %-22s polylines=%d totalLen=%.2fmm\n", s.Name, golden.RunCount, golden.TotalLengthMM)
	}
}

func drawFixture(s fixtureSpec) *image.Gray {
	img := image.NewGray(image.Rect(0, 0, s.Width, s.Height))
	// White background.
	draw.Draw(img, img.Bounds(), image.NewUniform(color.Gray{Y: 255}), image.Point{}, draw.Src)
	s.Draw(img)
	return img
}

func writePNG(path string, img image.Image) error {
	f, err := os.Create(path)
	if err != nil {
		return err
	}
	defer f.Close()
	enc := png.Encoder{CompressionLevel: png.BestCompression}
	return enc.Encode(f, img)
}

type goldenPolyline struct {
	Points [][2]float64 `json:"points"`
	Closed bool         `json:"closed"`
}

type goldenFile struct {
	Schema        int              `json:"schema"`
	Threshold     uint8            `json:"threshold"`
	SmoothingMM   float64          `json:"smoothing_mm"`
	MinSpurMM     float64          `json:"min_spur_mm"`
	TargetWidthMM float64          `json:"target_width_mm"`
	DiameterMM    float64          `json:"diameter_mm"`
	Polylines     []goldenPolyline `json:"polylines"`
	TotalLengthMM float64          `json:"total_length_mm"`
	RunCount      int              `json:"run_count"`
}

func buildGolden(s fixtureSpec, res *vectorize.Result) goldenFile {
	g := goldenFile{
		Schema:        1,
		Threshold:     s.Threshold,
		SmoothingMM:   s.SmoothingMM,
		MinSpurMM:     s.MinSpurMM,
		TargetWidthMM: s.TargetWidthMM,
		DiameterMM:    s.DefaultDiamterMM,
		Polylines:     make([]goldenPolyline, 0, len(res.Polylines)),
		RunCount:      len(res.Polylines),
	}
	var total float64
	for _, pl := range res.Polylines {
		gpl := goldenPolyline{Closed: pl.Closed, Points: make([][2]float64, len(pl.Points))}
		for i, p := range pl.Points {
			// Round to 1 micron (3 decimals in mm) so platform-level
			// floating-point noise doesn't cause spurious diffs.
			gpl.Points[i] = [2]float64{round3(p.X), round3(p.Y)}
			if i > 0 {
				dx := pl.Points[i].X - pl.Points[i-1].X
				dy := pl.Points[i].Y - pl.Points[i-1].Y
				total += math.Hypot(dx, dy)
			}
		}
		if pl.Closed && len(pl.Points) >= 2 {
			dx := pl.Points[0].X - pl.Points[len(pl.Points)-1].X
			dy := pl.Points[0].Y - pl.Points[len(pl.Points)-1].Y
			total += math.Hypot(dx, dy)
		}
		g.Polylines = append(g.Polylines, gpl)
	}
	g.TotalLengthMM = round3(total)
	return g
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }

func writeGolden(path string, g goldenFile) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(g); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// ---------- fixture corpus ----------

func allFixtures() []fixtureSpec {
	// Common params: tubed at 12mm diameter (matches existing
	// integration test), threshold 128 sits in the middle of [120,180]
	// so each fixture is solidly above-or-below it. Smoothing/spur left
	// at defaults (0 → derived from diameter) for most; the threshold-
	// robust fixture pins them to fixed mm so it stays reproducible if
	// the diameter-default math changes.
	return []fixtureSpec{
		blockLetterI(),
		thinL(),
		brokenHorizontal(),
		nearTouchingBars(),
		squareCorners(),
		curveU(),
	}
}

// blockLetterI: a thick filled vertical bar with serifs ("I" in a heavy
// display face). Tests centerline extraction on solid fills; the centerline
// should be a single vertical line down the middle (plus possibly the
// horizontal serif crossbars).
func blockLetterI() fixtureSpec {
	return fixtureSpec{
		Name: "block_letter_i", Width: 80, Height: 120,
		TargetWidthMM:    160, // 2 mm/px — same scale order as open_neon
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			// Vertical bar.
			fillRect(g, 30, 10, 50, 110)
			// Top + bottom serif bars.
			fillRect(g, 15, 10, 65, 22)
			fillRect(g, 15, 98, 65, 110)
		},
	}
}

// thinL: two ~3-px-wide strokes meeting at a 90° corner. Tests minimum-
// stroke handling and corner pinning.
func thinL() fixtureSpec {
	return fixtureSpec{
		Name: "thin_l", Width: 100, Height: 100,
		TargetWidthMM:    200,
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			// Vertical 3px stroke at x=20..23, y=15..85
			fillRect(g, 20, 15, 23, 85)
			// Horizontal 3px stroke at x=20..80, y=82..85
			fillRect(g, 20, 82, 80, 85)
		},
	}
}

// brokenHorizontal: a horizontal stroke with a 1-px gap in the middle.
// At ~2mm/px, that gap is ~2mm — well below the default min_spur. A clean
// pipeline can either reject the gap as two separate strokes or bridge it;
// the golden captures whichever the current pipeline emits, and the test
// guards against the count flipping silently.
func brokenHorizontal() fixtureSpec {
	return fixtureSpec{
		Name: "broken_horizontal", Width: 120, Height: 30,
		TargetWidthMM:    240,
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			// Two segments separated by a 2-px gap at x=58..59.
			fillRect(g, 10, 12, 57, 18)
			fillRect(g, 60, 12, 110, 18)
		},
	}
}

// nearTouchingBars: two parallel vertical bars 4 px apart. Tests that
// the pipeline keeps them as separate polylines and doesn't merge across
// the small gap.
func nearTouchingBars() fixtureSpec {
	return fixtureSpec{
		Name: "near_touching_bars", Width: 80, Height: 100,
		TargetWidthMM:    160,
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			fillRect(g, 25, 10, 32, 90)
			fillRect(g, 40, 10, 47, 90)
		},
	}
}

// squareCorners: a square outline — four straight edges and four 90°
// corners. Tests corner detection and closed-polyline emission.
func squareCorners() fixtureSpec {
	return fixtureSpec{
		Name: "square_corners", Width: 100, Height: 100,
		TargetWidthMM:    200,
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			// Hollow square 4 px stroke at the perimeter.
			fillRect(g, 15, 15, 85, 19) // top
			fillRect(g, 15, 81, 85, 85) // bottom
			fillRect(g, 15, 15, 19, 85) // left
			fillRect(g, 81, 15, 85, 85) // right
		},
	}
}

// curveU: a U-shaped continuous curve (semicircle + two vertical
// extensions). Tests centerline extraction on continuous curves.
func curveU() fixtureSpec {
	return fixtureSpec{
		Name: "curve_u", Width: 120, Height: 100,
		TargetWidthMM:    240,
		Threshold:        128,
		DefaultDiamterMM: 12,
		Draw: func(g *image.Gray) {
			// Two vertical 4-px stems.
			fillRect(g, 20, 15, 26, 65)
			fillRect(g, 94, 15, 100, 65)
			// Bottom semicircle annulus connecting them.
			cx, cy := 60.0, 65.0
			rOuter := 43.0
			rInner := 37.0
			for y := 65; y < 100; y++ {
				for x := 15; x < 105; x++ {
					dx := float64(x) - cx
					dy := float64(y) - cy
					d := math.Hypot(dx, dy)
					if d <= rOuter && d >= rInner && dy >= -0.5 {
						g.SetGray(x, y, color.Gray{Y: 0})
					}
				}
			}
		},
	}
}

// fillRect paints a black filled rectangle [x0,y0)..(x1,y1] inclusive.
func fillRect(g *image.Gray, x0, y0, x1, y1 int) {
	if x0 > x1 {
		x0, x1 = x1, x0
	}
	if y0 > y1 {
		y0, y1 = y1, y0
	}
	for y := y0; y <= y1; y++ {
		for x := x0; x <= x1; x++ {
			if x >= 0 && y >= 0 && x < g.Bounds().Dx() && y < g.Bounds().Dy() {
				g.SetGray(x, y, color.Gray{Y: 0})
			}
		}
	}
}
