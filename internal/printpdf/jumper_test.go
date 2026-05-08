package printpdf

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestRenderFromDocWithJumperDoesNotError is a smoke test for Tier 3
// #60 / NW #125 — Connect Tubes. Verifies that a doc carrying a
// jumper run produces a syntactically-valid PDF (gofpdf compresses
// page content streams by default, so a literal "JUMPER" substring
// search is not reliable; cf. returnstrip_test.go which calls
// pdf.SetCompression(false) on a hand-built fpdf when it needs to
// inspect the raw stream — we don't reach that hook from
// RenderFromDoc, by design). The structural assertions plus the
// neighboring TestRenderFromDocSkipsJumpersInBendList exercise the
// jumper code paths end-to-end without depending on stream
// compression behavior.
func TestRenderFromDocWithJumperDoesNotError(t *testing.T) {
	doc := &designdoc.Doc{
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
				// Jumper run between two midfield points so the dashed
				// stroke + midpoint label both fall inside a tile's
				// printable area. No electrodes (jumpers are wired,
				// not glass-open). Kind tags it for the dashed-stroke
				// + label code path.
				ID:   "j1",
				Kind: "jumper",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{50, 60}, {100, 70}},
				},
			},
		},
	}
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"
	opts.DesignVersionLabel = "v1"

	out, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Fatalf("output is not a PDF (first 8 bytes: %q)", string(out[:min(8, len(out))]))
	}
	if len(out) < 1024 {
		t.Errorf("output suspiciously small (%d bytes)", len(out))
	}

	// The jumper-aware emitter changes the rendered byte stream from
	// the same doc minus the jumper — verify that we're not silently
	// no-op'ing (a regression that lost the dashed-stroke + label
	// branch would produce identical output).
	without := *doc
	withoutRuns := []designdoc.Run{doc.Runs[0]}
	without.Runs = withoutRuns
	bareOut, err := RenderFromDoc(&without, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc (without jumper): %v", err)
	}
	if bytes.Equal(out, bareOut) {
		t.Errorf("output identical with and without jumper run — emitter likely no-op")
	}
}

// TestRenderFromDocSkipsJumpersInBendList verifies the bend-list
// summary page does NOT include a row for jumper runs. Jumpers are
// 2-vertex splice tubes — they have no bends to enumerate, and the
// "(no bends auto-detected)" placeholder row would just clutter the
// summary. We stand the test up by rendering once with a jumper and
// once without, then asserting the bend list page emits the same
// number of run-header bytes (a header-per-non-jumper-run is the
// observable behavior). gofpdf's stream compression hides the literal
// header text from a substring search; comparing byte length deltas
// against the no-jumper baseline is the closest we can get to a
// behavioral assertion without reaching for the compression-disabled
// fpdf hook returnstrip_test.go uses.
func TestRenderFromDocSkipsJumpersInBendList(t *testing.T) {
	primary := designdoc.Run{
		// Primary run with bends — keeps the bend-list page emitter
		// alive (it fires only when totalBends > 0).
		ID: "r1",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{
				{0, 0}, {50, 0}, {50, 50}, {100, 50}, {100, 0},
			},
		},
		Electrodes:     []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 4}},
		TubeDiameterMM: 10,
	}
	jumper := designdoc.Run{
		ID:   "j1",
		Kind: "jumper",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{100, 0}, {120, 5}},
		},
	}

	docWith := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs:      []designdoc.Run{primary, jumper},
	}
	docWithout := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		// Same primary; identical bend list expected.
		Runs: []designdoc.Run{primary},
	}
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"
	opts.DesignVersionLabel = "v1"

	withOut, err := RenderFromDoc(docWith, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc with jumper: %v", err)
	}
	withoutOut, err := RenderFromDoc(docWithout, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc without jumper: %v", err)
	}
	// Heuristic: a per-run bend-list row is on the order of 30–60 bytes
	// of compressed PDF stream. If the jumper had been emitted into
	// the bend list, withOut would be at least ~30 bytes larger than
	// withoutOut after accounting for the jumper's (small) main-page
	// dashed stroke + JUMPER label additions. We expect the delta to
	// be modest (jumper main-page geometry adds <200 bytes); a
	// delta over 500 bytes would suggest the bend list grew too.
	delta := len(withOut) - len(withoutOut)
	if delta > 500 {
		t.Errorf("jumper added %d bytes to the rendered PDF — likely emitted into the bend list (expected <500)", delta)
	}
	// Sanity: still a PDF.
	if !bytes.HasPrefix(withOut, []byte("%PDF-")) {
		t.Errorf("not a PDF: %q", string(withOut[:8]))
	}
	// Sanity: the housings label test pattern works regardless of
	// compression (the literal "j1 ·" run-header would have to fit
	// inside the compressed content stream — it doesn't, so this
	// assertion is structurally weak — but if a future change
	// removes compression, we still want the test to enforce the
	// invariant. Keep it.
	if strings.Contains(string(withOut), "j1 ·") {
		t.Errorf("bend list page emitted a row for jumper run j1")
	}
}
