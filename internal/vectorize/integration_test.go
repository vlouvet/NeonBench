package vectorize

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

// updateGoldens, when true, causes TestVectorizeGoldens to overwrite each
// fixture's *.golden.json with the current pipeline output instead of
// asserting against it. Use this after intentional pipeline changes:
//
//	go test ./internal/vectorize -run TestVectorizeGoldens -update
//
// Always review the diff before committing — a clean small drift is
// expected after intentional changes; a sprawling topology change (run
// counts flipping wildly, lengths swinging by tens of percent) wants
// explanation in the PR body.
var updateGoldens = flag.Bool("update", false, "regenerate vectorize golden files instead of asserting against them")

// TestVectorizeOPENProducesCenterlines is the headline test the
// skeleton-graph rewrite exists to satisfy. With potrace's outline-tracing
// approach, the same OPEN image produced two parallel paths per letter
// stroke. The centerline extractor must produce one path per stroke
// instead, and no spurious "tubes 0mm apart" spacing errors at the
// junction welds where polylines meet.
//
// Bend-radius errors at the letter corners ARE expected: the test image
// is heavy block sans-serif with square 90° corners, which physically
// can't be bent on any commercial neon tube — that's the validator
// correctly flagging un-buildable geometry. The test asserts a bounded
// count so we know we have ~one error per real corner, not the 50+ we'd
// see if the vectorizer was emitting outline pairs.
func TestVectorizeOPENProducesCenterlines(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "open_neon.png"))
	if err != nil {
		t.Fatalf("read test image: %v", err)
	}
	res, err := VectorizeRaster(context.Background(), Request{
		SourceBytes:       data,
		TargetWidthMM:     600,
		Threshold:         128,
		DefaultDiameterMM: 12,
	})
	if err != nil {
		t.Fatalf("vectorize: %v", err)
	}
	t.Logf("polylines: %d (image %dx%d px → %.1f x %.1f mm)",
		len(res.Polylines), res.WidthPx, res.HeightPx, res.WidthMM, res.HeightMM)
	if n := len(res.Polylines); n < 4 || n > 16 {
		t.Errorf("OPEN should yield 4–16 centerline polylines (1 per stroke or letter), got %d", n)
	}

	report, err := validate.ValidateSVG(res.SVG, validate.Limits{
		DiameterMM:         12,
		MinBendRadiusMM:    27, // wall-thinning derivation for ø12mm
		MaxSegmentLengthMM: 2400,
		MinSpacingMM:       18,
	})
	if err != nil {
		t.Fatalf("validate: %v", err)
	}

	bendErrors, spacingErrors := 0, 0
	for _, iss := range report.Issues {
		if iss.Severity != validate.SeverityError {
			continue
		}
		switch iss.Rule {
		case validate.RuleMinBendRadius:
			bendErrors++
		case validate.RuleMinSpacing:
			spacingErrors++
		}
		t.Logf("%s @ (%.1f, %.1f) — %s", iss.Rule, iss.XMM, iss.YMM, iss.Message)
	}

	// Outline-pair vectorization (the old potrace path) typically yields
	// 50+ bend errors on this kind of source because every letter side
	// is its own polyline with its own corners. Centerlines should give
	// us roughly one bend error per actual letter corner — bounded well
	// under 20 across all four letters.
	if bendErrors > 20 {
		t.Errorf("bend errors should be ≤20 (one per real corner), got %d — likely still emitting outline pairs", bendErrors)
	}
	// Spacing errors at junction welds are the canonical false positive
	// the centerline approach is supposed to retire. Any spacing error
	// here means the weld exemption isn't covering the case.
	if spacingErrors != 0 {
		t.Errorf("expected 0 spacing errors (junction welds should be exempt), got %d", spacingErrors)
	}
}

// goldenPolyline / goldenFile mirror the JSON written by
// scripts/regen-vectorize-goldens.go. Keep these in sync with that script
// (only one consumer per side, so drift is easy to catch).
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

