package printpdf

import (
	"bytes"
	"fmt"
	"math"
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
	// The third source of nondeterminism, and the one that is ours rather
	// than gofpdf's: the tile footer stamps the current UTC date. Left
	// live, TestRenderFromDocGoldenBytes passes only on the calendar day
	// its digest was recorded and goes red at midnight UTC on every branch
	// simultaneously. Pinned to the same fixed date as the PDF metadata.
	footerDate = func() string { return fixed.Format("2006-01-02") }
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
//
// Tier 3 #122 reviewed the byte comparisons here and left them. They are not
// standing in for a geometric assertion: "these two option settings produce
// the same artifact" is exactly a byte-equality question, and the ±10%
// size-divergence check is watching for structural divergence (extra pages,
// dropped labels) rather than for shape. The shape question — where the mirror
// puts a coordinate — is answered directly by TestMakePageProjectorMirrored
// and TestMirrorRotateOrderIsMirrorThenRotate, because mirroring lives in the
// projector and not in the drawing plan (runpath.go emits world mm).
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
	const contentW, contentH = 195.9, 259.4
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
			if got := resolveRotate(c.mode, c.designW, c.designH, contentW, contentH, stepW, stepH); got != c.want {
				uc, ur := tileGrid(c.designW, c.designH, contentW, contentH, stepW, stepH)
				rc, rr := tileGrid(c.designH, c.designW, contentW, contentH, stepW, stepH)
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

// --- Bug #12: multi-tile mirrored prints put the halves on the wrong
// sheets -----------------------------------------------------------------
//
// The shared fixture below is the one from the bug report: a 200 mm wide
// design tiled into two 100 mm columns, 10 mm margin. makePageProjector
// flips each tile inside its own page rectangle, which is the right
// image for that sheet — but the sheets used to be emitted in world
// order, so page 1 got the design's LEFT strip when a mirrored assembly
// needs its RIGHT strip there.
const (
	b12Margin   = 10.0
	b12ContentW = 100.0
	b12ContentH = 100.0
	b12StepW    = 100.0
	b12StepH    = 100.0
)

// b12BBox is a 200 x 100 design: 2 columns, 1 row.
var b12BBox = [4]float64{0, 0, 200, 100}

// TestTilePlanMirroredPutsRightEdgeOnFirstSheet is the bug report's probe
// turned into an assertion. The design's right edge (world x = 200) has to
// project onto the FIRST sheet, because mirroring the whole design puts
// its right edge on the left of the assembled pattern — and the first
// sheet is the one the operator tapes down first.
//
// The sheet is identified by the label it prints, not by its index, so
// this also pins that the footer's "Tile 1,1" and the geometry agree: a
// fix that reordered the geometry but kept labelling sheets in world
// order would still hand the operator a scrambled pattern.
func TestTilePlanMirroredPutsRightEdgeOnFirstSheet(t *testing.T) {
	plan := tilePlan(b12BBox, 2, 1, b12StepW, b12StepH, true, false)
	if len(plan) != 2 {
		t.Fatalf("plan has %d sheets, want 2", len(plan))
	}

	first := plan[0]
	if first.Col != 0 || first.Row != 0 {
		t.Errorf("first sheet is labelled Tile %d,%d — the first sheet off the printer must be the assembly's top-left", first.Col+1, first.Row+1)
	}

	// Project the design's right edge with the first sheet's projector.
	cx, cy := 100.0, 50.0
	toPage := makeTileProjector(cx, cy, first.OriginX, first.OriginY,
		b12Margin, b12ContentW, b12ContentH, true, false)
	gotX, _ := toPage(b12BBox[2], 0)
	const wantX = b12Margin // flush against the content area's left edge
	if gotX != wantX {
		t.Errorf("design right edge (world x=%g) projects to page x=%g on sheet 1, want %g.\n"+
			"Sheet 1 carries world tile [%g, %g]. Getting the right edge off-sheet means the "+
			"sheets are still emitted in world order: page 1 has the design's LEFT strip, so "+
			"taping the sheets left-to-right reconstructs the design with its halves swapped.",
			b12BBox[2], gotX, wantX, first.OriginX, first.OriginX+b12ContentW)
	}
}

// TestTilePlanMirroredAssemblyIsMonotonic is the assembly test: lay the
// sheets out left to right in the order they print, and a walk across the
// taped-up pattern must sweep the design's world X monotonically
// DOWNWARD (that is what a mirror is). Any sheet in the wrong place shows
// up as a break in the monotonicity.
func TestTilePlanMirroredAssemblyIsMonotonic(t *testing.T) {
	plan := tilePlan(b12BBox, 2, 1, b12StepW, b12StepH, true, false)
	cx, cy := 100.0, 50.0

	// assemblyX is the sheet's page-x offset by the sheets already taped
	// down to its left: the coordinate of the point on the assembled
	// pattern.
	assemblyX := func(sheet int, pageX float64) float64 {
		return float64(sheet)*b12ContentW + (pageX - b12Margin)
	}

	// World points from the design's right edge leftward. Each one is
	// looked up on whichever sheet actually carries it.
	worldXs := []float64{200, 175, 150, 125, 100, 75, 50, 25, 0}
	prev := -1.0
	for _, wx := range worldXs {
		found := false
		for i, tile := range plan {
			if wx < tile.OriginX || wx > tile.OriginX+b12ContentW {
				continue
			}
			toPage := makeTileProjector(cx, cy, tile.OriginX, tile.OriginY,
				b12Margin, b12ContentW, b12ContentH, true, false)
			px, _ := toPage(wx, 0)
			ax := assemblyX(i, px)
			if ax < prev {
				t.Errorf("world x=%g lands at assembly x=%g on sheet %d, behind the previous point at %g — "+
					"the assembled pattern doubles back, so the halves are on the wrong sheets",
					wx, ax, i+1, prev)
			}
			prev = ax
			found = true
			break
		}
		if !found {
			t.Errorf("world x=%g is not carried by any sheet in the plan", wx)
		}
	}
}

// TestTilePlanPreservesTileStep pins that reordering the sheets did not
// disturb the tile pitch. Adjacent sheets must still be exactly one step
// apart in world space, or the OverlapMM taping allowance silently
// disappears and the sheets no longer join.
func TestTilePlanPreservesTileStep(t *testing.T) {
	const overlapStep = 90.0 // contentW 100 with 10 mm overlap
	for _, mirrored := range []bool{false, true} {
		plan := tilePlan(b12BBox, 3, 1, overlapStep, b12StepH, mirrored, false)
		for i := 1; i < len(plan); i++ {
			gap := plan[i].OriginX - plan[i-1].OriginX
			if gap != overlapStep && gap != -overlapStep {
				t.Errorf("mirrored=%v: sheets %d and %d are %g mm apart in world space, want ±%g",
					mirrored, i, i+1, gap, overlapStep)
			}
		}
	}
}

// TestTilePlanSingleTileMirroredUnchanged pins the case that already
// worked: a design that fits one sheet has nothing to reorder, and the
// fix must not perturb it. This is the overwhelming majority of real
// jobs.
func TestTilePlanSingleTileMirroredUnchanged(t *testing.T) {
	for _, rotated := range []bool{false, true} {
		plan := tilePlan(b12BBox, 1, 1, b12StepW, b12StepH, true, rotated)
		if len(plan) != 1 {
			t.Fatalf("rotated=%v: %d sheets, want 1", rotated, len(plan))
		}
		want := tilePlacement{Col: 0, Row: 0, OriginX: b12BBox[0], OriginY: b12BBox[1]}
		if plan[0] != want {
			t.Errorf("rotated=%v: single-tile mirrored plan = %+v, want %+v", rotated, plan[0], want)
		}
	}
}

// TestTilePlanUnmirroredIsWorldOrder is the byte-identity guard for the
// un-mirrored path. Un-mirrored output is a plain row-major walk of the
// world tiles and must stay exactly that — the reordering is allowed to
// exist only when Mirror is on.
func TestTilePlanUnmirroredIsWorldOrder(t *testing.T) {
	const cols, rows = 3, 2
	for _, rotated := range []bool{false, true} {
		plan := tilePlan(b12BBox, cols, rows, b12StepW, b12StepH, false, rotated)
		if len(plan) != cols*rows {
			t.Fatalf("rotated=%v: %d sheets, want %d", rotated, len(plan), cols*rows)
		}
		i := 0
		for r := 0; r < rows; r++ {
			for c := 0; c < cols; c++ {
				want := tilePlacement{
					Col: c, Row: r,
					OriginX: b12BBox[0] + float64(c)*b12StepW,
					OriginY: b12BBox[1] + float64(r)*b12StepH,
				}
				if plan[i] != want {
					t.Errorf("rotated=%v: un-mirrored sheet %d = %+v, want %+v (this changes existing PDFs byte-for-byte)",
						rotated, i, plan[i], want)
				}
				i++
			}
		}
	}
}

// TestTilePlanMirroredRotatedReversesRows is the rotated half of the fix.
// makeTileProjector composes mirror-then-rotate as R·Mh = Mv·R, so a
// rotated render is reflected VERTICALLY in page space — which means it is
// the ROW order that has to reverse, not the column order. Reversing
// columns here would be a no-op on the wrong axis and leave the bug in
// place for every rotated multi-tile job.
//
// Fixture: a 200 x 100 design rotated 90° becomes 100 wide x 200 tall with
// bbox [50, -50, 150, 150] — 1 column, 2 rows at a 100 mm step.
//
// Hand-computed landmark: the design's bottom-right corner, world
// (200, 100). Rotation about (100, 50) sends it to rotated (50, 150).
// The first sheet must carry it at the top-left of the content area:
// page x = 50 - 50 + 10 = 10, page y = (10 + 100 + 50) - 150 = 10.
func TestTilePlanMirroredRotatedReversesRows(t *testing.T) {
	cx, cy := 100.0, 50.0
	rb := rotatedBBox(b12BBox)
	if rb != ([4]float64{50, -50, 150, 150}) {
		t.Fatalf("fixture drifted: rotatedBBox = %v", rb)
	}

	plan := tilePlan(rb, 1, 2, b12StepW, b12StepH, true, true)
	if len(plan) != 2 {
		t.Fatalf("plan has %d sheets, want 2", len(plan))
	}
	first := plan[0]
	if first.Col != 0 || first.Row != 0 {
		t.Errorf("first rotated sheet is labelled Tile %d,%d, want Tile 1,1", first.Col+1, first.Row+1)
	}

	toPage := makeTileProjector(cx, cy, first.OriginX, first.OriginY,
		b12Margin, b12ContentW, b12ContentH, true, true)
	gotX, gotY := toPage(200, 100)
	const wantX, wantY = 10.0, 10.0
	if gotX != wantX || gotY != wantY {
		t.Errorf("mirrored+rotated: design corner (200,100) projects to (%g,%g) on sheet 1, want (%g,%g).\n"+
			"Sheet 1 carries rotated-world row starting at y=%g. A y far outside the content area means the "+
			"ROW order was not reversed — the rotated mirror lands on the Y axis, so reversing columns "+
			"fixes nothing here.",
			gotX, gotY, wantX, wantY, first.OriginY)
	}

	// The second sheet carries the opposite corner, world (0, 0) →
	// rotated (150, -50), at the bottom-right of its content area.
	second := makeTileProjector(cx, cy, plan[1].OriginX, plan[1].OriginY,
		b12Margin, b12ContentW, b12ContentH, true, true)
	if x, y := second(0, 0); x != 110 || y != 110 {
		t.Errorf("mirrored+rotated: design corner (0,0) projects to (%g,%g) on sheet 2, want (110,110)", x, y)
	}
}

// ---------------------------------------------------------------------
// Tier 3 #109 — the tile grid must be trimmed to the design extent.
// ---------------------------------------------------------------------

// legacyTileCount is the pre-#109 formula, kept in the test file as the
// baseline the assertions below measure against. Every "we saved a
// sheet" claim in this section is a comparison against THIS function
// rather than a hard-coded page total, so the tests still say something
// if the paper defaults ever move.
func legacyTileCount(design, step float64) int {
	n := int(math.Ceil(design / step))
	if n < 1 {
		n = 1
	}
	return n
}

// assertCovers is the non-negotiable half of #109. The first sheet
// carries `content` mm and every sheet after it adds `step`, so
// (n-1)*step + content is the total covered extent and it must reach
// the design. Trimming a sheet the design actually needs is far worse
// than printing a blank one: it silently truncates the pattern, and a
// truncated 1:1 pattern does not look wrong until it is taped up on
// the bench.
func assertCovers(t *testing.T, n int, design, content, step float64) {
	t.Helper()
	covered := float64(n-1)*step + content
	if covered < design {
		t.Errorf("COVERAGE REGRESSION: %d sheets cover %g mm of a %g mm design "+
			"(content %g, step %g) — the pattern would print truncated",
			n, covered, design, content, step)
	}
}

// TestTileGridTrimsToDesignExtent is the probe table from the #109 spec,
// measured at the A4 default (content 190 mm, overlap 10 mm, step 180
// mm). Each row asserts the new count, the coverage invariant, and that
// the new count never EXCEEDS the legacy one — a "fix" that added paper
// would be its own bug.
func TestTileGridTrimsToDesignExtent(t *testing.T) {
	const contentW, contentH = 190.0, 190.0
	const stepW, stepH = 180.0, 180.0

	cases := []struct {
		designW    float64
		want       int
		wantLegacy int
	}{
		// Remainders that land inside the overlap band: the last sheet
		// carries a full content width, so the legacy divisor bought a
		// sheet with nothing on it.
		{190, 1, 2},
		{370, 2, 3},
		{550, 3, 4},
		{730, 4, 5},
		// Just past the band — both formulas agree, no sheet to save.
		{191, 2, 2},
		{400, 3, 3},
	}
	for _, c := range cases {
		t.Run(fmt.Sprintf("designW=%g", c.designW), func(t *testing.T) {
			cols, rows := tileGrid(c.designW, 100, contentW, contentH, stepW, stepH)
			if cols != c.want {
				t.Errorf("tileGrid cols = %d, want %d", cols, c.want)
			}
			if rows != 1 {
				t.Errorf("tileGrid rows = %d, want 1 (a 100 mm design fits one 190 mm sheet)", rows)
			}
			assertCovers(t, cols, c.designW, contentW, stepW)

			if got := legacyTileCount(c.designW, stepW); got != c.wantLegacy {
				t.Errorf("legacy formula gave %d columns, but this table was built assuming %d — "+
					"the table no longer describes the bug it was written for", got, c.wantLegacy)
			}
			if cols > c.wantLegacy {
				t.Errorf("tileGrid asks for MORE paper than the legacy formula (%d > %d)", cols, c.wantLegacy)
			}
		})
	}
}

// TestTileGridExactContentSizeIsOneSheet is the headline case: a design
// exactly one sheet in both directions used to bill FOUR sheets, three
// of which carried nothing.
func TestTileGridExactContentSizeIsOneSheet(t *testing.T) {
	const content, step = 190.0, 180.0

	cols, rows := tileGrid(content, content, content, content, step, step)
	if cols != 1 || rows != 1 {
		t.Errorf("a design exactly the content size tiled %d×%d, want 1×1", cols, rows)
	}
	assertCovers(t, cols, content, content, step)
	assertCovers(t, rows, content, content, step)

	// Negative control: the formula this replaced really did charge
	// four sheets here, so the 1×1 above is a fix and not a tautology.
	legacy := legacyTileCount(content, step) * legacyTileCount(content, step)
	if legacy != 4 {
		t.Errorf("legacy formula billed %d sheets for the exact-fit case, expected 4 — "+
			"this test no longer pins the bug it was written for", legacy)
	}
}

// TestTileGridZeroOverlapMatchesLegacy pins that #109 is a trim and not
// a different tiling. With no overlap the step IS the content width,
// there is no band for a remainder to hide in, and the new formula must
// reduce to exactly the old one across a wide sweep.
func TestTileGridZeroOverlapMatchesLegacy(t *testing.T) {
	const content = 190.0
	for d := 0.5; d < 2000; d += 0.5 {
		cols, _ := tileGrid(d, d, content, content, content, content)
		if want := legacyTileCount(d, content); cols != want {
			t.Fatalf("overlap=0, designW=%g: tileGrid gave %d columns, legacy gave %d — "+
				"with no overlap the two formulas must coincide", d, cols, want)
		}
	}
}

// TestTileGridCoverageNeverRegresses sweeps arbitrary design widths at
// several paper/overlap combinations and asserts the invariant on every
// one, plus "never more paper than before". A table of hand-picked
// widths can miss the boundary the formula actually gets wrong; the
// sweep cannot.
func TestTileGridCoverageNeverRegresses(t *testing.T) {
	papers := []struct {
		name              string
		contentW, overlap float64
	}{
		{"A4 portrait, 10 mm overlap", 190, 10},
		{"Letter portrait, 10 mm overlap", 195.9, 10},
		{"Letter portrait, 25 mm overlap", 195.9, 25},
		{"A2 portrait, 0 mm overlap", 400, 0},
	}
	for _, p := range papers {
		t.Run(p.name, func(t *testing.T) {
			step := p.contentW - p.overlap
			for d := 0.25; d < 2500; d += 0.25 {
				cols, _ := tileGrid(d, 1, p.contentW, p.contentW, step, step)
				assertCovers(t, cols, d, p.contentW, step)
				if legacy := legacyTileCount(d, step); cols > legacy {
					t.Fatalf("designW=%g: %d columns, more than the legacy %d", d, cols, legacy)
				}
				if cols < 1 {
					t.Fatalf("designW=%g: %d columns — the floor is gone", d, cols)
				}
			}
			// A degenerate (zero / negative) design still gets a sheet:
			// the renderers reject those earlier, but tileGrid must not
			// be the thing that returns a zero-page PDF.
			for _, d := range []float64{0, -5} {
				if cols, rows := tileGrid(d, d, p.contentW, p.contentW, step, step); cols != 1 || rows != 1 {
					t.Errorf("tileGrid(%g, %g) = %d×%d, want 1×1", d, d, cols, rows)
				}
			}
		})
	}
}

// TestResolveRotateFitUsesTrimmedGridOnBothBranches guards the
// like-with-like rule at the two rotate=fit call sites. Both branches
// have to count the same way; updating one and not the other makes
// "fit" compare a trimmed grid against an untrimmed one and choose the
// orientation that costs MORE sheets.
//
// The two rows below disagree in opposite directions, which is what
// makes them catch a half-applied fix: mixing the formulas gives the
// wrong answer on one row or the other, whichever branch was left
// behind.
//
// Numbers are A4 portrait, 10 mm margin, 10 mm overlap: content
// 190 × 277, step 180 × 267.
func TestResolveRotateFitUsesTrimmedGridOnBothBranches(t *testing.T) {
	const contentW, contentH = 190.0, 277.0
	const stepW, stepH = 180.0, 267.0

	cases := []struct {
		name             string
		designW, designH float64
		want             bool
		wantLegacy       bool
	}{
		// 250 × 185: trimmed, upright is 2×1 = 2 sheets and rotated is
		// 1×1 = 1, so fit rotates. The legacy formula billed the
		// rotated layout at 2×1 as well, called it a tie, and printed
		// a sheet it did not need.
		{"fit rotates once the rotated grid is trimmed", 250, 185, true, false},
		// 190 × 280: trimmed, both orientations cost 2 sheets, so the
		// tie rule keeps it upright. The legacy formula billed upright
		// at 2×2 = 4 and rotated at 2×1 = 2, and turned the pattern to
		// "save" two sheets that were never needed.
		{"fit declines to rotate a tie the legacy grid mis-billed", 190, 280, false, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := resolveRotate(RotateFit, c.designW, c.designH, contentW, contentH, stepW, stepH)
			if got != c.want {
				uc, ur := tileGrid(c.designW, c.designH, contentW, contentH, stepW, stepH)
				rc, rr := tileGrid(c.designH, c.designW, contentW, contentH, stepW, stepH)
				t.Errorf("resolveRotate(fit, %g × %g) = %v, want %v (upright %d×%d=%d, rotated %d×%d=%d)",
					c.designW, c.designH, got, c.want, uc, ur, uc*ur, rc, rr, rc*rr)
			}

			// Negative control: the legacy formula chose the OTHER
			// orientation on this design, so the row above is a real
			// assertion about the new counting rule.
			legacy := legacyTileCount(c.designH, stepW)*legacyTileCount(c.designW, stepH) <
				legacyTileCount(c.designW, stepW)*legacyTileCount(c.designH, stepH)
			if legacy != c.wantLegacy {
				t.Errorf("legacy formula chose rotated=%v, but this case exists because it chose %v — "+
					"the case no longer distinguishes the two formulas", legacy, c.wantLegacy)
			}
			if legacy == got {
				t.Error("old and new formulas agree on this design, so it cannot catch a half-applied fix")
			}

			// Whichever orientation was picked must still cover the
			// design. Rotation swaps the design's axes, never the
			// paper's.
			dw, dh := c.designW, c.designH
			if got {
				dw, dh = dh, dw
			}
			cols, rows := tileGrid(dw, dh, contentW, contentH, stepW, stepH)
			assertCovers(t, cols, dw, contentW, stepW)
			assertCovers(t, rows, dh, contentH, stepH)
		})
	}
}

// exactPageSizeDoc is exactly one A4-portrait content area — 190 × 277
// mm at the default 10 mm margin — so it is the worst case for the
// pre-#109 grid: a one-sheet job billed as four. One 90° corner gives
// it a bend-list page, which the page-count arithmetic below derives
// rather than assumes.
func exactPageSizeDoc() *designdoc.Doc {
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 190, 277},
		Runs: []designdoc.Run{{
			ID: "run-exact",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{5, 5}, {185, 5}, {185, 272}},
			},
			Electrodes:     []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
			TubeDiameterMM: 10,
		}},
	}
}

