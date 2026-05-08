package vectorize

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// Benchmark suite for the vectorize pipeline against the goldens
// fixture corpus. These benchmarks are not auto-run by `go test`; they
// require `-bench`:
//
//	go test -bench=. -benchtime=3x ./internal/vectorize/
//	go test -bench=BenchmarkVectorize_curve_u -benchmem ./internal/vectorize/
//
// CI does not gate on these — `go test -bench` is opt-in. The signal
// here is for local triage when a refactor lands and a reviewer wants
// to confirm the pipeline didn't accidentally pick up an O(n²) loop.
//
// Baseline numbers (Apple M4, Go 1.26, May 2026 main, -benchtime=2s):
//
//   BenchmarkVectorize_block_letter_i      ~  420 µs/op   ~ 208 kB/op    385 allocs/op
//   BenchmarkVectorize_broken_horizontal   ~   95 µs/op   ~ 119 kB/op    170 allocs/op
//   BenchmarkVectorize_curve_u             ~  295 µs/op   ~ 246 kB/op    618 allocs/op
//   BenchmarkVectorize_near_touching_bars  ~  215 µs/op   ~ 183 kB/op    233 allocs/op
//   BenchmarkVectorize_square_corners      ~  235 µs/op   ~ 240 kB/op    355 allocs/op
//   BenchmarkVectorize_thin_l              ~  205 µs/op   ~ 199 kB/op    196 allocs/op
//
// Refresh these numbers when re-baselining: run with `-benchtime=2s
// -count=3` and take the median. A sustained 2× slowdown on any
// fixture, or a 3× allocation jump, is worth investigating in a PR.
// Older / slower hardware (Intel Mac, x86 Linux CI runners) typically
// runs 2-3× these numbers — the ratios between fixtures matter more
// than the absolute values.
//
// The fixture geometry is small (≤ 320 px tall) by design — these are
// not representative of full-size production designs (a real install
// might run 2000×2000 px). They exist to catch hot-loop regressions
// fast in the inner-loop functions; if you're benchmarking real-world
// scale, run against testdata/open_neon.png instead.

var benchFixtures = []string{
	"block_letter_i.png",
	"broken_horizontal.png",
	"curve_u.png",
	"near_touching_bars.png",
	"square_corners.png",
	"thin_l.png",
}

func BenchmarkVectorize_block_letter_i(b *testing.B) {
	benchFixture(b, "block_letter_i.png")
}

func BenchmarkVectorize_broken_horizontal(b *testing.B) {
	benchFixture(b, "broken_horizontal.png")
}

func BenchmarkVectorize_curve_u(b *testing.B) {
	benchFixture(b, "curve_u.png")
}

func BenchmarkVectorize_near_touching_bars(b *testing.B) {
	benchFixture(b, "near_touching_bars.png")
}

func BenchmarkVectorize_square_corners(b *testing.B) {
	benchFixture(b, "square_corners.png")
}

func BenchmarkVectorize_thin_l(b *testing.B) {
	benchFixture(b, "thin_l.png")
}

// benchFixture loads the fixture and its golden once (outside the
// timed loop) and benchmarks just the VectorizeRaster call so the
// numbers reflect the pipeline cost, not file I/O.
func benchFixture(b *testing.B, name string) {
	b.Helper()
	dir := filepath.Join("testdata", "goldens")
	pngPath := filepath.Join(dir, name)
	goldenPath := filepath.Join(dir, name[:len(name)-len(".png")]+".golden.json")

	golden, err := readGolden(goldenPath)
	if err != nil {
		b.Fatalf("read golden: %v", err)
	}
	data, err := os.ReadFile(pngPath)
	if err != nil {
		b.Fatalf("read fixture: %v", err)
	}

	req := Request{
		SourceBytes:       data,
		TargetWidthMM:     golden.TargetWidthMM,
		Threshold:         golden.Threshold,
		SmoothingMM:       golden.SmoothingMM,
		MinSpurMM:         golden.MinSpurMM,
		DefaultDiameterMM: golden.DiameterMM,
	}

	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		if _, err := VectorizeRaster(context.Background(), req); err != nil {
			b.Fatalf("vectorize: %v", err)
		}
	}
}