// Tolerances. These are picked so floating-point drift across platforms
// doesn't trip the test, but a real topology change does:
//
//   - run_count: exact match (a flip means the pipeline split or merged a
//     stroke — always worth reviewing).
//   - total_length_mm: 0.5% of golden — captures cumulative numeric drift.
//   - per-polyline vertex count: ±1 — RDP simplification can shift by one
//     under floating-point rounding without changing topology.
//   - per-vertex distance: 0.1 mm — tighter than any human can perceive
//     on a neon tube, looser than any reasonable FP noise.
const (
	goldenLengthTol = 0.005 // 0.5%
	goldenVertexTol = 1     // ±1 vertex per polyline
	goldenPointTol  = 0.1   // mm
)

// TestVectorizeGoldens iterates the fixture corpus under
// testdata/goldens/, runs the pipeline with each fixture's recorded
// params, and compares the output to the corresponding *.golden.json.
//
// The fixture and the params live next to each other so a regression
// reviewer has everything in one place: see the PNG, see the captured
// pipeline output, run the test, see the diff.
func TestVectorizeGoldens(t *testing.T) {
	dir := filepath.Join("testdata", "goldens")
	entries, err := os.ReadDir(dir)
	if err != nil {
		t.Fatalf("read goldens dir: %v", err)
	}
	var fixtures []string
	for _, e := range entries {
		if e.IsDir() || filepath.Ext(e.Name()) != ".png" {
			continue
		}
		fixtures = append(fixtures, e.Name())
	}
	sort.Strings(fixtures)
	if len(fixtures) == 0 {
		t.Fatalf("no PNG fixtures found in %s — run scripts/regen-vectorize-goldens.go", dir)
	}

	for _, name := range fixtures {
		name := name
		t.Run(name, func(t *testing.T) {
			pngPath := filepath.Join(dir, name)
			goldenPath := filepath.Join(dir, name[:len(name)-len(".png")]+".golden.json")

			golden, err := readGolden(goldenPath)
			if err != nil {
				t.Fatalf("read golden: %v", err)
			}

			data, err := os.ReadFile(pngPath)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}
			res, err := VectorizeRaster(context.Background(), Request{
				SourceBytes:       data,
				TargetWidthMM:     golden.TargetWidthMM,
				Threshold:         golden.Threshold,
				SmoothingMM:       golden.SmoothingMM,
				MinSpurMM:         golden.MinSpurMM,
				DefaultDiameterMM: golden.DiameterMM,
			})
			if err != nil {
				t.Fatalf("vectorize: %v", err)
			}

			actual := buildGoldenFromResult(golden, res)

			if *updateGoldens {
				if err := writeGolden(goldenPath, actual); err != nil {
					t.Fatalf("write golden: %v", err)
				}
				t.Logf("updated %s (runs=%d, total=%.3fmm)", filepath.Base(goldenPath), actual.RunCount, actual.TotalLengthMM)
				return
			}

			diffs := compareGolden(golden, actual)
			for _, d := range diffs {
				t.Errorf("%s: %s", name, d)
			}
			if len(diffs) == 0 {
				t.Logf("%s OK (runs=%d, total=%.3fmm)", name, actual.RunCount, actual.TotalLengthMM)
				return
			}
			// Test failed — dump a self-contained SVG with the actual
			// polyline geometry overlaid on a base64 copy of the source
			// PNG, so reviewers can eyeball the regression in their PR
			// diff tool of choice. See dumpFailureArtifact for the
			// rationale on the format.
			if path, err := dumpFailureArtifact(dir, name, data, res, golden); err != nil {
				t.Logf("dump failure artifact: %v", err)
			} else {
				t.Logf("failure artifact: %s", path)
			}
		})
	}
}

