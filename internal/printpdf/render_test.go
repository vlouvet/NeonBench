package printpdf

import (
	"bytes"
	"fmt"
	"strings"
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
	proj := makePageProjector(10, 20, 5, 100, 200, false, false)
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
	proj := makePageProjector(10, 20, 5, 100, 200, true, false)
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

// ---------------------------------------------------------------------
// Tier 2 #93 — rotate to fit, step-and-repeat copies.
// ---------------------------------------------------------------------

// pdfPageCount counts page objects in a gofpdf-emitted PDF. gofpdf
// leaves page dictionaries uncompressed (only content streams are
// compressed), so counting "/Type /Page" and subtracting the single
// "/Type /Pages" parent gives the page count. Mirrors the helper the
// server integration tests use.
func pdfPageCount(b []byte) int {
	s := string(b)
	return strings.Count(s, "/Type /Page") - strings.Count(s, "/Type /Pages")
}

// TestValidRotate pins the accepted query values, including the empty
// string: an absent `rotate` parameter must be valid, or every legacy
// caller starts getting 400s.
func TestValidRotate(t *testing.T) {
	for _, ok := range []string{RotateNone, RotateFixed90, RotateFit} {
		if !ValidRotate(ok) {
			t.Errorf("ValidRotate(%q) = false, want true", ok)
		}
	}
	for _, bad := range []string{"0", "180", "270", "fitt", "FIT", "yes", "-90"} {
		if ValidRotate(bad) {
			t.Errorf("ValidRotate(%q) = true, want false", bad)
		}
	}
}

// TestCopiesOrOne pins the absent-safe zero value.
func TestCopiesOrOne(t *testing.T) {
	cases := map[int]int{-3: 1, 0: 1, 1: 1, 2: 2, 50: 50}
	for in, want := range cases {
		if got := (Options{Copies: in}).CopiesOrOne(); got != want {
			t.Errorf("Options{Copies:%d}.CopiesOrOne() = %d, want %d", in, got, want)
		}
	}
}

// TestResolveRotate covers the three modes and — the load-bearing one —
// the tie rule. Numbers below are for US Letter portrait with the
// default 10 mm margin and 10 mm tile overlap: content 195.9 × 259.4,
// step 185.9 × 249.4.
func TestResolveRotate(t *testing.T) {
	const stepW, stepH = 185.9, 249.4
	cases := []struct {
		name             string
		mode             string
		designW, designH float64
		want             bool
	}{
		// 240 × 180 needs 2×1 = 2 tiles upright, 1×1 = 1 rotated.
		{"fit rotates when it saves a sheet", RotateFit, 240, 180, true},
		{"90 always rotates", RotateFixed90, 240, 180, true},
		{"none never rotates", RotateNone, 240, 180, false},
		// 180 × 240 is already the cheap orientation: 1 tile upright,
		// 2 rotated. Never rotate.
		{"fit leaves an already-fitting pattern alone", RotateFit, 180, 240, false},
		// A square ties (same count both ways) — keep un-rotated so the
		// same design prints the same way round every time.
		{"fit tie keeps un-rotated (square)", RotateFit, 240, 240, false},
		{"fit tie keeps un-rotated (single tile both ways)", RotateFit, 100, 120, false},
		// 90 ignores the tile math entirely, ties included.
		{"90 rotates even on a tie", RotateFixed90, 240, 240, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := resolveRotate(c.mode, c.designW, c.designH, stepW, stepH); got != c.want {
				uc, ur := tileGrid(c.designW, c.designH, stepW, stepH)
				rc, rr := tileGrid(c.designH, c.designW, stepW, stepH)
				t.Errorf("resolveRotate(%q, %g, %g) = %v, want %v (upright %d×%d=%d tiles, rotated %d×%d=%d tiles)",
					c.mode, c.designW, c.designH, got, c.want, uc, ur, uc*ur, rc, rr, rc*rr)
			}
		})
	}
}

// TestRotatedBBoxSwapsDimensionsAboutCentre pins that rotation is about
// the bbox centre — the centre must survive so a rotated pattern stays
// where the operator expects it rather than swinging into the margins.
func TestRotatedBBoxSwapsDimensionsAboutCentre(t *testing.T) {
	in := [4]float64{10, 20, 210, 120} // 200 × 100, centre (110, 70)
	got := rotatedBBox(in)
	want := [4]float64{60, -30, 160, 170} // 100 × 200, same centre
	if got != want {
		t.Fatalf("rotatedBBox(%v) = %v, want %v", in, got, want)
	}
	gotCX, gotCY := (got[0]+got[2])/2, (got[1]+got[3])/2
	if gotCX != 110 || gotCY != 70 {
		t.Errorf("rotation moved the bbox centre to (%g,%g), want (110,70)", gotCX, gotCY)
	}
}

