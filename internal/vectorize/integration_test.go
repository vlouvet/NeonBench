package vectorize

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

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
