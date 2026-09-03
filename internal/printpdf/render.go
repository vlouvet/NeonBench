package printpdf

import (
	"bytes"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/validate"
)

// ErrNoStripsToRender is returned by RenderFromDoc when StripsOnly is
// set on a doc that has no channel-letter face runs (Tier 3 #50). The
// handler translates this to HTTP 422 with a short user-facing message
// so the hidden print iframe shows something instead of silently
// spooling an empty job. Sentinel; errors.Is works directly.
var ErrNoStripsToRender = errors.New("no return strips in this design (StripsOnly requires at least one channel-letter face run)")

// Options bundle the user-facing knobs for a print job.
type Options struct {
	Paper              Paper
	Landscape          bool
	MarginMM           float64 // page margin (default 10mm)
	OverlapMM          float64 // bleed/overlap between tiles (default 10mm)
	StrokeMM           float64 // outline pen width (default 0.5mm)
	ProjectName        string
	DesignVersionLabel string
	TubeSpecName       string
	// TubeEndGapMM is the project's tube-end-gap setting (NW #135).
	// Zero means "not set; show nothing in the footer". V1 surfaces
	// this as informational text only — Tier 3 #27 will turn it into
	// a validation rule once a frame/substrate model exists.
	TubeEndGapMM float64
	// ChannelLetterDepthMM is the project's default depth for any
	// run flagged as a channel-letter face (NW #106). Drives the
	// height of the unfolded "return strip" page emitted per face
	// run. Zero falls back to 100 mm at emission time. Per-run
	// overrides on the design doc (Run.ChannelLetterDepthMM) win
	// over this value (Tier 3 #26).
	ChannelLetterDepthMM float64
	// StripOverlapMM is the project's strip-overlap allowance in
	// millimeters (Tier 3 #26). The renderer draws a dashed shear
	// line at the right end of each unfolded return strip; the
	// fabricator shears at this line so the doubled-back metal
	// forms the seam. Zero falls back to 12.7 mm (½ in) at
	// emission time.
	StripOverlapMM float64
	// StripsOnly, when true, suppresses the main pattern pages and
	// the bend-list summary page from RenderFromDoc, emitting ONLY
	// the per-run channel-letter return-strip pages and any
	// raceway-grouped strip pages (Tier 3 #50). Operators flip this
	// on after the front-face glass is bent and they only want to
	// print the metal-strip patterns. Has no effect on Render
	// (SVG-only path) — that path doesn't emit strip pages anyway.
	// When true and the design has zero face-flagged runs the
	// renderer returns ErrNoStripsToRender so the handler can return
	// a 422 with a clear "no return strips in this design" message
	// (a zero-page PDF is technically invalid; failing loud lets the
	// caller's iframe surface the error).
	StripsOnly bool
	// Mirror, when non-nil, controls whether the pattern's coordinate
	// space is horizontally flipped before rendering (Tier 2 #73). The
	// trade convention is that the bender works against the BACK of
	// the glass tube while looking at the printed pattern, so the
	// printed image must be mirrored relative to the front-facing
	// design ("the layout is reversed automatically when it comes in"
	// — NeonWizard operator quote).
	//
	// Pointer-bool semantics mirror the pattern from Tier 3 #33c so
	// the zero value ("unspecified") means "use the trade default of
	// MIRRORED." Nil → mirrored. &true → mirrored. &false → front-
	// facing (un-mirrored), used for marketing renders and front-side
	// review. MirrorOn() centralizes the resolution so call sites
	// don't have to repeat the nil-check.
	//
	// Scope: mirroring applies to the main tile pages and the bend-
	// list summary page (the front-face pattern surfaces the bender
	// reads against the back of the glass). Channel-letter return-
	// strip pages and nested-return-strip pages are unfolded perimeter
	// patterns rendered in their own 1D coordinate space — mirroring
	// them would invert arc-length direction without operator
	// benefit — and the raceway page is a plan view of a box, which
	// has no front or back side to read through. All three render the
	// same regardless of the flag.
	Mirror *bool
	// Rotate turns the pattern 90° clockwise about its bounding-box
	// centre before the paper-tiling math runs (Tier 2 #93). Values:
	//
	//	""     — no rotation. The default, and the absent-safe value:
	//	         a request that never mentions rotation renders exactly
	//	         the PDF NeonBench shipped before this option existed.
	//	"90"   — always rotate.
	//	"fit"  — rotate only when doing so needs FEWER tiles. A tie
	//	         keeps the un-rotated orientation, so "fit" is stable:
	//	         an operator who sees no change is not looking at a
	//	         coin flip, they are looking at "rotating wouldn't
	//	         have saved a sheet".
	//
	// Use the Rotate* constants rather than bare strings, and
	// ValidRotate to police user input at the HTTP boundary.
	//
	// Scope, and the order relative to Mirror, are documented on
	// makeTileProjector — the single place both transforms compose.
	Rotate string
	// Copies is the number of times the whole page set is repeated in
	// one PDF (query `copies=N`, Tier 2 #93 step-and-repeat). Zero and
	// one both mean "one copy", so the zero value is absent-safe.
	// The handler clamps the accepted range to 1..MaxCopies and
	// rejects anything else with a 400; the renderer only guards the
	// low end so a programmatic caller can't ask for zero pages.
	//
	// Copies multiply PAGES, not geometry: a 1:1 production pattern
	// stays 1:1 and two letters never share a sheet (they could not
	// both be cut out). Every page of copy k is stamped "Copy k of N"
	// so a stack of paper on the bench is never ambiguous.
	Copies int
}

// Accepted values for Options.Rotate. RotateNone is the zero value so
// an Options built without touching Rotate is un-rotated.
const (
	RotateNone    = ""
	RotateFixed90 = "90"
	RotateFit     = "fit"
)

// MaxCopies caps the step-and-repeat count. Fifty sheets of a tiled
// pattern is already an unusual bench job; past that the request is
// almost certainly a typo or a scraper, and the PDF would be large
// enough to be a denial-of-service lever on a single-binary shop tool.
const MaxCopies = 50

// ValidRotate reports whether s is an accepted Options.Rotate value.
// The empty string is valid (it means "no rotation"), which is what
// makes an absent `rotate` query parameter a no-op instead of an error.
// footerDate returns the date stamped into every tile footer.
//
// It is a variable so tests can pin it. TestRenderFromDocGoldenBytes hashes
// the entire PDF, and a live clock made that digest valid only on the UTC day
// it was recorded: the suite went red at midnight UTC and stayed red, on every
// branch at once, with nothing in the diff to explain it. That is the third
// source of PDF nondeterminism -- render_test.go's init() already pins gofpdf's
// creation/modification dates and catalog map order; this one was missed
// because it is our own output rather than the library's.
//
// The printed sheet still carries the real date. Only the test pins it.
var footerDate = func() string { return time.Now().UTC().Format("2006-01-02") }

func ValidRotate(s string) bool {
	switch s {
	case RotateNone, RotateFixed90, RotateFit:
		return true
	}
	return false
}