// TestMirrorRotateOrderIsMirrorThenRotate is THE order test. Mirror and
// rotation do not commute: the two orders differ by a 180° turn, i.e.
// the bender would hold the sheet upside down. NeonBench fixes the order
// as MIRROR, THEN ROTATE — mirroring is a property of the pattern (the
// bender reads through the back of the glass), rotation is a property of
// the paper (a sheet has a long axis).
//
// Fixture: a 100 × 50 design bbox centred at (50, 25). Rotated it
// becomes 50 × 100 with bbox [25, -25, 75, 75], so the single tile's
// origin is (25, -25). Margin 5, content 100 × 60.
//
// The known point is the design's bottom-left corner, world (0, 50).
func TestMirrorRotateOrderIsMirrorThenRotate(t *testing.T) {
	const margin, contentW, contentH = 5.0, 100.0, 60.0
	bbox := [4]float64{0, 0, 100, 50}
	cx, cy := 50.0, 25.0
	rb := rotatedBBox(bbox)
	if rb != ([4]float64{25, -25, 75, 75}) {
		t.Fatalf("fixture drifted: rotatedBBox = %v", rb)
	}

	// Rotation alone: world (0,50) → rotated world (25,-25) → page
	// (25-25+5, -25+25+5) = (5, 5).
	rotOnly := makeTileProjector(cx, cy, rb[0], rb[1], margin, contentW, contentH, false, true)
	if x, y := rotOnly(0, 50); x != 5 || y != 5 {
		t.Fatalf("rotate-only projector(0,50) = (%g,%g), want (5,5)", x, y)
	}

	// Mirror THEN rotate. Reflecting the design horizontally and then
	// turning it 90° is the same image as turning it and then
	// reflecting VERTICALLY (R·Mh = Mv·R), so the rotated point's Y
	// flips within the content rectangle: 5 → (2*5 + 60) - 5 = 65.
	// X is untouched.
	both := makeTileProjector(cx, cy, rb[0], rb[1], margin, contentW, contentH, true, true)
	gotX, gotY := both(0, 50)
	const wantX, wantY = 5.0, 65.0
	if gotX != wantX || gotY != wantY {
		t.Errorf("mirror-then-rotate projector(0,50) = (%g,%g), want (%g,%g). "+
			"Getting (105,5) would mean the order silently flipped to "+
			"rotate-then-mirror — the X axis got reflected instead of the Y "+
			"axis, and the bender's sheet is upside down relative to spec.",
			gotX, gotY, wantX, wantY)
	}

	// And the wrong order is genuinely a different page position, so
	// this test can actually fail if someone swaps the composition.
	wrongX := margin + contentW + rb[0] - 25 // horizontal flip of the rotated x
	if wrongX == gotX {
		t.Error("the two orders produced the same point — the fixture no longer discriminates")
	}
}

// TestRenderFromDocRotateReducesPageCount is the end-to-end tile-count
// claim: a wide pattern that needs two sheets upright needs one rotated.
// rotate=90 and rotate=fit must both take it; rotate absent must not.
func TestRenderFromDocRotateReducesPageCount(t *testing.T) {
	doc := widePatternDoc()
	opts := DefaultOptions()
	opts.ProjectName = "RotateFit"

	render := func(mode string) []byte {
		o := opts
		o.Rotate = mode
		out, err := RenderFromDoc(doc, o, 10)
		if err != nil {
			t.Fatalf("RenderFromDoc(rotate=%q): %v", mode, err)
		}
		return out
	}

	upright := pdfPageCount(render(RotateNone))
	fixed90 := pdfPageCount(render(RotateFixed90))
	fit := pdfPageCount(render(RotateFit))
	t.Logf("pages: upright=%d rotate90=%d fit=%d", upright, fixed90, fit)

	// 240 × 180 on Letter portrait: 2 tiles upright + 1 bend-list page.
	if upright != 3 {
		t.Errorf("un-rotated page count = %d, want 3 (2 tiles + bend list)", upright)
	}
	// Rotated: 1 tile + 1 bend-list page.
	if fixed90 != 2 {
		t.Errorf("rotate=90 page count = %d, want 2 (1 tile + bend list)", fixed90)
	}
	if fit != fixed90 {
		t.Errorf("rotate=fit page count = %d, want %d (it should pick the rotated layout)", fit, fixed90)
	}
	if fit >= upright {
		t.Errorf("rotate=fit (%d pages) did not beat un-rotated (%d pages)", fit, upright)
	}
}

