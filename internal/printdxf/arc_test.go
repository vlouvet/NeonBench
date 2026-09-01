package printdxf

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// An arc segment goes out as an LWPOLYLINE vertex bulge (group code 42), which
// is exactly how this arc is defined — sagitta over half-chord. So the curve
// reaches the bender's CAM as a real arc with no flattening and no
// approximation error, rather than as a couple of dozen short chords.
func TestArcSegmentEmitsBulge(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 200},
		Runs: []designdoc.Run{{
			ID: "r1",
			Polyline: designdoc.Polyline{
				Points:       [][2]float64{{0, 0}, {100, 0}, {100, 100}},
				SegmentTypes: []string{designdoc.SegmentArc, designdoc.SegmentLine},
			},
		}},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("emit: %v", err)
	}
	out := buf.String()

	// Group code 42 is written as its own line pair, "42\n<value>".
	if n := strings.Count(out, "\n42\n"); n != 1 {
		t.Errorf("expected exactly 1 bulge pair for 1 arc segment, got %d", n)
	}
	if !strings.Contains(out, "\n42\n0.5\n") {
		idx := strings.Index(out, "\n42\n")
		ctx := ""
		if idx >= 0 {
			end := idx + 40
			if end > len(out) {
				end = len(out)
			}
			ctx = out[idx:end]
		}
		t.Errorf("bulge value is not 0.5; got %q", ctx)
	}
	// The vertex list itself must be unchanged — a bulge curves the segment,
	// it does not add points.
	if n := strings.Count(out, "\n10\n"); n < 3 {
		t.Errorf("expected the 3 original vertices to survive, found %d x-coords", n)
	}
}

// A run with no arcs must emit byte-identical DXF to before the feature.
func TestNoArcsEmitUnchangedDXF(t *testing.T) {
	mk := func(withField bool) string {
		pl := designdoc.Polyline{Points: [][2]float64{{0, 0}, {100, 0}, {100, 100}}}
		if withField {
			pl.SegmentTypes = []string{designdoc.SegmentLine, designdoc.SegmentLine}
		}
		var buf bytes.Buffer
		if err := EmitDXF(&buf, &designdoc.Doc{
			Version:   1,
			ViewBoxMM: [4]float64{0, 0, 200, 200},
			Runs:      []designdoc.Run{{ID: "r1", Polyline: pl}},
		}); err != nil {
			t.Fatalf("emit: %v", err)
		}
		return buf.String()
	}
	if mk(false) != mk(true) {
		t.Error("an all-line segment_types array changed the DXF; it must be inert")
	}
	if strings.Contains(mk(false), "\n42\n") {
		t.Error("a run with no arcs emitted a bulge pair")
	}
}

// Tier 3 #87 — a flipped arc ("arc_r") must go out with a NEGATIVE bulge.
// A DXF bulge is signed: positive sweeps counter-clockwise from this vertex to
// the next, negative clockwise. Emitting +0.5 for both sides would show the
// operator one curve on screen and hand the bender its mirror image, with
// nothing in the file to reveal the disagreement.
func TestFlippedArcEmitsNegativeBulge(t *testing.T) {
	mk := func(st string) string {
		doc := &designdoc.Doc{
			Version:   1,
			ViewBoxMM: [4]float64{0, 0, 200, 200},
			Runs: []designdoc.Run{{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points:       [][2]float64{{0, 0}, {100, 0}, {100, 100}},
					SegmentTypes: []string{st, designdoc.SegmentLine},
				},
			}},
		}
		var buf bytes.Buffer
		if err := EmitDXF(&buf, doc); err != nil {
			t.Fatalf("emit: %v", err)
		}
		return buf.String()
	}

	flipped := mk(designdoc.SegmentArcR)
	if !strings.Contains(flipped, "\n42\n-0.5\n") {
		idx := strings.Index(flipped, "\n42\n")
		ctx := ""
		if idx >= 0 {
			end := idx + 40
			if end > len(flipped) {
				end = len(flipped)
			}
			ctx = flipped[idx:end]
		}
		t.Errorf("flipped arc bulge is not -0.5; got %q", ctx)
	}
	if n := strings.Count(flipped, "\n42\n"); n != 1 {
		t.Errorf("expected exactly 1 bulge pair, got %d", n)
	}

	// Only the sign differs: same vertices, same entity, same everything else.
	unflipped := mk(designdoc.SegmentArc)
	if strings.ReplaceAll(flipped, "\n42\n-0.5\n", "\n42\n0.5\n") != unflipped {
		t.Error("flipping an arc changed more than the bulge sign")
	}
}
