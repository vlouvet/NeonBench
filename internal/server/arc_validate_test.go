package server

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/validate"
)

// The whole point of emitting arcs as cubics rather than as an SVG `A`: the
// validator's parser does not implement elliptical arcs — it approximates
// them as a straight line to the endpoint and warns. If ToSVG ever goes back
// to `A`, the validator silently measures the chord instead of the glass, and
// every bend-radius check on a curved segment becomes wrong. This test fails
// loudly if that happens.
func TestArcSegmentReachesTheValidatorAsACurve(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 300, 300},
		Runs: []designdoc.Run{{
			ID: "r1",
			Polyline: designdoc.Polyline{
				Points:       [][2]float64{{50, 150}, {250, 150}},
				SegmentTypes: []string{designdoc.SegmentArc},
			},
			TubeDiameterMM: 12,
		}},
	}
	svg := designdoc.ToSVG(doc)

	polys, _, issues, err := validate.ExtractMMPolylines(svg)
	if err != nil {
		t.Fatalf("extract: %v", err)
	}
	for _, is := range issues {
		if is.Rule == validate.RuleUnsupportedPath {
			t.Errorf("arc emission produced an unsupported-path warning: %s", is.Message)
		}
	}
	if len(polys) != 1 {
		t.Fatalf("expected 1 polyline, got %d", len(polys))
	}

	// The chord is 200mm; the arc over it is ~1.15911x that.
	got := polys[0].Length()
	want := 200 * (0.625 * 4 * math.Atan(0.5))
	if math.Abs(got-want)/want > 0.002 {
		t.Errorf("validator measured %.3fmm, want ~%.3fmm (the arc, not the %v mm chord)", got, want, 200.0)
	}
	if math.Abs(got-200) < 1 {
		t.Fatalf("validator measured %.3fmm — that is the chord; the curve was lost", got)
	}
}

// A doc with no arcs must emit byte-identical SVG to before the feature.
func TestNoArcsEmitUnchangedSVG(t *testing.T) {
	mk := func(withField bool) []byte {
		pl := designdoc.Polyline{Points: [][2]float64{{0, 0}, {100, 0}, {100, 100}}}
		if withField {
			pl.SegmentTypes = []string{designdoc.SegmentLine, designdoc.SegmentLine}
		}
		return designdoc.ToSVG(&designdoc.Doc{
			Version:   1,
			ViewBoxMM: [4]float64{0, 0, 200, 200},
			Runs:      []designdoc.Run{{ID: "r1", Polyline: pl, TubeDiameterMM: 10}},
		})
	}
	if string(mk(false)) != string(mk(true)) {
		t.Error("an all-line segment_types array changed the emitted SVG; it must be inert")
	}
}