// TestRenderFromDocRotateFitTieKeepsUnrotated pins the tie rule at the
// renderer level, not just in resolveRotate: on a square design where
// both orientations cost the same number of sheets, rotate=fit must
// produce a BYTE-IDENTICAL PDF to no rotation at all. Byte equality is
// the strongest available statement that nothing was rotated (a rotated
// square has the same bbox but different geometry).
func TestRenderFromDocRotateFitTieKeepsUnrotated(t *testing.T) {
	doc := squarePatternDoc()
	opts := DefaultOptions()
	opts.ProjectName = "RotateTie"

	plain, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc plain: %v", err)
	}
	fitOpts := opts
	fitOpts.Rotate = RotateFit
	fit, err := RenderFromDoc(doc, fitOpts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc fit: %v", err)
	}
	if !bytes.Equal(plain, fit) {
		t.Errorf("rotate=fit on a tie was NOT byte-identical to no rotation "+
			"(%d vs %d bytes) — the tie must keep the un-rotated orientation so "+
			"repeat prints of the same design come off the bench the same way round",
			len(plain), len(fit))
	}

	// Sanity: rotate=90 on the same doc DOES change the bytes, so the
	// equality above is a real assertion and not a dead code path.
	nine := opts
	nine.Rotate = RotateFixed90
	rotated, err := RenderFromDoc(doc, nine, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc rotate=90: %v", err)
	}
	if bytes.Equal(plain, rotated) {
		t.Error("rotate=90 produced byte-identical output to no rotation — the rotation did nothing")
	}
}

// TestRotationLeavesStripPagesAlone pins the scope rule: return-strip
// and raceway-strip pages are unfolded 1D perimeter patterns in their
// own coordinate space, so rotation must not touch them. With
// StripsOnly the whole PDF is strip pages, so "byte-identical with and
// without rotation" is exactly the assertion we want.
func TestRotationLeavesStripPagesAlone(t *testing.T) {
	doc := faceStripDoc()
	opts := DefaultOptions()
	opts.ProjectName = "StripScope"
	opts.StripsOnly = true

	plain, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc strips-only: %v", err)
	}
	for _, mode := range []string{RotateFixed90, RotateFit} {
		o := opts
		o.Rotate = mode
		got, err := RenderFromDoc(doc, o, 10)
		if err != nil {
			t.Fatalf("RenderFromDoc strips-only rotate=%q: %v", mode, err)
		}
		if !bytes.Equal(plain, got) {
			t.Errorf("rotate=%q changed the return-strip pages (%d vs %d bytes) — "+
				"strips are unfolded 1D patterns and must render identically regardless of rotation",
				mode, len(plain), len(got))
		}
	}
}

// TestRenderFromDocCopiesMultipliesPages — copies=N must produce exactly
// N times the page count of a single copy, for the full page set and for
// a strips-only set (copies of strips is a meaningful bench request).
func TestRenderFromDocCopiesMultipliesPages(t *testing.T) {
	doc := faceStripDoc()
	base := DefaultOptions()
	base.ProjectName = "Copies"

	for _, stripsOnly := range []bool{false, true} {
		opts := base
		opts.StripsOnly = stripsOnly
		one, err := RenderFromDoc(doc, opts, 10)
		if err != nil {
			t.Fatalf("RenderFromDoc copies=1 stripsOnly=%v: %v", stripsOnly, err)
		}
		onePages := pdfPageCount(one)
		if onePages < 1 {
			t.Fatalf("single-copy render had %d pages", onePages)
		}
		for _, n := range []int{2, 3, 5} {
			o := opts
			o.Copies = n
			out, err := RenderFromDoc(doc, o, 10)
			if err != nil {
				t.Fatalf("RenderFromDoc copies=%d stripsOnly=%v: %v", n, stripsOnly, err)
			}
			if got, want := pdfPageCount(out), onePages*n; got != want {
				t.Errorf("copies=%d stripsOnly=%v: %d pages, want %d (%d × %d)",
					n, stripsOnly, got, want, onePages, n)
			}
		}
	}
}