// CopiesOrOne resolves Options.Copies to a usable page-set count. Both
// zero (field never set) and any negative value mean one copy.
func (o Options) CopiesOrOne() int {
	if o.Copies < 1 {
		return 1
	}
	return o.Copies
}

// tileCount returns the number of sheets needed to cover a design
// extent of `design` mm along one axis, where each sheet carries
// `content` mm of pattern and consecutive sheets advance by `step`
// (= content - overlap).
//
// Tier 3 #109. The obvious ceil(design/step) over-counts, because the
// LAST sheet does not advance by a step — it carries a full content
// width. Dividing the whole design by the step therefore charges the
// overlap band to the final sheet as well, and any remainder landing
// inside that band buys a sheet with nothing on it. At the A4 default
// (content 190, overlap 10, step 180) a design exactly 190 mm wide
// billed two columns, so a design exactly one page in both directions
// printed on FOUR sheets.
//
// So: the first sheet covers `content`, and every sheet after it adds
// `step`. Where the overlap is zero the two formulas coincide, which is
// the sanity check that this is a trim and not a different tiling.
//
// Coverage is the non-negotiable half: (n-1)*step + content >= design
// must hold for every input, because dropping a needed sheet silently
// truncates the pattern, and a truncated full-size pattern does not
// look wrong until it is taped up on the bench.
func tileCount(design, content, step float64) int {
	n := 1
	if design > content {
		n += int(math.Ceil((design - content) / step))
	}
	if n < 1 {
		n = 1
	}
	return n
}

// tileGrid returns the column/row counts needed to cover a designW ×
// designH pattern on contentW × contentH sheets at the given per-tile
// step. Extracted from the two renderers so rotate=fit can ask "how
// many tiles the other way round?" without duplicating the ceiling
// math (and drifting from it).
//
// The content size is a separate argument from the step because the
// two differ by the overlap and the last sheet in each direction is
// billed at the content size — see tileCount.
func tileGrid(designW, designH, contentW, contentH, stepW, stepH float64) (cols, rows int) {
	return tileCount(designW, contentW, stepW), tileCount(designH, contentH, stepH)
}

// tilePlacement is one printed sheet of the main pattern.
type tilePlacement struct {
	// Col, Row are the sheet's position in the ASSEMBLY grid — the
	// order the sheets get taped together in, and what the footer's
	// "Tile c,r of C×R" prints. For an un-mirrored render this is also
	// the world-space column/row of the strip below; for a mirrored one
	// it deliberately is not.
	Col, Row int
	// OriginX, OriginY are the world-space (post-rotation) coordinates
	// of the top-left corner of the strip this sheet carries.
	OriginX, OriginY float64
}

// tilePlan returns the main pattern's sheets in PAGE ORDER, pairing each
// sheet's assembly-grid position with the strip of world space it must
// carry.
//
// For an un-mirrored render the two are the same thing and this is the
// plain row-major walk the renderers have always done.
//
// For a MIRRORED render they are not, and that is Bug #12. makePageProjector
// flips each tile within its own page rectangle, which is the correct
// per-sheet image — but the sheets were still emitted in world order, so
// page 1 carried the design's LEFT strip when a mirrored assembly needs
// its RIGHT strip there. Every sheet was individually right and the
// taped-up result was scrambled.
//
// The fix is to walk the mirrored axis backwards. Reversing the emission
// order is exact rather than approximate: mirroring the whole tiled
// region about its own centre maps the tile at index i onto index
// n-1-i and leaves the per-tile projection algebraically unchanged
// (page_x = margin + tileX + contentW - x either way), so the existing
// projector keeps working untouched and the tile step — and with it the
// OverlapMM taping allowance — is preserved exactly. Anchoring the flip
// to the design bbox instead (the other candidate fix) would have had to
// recompute every tile origin and the clipping rectangle with it.
//
// WHICH axis reverses depends on rotation, because rotation moves the
// mirror: makeTileProjector composes mirror-then-rotate as R·Mh = Mv·R,
// so a rotated render is reflected VERTICALLY in page space and it is the
// ROW order that must reverse, not the column order.
func tilePlan(bbox [4]float64, cols, rows int, stepW, stepH float64, mirrored, rotated bool) []tilePlacement {
	plan := make([]tilePlacement, 0, cols*rows)
	for r := 0; r < rows; r++ {
		for c := 0; c < cols; c++ {
			worldCol, worldRow := c, r
			if mirrored {
				if rotated {
					worldRow = rows - 1 - r
				} else {
					worldCol = cols - 1 - c
				}
			}
			plan = append(plan, tilePlacement{
				Col:     c,
				Row:     r,
				OriginX: bbox[0] + float64(worldCol)*stepW,
				OriginY: bbox[1] + float64(worldRow)*stepH,
			})
		}
	}
	return plan
}

// resolveRotate turns an Options.Rotate mode into the concrete
// "is this render rotated?" boolean for one design/paper pairing.
//
// The tie rule is load-bearing: rotated < unrotated, strictly. A square
// design, or any design where both orientations need the same number of
// sheets, stays un-rotated — so "fit" never silently reorients a
// pattern for zero paper saved, and repeat prints of the same design
// come off the bench the same way round every time.
//
// Only the DESIGN turns: the paper does not, so contentW/contentH and
// stepW/stepH are passed to both branches unswapped. Both branches must
// also use the same counting rule (Tier 3 #109) or the comparison stops
// comparing like with like and "fit" starts choosing an orientation
// that costs more sheets than the one it rejected.
func resolveRotate(mode string, designW, designH, contentW, contentH, stepW, stepH float64) bool {
	switch mode {
	case RotateFixed90:
		return true
	case RotateFit:
		uc, ur := tileGrid(designW, designH, contentW, contentH, stepW, stepH)
		rc, rr := tileGrid(designH, designW, contentW, contentH, stepW, stepH)
		return rc*rr < uc*ur
	default:
		return false
	}
}

// rotatedBBox returns bbox after the same 90° rotation makeTileProjector
// applies: the centre is unchanged and width/height swap. Callers feed
// the result back into the tiling math so a rotated pattern is tiled in
// its rotated orientation rather than being rotated into the margins.
func rotatedBBox(bbox [4]float64) [4]float64 {
	cx := (bbox[0] + bbox[2]) / 2
	cy := (bbox[1] + bbox[3]) / 2
	halfW := (bbox[2] - bbox[0]) / 2
	halfH := (bbox[3] - bbox[1]) / 2
	return [4]float64{cx - halfH, cy - halfW, cx + halfH, cy + halfW}
}

// MirrorOn resolves the pointer-bool Mirror field to a plain bool with
// the trade-default substitution applied: nil → true (mirrored). Use
// this everywhere the renderer needs to branch on mirror state so the
// "nil means default" rule stays in one place.
func (o Options) MirrorOn() bool {
	if o.Mirror == nil {
		return true
	}
	return *o.Mirror
}

// DefaultOptions returns conservative paper-template defaults.
func DefaultOptions() Options {
	return Options{
		Paper:     PaperLetter,
		Landscape: false,
		MarginMM:  10,
		OverlapMM: 10,
		StrokeMM:  0.5,
	}
}