// dumpFailureArtifact writes an SVG to testdata/goldens/_failures/<name>.svg
// containing:
//
//   - The source PNG embedded as a base64 data URL <image> so the artifact
//     is self-contained and openable as a single file.
//   - The actual polyline geometry from the failing run overlaid in red.
//   - The golden polyline geometry overlaid in semi-transparent green
//     for direct visual comparison.
//
// The _failures/ directory is in .gitignore so these don't end up
// committed; they exist purely as reviewer triage aids.
func dumpFailureArtifact(dir, fixtureName string, sourcePNG []byte, res *Result, golden goldenFile) (string, error) {
	failuresDir := filepath.Join(dir, "_failures")
	if err := os.MkdirAll(failuresDir, 0o755); err != nil {
		return "", err
	}
	svgName := fixtureName[:len(fixtureName)-len(".png")] + ".svg"
	out := filepath.Join(failuresDir, svgName)

	var buf bytes.Buffer
	widthMM := res.WidthMM
	heightMM := res.HeightMM
	fmt.Fprintf(&buf,
		`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="%smm" height="%smm" viewBox="0 0 %s %s">`+"\n",
		fmtFloat(widthMM), fmtFloat(heightMM), fmtFloat(widthMM), fmtFloat(heightMM))
	// Faint base64-embedded PNG behind the geometry. The image stretches
	// to the full viewBox so source pixels line up with mm coordinates
	// the same way the pipeline maps them.
	enc := base64.StdEncoding.EncodeToString(sourcePNG)
	fmt.Fprintf(&buf,
		`<image x="0" y="0" width="%s" height="%s" opacity="0.25" href="data:image/png;base64,%s"/>`+"\n",
		fmtFloat(widthMM), fmtFloat(heightMM), enc)
	// Golden polylines in green (semi-transparent) — the expected result.
	fmt.Fprintln(&buf, `<g fill="none" stroke="#00aa00" stroke-width="0.6" stroke-opacity="0.6" stroke-linecap="round" stroke-linejoin="round">`)
	for _, pl := range golden.Polylines {
		writeGoldenPath(&buf, pl)
	}
	fmt.Fprintln(&buf, `</g>`)
	// Actual polylines in red — what the pipeline produced.
	fmt.Fprintln(&buf, `<g fill="none" stroke="#cc0000" stroke-width="0.5" stroke-linecap="round" stroke-linejoin="round">`)
	for _, pl := range res.Polylines {
		writeMMPath(&buf, pl)
	}
	fmt.Fprintln(&buf, `</g>`)
	fmt.Fprintln(&buf, `</svg>`)

	if err := os.WriteFile(out, buf.Bytes(), 0o644); err != nil {
		return "", err
	}
	return out, nil
}

func writeMMPath(buf *bytes.Buffer, pl MMPolyline) {
	if len(pl.Points) < 2 {
		return
	}
	buf.WriteString(`<path d="`)
	for i, p := range pl.Points {
		cmd := "L"
		if i == 0 {
			cmd = "M"
		}
		fmt.Fprintf(buf, "%s%s %s ", cmd, fmtFloat(p.X), fmtFloat(p.Y))
	}
	if pl.Closed {
		buf.WriteByte('Z')
	}
	buf.WriteString(`"/>`)
	buf.WriteByte('\n')
}

func writeGoldenPath(buf *bytes.Buffer, pl goldenPolyline) {
	if len(pl.Points) < 2 {
		return
	}
	buf.WriteString(`<path d="`)
	for i, p := range pl.Points {
		cmd := "L"
		if i == 0 {
			cmd = "M"
		}
		fmt.Fprintf(buf, "%s%s %s ", cmd, fmtFloat(p[0]), fmtFloat(p[1]))
	}
	if pl.Closed {
		buf.WriteByte('Z')
	}
	buf.WriteString(`"/>`)
	buf.WriteByte('\n')
}

func readGolden(path string) (goldenFile, error) {
	var g goldenFile
	raw, err := os.ReadFile(path)
	if err != nil {
		return g, err
	}
	if err := json.Unmarshal(raw, &g); err != nil {
		return g, fmt.Errorf("parse %s: %w", path, err)
	}
	return g, nil
}

