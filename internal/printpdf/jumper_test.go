package printpdf

import (
	"bytes"
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// jumperDoc is a primary run plus a jumper spliced across midfield, positioned
// so the dashed stroke and its midpoint label both land inside a tile's
// printable area. The jumper carries no electrodes — jumpers are wired, not
// glass-open — and `Kind` is what tags it for the dashed-stroke + label path.
func jumperDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {50, 0}, {100, 50}, {150, 0}, {200, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0},
					{PointIndex: 4},
				},
				TubeDiameterMM: 10,
			},
			{
				ID:   "j1",
				Kind: "jumper",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{50, 60}, {100, 70}},
				},
			},
		},
	}
}

// TestJumperIsDrawnDashedAndLabelled is Tier 3 #60 / NW #125 — Connect Tubes —
// asserted on the geometry rather than on the size of the PDF.
//
// This test used to render the doc twice, with and without the jumper, and
// require the two byte streams to differ ("output identical with and without
// jumper run — emitter likely no-op"). That could only ever detect that
// *something* changed; it could not tell a dashed splice tube from an extra
// space in a label. Tier 3 #122's seam answers the real question: for a jumper
// run the plan is one dashed stroke between the two splice points, plus a
// "JUMPER" callout anchored at their midpoint.
func TestJumperIsDrawnDashedAndLabelled(t *testing.T) {
	doc := jumperDoc()
	primary, jumper := planRunDrawing(doc.Runs[0]), planRunDrawing(doc.Runs[1])

	if len(jumper.Paths) != 1 {
		t.Fatalf("jumper planned %d subpaths, want 1", len(jumper.Paths))
	}
	stroke := jumper.Paths[0]
	if !stroke.Dashed {
		t.Error("jumper stroke is solid — it would print as lit glass on the pattern")
	}
	if stroke.Closed {
		t.Error("jumper stroke is closed — a 2-vertex splice tube is an open run")
	}
	if got, want := len(stroke.Ops), 2; got != want {
		t.Fatalf("jumper stroke has %d operators, want %d (a move and a line)", got, want)
	}
	if stroke.Ops[0].Kind != opMoveTo || stroke.Ops[1].Kind != opLineTo {
		t.Errorf("jumper stroke operators are %v %v, want M then L", stroke.Ops[0].Kind, stroke.Ops[1].Kind)
	}
	for i, want := range [][2]float64{{50, 60}, {100, 70}} {
		if got := stroke.Ops[i]; got.X != want[0] || got.Y != want[1] {
			t.Errorf("jumper operator %d ends at (%g,%g), want (%g,%g)", i, got.X, got.Y, want[0], want[1])
		}
	}

	if jumper.Label == nil {
		t.Fatal("jumper planned no label — the bender is handed a dashed line with no explanation")
	}
	if jumper.Label.Text != "JUMPER" {
		t.Errorf("jumper label = %q, want %q", jumper.Label.Text, "JUMPER")
	}
	// Midpoint of (50,60)–(100,70).
	if d := math.Hypot(jumper.Label.X-75, jumper.Label.Y-65); d > 1e-9 {
		t.Errorf("jumper label anchored at (%g,%g), %.4f mm off the splice midpoint (75,65)",
			jumper.Label.X, jumper.Label.Y, d)
	}

	// Negative control: the primary run in the same doc must NOT pick up the
	// jumper treatment, or "dashed" would mean nothing.
	for i, p := range primary.Paths {
		if p.Dashed {
			t.Errorf("primary run subpath %d came out dashed", i)
		}
	}
	if primary.Label != nil {
		t.Errorf("primary run picked up a %q label", primary.Label.Text)
	}
}

// TestRenderFromDocWithJumperDoesNotError is the end-to-end smoke test: a doc
// carrying a jumper assembles into a syntactically-valid, non-trivial PDF.
//
// The byte-length check here is deliberate and stays. Its question is "did a
// PDF come out of this at all", which is exactly what a length answers; the
// geometric question — is the jumper drawn, and drawn dashed — belongs to
// TestJumperIsDrawnDashedAndLabelled above, which asks it of the plan.
func TestRenderFromDocWithJumperDoesNotError(t *testing.T) {
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"
	opts.DesignVersionLabel = "v1"

	out, err := RenderFromDoc(jumperDoc(), opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Fatalf("output is not a PDF (first 8 bytes: %q)", string(out[:min(8, len(out))]))
	}
	if len(out) < 1024 {
		t.Errorf("output suspiciously small (%d bytes)", len(out))
	}
}

// TestRenderFromDocSkipsJumpersInBendList verifies the bend-list summary page
// does NOT enumerate jumper runs. Jumpers are 2-vertex splice tubes — they have
// no bends, and the "(no bends auto-detected)" placeholder row would just
// clutter the summary.
//
// The old version of this test stood two renders side by side and required the
// jumper to add fewer than 500 bytes to the PDF, reasoning that a bend-list row
// is "on the order of 30–60 bytes of compressed stream". That threshold is an
// order of magnitude above the thing it was watching for, so it could never
// have fired; the accompanying `strings.Contains(pdf, "j1 ·")` check was worse
// than weak — RenderFromDoc's content streams are Flate-compressed, so the
// literal is not in the bytes whether the row was emitted or not, and the
// assertion passed by construction.
//
// Tier 3 #122 asks the question of bendListRuns instead, which is the function
// drawBendListPage and the bend pre-compute both walk.
func TestRenderFromDocSkipsJumpersInBendList(t *testing.T) {
	doc := jumperDoc()

	var ids []string
	for _, run := range bendListRuns(doc) {
		ids = append(ids, run.ID)
	}
	if len(ids) != 1 || ids[0] != "r1" {
		t.Errorf("bend list enumerates %v, want [r1] — jumper j1 must not get a row", ids)
	}

	// Guard against the assertion going vacuous if the fixture ever loses its
	// jumper: the doc really does contain one, and a non-jumper really is
	// enumerated.
	sawJumper := false
	for _, run := range doc.Runs {
		if run.Kind == "jumper" {
			sawJumper = true
		}
	}
	if !sawJumper {
		t.Fatal("fixture has no jumper run — this test asserts nothing")
	}

	// End-to-end: the page set still renders.
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"
	opts.DesignVersionLabel = "v1"
	out, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Errorf("not a PDF: %q", string(out[:8]))
	}
}
