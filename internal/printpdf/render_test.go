package printpdf

import (
	"bytes"
	"testing"
	"time"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// init pins the gofpdf-side sources of nondeterminism so two
// back-to-back renders with identical inputs produce byte-identical
// output. Two knobs:
//
//   - Creation / modification dates default to time.Now() inside
//     gofpdf — pin them to a fixed UTC instant.
//   - The font / image / gradient catalog tables are emitted in Go
//     map iteration order by default, which is randomized per
//     process AND per goroutine. Enable SetDefaultCatalogSort so
//     gofpdf sorts the keys before emitting; otherwise back-to-back
//     renders share the same byte LENGTH but different bytes (caught
//     by the Windows CI runner, where the map seed happens to
//     produce a different order than the Linux runner did).
//
// Without these two pins, TestRenderFromDocMirrorChangesOutput's
// byte-equality assertion on the default-vs-explicit-true case
// (the load-bearing trade-default invariant) flakes intermittently.
func init() {
	fixed := time.Date(2026, 5, 9, 0, 0, 0, 0, time.UTC)
	gofpdf.SetDefaultCreationDate(fixed)
	gofpdf.SetDefaultModificationDate(fixed)
	gofpdf.SetDefaultCatalogSort(true)
}

// TestMirrorOnDefault pins the trade-default behavior: an unset
// Options.Mirror field (nil pointer) means "mirrored" because the
// operator bends against the BACK of the glass tube while reading the
// printed pattern (Tier 2 #73, NW parity quote: "the layout is
// reversed automatically when it comes in"). Explicit &true preserves
// that, and only &false opts out — for marketing renders / front-side
// review.
func TestMirrorOnDefault(t *testing.T) {
	cases := []struct {
		name string
		set  *bool
		want bool
	}{
		{"nil defaults to mirrored", nil, true},
		{"explicit true is mirrored", boolPtr(true), true},
		{"explicit false is un-mirrored", boolPtr(false), false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			opts := DefaultOptions()
			opts.Mirror = c.set
			if got := opts.MirrorOn(); got != c.want {
				t.Errorf("MirrorOn() with %v: got %v want %v", c.set, got, c.want)
			}
		})
	}
}

// TestMakePageProjectorIdentity verifies the non-mirrored projector
// does exactly what the pre-Tier-2-#73 inline lambda did: world (mm)
// minus tile origin plus margin. This is the byte-compatible identity
// every existing printpdf test depends on.
func TestMakePageProjectorIdentity(t *testing.T) {
	// Tile at world (10, 20), 100 mm content width, 5 mm margin.
	proj := makePageProjector(10, 20, 5, 100, false)
	cases := []struct {
		x, y         float64
		wantX, wantY float64
	}{
		// At the tile's top-left corner the page coordinate is (margin, margin).
		{10, 20, 5, 5},
		// At the tile's right edge (x = tileX + contentW) the page x is
		// margin + contentW = 105.
		{110, 20, 105, 5},
		// Mid-tile point.
		{60, 70, 55, 55},
	}
	for _, c := range cases {
		gotX, gotY := proj(c.x, c.y)
		if gotX != c.wantX || gotY != c.wantY {
			t.Errorf("identity projector(%g,%g) = (%g,%g), want (%g,%g)",
				c.x, c.y, gotX, gotY, c.wantX, c.wantY)
		}
	}
}

// TestMakePageProjectorMirrored verifies the mirrored projector flips
// X around the tile's content rectangle so the left and right edges
// swap (the trade-required back-side view). Y is unaffected.
//
// The mathematical contract: a world-x at the tile's left edge
// (tileX) maps to the page's right content edge (margin + contentW);
// a world-x at the tile's right edge (tileX + contentW) maps to the
// page's left content edge (margin). All in between scales linearly.
func TestMakePageProjectorMirrored(t *testing.T) {
	proj := makePageProjector(10, 20, 5, 100, true)
	cases := []struct {
		x, y         float64
		wantX, wantY float64
	}{
		// Tile's left edge (world x = tileX = 10) -> page x = margin + contentW = 105.
		{10, 20, 105, 5},
		// Tile's right edge (world x = tileX + contentW = 110) -> page x = margin = 5.
		{110, 20, 5, 5},
		// Center of tile -> center of content area.
		{60, 70, 55, 55},
	}
	for _, c := range cases {
		gotX, gotY := proj(c.x, c.y)
		if gotX != c.wantX || gotY != c.wantY {
			t.Errorf("mirrored projector(%g,%g) = (%g,%g), want (%g,%g)",
				c.x, c.y, gotX, gotY, c.wantX, c.wantY)
		}
	}
}

