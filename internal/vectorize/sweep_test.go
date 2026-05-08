package vectorize

import (
	"context"
	"math"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

// TestVectorizeThresholdSweep runs each fixture in the goldens corpus
// through the vectorize pipeline at a parametric sweep of binarize
// thresholds and asserts the documented invariant.
//
// Invariant: monotonic non-decrease in foreground coverage as the
// threshold is raised. The binarizer treats pixels whose Y < threshold
// as foreground (see PreprocessAndBinarize → grayToBinary), so a higher
// threshold can only ever match strictly more pixels. The vectorizer's
// output total polyline length is a noisy proxy for foreground coverage
// (centerline length scales with stroke length, which scales with
// foreground area for fixed stroke width), so we assert:
//
//   - The total polyline length is non-decreasing across the threshold
//     sweep, within a small slack to absorb skeletonization noise from
//     thresholds that just barely grab a pixel-thin border.
//   - Run count never collapses to zero (the threshold sweep must stay
//     within the "fixture is still recognizable" range).
//
// These thresholds (80, 110, 140, 170, 200) span the reasonable user
// range for the synthetic fixtures (which are pure black/white) — if
// future fixtures move toward photographic input, this range would need
// to be revisited per-fixture.
//
// A flip in this invariant signals one of:
//   - Binarizer regression (sign flip on the threshold comparison)
//   - Spur-prune iteration regression (eating geometry that should
//     survive at a higher threshold)
//   - Skeleton classifier regression (mis-counting degree at a junction
//     that only exists at a wider stroke)
//
// All three are real things the centerline pipeline has had bugs in
// before and that the existing single-threshold goldens don't catch.
func TestVectorizeThresholdSweep(t *testing.T) {
	thresholds := []uint8{80, 110, 140, 170, 200}
	// Slack absorbs ±2% noise from skeletonization: at thresholds where
	// a one-pixel-wide border just barely qualifies, Zhang-Suen can drop
	// it on one threshold and keep it on the next, producing a tiny
	// negative delta. 2% is well below the threshold for any real
	// regression and well above the skeletonizer's measured floor.
	const slack = 0.02

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
		t.Fatalf("no PNG fixtures in %s", dir)
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

			lengths := make([]float64, len(thresholds))
			runs := make([]int, len(thresholds))
			for i, thr := range thresholds {
				res, err := VectorizeRaster(context.Background(), Request{
					SourceBytes:       data,
					TargetWidthMM:     golden.TargetWidthMM,
					Threshold:         thr,
					SmoothingMM:       golden.SmoothingMM,
					MinSpurMM:         golden.MinSpurMM,
					DefaultDiameterMM: golden.DiameterMM,
				})
				if err != nil {
					t.Fatalf("vectorize @ thr=%d: %v", thr, err)
				}
				total := totalLengthMM(res.Polylines)
				lengths[i] = total
				runs[i] = len(res.Polylines)
				t.Logf("thr=%d runs=%d total=%.3fmm", thr, runs[i], total)
				if runs[i] == 0 {
					t.Errorf("thr=%d produced zero polylines — fixture must remain recognizable across the sweep", thr)
				}
			}

			// Monotonic non-decrease in total length, within slack.
			for i := 1; i < len(thresholds); i++ {
				prev, cur := lengths[i-1], lengths[i]
				if prev == 0 {
					continue
				}
				// Allow up to `slack` relative drop without flagging.
				if cur < prev*(1-slack) {
					t.Errorf("non-monotonic length: thr=%d→%d went %.3f→%.3f mm (drop %.2f%% > %.2f%% slack)",
						thresholds[i-1], thresholds[i], prev, cur,
						100*(prev-cur)/prev, 100*slack)
				}
			}
		})
	}
}