// TestRenderFromDocCopiesAbsentSafe — Copies unset (0) and Copies=1 must
// produce byte-identical PDFs, which is the same thing as saying the
// step-and-repeat code path is invisible until asked for. This is the
// half of the absent-safety contract that lives in the renderer; the
// query-parameter half lives in the server tests.
func TestRenderFromDocCopiesAbsentSafe(t *testing.T) {
	doc := faceStripDoc()
	opts := DefaultOptions()
	opts.ProjectName = "AbsentSafe"

	unset, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc unset: %v", err)
	}
	explicit := opts
	explicit.Copies = 1
	one, err := RenderFromDoc(doc, explicit, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc copies=1: %v", err)
	}
	if !bytes.Equal(unset, one) {
		t.Errorf("Copies unset (%d bytes) differs from Copies=1 (%d bytes)", len(unset), len(one))
	}

	// Same for Rotate: the zero value must be the no-rotation path.
	none := opts
	none.Rotate = RotateNone
	out, err := RenderFromDoc(doc, none, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc rotate=none: %v", err)
	}
	if !bytes.Equal(unset, out) {
		t.Errorf("Rotate=RotateNone differs from Rotate unset (%d vs %d bytes)", len(out), len(unset))
	}
}

// TestSVGRenderHonorsRotateAndCopies — the SVG-only fallback path (used
// by pre-Phase-2 versions with no structured design doc) must honor the
// same two options, or the same URL produces different behavior
// depending on how old the saved version is.
func TestSVGRenderHonorsRotateAndCopies(t *testing.T) {
	// 240 × 180 mm wide "L" — two Letter-portrait tiles upright, one
	// rotated, matching widePatternDoc's geometry claim.
	svg := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="240mm" height="180mm" viewBox="0 0 240 180">
  <path d="M5,5 L235,5 L235,175 L5,175" fill="none" stroke="black" />
</svg>`)
	opts := DefaultOptions()
	opts.ProjectName = "SVGRotate"

	plain, err := Render(svg, opts)
	if err != nil {
		t.Fatalf("Render plain: %v", err)
	}
	rot := opts
	rot.Rotate = RotateFit
	rotated, err := Render(svg, rot)
	if err != nil {
		t.Fatalf("Render fit: %v", err)
	}
	if got, want := pdfPageCount(plain), 2; got != want {
		t.Errorf("un-rotated SVG render: %d pages, want %d", got, want)
	}
	if got, want := pdfPageCount(rotated), 1; got != want {
		t.Errorf("rotate=fit SVG render: %d pages, want %d", got, want)
	}

	cp := opts
	cp.Copies = 3
	copied, err := Render(svg, cp)
	if err != nil {
		t.Fatalf("Render copies=3: %v", err)
	}
	if got, want := pdfPageCount(copied), pdfPageCount(plain)*3; got != want {
		t.Errorf("copies=3 SVG render: %d pages, want %d", got, want)
	}
}

// TestTileFooterStatesRotationAndCopies is the footer-honesty test. A
// rotated sheet, or one of N copies, has to say so on the page — a
// rotated pattern found on a bench a week later with nothing indicating
// the rotation is a real fabrication hazard.
//
// drawTileOverlay is exercised directly against an uncompressed fpdf so
// the footer string is searchable in the output (RenderFromDoc's own
// content streams are compressed), the same technique returnstrip_test
// uses.
func TestTileFooterStatesRotationAndCopies(t *testing.T) {
	opts := DefaultOptions()
	opts.ProjectName = "FooterTest"
	opts.DesignVersionLabel = "v1"

	overlay := func(rotated bool, copyNo, copies int) string {
		pdf := gofpdf.NewCustom(&gofpdf.InitType{
			OrientationStr: "P",
			UnitStr:        "mm",
			Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
		})
		pdf.SetCompression(false)
		pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
		pdf.SetAutoPageBreak(false, 0)
		pdf.AddPage()
		drawTileOverlay(pdf, opts, opts.Paper.WidthMM, opts.Paper.HeightMM,
			opts.Paper.WidthMM-2*opts.MarginMM, opts.Paper.HeightMM-2*opts.MarginMM,
			0, 0, 1, 1, rotated, copyNo, copies)
		var buf bytes.Buffer
		if err := pdf.Output(&buf); err != nil {
			t.Fatalf("output: %v", err)
		}
		return buf.String()
	}

	// Baseline: neither note appears when neither option is active, so
	// the default footer is unchanged from pre-Tier-2-#93 output.
	plain := overlay(false, 1, 1)
	for _, unwanted := range []string{"ROTATED", "Copy "} {
		if strings.Contains(plain, unwanted) {
			t.Errorf("default footer contains %q — the notes must only appear when the option is active", unwanted)
		}
	}
	if !strings.Contains(plain, "Tile 1,1 of 1") {
		t.Error("default footer lost its tile landmark")
	}

	if got := overlay(true, 1, 1); !strings.Contains(got, "ROTATED 90") {
		t.Error("rotated page footer does not state the rotation")
	}
	got := overlay(true, 2, 3)
	if !strings.Contains(got, "ROTATED 90") {
		t.Error("rotated+copies footer lost the rotation note")
	}
	if !strings.Contains(got, "Copy 2 of 3") {
		t.Error("copies footer does not identify which copy this sheet is")
	}
}

// widePatternDoc is 240 × 180 mm — wider than one Letter-portrait tile
// (195.9 mm content) but shorter than one tall (259.4 mm), so rotating
// it drops the sheet count from two to one. Two 90° corners give it a
// bend-list page as well, which the page-count assertions account for.
func widePatternDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 240, 180},
		Runs: []designdoc.Run{{
			ID: "run-wide",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{5, 5}, {235, 5}, {235, 175}, {5, 175}},
			},
			Electrodes:     []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 3}},
			TubeDiameterMM: 10,
		}},
	}
}

// squarePatternDoc is 240 × 240 mm: 2×1 tiles upright, 2×1 rotated —
// a tie, which rotate=fit must decline.
func squarePatternDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 240, 240},
		Runs: []designdoc.Run{{
			ID: "run-square",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{5, 5}, {235, 5}, {235, 235}, {5, 235}},
			},
			TubeDiameterMM: 10,
		}},
	}
}

// faceStripDoc has one channel-letter face run (so strips-only has
// something to emit) plus a plain run.
func faceStripDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 120},
		Runs: []designdoc.Run{
			{
				ID: "face-rect",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
			},
			{
				ID: "plain",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{10, 80}, {180, 80}, {180, 110}},
				},
			},
		},
	}
}

// TestBendListCopyMarkerOnEveryContinuationPage — a long design spills
// the bend list onto continuation pages, and every one of them has to
// carry the copy marker. Stamping only the last sheet would leave the
// pages in between unattributable in a step-and-repeat stack, which is
// exactly the ambiguity the marker exists to prevent.
func TestBendListCopyMarkerOnEveryContinuationPage(t *testing.T) {
	opts := DefaultOptions()
	opts.ProjectName = "LongBendList"
	opts.DesignVersionLabel = "v1"

	// 40 L-shaped runs: one 90° bend each, ~12 mm of bend-list height
	// apiece, which overflows a single Letter page several times over.
	doc := &designdoc.Doc{Version: 1, ViewBoxMM: [4]float64{0, 0, 200, 100}}
	bends := make(map[string][]designdoc.BendPoint, 40)
	for i := 0; i < 40; i++ {
		id := fmt.Sprintf("run-%d", i)
		run := designdoc.Run{
			ID: id,
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {50, 0}, {50, 40}},
			},
			TubeDiameterMM: 10,
		}
		doc.Runs = append(doc.Runs, run)
		bends[id] = designdoc.EffectiveBends(run, 10)
	}

	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	pdf.SetCompression(false)
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(false, 0)
	drawBendListPage(pdf, opts, doc, bends, opts.Paper.HeightMM, 2, 3)

	pages := pdf.PageCount()
	if pages < 2 {
		t.Fatalf("fixture produced a %d-page bend list; it must spill to exercise continuation pages", pages)
	}
	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		t.Fatalf("output: %v", err)
	}
	if got := strings.Count(buf.String(), "Copy 2 of 3"); got != pages {
		t.Errorf("bend list spans %d pages but carries %d copy markers — "+
			"continuation pages are unattributable in a printed stack", pages, got)
	}

	// And a single copy still stamps nothing, so the default PDF is
	// unchanged from pre-Tier-2-#93 output.
	solo := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	solo.SetCompression(false)
	solo.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	solo.SetAutoPageBreak(false, 0)
	drawBendListPage(solo, opts, doc, bends, opts.Paper.HeightMM, 1, 1)
	var soloBuf bytes.Buffer
	if err := solo.Output(&soloBuf); err != nil {
		t.Fatalf("output: %v", err)
	}
	if strings.Contains(soloBuf.String(), "Copy ") {
		t.Error("single-copy bend list carries a copy marker; it must stay silent")
	}
}