// TestRenderFromDocMirrorChangesOutput is a behavioral golden: with
// the default options (mirror unset → trade default mirrored) the
// renderer must produce a DIFFERENT byte stream from the explicit
// `Mirror = &false` request. A regression that silently drops the
// mirror code path would make them byte-identical and this test would
// catch it.
//
// We additionally pin that the default-options output matches the
// explicit `Mirror = &true` output — the trade-default-is-mirrored
// invariant is the load-bearing piece of the spec.
func TestRenderFromDocMirrorChangesOutput(t *testing.T) {
	doc := mirrorTestDoc()
	opts := DefaultOptions()
	opts.ProjectName = "MirrorTest"
	opts.DesignVersionLabel = "v1"

	// Default options → trade-default mirrored.
	defaultOut, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc default: %v", err)
	}

	// Explicit mirrored — must match default byte-for-byte.
	mirOpts := opts
	tru := true
	mirOpts.Mirror = &tru
	mirroredOut, err := RenderFromDoc(doc, mirOpts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc explicit mirror: %v", err)
	}
	if !bytes.Equal(defaultOut, mirroredOut) {
		t.Errorf("DefaultOptions() (mirror unset) did NOT match explicit Mirror=&true — "+
			"the trade-default invariant is broken (default=%d bytes, explicit-true=%d bytes)",
			len(defaultOut), len(mirroredOut))
	}

	// Explicit un-mirrored (front-facing) — must differ from default.
	frontOpts := opts
	fal := false
	frontOpts.Mirror = &fal
	frontOut, err := RenderFromDoc(doc, frontOpts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc front-facing: %v", err)
	}
	if bytes.Equal(defaultOut, frontOut) {
		t.Errorf("mirrored and front-facing PDFs are byte-identical — the mirror code path did nothing")
	}

	// Both outputs must still be valid PDFs (no garbage from the
	// per-coordinate flip).
	for name, out := range map[string][]byte{"mirrored": defaultOut, "front": frontOut} {
		if !bytes.HasPrefix(out, []byte("%PDF-")) {
			t.Errorf("%s output is not a PDF (first 8 bytes: %q)", name, string(out[:min(8, len(out))]))
		}
		if len(out) < 1024 {
			t.Errorf("%s output suspiciously small (%d bytes)", name, len(out))
		}
	}

	// The two outputs should be similar in size — the mirror flip
	// only changes coordinate values, not the count or kind of
	// graphics objects emitted. A delta over 10% would suggest the
	// mirror code path is structurally diverging (skipping
	// labels, adding extra pages, etc.).
	delta := len(defaultOut) - len(frontOut)
	if delta < 0 {
		delta = -delta
	}
	avg := (len(defaultOut) + len(frontOut)) / 2
	if avg > 0 && delta*10 > avg {
		t.Errorf("mirrored vs front-facing PDF sizes diverge by >10%% (%d vs %d) — "+
			"mirror code path may be emitting extra/missing objects",
			len(defaultOut), len(frontOut))
	}
}

// TestRenderSVGMirrorChangesOutput is the equivalent of
// TestRenderFromDocMirrorChangesOutput for the SVG-only `Render`
// path used by pre-Phase-2 designs without a structured design_doc.
// Both renderers must honor the same Mirror semantics so a single
// handler call site (`?mirror=0`) toggles whichever path actually
// fires (see internal/server/handlers_print.go for the dispatch).
func TestRenderSVGMirrorChangesOutput(t *testing.T) {
	// A small asymmetric SVG (the letter "F" in mm-space) — exactly
	// the smoke-test pattern from the spec. width/height in mm make
	// ExtractMMPolylines happy; the polyline is rendered as a series
	// of M/L commands inside a <path> (the SVG parser supports path
	// d-strings; <polyline> is not on the supported element list).
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100">
  <path d="M10,10 L50,10 L50,30 L25,30 L25,50 L40,50 L40,70 L25,70 L25,90 L10,90 Z"
        fill="none" stroke="black" />
</svg>`)
	opts := DefaultOptions()
	opts.ProjectName = "MirrorSVG"

	defaultOut, err := Render(svg, opts)
	if err != nil {
		t.Fatalf("Render default: %v", err)
	}

	frontOpts := opts
	fal := false
	frontOpts.Mirror = &fal
	frontOut, err := Render(svg, frontOpts)
	if err != nil {
		t.Fatalf("Render front-facing: %v", err)
	}

	if bytes.Equal(defaultOut, frontOut) {
		t.Errorf("SVG-path mirrored and front-facing PDFs are byte-identical — Render didn't honor Mirror")
	}
	if !bytes.HasPrefix(defaultOut, []byte("%PDF-")) ||
		!bytes.HasPrefix(frontOut, []byte("%PDF-")) {
		t.Errorf("output is not a PDF")
	}
}

// mirrorTestDoc builds a 3-run fixture matching the spec's "3-run
// fixture" requirement (Deliverables #6). Asymmetric layout so the
// mirror has visible effect: a primary horizontal run, a tilted
// secondary, and a jumper between them.
func mirrorTestDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{
			{
				ID: "run-1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{10, 10}, {80, 10}, {80, 40}, {20, 40}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0},
					{PointIndex: 3},
				},
				TubeDiameterMM: 10,
			},
			{
				ID: "run-2",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{120, 20}, {180, 50}, {180, 80}, {130, 80}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0},
					{PointIndex: 3},
				},
				TubeDiameterMM: 10,
			},
			{
				ID:   "jmp-1",
				Kind: "jumper",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{80, 40}, {120, 20}},
				},
			},
		},
		Labels: []designdoc.Label{
			{X: 50, Y: 60, Text: "left"},
			{X: 150, Y: 60, Text: "right"},
		},
		Dimensions: []designdoc.Dimension{
			{X1: 10, Y1: 90, X2: 180, Y2: 90, Note: "overall"},
		},
	}
}

func boolPtr(b bool) *bool { return &b }