func writeGolden(path string, g goldenFile) error {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetIndent("", "  ")
	if err := enc.Encode(g); err != nil {
		return err
	}
	return os.WriteFile(path, buf.Bytes(), 0o644)
}

// buildGoldenFromResult constructs a goldenFile from a vectorize Result,
// preserving the input params from the existing golden so -update doesn't
// drop the params field. Same shape the regen script produces.
func buildGoldenFromResult(params goldenFile, res *Result) goldenFile {
	out := goldenFile{
		Schema:        1,
		Threshold:     params.Threshold,
		SmoothingMM:   params.SmoothingMM,
		MinSpurMM:     params.MinSpurMM,
		TargetWidthMM: params.TargetWidthMM,
		DiameterMM:    params.DiameterMM,
		Polylines:     make([]goldenPolyline, 0, len(res.Polylines)),
		RunCount:      len(res.Polylines),
	}
	var total float64
	for _, pl := range res.Polylines {
		gpl := goldenPolyline{Closed: pl.Closed, Points: make([][2]float64, len(pl.Points))}
		for i, p := range pl.Points {
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
		out.Polylines = append(out.Polylines, gpl)
	}
	out.TotalLengthMM = round3(total)
	return out
}

// compareGolden returns a slice of human-readable diff lines, empty when
// the actual output matches the golden within tolerance. The messages
// include enough detail (polyline index, point index, mm delta) for a
// reviewer to eyeball the regression before deciding to fix-or-rebless.
func compareGolden(want, got goldenFile) []string {
	var diffs []string

	if got.RunCount != want.RunCount {
		diffs = append(diffs, fmt.Sprintf("run_count: want %d, got %d", want.RunCount, got.RunCount))
		// Topology mismatch: per-polyline diffs would be apples-to-oranges,
		// so report the high-level mismatch and stop.
		return diffs
	}

	relErr := relativeError(got.TotalLengthMM, want.TotalLengthMM)
	if relErr > goldenLengthTol {
		diffs = append(diffs, fmt.Sprintf("total_length_mm: want %.3f, got %.3f (rel err %.4f, tol %.4f)",
			want.TotalLengthMM, got.TotalLengthMM, relErr, goldenLengthTol))
	}

	for i := range want.Polylines {
		w := want.Polylines[i]
		g := got.Polylines[i]
		if w.Closed != g.Closed {
			diffs = append(diffs, fmt.Sprintf("polyline[%d].closed: want %t, got %t", i, w.Closed, g.Closed))
			continue
		}
		dvc := absInt(len(g.Points) - len(w.Points))
		if dvc > goldenVertexTol {
			diffs = append(diffs, fmt.Sprintf("polyline[%d].vertex_count: want %d, got %d (delta %d, tol ±%d)",
				i, len(w.Points), len(g.Points), len(g.Points)-len(w.Points), goldenVertexTol))
			continue
		}
		// Walk the shorter list: when ±1 vertex, the matching prefix /
		// suffix is well-aligned for the first len(short) entries.
		n := len(w.Points)
		if len(g.Points) < n {
			n = len(g.Points)
		}
		for k := 0; k < n; k++ {
			dx := g.Points[k][0] - w.Points[k][0]
			dy := g.Points[k][1] - w.Points[k][1]
			d := math.Hypot(dx, dy)
			if d > goldenPointTol {
				diffs = append(diffs, fmt.Sprintf("polyline[%d].points[%d]: want (%.3f,%.3f), got (%.3f,%.3f) — Δ%.3fmm > %.3fmm",
					i, k, w.Points[k][0], w.Points[k][1], g.Points[k][0], g.Points[k][1], d, goldenPointTol))
			}
		}
	}
	return diffs
}

func relativeError(got, want float64) float64 {
	if want == 0 {
		if got == 0 {
			return 0
		}
		return math.Inf(1)
	}
	return math.Abs(got-want) / math.Abs(want)
}

func absInt(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func round3(v float64) float64 { return math.Round(v*1000) / 1000 }