// TestRenderFromDocExactPageSizeDropsBlankTiles proves #109 through a
// real render rather than the helper alone. A design exactly one A4
// content area used to spool four tile pages; three of them were blank.
//
// The doc's non-tile pages (the bend list) are MEASURED, not assumed:
// the same doc is rendered on A2, where one sheet is enough under
// either formula, and the fixed page count falls out of that. So this
// test keeps its meaning if the bend-list layout ever changes.
func TestRenderFromDocExactPageSizeDropsBlankTiles(t *testing.T) {
	doc := exactPageSizeDoc()
	opts := DefaultOptions()
	opts.ProjectName = "TrimTileGrid"

	render := func(p Paper) int {
		o := opts
		o.Paper = p
		out, err := RenderFromDoc(doc, o, 10)
		if err != nil {
			t.Fatalf("RenderFromDoc(%s): %v", p.Name, err)
		}
		return pdfPageCount(out)
	}

	// A2 content is 400 × 574 mm — one sheet under either formula, so
	// this render isolates the doc's fixed (non-tile) pages.
	fixed := render(PaperA2) - 1
	if fixed < 1 {
		t.Fatalf("control render gave %d fixed pages; expected at least the bend-list page", fixed)
	}

	got := render(PaperA4)

	// The pre-#109 counts for this exact design/paper pairing: content
	// 190 × 277, step 180 × 267.
	legacyTiles := legacyTileCount(190, 180) * legacyTileCount(277, 267)
	before := fixed + legacyTiles
	after := fixed + 1
	t.Logf("fixed pages=%d; tiles before=%d after=1; total before=%d after=%d",
		fixed, legacyTiles, before, after)

	if legacyTiles != 4 {
		t.Errorf("legacy grid billed %d tiles for the exact-fit design, expected 4 — "+
			"this test no longer exercises the headline case", legacyTiles)
	}
	if got != after {
		t.Errorf("RenderFromDoc on a design exactly one A4 content area emitted %d pages, want %d "+
			"(1 tile + %d fixed)", got, after, fixed)
	}
	if got >= before {
		t.Errorf("page count did not drop: %d pages now, %d before the fix", got, before)
	}
}