// TestVectorizeDiameterSweep re-runs a representative subset of the
// fixture corpus (block_letter_i, curve_u) at 8 / 12 / 15 mm tube
// diameter to catch regressions in the diameter-derived defaults for
// `min_spur` and `smoothing` (see vectorize.go: minSpurMM = max(2*D, 4),
// smoothingMM = max(0.3, D/40)).
//
// Invariants per fixture:
//
//   - Run count must remain non-zero at every diameter (the fixture is
//     designed to survive the prune at 15mm).
//   - As diameter grows, smoothing epsilon grows, so total polyline
//     length must be (approximately) non-increasing — RDP simplification
//     never adds path length, only removes vertices. We allow a small
//     positive slack because vertex collapses can briefly add a
//     marginally longer chord between two surviving vertices.
//   - As diameter grows, min_spur grows, so the run count must be
//     non-increasing too: any regression that re-introduces sub-min_spur
//     spurs at larger diameters would show up as run-count growth.
//
// Either invariant flipping is a strong signal that the diameter →
// param defaults wiring has regressed.
func TestVectorizeDiameterSweep(t *testing.T) {
	diameters := []float64{8, 12, 15}
	const lengthSlack = 0.05 // 5% — RDP can shift length slightly per pass.

	cases := []string{"block_letter_i.png", "curve_u.png"}
	for _, name := range cases {
		name := name
		t.Run(name, func(t *testing.T) {
			pngPath := filepath.Join("testdata", "goldens", name)
			goldenPath := filepath.Join("testdata", "goldens", name[:len(name)-len(".png")]+".golden.json")
			golden, err := readGolden(goldenPath)
			if err != nil {
				t.Fatalf("read golden: %v", err)
			}
			data, err := os.ReadFile(pngPath)
			if err != nil {
				t.Fatalf("read fixture: %v", err)
			}

			lengths := make([]float64, len(diameters))
			runs := make([]int, len(diameters))
			for i, d := range diameters {
				res, err := VectorizeRaster(context.Background(), Request{
					SourceBytes:       data,
					TargetWidthMM:     golden.TargetWidthMM,
					Threshold:         golden.Threshold,
					DefaultDiameterMM: d,
					// Leave SmoothingMM / MinSpurMM at zero so the
					// pipeline derives them from D — that's the wiring
					// this test is exercising.
				})
				if err != nil {
					t.Fatalf("vectorize @ D=%.0fmm: %v", d, err)
				}
				lengths[i] = totalLengthMM(res.Polylines)
				runs[i] = len(res.Polylines)
				t.Logf("D=%.0fmm runs=%d total=%.3fmm", d, runs[i], lengths[i])
				if runs[i] == 0 {
					t.Errorf("D=%.0fmm produced zero polylines — fixture must survive prune at this diameter", d)
				}
			}

			for i := 1; i < len(diameters); i++ {
				if runs[i] > runs[i-1] {
					t.Errorf("non-monotonic run_count: D=%.0f→%.0f went %d→%d (must be non-increasing as diameter grows)",
						diameters[i-1], diameters[i], runs[i-1], runs[i])
				}
				if prev := lengths[i-1]; prev > 0 {
					if lengths[i] > prev*(1+lengthSlack) {
						t.Errorf("non-monotonic length: D=%.0f→%.0f went %.3f→%.3f mm (grew %.2f%% > %.2f%% slack)",
							diameters[i-1], diameters[i], prev, lengths[i],
							100*(lengths[i]-prev)/prev, 100*lengthSlack)
					}
				}
			}
		})
	}
}

// totalLengthMM sums the polyline length (mm) across a Result's
// polylines. Closed polylines include the closing edge.
func totalLengthMM(polys []MMPolyline) float64 {
	var total float64
	for _, pl := range polys {
		for i := 1; i < len(pl.Points); i++ {
			dx := pl.Points[i].X - pl.Points[i-1].X
			dy := pl.Points[i].Y - pl.Points[i-1].Y
			total += math.Hypot(dx, dy)
		}
		if pl.Closed && len(pl.Points) >= 2 {
			dx := pl.Points[0].X - pl.Points[len(pl.Points)-1].X
			dy := pl.Points[0].Y - pl.Points[len(pl.Points)-1].Y
			total += math.Hypot(dx, dy)
		}
	}
	return total
}