// Render produces a 1:1-scale print PDF of the SVG's geometry. If the
// design exceeds a single sheet, it is tiled across pages with overlap
// markers, registration crosses, a scale bar, and tile labels.
func Render(svg []byte, opts Options) ([]byte, error) {
	if opts.Paper.WidthMM == 0 {
		opts.Paper = PaperLetter
	}
	if opts.MarginMM <= 0 {
		opts.MarginMM = 10
	}
	if opts.OverlapMM < 0 {
		opts.OverlapMM = 0
	}
	if opts.StrokeMM <= 0 {
		opts.StrokeMM = 0.5
	}

	polylines, bbox, _, err := validate.ExtractMMPolylines(svg)
	if err != nil {
		return nil, fmt.Errorf("parse svg: %w", err)
	}

	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	contentW := pageW - 2*opts.MarginMM
	contentH := pageH - 2*opts.MarginMM
	if contentW <= 0 || contentH <= 0 {
		return nil, fmt.Errorf("margins exceed paper size")
	}

	designW := bbox[2] - bbox[0]
	designH := bbox[3] - bbox[1]
	if designW <= 0 || designH <= 0 {
		return nil, fmt.Errorf("design has zero area")
	}

	// Tiles overlap by OverlapMM, so the effective unique area per tile is
	// (contentW - overlap) × (contentH - overlap).
	stepW := contentW - opts.OverlapMM
	stepH := contentH - opts.OverlapMM
	if stepW <= 0 {
		stepW = contentW
	}
	if stepH <= 0 {
		stepH = contentH
	}
	// Tier 2 #93 — decide the orientation BEFORE the tile grid, then
	// tile the pattern in whichever orientation we settled on. The
	// rotation is about the design bbox centre, so the rotated bbox
	// keeps that centre and swaps width for height.
	rotated := resolveRotate(opts.Rotate, designW, designH, contentW, contentH, stepW, stepH)
	cx := (bbox[0] + bbox[2]) / 2
	cy := (bbox[1] + bbox[3]) / 2
	if rotated {
		bbox = rotatedBBox(bbox)
		designW, designH = designH, designW
	}
	cols, rows := tileGrid(designW, designH, contentW, contentH, stepW, stepH)

	orient := "P"
	if opts.Landscape {
		orient = "L"
	}
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: orient,
		UnitStr:        "mm",
		SizeStr:        "",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCreator("NeonBench", false)
	pdf.SetTitle(opts.ProjectName, false)

	mirrored := opts.MirrorOn()
	copies := opts.CopiesOrOne()
	// Copies repeat the whole page SET, not individual pages, so a
	// stack off the printer is "copy 1 complete, copy 2 complete, ..."
	// and can be split by hand without collating.
	for copyNo := 1; copyNo <= copies; copyNo++ {
		// Sheets come out of tilePlan in page order, each already paired
		// with the strip of world space a mirrored assembly needs on it
		// (Bug #12) and with its position in the assembly grid.
		for _, tile := range tilePlan(bbox, cols, rows, stepW, stepH, mirrored, rotated) {
			pdf.AddPage()

			// Save graphics state, clip to content area.
			pdf.ClipRect(opts.MarginMM, opts.MarginMM, contentW, contentH, false)
			pdf.SetDrawColor(0, 0, 0)
			pdf.SetLineWidth(opts.StrokeMM)

			// World (mm) -> page (mm) projection. When mirroring is on
			// (the trade default for back-side bending — Tier 2 #73)
			// we additionally flip X around the tile's right edge so
			// the printed pattern reads correctly through the back of
			// the glass. The flip is applied per-coordinate rather
			// than as a gofpdf TransformBegin/MirrorHorizontal pair
			// so the polyline geometry mirrors without inverting any
			// text glyphs we draw on top — the text labels remain
			// readable left-to-right at their (now-mirrored) anchor.
			// Tier 2 #93 folds the optional 90° rotation onto the
			// front of the same projector — see makeTileProjector for
			// the mirror-then-rotate order and why it is fixed.
			toPage := makeTileProjector(cx, cy, tile.OriginX, tile.OriginY, opts.MarginMM, contentW, contentH, mirrored, rotated)

			for _, pl := range polylines {
				if len(pl.Points) < 2 {
					continue
				}
				start := pl.Points[0]
				sx, sy := toPage(start.X, start.Y)
				pdf.MoveTo(sx, sy)
				for i := 1; i < len(pl.Points); i++ {
					p := pl.Points[i]
					px, py := toPage(p.X, p.Y)
					pdf.LineTo(px, py)
				}
				if pl.Closed {
					pdf.LineTo(sx, sy)
				}
				pdf.DrawPath("D") // stroke only
			}

			pdf.ClipEnd()

			drawTileOverlay(pdf, opts, pageW, pageH, contentW, contentH, tile.Col, tile.Row, cols, rows, rotated, copyNo, copies)
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("write pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// RenderFromDoc renders a structured design doc as a 1:1 print pattern.
// In addition to the polylines that the SVG-based Render emits, this
// pipeline knows about runs, electrodes, blockouts, and bends — so the
// bender's pattern can show numbered bend apex markers, electrode
// positions, and a bend-list summary page at the back.
func RenderFromDoc(doc *designdoc.Doc, opts Options, projectDiameterMM float64) ([]byte, error) {
	if opts.Paper.WidthMM == 0 {
		opts.Paper = PaperLetter
	}
	if opts.MarginMM <= 0 {
		opts.MarginMM = 10
	}
	if opts.OverlapMM < 0 {
		opts.OverlapMM = 0
	}
	if opts.StrokeMM <= 0 {
		opts.StrokeMM = 0.5
	}

	// StripsOnly fail-fast: refuse to emit a zero-page PDF. Walk runs
	// once before any geometry / paper math; if no run is a channel-
	// letter face, return the typed sentinel so the handler maps to
	// HTTP 422. We don't enforce the same check in the SVG-only Render
	// path: that path never emits strip pages, so calling it with
	// StripsOnly is meaningless either way; the handler steers
	// StripsOnly requests at the doc-bearing path.
	if opts.StripsOnly {
		anyFace := false
		for _, run := range doc.Runs {
			if run.IsChannelLetterFace && len(run.Polyline.Points) >= 2 {
				anyFace = true
				break
			}
		}
		if !anyFace {
			return nil, ErrNoStripsToRender
		}
	}

	bbox := docBBox(doc)
	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	contentW := pageW - 2*opts.MarginMM
	contentH := pageH - 2*opts.MarginMM
	if contentW <= 0 || contentH <= 0 {
		return nil, fmt.Errorf("margins exceed paper size")
	}
	designW := bbox[2] - bbox[0]
	designH := bbox[3] - bbox[1]
	if designW <= 0 || designH <= 0 {
		return nil, fmt.Errorf("design has zero area")
	}

	stepW := contentW - opts.OverlapMM
	stepH := contentH - opts.OverlapMM
	if stepW <= 0 {
		stepW = contentW
	}
	if stepH <= 0 {
		stepH = contentH
	}
	// Tier 2 #93 — settle the orientation BEFORE the tile grid so the
	// pattern is tiled in the orientation it will actually print in.
	// Rotation is about the bbox centre, which the rotated bbox keeps;
	// only width and height trade places.
	rotated := resolveRotate(opts.Rotate, designW, designH, contentW, contentH, stepW, stepH)
	cx := (bbox[0] + bbox[2]) / 2
	cy := (bbox[1] + bbox[3]) / 2
	if rotated {
		bbox = rotatedBBox(bbox)
		designW, designH = designH, designW
	}
	cols, rows := tileGrid(designW, designH, contentW, contentH, stepW, stepH)

	orient := "P"
	if opts.Landscape {
		orient = "L"
	}
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: orient,
		UnitStr:        "mm",
		SizeStr:        "",
		Size:           gofpdf.SizeType{Wd: opts.Paper.WidthMM, Ht: opts.Paper.HeightMM},
	})
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCreator("NeonBench", false)
	pdf.SetTitle(opts.ProjectName, false)

	// Pre-compute bends per run so the apex numbers we draw on the tiles
	// match the bend list page at the back. bendListRuns is the single
	// source of truth for which runs the summary enumerates, so the
	// pre-compute and the page cannot drift apart.
	bendsByRun := make(map[string][]designdoc.BendPoint, len(doc.Runs))
	for _, run := range bendListRuns(doc) {
		bendsByRun[run.ID] = designdoc.EffectiveBends(run, projectDiameterMM)
	}

	// StripsOnly skips the main tile pages entirely — the operator only
	// wants the metal-strip pages, post-fabrication. The strip pages
	// themselves are still emitted below by the unchanged emit calls.
	mirrored := opts.MirrorOn()
	copies := opts.CopiesOrOne()
	// Tier 2 #93 step-and-repeat. Copies repeat the whole page SET —
	// tiles, strip pages and the bend list — so a printed stack reads
	// "copy 1 complete, copy 2 complete, ..." and can be split by hand.
	// Geometry is untouched: a 1:1 production pattern stays 1:1 and two
	// letters never share a sheet, because they could not both be cut
	// out of it. copies == 1 emits exactly the pre-Tier-2-#93 page set.
	for copyNo := 1; copyNo <= copies; copyNo++ {
		if !opts.StripsOnly {
			// Sheets come out of tilePlan in page order, each already
			// paired with the strip of world space a mirrored assembly
			// needs on it (Bug #12) and with its assembly-grid position.
			for _, tile := range tilePlan(bbox, cols, rows, stepW, stepH, mirrored, rotated) {
				pdf.AddPage()
				// World (mm) -> page (mm) projection. When mirroring
				// is on (the trade default for back-side bending —
				// Tier 2 #73) we additionally flip X around the
				// tile's right edge so the printed pattern reads
				// correctly through the back of the glass. The flip
				// is applied per-coordinate rather than as a gofpdf
				// TransformBegin/MirrorHorizontal pair so the polyline
				// geometry mirrors without inverting any text glyphs
				// we draw on top — bend-number labels, dimension
				// notes, and free-text labels remain readable
				// left-to-right at their (now-mirrored) anchor
				// positions. See Options.Mirror for the trade-default
				// rationale and front-facing opt-out, and
				// makeTileProjector for the Tier 2 #93 rotation that
				// composes onto the front of it (mirror, then rotate).
				toPage := makeTileProjector(cx, cy, tile.OriginX, tile.OriginY, opts.MarginMM, contentW, contentH, mirrored, rotated)

				pdf.ClipRect(opts.MarginMM, opts.MarginMM, contentW, contentH, false)
				pdf.SetDrawColor(0, 0, 0)
				pdf.SetLineWidth(opts.StrokeMM)

				// Draw the tube geometry: alive segments solid,
				// blockouts dashed, jumpers dashed + labeled.
				// Tier 3 #60 (NW #125) — jumpers are short splice
				// tubes between two primary runs; rendering them
				// dashed (≤2 mm dash, 1 mm gap per spec) keeps them
				// visually distinct from primary runs on the print
				// pattern, and a centered "JUMPER" label at the
				// midpoint tells the bender what they are at a glance.
				//
				// Tier 3 #122 — WHAT to draw is decided by
				// planRunDrawing (runpath.go), a pure function over the
				// run; this loop only projects world mm into page mm
				// and hands the operators to gofpdf. That split is what
				// makes the drawn geometry assertable without a PDF:
				// the tests read the same plan value this executes.
				// Keep it that way — geometry decisions belong in
				// runpath.go, not here.
				for _, run := range doc.Runs {
					plan := planRunDrawing(run)
					for _, path := range plan.Paths {
						if path.Dashed {
							pdf.SetDashPattern([]float64{2, 1}, 0)
						}
						// Every pathOpKind needs a case here. There is
						// deliberately no default: a kind that falls
						// through would be drawn as whichever operator
						// the default happened to be, which is how you
						// ship a curve as a line. Add the kind to
						// runpath.go and to this switch together.
						for _, op := range path.Ops {
							switch op.Kind {
							case opMoveTo:
								x, y := toPage(op.X, op.Y)
								pdf.MoveTo(x, y)
							case opLineTo:
								x, y := toPage(op.X, op.Y)
								pdf.LineTo(x, y)
							case opCubicTo:
								c1x, c1y := toPage(op.C1X, op.C1Y)
								c2x, c2y := toPage(op.C2X, op.C2Y)
								ex, ey := toPage(op.X, op.Y)
								pdf.CurveBezierCubicTo(c1x, c1y, c2x, c2y, ex, ey)
							}
						}
						pdf.DrawPath("D")
						if path.Dashed {
							pdf.SetDashPattern([]float64{}, 0)
						}
					}
					if plan.Label != nil {
						// Midpoint label "JUMPER" — 6 pt Helvetica,
						// stroke-free, at the plan's world-mm anchor.
						mx, my := toPage(plan.Label.X, plan.Label.Y)
						pdf.SetFont("Helvetica", "", 6)
						lw := pdf.GetStringWidth(plan.Label.Text)
						// 1 mm vertical offset from the midpoint so
						// the label doesn't sit directly on the dashed
						// line — readable at 1:1.
						pdf.Text(mx-lw/2, my-1, plan.Label.Text)
					}
				}

				// Electrodes: small open circle with a centered cross.
				for _, run := range doc.Runs {
					for _, e := range run.Electrodes {
						if e.PointIndex < 0 || e.PointIndex >= len(run.Polyline.Points) {
							continue
						}
						p := run.Polyline.Points[e.PointIndex]
						ex, ey := toPage(p[0], p[1])
						drawElectrodeMark(pdf, ex, ey)
					}
				}

				// Numbered bend apex labels (and a small dot at the apex).
				pdf.SetFont("Helvetica", "B", 7)
				for _, run := range doc.Runs {
					for i, b := range bendsByRun[run.ID] {
						bx, by := toPage(b.X, b.Y)
						pdf.SetLineWidth(0.2)
						pdf.Circle(bx, by, 1.6, "D")
						pdf.SetLineWidth(opts.StrokeMM)
						label := fmt.Sprintf("%s.%d", shortRunID(run.ID), i+1)
						pdf.Text(bx+2, by-1, label)
					}
				}

				// Doc-level dimensions: line + perpendicular ticks + measured label.
				pdf.SetLineWidth(0.3)
				for _, d := range doc.Dimensions {
					ax, ay := toPage(d.X1, d.Y1)
					bx, by := toPage(d.X2, d.Y2)
					pdf.Line(ax, ay, bx, by)
					dx := bx - ax
					dy := by - ay
					length := math.Hypot(dx, dy)
					if length > 0 {
						px := -dy / length * 1.5
						py := dx / length * 1.5
						pdf.Line(ax-px, ay-py, ax+px, ay+py)
						pdf.Line(bx-px, by-py, bx+px, by+py)
					}
					measured := math.Hypot(d.X2-d.X1, d.Y2-d.Y1)
					note := fmt.Sprintf("%.1fmm", measured)
					if d.Note != "" {
						note += " · " + d.Note
					}
					pdf.SetFont("Helvetica", "", 8)
					pdf.Text((ax+bx)/2+1, (ay+by)/2-1, note)
				}
				pdf.SetLineWidth(opts.StrokeMM)

				// Doc-level text labels: small dot + text to the right.
				pdf.SetFont("Helvetica", "", 9)
				for _, l := range doc.Labels {
					lx, ly := toPage(l.X, l.Y)
					pdf.SetLineWidth(0.3)
					pdf.Circle(lx, ly, 0.7, "F")
					pdf.SetLineWidth(opts.StrokeMM)
					pdf.Text(lx+2, ly-1, l.Text)
				}

				pdf.ClipEnd()
				drawTileOverlay(pdf, opts, pageW, pageH, contentW, contentH, tile.Col, tile.Row, cols, rows, rotated, copyNo, copies)
			}
		} // end if !opts.StripsOnly — main pattern + tile overlays skipped when stripping.

		// Channel-letter return-strip pages (NW #106): one extra page per
		// face-marked run, sandwiched between the tile pages and the
		// bend-list summary so the operator can flip from face-pattern to
		// return-strip in printed order. Depth falls back to the shop
		// default when the project's column is NULL — the renderer always
		// has *some* value to draw with.
		//
		// Tier 3 #26 polish:
		//   - Per-run ChannelLetterDepthMM overrides the project default
		//     for that run (lets one project mix tall and shallow returns).
		//   - Runs sharing a non-empty RacewayID are emitted as ONE
		//     combined NESTED RETURN strip in declaration order (Strattman
		//     raceway construction); ungrouped face runs continue to get
		//     one strip page each. Nested pages render *after* the
		//     per-run pages so the operator's stack is "individual letters
		//     first, then any shared raceway".
		//
		// Tier 2 #104: the modelled raceway BOX gets its own page after
		// all of those — a plan view of the aluminium enclosure itself,
		// which is a different object from the return strips (see
		// emitNestedReturnStrip's doc comment for why the old name was
		// wrong).
		projectDepth := opts.ChannelLetterDepthMM
		if projectDepth <= 0 {
			projectDepth = 100
		}
		groups := groupByRaceway(doc.Runs)
		for _, run := range doc.Runs {
			if !run.IsChannelLetterFace {
				continue
			}
			if len(run.Polyline.Points) < 2 {
				continue
			}
			if run.RacewayID != "" {
				// Handled by the raceway emitter below.
				continue
			}
			emitReturnStrip(pdf, opts, run, runDepthMM(run, projectDepth))
			// Strip pages have their own footer and never go through
			// drawTileOverlay, so the step-and-repeat marker is stamped
			// on separately (no-op for a single copy).
			stampCopyMarker(pdf, opts, pageH, copyNo, copies)
		}
		for _, gid := range groups.OrderedIDs {
			runs := groups.ByID[gid]
			if len(runs) == 0 {
				continue
			}
			emitNestedReturnStrip(pdf, opts, gid, runs, projectDepth)
			stampCopyMarker(pdf, opts, pageH, copyNo, copies)
		}

		// Tier 2 #104 — one dimensioned plan view per modelled raceway
		// box. Gated on the design actually carrying a Raceway record:
		// a design that only has a raceway GUIDELINE has told us where
		// the tubes are cut, not what box they mount to, and inventing
		// one would put a fabrication drawing of an object nobody
		// specified into the operator's stack. Honours StripsOnly the
		// same way the strip pages do (it is bench hardware output, not
		// pattern output).
		for _, rw := range doc.Raceways {
			emitRacewayPage(pdf, opts, rw, doc)
			stampCopyMarker(pdf, opts, pageH, copyNo, copies)
		}

		// Bend-list summary page (only if any bends were detected). The
		// bend list is about the main runs, not the metal strips — when
		// StripsOnly is on we skip it (the operator already has the bend
		// list from the original print run).
		if !opts.StripsOnly {
			totalBends := 0
			for _, bs := range bendsByRun {
				totalBends += len(bs)
			}
			if totalBends > 0 {
				drawBendListPage(pdf, opts, doc, bendsByRun, pageH, copyNo, copies)
			}
		}
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("write pdf: %w", err)
	}
	return buf.Bytes(), nil
}

// makePageProjector returns a world-mm → page-mm coordinate projector
// for one tile of the main pattern. The non-mirrored projection is the
// trivial translation `(x-tileX+margin, y-tileY+margin)`. The mirrored
// projection (Tier 2 #73, the trade default for back-side bending)
// flips X within the tile's content rectangle:
//
//	mirrored_page_x = margin + contentW - (x - tileX)
//	              = (contentW + tileX + margin) - x
//
// Both projections share the same Y mapping; we only mirror horizontally.
// The flip happens at the per-coordinate level rather than as a
// `pdf.TransformBegin / TransformMirrorHorizontal` pair so the polyline
// geometry mirrors without dragging the text glyphs along — bend-number
// labels, dimension notes, and free-text labels emitted via `pdf.Text`
// at the mirrored anchor position still read left-to-right (the
// operator views them through the back of the glass tube and they look
// the same as if the printed page were folded face-down).
//
// `contentW` is the page's content width in mm (paper width minus
// twice the margin); the caller has already computed it for the tile-
// overlay drawer so we accept it as an argument rather than recomputing
// here. Tiles at the right edge of a multi-tile design will not have
// exactly `contentW` mm of design in them, but the per-coordinate flip
// is anchored to the tile's *page* rectangle, not the design's bbox,
// so the printout stays inside the page bounds (and matches the
// non-mirrored layout's clipping rectangle).
func makePageProjector(tileX, tileY, marginMM, contentW, contentH float64, mirrored, rotated bool) func(x, y float64) (float64, float64) {
	if !mirrored {
		return func(x, y float64) (float64, float64) {
			return x - tileX + marginMM, y - tileY + marginMM
		}
	}
	if rotated {
		// Tier 2 #93. The caller has already rotated the world
		// coordinate 90° clockwise, so the mirror axis rotates with
		// it: reflecting the ROTATED pattern vertically is exactly
		// the same image as reflecting the design horizontally and
		// THEN rotating it. (Reflection/rotation matrices: R·Mh =
		// Mv·R, proved in the test that pins the order.) Anchored to
		// the tile's content rectangle in the same page-flush way the
		// horizontal branch below is.
		bottom := marginMM + contentH + tileY
		return func(x, y float64) (float64, float64) {
			return x - tileX + marginMM, bottom - y
		}
	}
	// Precompute the constant component so the per-vertex math is a
	// single subtraction. `right = marginMM + contentW + tileX`, then
	// `mirrored_x = right - x`. Symmetric with the non-mirrored path's
	// `(x - tileX) + marginMM` re-arranged: at x = tileX (left edge of
	// the design tile) we get `right - tileX = marginMM + contentW`
	// (right edge of the page content area), at x = tileX + contentW
	// we get `marginMM` (left edge of the page content area).
	right := marginMM + contentW + tileX
	return func(x, y float64) (float64, float64) {
		return right - x, y - tileY + marginMM
	}
}

// makeTileProjector is the single composed world-mm → page-mm transform
// used by both renderers' main pattern pages: it fuses the Tier 2 #93
// rotation onto the front of the Tier 2 #73 mirror-aware page projector
// so every geometry call site stays a plain `toPage(x, y)`.
//
// ORDER — mirror, THEN rotate. The two do not commute (they differ by a
// 180° turn, i.e. the bender would hold the sheet upside down), so the
// order is fixed here and pinned by TestMirrorRotateOrderIsMirrorThenRotate.
// The reasoning is physical, not arbitrary:
//
//   - Mirroring is a property of the PATTERN. The bender reads the
//     printed sheet through the back of the glass, so the mirror is
//     part of turning a design into a bender's pattern.
//   - Rotation is a property of the PAPER. It only exists because a
//     sheet has a long axis and we would like to feed fewer of them.
//
// So we mirror the design into a pattern, and then lay that pattern on
// paper whichever way round costs fewer tiles. Implementation-wise the
// rotation is applied to the world coordinate here and the mirror is
// applied in page space by makePageProjector — flipping the vertical
// axis rather than the horizontal one, which is the same composition
// (R·Mh = Mv·R) with one fewer transform to evaluate per vertex.
//
// SCOPE — main pattern tiles and the bend-list summary page only, the
// same rule Options.Mirror already documents. Channel-letter return-
// strip and raceway-strip pages are unfolded 1D perimeter patterns
// living in their own coordinate space; they never call this projector,
// so rotating the pattern leaves them byte-for-byte unchanged. That is
// deliberate: a strip is cut from flat stock and its orientation on the
// page carries no fabrication meaning, while its arc-length direction
// does.
//
// (cx, cy) is the pattern bounding box's centre — unchanged by the
// rotation, so callers may pass either the pre- or post-rotation bbox's
// centre.
func makeTileProjector(cx, cy, tileX, tileY, marginMM, contentW, contentH float64, mirrored, rotated bool) func(x, y float64) (float64, float64) {
	page := makePageProjector(tileX, tileY, marginMM, contentW, contentH, mirrored, rotated)
	if !rotated {
		// Identity fast path: no extra closure hop per vertex, and
		// byte-identical output to every pre-Tier-2-#93 render.
		return page
	}
	// 90° clockwise about (cx, cy) in screen coordinates (y down):
	// x' = cx - (y - cy), y' = cy + (x - cx).
	return func(x, y float64) (float64, float64) {
		return page(cx-(y-cy), cy+(x-cx))
	}
}

// stampCopyMarker writes "Copy k of N" at the bottom-left of the page
// gofpdf is currently on. It exists for the page kinds that do NOT go
// through drawTileOverlay — return-strip, raceway-strip and bend-list
// pages — so that a step-and-repeat stack is unambiguous whichever
// sheet the fabricator picks up. Deliberately silent for a single
// copy, which keeps the default PDF byte-identical to pre-Tier-2-#93
// output.
func stampCopyMarker(pdf *gofpdf.Fpdf, opts Options, pageH float64, copyNo, copies int) {
	if copies <= 1 {
		return
	}
	pdf.SetFont("Helvetica", "", 7)
	pdf.SetTextColor(0, 0, 0)
	pdf.Text(opts.MarginMM, pageH-opts.MarginMM/2+1,
		fmt.Sprintf("Copy %d of %d", copyNo, copies))
}

func docBBox(doc *designdoc.Doc) [4]float64 {
	if doc.ViewBoxMM[2] > 0 && doc.ViewBoxMM[3] > 0 {
		return [4]float64{
			doc.ViewBoxMM[0],
			doc.ViewBoxMM[1],
			doc.ViewBoxMM[0] + doc.ViewBoxMM[2],
			doc.ViewBoxMM[1] + doc.ViewBoxMM[3],
		}
	}
	bb := [4]float64{math.Inf(1), math.Inf(1), math.Inf(-1), math.Inf(-1)}
	for _, run := range doc.Runs {
		// Flattened: an arc bulges outside the hull of its endpoints, so a
		// bbox over the raw vertices would crop the curve off the page.
		for _, p := range run.Polyline.FlatPoints() {
			if p[0] < bb[0] {
				bb[0] = p[0]
			}
			if p[1] < bb[1] {
				bb[1] = p[1]
			}
			if p[0] > bb[2] {
				bb[2] = p[0]
			}
			if p[1] > bb[3] {
				bb[3] = p[1]
			}
		}
	}
	if math.IsInf(bb[0], 1) {
		return [4]float64{0, 0, 0, 0}
	}
	return bb
}

// drawElectrodeMark draws a small unfilled circle with a centered "+" so the
// bender can locate the tube end. ~3mm diameter — visible at 1:1 without
// crowding the tube line.
func drawElectrodeMark(pdf *gofpdf.Fpdf, x, y float64) {
	pdf.SetLineWidth(0.4)
	pdf.Circle(x, y, 1.5, "D")
	pdf.Line(x-1.2, y, x+1.2, y)
	pdf.Line(x, y-1.2, x, y+1.2)
}

// shortRunID strips the "run-" prefix to keep on-page bend labels compact
// (e.g. "1.3" instead of "run-1.3").
func shortRunID(id string) string {
	const prefix = "run-"
	if len(id) > len(prefix) && id[:len(prefix)] == prefix {
		return id[len(prefix):]
	}
	return id
}

// bendListRuns returns the runs the bend-list summary enumerates, in page
// order.
//
// Tier 3 #60 — jumpers are 2-vertex splice tubes; the bend list is about
// primary runs and a jumper would only ever contribute a "(no bends auto-
// detected)" row that clutters the summary. Skip them entirely.
//
// Tier 3 #122 — this exists as a named function rather than an inline
// `continue` so that "which runs get a row?" is assertable directly. The test
// that used to guard it compared PDF byte-length deltas against a 500-byte
// threshold, which a ~40-byte compressed row could never have crossed.
// drawBendListPage and the bend pre-compute in RenderFromDoc both walk this,
// so the assertion is on the decision they actually make.
func bendListRuns(doc *designdoc.Doc) []designdoc.Run {
	out := make([]designdoc.Run, 0, len(doc.Runs))
	for _, run := range doc.Runs {
		if run.Kind == "jumper" {
			continue
		}
		out = append(out, run)
	}
	return out
}

// drawBendListPage emits a final page listing each run's bends in order
// with arc-length offset and turn angle, plus electrode count, total tube
// length, and any per-run color/diameter overrides.
// The bend list can spill onto continuation pages for a long design, so
// the Tier 2 #93 copy marker is stamped by this function rather than by
// the caller — otherwise only the LAST sheet of a multi-page bend list
// would carry it, and the pages in between would be unattributable in a
// step-and-repeat stack. No-op for a single copy.
func drawBendListPage(pdf *gofpdf.Fpdf, opts Options, doc *designdoc.Doc, bendsByRun map[string][]designdoc.BendPoint, pageH float64, copyNo, copies int) {
	pdf.AddPage()
	stampCopyMarker(pdf, opts, pageH, copyNo, copies)
	mx := opts.MarginMM
	pdf.SetFont("Helvetica", "B", 14)
	pdf.Text(mx, mx+8, "Bend list")
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(mx, mx+14, fmt.Sprintf("%s — %s", opts.ProjectName, opts.DesignVersionLabel))

	y := mx + 22
	pdf.SetFont("Helvetica", "B", 10)
	for _, run := range bendListRuns(doc) {
		bends := bendsByRun[run.ID]
		title := fmt.Sprintf("%s · %d pts · %d electrode%s · %d bend%s",
			run.ID,
			len(run.Polyline.Points),
			len(run.Electrodes), pluralize(len(run.Electrodes)),
			len(bends), pluralize(len(bends)),
		)
		if run.TubeDiameterMM > 0 {
			title += fmt.Sprintf(" · ø%.1fmm", run.TubeDiameterMM)
		}
		if run.Color != "" {
			title += " · " + run.Color
		}
		pdf.SetFont("Helvetica", "B", 10)
		pdf.Text(mx, y, title)
		y += 5
		pdf.SetFont("Helvetica", "", 9)
		if note := strings.TrimSpace(run.Notes); note != "" {
			pdf.SetFont("Helvetica", "I", 9)
			for _, ln := range strings.Split(note, "\n") {
				pdf.Text(mx+4, y, "    "+ln)
				y += 4
			}
			pdf.SetFont("Helvetica", "", 9)
			y += 1
		}
		if len(bends) == 0 {
			pdf.Text(mx+4, y, "  (no bends auto-detected; smooth curves below 20°)")
			y += 6
		} else {
			for i, b := range bends {
				radius := "-"
				if !math.IsInf(b.RadiusMM, 0) && !math.IsNaN(b.RadiusMM) && b.RadiusMM > 0 {
					radius = fmt.Sprintf("%.1fmm", b.RadiusMM)
				}
				line := fmt.Sprintf("  %s.%d   arc %6.1fmm   turn %3.0f°   r %s",
					shortRunID(run.ID), i+1, b.ArcLengthMM, b.AngleDeg, radius)
				pdf.Text(mx+4, y, line)
				y += 5
			}
			y += 2
		}
		// Tier 3 #77 — special-bend callouts. JUMP and DROP entries
		// emit one row per annotation, ordered by arc length so the
		// bender encounters them in the same order they walk the tube.
		// Distinct kinds (vs. the auto-detected geometric bends above)
		// because the bender needs to plan flame technique differently
		// for a horseshoe lift over an obstacle vs. a localized drop
		// behind the substrate. Skipped silently when the run carries
		// no jump or drop annotations.
		if specials := specialBendsForRun(run); len(specials) > 0 {
			pdf.SetFont("Helvetica", "B", 9)
			pdf.Text(mx+4, y, "Special bends:")
			y += 5
			pdf.SetFont("Helvetica", "", 9)
			for _, s := range specials {
				line := fmt.Sprintf("  %s.%s   arc %6.1fmm   %s",
					shortRunID(run.ID), s.tag, s.arcMM, s.label)
				pdf.Text(mx+4, y, line)
				y += 5
				// Page break inside the special-bend list too.
				if y > opts.Paper.HeightMM-mx-15 {
					pdf.AddPage()
					stampCopyMarker(pdf, opts, pageH, copyNo, copies)
					y = mx + 8
				}
			}
			y += 2
		}
		// Tier 3 #62 — per-run "Housings" subsection. Lists every
		// electrode that has a configured housing (HousingType != "")
		// with its bore diameter and mounting elevation. Skipped when
		// no electrode has a housing set, so designs that haven't been
		// tagged with housings yet keep the bend list compact.
		if housings := housingsForRun(run); len(housings) > 0 {
			pdf.SetFont("Helvetica", "B", 9)
			pdf.Text(mx+4, y, "Housings:")
			y += 5
			pdf.SetFont("Helvetica", "", 9)
			for _, h := range housings {
				pdf.Text(mx+4, y, "  "+h)
				y += 5
			}
			y += 2
		}
		// Page break: leave some margin from the footer area.
		if y > opts.Paper.HeightMM-mx-15 {
			pdf.AddPage()
			stampCopyMarker(pdf, opts, pageH, copyNo, copies)
			y = mx + 8
		}
	}
}

// specialBend is one "JUMP" or "DROP" entry in the bend-list summary.
// Tier 3 #77 — distinct from the geometric bends (which the bender
// produces by heating-and-shaping the existing tube curve) because
// these are operator-authored callouts the bender must actively
// flame in. Sorted by ArcLengthMM so the bender walks the tube in
// physical order on the shop floor.
type specialBend struct {
	tag   string  // short code printed in the row (e.g. "J1", "D2")
	label string  // human-readable kind: "JUMP" or "DROP"
	arcMM float64 // arc length from the start of the live arc
}

// specialBendsForRun returns the JUMP and DROP annotations on a run,
// ordered by arc length along the live arc. Returns nil when the run
// carries no jump or drop_bend annotations so the caller can elide the
// "Special bends:" subsection entirely.
//
// Out-of-range LiveIndex values are silently dropped (defensive — the
// editor and storage validation should already prevent it). The arc-
// length walk mirrors EffectiveBends' logic: sum Euclidean distances
// between consecutive live-arc points.
func specialBendsForRun(run designdoc.Run) []specialBend {
	if len(run.Annotations) == 0 {
		return nil
	}
	liveIdx, _ := designdoc.LiveArcIndices(run)
	n := len(liveIdx)
	if n < 2 {
		return nil
	}
	// arcAt[i] = cumulative arc length from live-arc point 0 to i.
	arcAt := make([]float64, n)
	for i := 1; i < n; i++ {
		// Tier 3 #78 — an arc is ~15.9% longer than its chord, and this is
		// what positions every bend callout along the tube. Measuring the
		// chord would slide every downstream mark up the glass.
		arcAt[i] = arcAt[i-1] + run.Polyline.WalkSegmentLengthMM(liveIdx[i-1], liveIdx[i])
	}
	var out []specialBend
	var jumpCount, dropCount int
	for _, a := range run.Annotations {
		if a.LiveIndex < 0 || a.LiveIndex >= n {
			continue
		}
		switch a.Kind {
		case "jump":
			jumpCount++
			out = append(out, specialBend{
				tag:   fmt.Sprintf("J%d", jumpCount),
				label: "JUMP",
				arcMM: arcAt[a.LiveIndex],
			})
		case "drop_bend":
			dropCount++
			out = append(out, specialBend{
				tag:   fmt.Sprintf("D%d", dropCount),
				label: "DROP",
				arcMM: arcAt[a.LiveIndex],
			})
		}
	}
	if len(out) == 0 {
		return nil
	}
	// Sort by arc length so the bender walks the tube in physical
	// order. Stable sort keeps J1/J2/... and D1/D2/... numbering
	// monotonic when two annotations land at the same arc position.
	sortSpecials(out)
	return out
}

// sortSpecials sorts specials by ArcLengthMM ascending; stable on
// equal-arc-length to keep J1 < J2 / D1 < D2 numbering monotonic.
// Implemented as an insertion sort because annotation counts are tiny
// (typically < 10 per run) and avoiding a sort.Slice import keeps the
// dependency surface lean.
func sortSpecials(s []specialBend) {
	for i := 1; i < len(s); i++ {
		v := s[i]
		j := i - 1
		for j >= 0 && s[j].arcMM > v.arcMM {
			s[j+1] = s[j]
			j--
		}
		s[j+1] = v
	}
}

// housingsForRun returns one display string per electrode that has a
// configured housing on this run, in electrode order ("E1: ...",
// "E2: ..."). Electrodes with HousingType == "" are skipped, so the
// caller can short-circuit the whole "Housings" section when the
// returned slice is empty. Stock-shell labels mirror the frontend
// HOUSING_LIBRARY (Strattman NT Ch.3 Table 3.4); the bore is read from
// the library when stock and from the doc when custom — same
// authoritative-source split docOps.setElectrodeHousing enforces.
func housingsForRun(run designdoc.Run) []string {
	var out []string
	for i, e := range run.Electrodes {
		if e.HousingType == "" {
			continue
		}
		label, bore := housingDimsForType(e.HousingType, e.BoreDiameterMM)
		line := fmt.Sprintf("E%d - %s (bore %.1f mm", i+1, label, bore)
		if e.ElevationMM > 0 {
			line += fmt.Sprintf(", elev %.1f mm", e.ElevationMM)
		}
		line += ")"
		out = append(out, line)
	}
	return out
}

// housingDimsForType resolves a (HousingType, BoreDiameterMM) pair to
// the printed label + bore. Stock shells override the doc-supplied bore
// (the library is authoritative); custom uses the doc value. Mirrors
// web/src/lib/housingLibrary.ts; if a third stock shell is added there
// it should be added here too. Mismatches are picked up by the round-
// trip integration test rather than by a code-level guard, so the two
// tables can drift if a future task forgets to update both — keep them
// in sync.
func housingDimsForType(housingType string, customBoreMM float64) (label string, boreMM float64) {
	switch housingType {
	case "shell-15":
		return "15-shell (3/8\" x 1-5/16\")", 9.5
	case "shell-19":
		return "19-shell (1/2\" x 1-5/8\")", 12.7
	case "custom":
		return "Custom", customBoreMM
	default:
		return housingType, customBoreMM
	}
}

func pluralize(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// drawTileOverlay adds registration crosses at the four printable-area
// corners, a scale bar, and a footer that identifies the tile/project.
//
// `rotated`, `copyNo` and `copies` drive the Tier 2 #93 footer-honesty
// rule: a sheet that is rotated relative to the design, or that is one
// of N identical copies, must SAY so. A rotated pattern found on a
// bench a week later with nothing indicating the rotation is a real
// fabrication hazard, and an un-labelled stack of step-and-repeat
// output is impossible to split back apart. Both notes are appended
// only when active, so the default footer string — and therefore the
// default PDF — is byte-identical to pre-Tier-2-#93 output.
func drawTileOverlay(pdf *gofpdf.Fpdf, opts Options, pageW, pageH, contentW, contentH float64, col, row, cols, rows int, rotated bool, copyNo, copies int) {
	mx := opts.MarginMM
	my := opts.MarginMM

	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(0.2)

	// Registration crosses at corners (just inside the content area).
	const crossArm = 5.0
	corners := []struct{ x, y float64 }{
		{mx, my},
		{mx + contentW, my},
		{mx, my + contentH},
		{mx + contentW, my + contentH},
	}
	for _, p := range corners {
		pdf.Line(p.x-crossArm, p.y, p.x+crossArm, p.y)
		pdf.Line(p.x, p.y-crossArm, p.x, p.y+crossArm)
	}

	// 100mm scale bar bottom-left of the content area.
	scaleStart := mx
	scaleY := pageH - my/2 - 4
	scaleLen := 100.0
	pdf.SetLineWidth(0.5)
	pdf.Line(scaleStart, scaleY, scaleStart+scaleLen, scaleY)
	for i := 0; i <= 10; i++ {
		x := scaleStart + float64(i)*10
		pdf.Line(x, scaleY-1.5, x, scaleY+1.5)
	}
	pdf.SetFont("Helvetica", "", 8)
	pdf.Text(scaleStart, scaleY-2, "0")
	pdf.Text(scaleStart+50-3, scaleY-2, "50mm")
	pdf.Text(scaleStart+100-7, scaleY-2, "100mm")
	pdf.Text(scaleStart+105, scaleY+1, "(verify scale: should measure 100mm)")

	// Footer right side: project / version / tube spec / tile coordinates.
	footerY := pageH - my/2 - 4
	footerText := fmt.Sprintf("NeonBench  •  %s", opts.ProjectName)
	if opts.DesignVersionLabel != "" {
		footerText += "  •  " + opts.DesignVersionLabel
	}
	if opts.TubeSpecName != "" {
		footerText += "  •  " + opts.TubeSpecName
	}
	if opts.TubeEndGapMM > 0 {
		// Tube end gap (NW #135) — distance from tube end to channel
		// letter / substrate edge. Informational footer only in V1.
		footerText += fmt.Sprintf("  •  End gap %.2fmm", opts.TubeEndGapMM)
	}
	if rotated {
		footerText += "  •  ROTATED 90°"
	}
	if copies > 1 {
		footerText += fmt.Sprintf("  •  Copy %d of %d", copyNo, copies)
	}
	footerText += fmt.Sprintf("  •  Tile %d,%d of %d×%d  •  %s", col+1, row+1, cols, rows, footerDate())
	pdf.SetFont("Helvetica", "", 7)
	tw := pdf.GetStringWidth(footerText)
	pdf.Text(pageW-mx-tw, footerY+1, footerText)
}