// TestRenderFromDocTrimmedGridStillCoversTheDesign is the render-level
// half of the coverage invariant. Trimming must never drop a sheet the
// pattern needs, so for a design just past the exact-fit boundary the
// tile count has to go back up.
func TestRenderFromDocTrimmedGridStillCoversTheDesign(t *testing.T) {
	opts := DefaultOptions()
	opts.Paper = PaperA4
	opts.ProjectName = "TrimCoverage"

	pages := func(doc *designdoc.Doc) int {
		out, err := RenderFromDoc(doc, opts, 10)
		if err != nil {
			t.Fatalf("RenderFromDoc: %v", err)
		}
		return pdfPageCount(out)
	}

	exact := pages(exactPageSizeDoc())

	// One millimetre wider than a sheet needs a second column, and the
	// renderer has to actually emit it.
	over := exactPageSizeDoc()
	over.ViewBoxMM = [4]float64{0, 0, 191, 277}
	if got := pages(over); got != exact+1 {
		t.Errorf("a 191 × 277 mm design emitted %d pages but the 190 × 277 one emitted %d — "+
			"the extra millimetre must buy a second column, or the pattern prints truncated",
			got, exact)
	}

	// Likewise on the other axis.
	tall := exactPageSizeDoc()
	tall.ViewBoxMM = [4]float64{0, 0, 190, 278}
	if got := pages(tall); got != exact+1 {
		t.Errorf("a 190 × 278 mm design emitted %d pages but the 190 × 277 one emitted %d — "+
			"the extra millimetre must buy a second row", got, exact)
	}
}

// Bug #18's regression test used to live here. It rendered two PDFs, inflated
// their Flate-compressed content streams with a parser defined in this file,
// and counted cubic-Bezier operators — because nothing in this package could
// say what the renderer had drawn. Tier 3 #122 replaced that with a seam
// (runpath.go): the test is now TestPlanRunDrawingDrawsClosingSegmentArc in
// runpath_test.go, and it asserts that the drawn glass passes through the
// closing arc's apex rather than counting operators in a byte stream. The
// in-test PDF parser is gone with it.
