package designdoc

import (
	"math"
	"reflect"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

// toSVGForRun renders a single run to the canonical SVG string so a test can
// assert on its <path> paint attributes.
func toSVGForRun(run Run) string {
	doc := &Doc{Version: SchemaVersion, ViewBoxMM: [4]float64{0, 0, 100, 100}, Runs: []Run{run}}
	return string(ToSVG(doc))
}

// Bug #01 — open tube runs were emitted with fill="black", which paints the
// enclosed area solid in the inline preview (an open "O" became a blob). A tube
// is a stroke, not a region: open runs must be stroked, not filled.
func TestToSVGStrokesOpenTubeRun(t *testing.T) {
	svg := toSVGForRun(Run{
		ID:       "open",
		Polyline: Polyline{Points: [][2]float64{{0, 0}, {50, 0}, {50, 50}}, Closed: false},
	})
	if strings.Contains(svg, `fill="black"`) {
		t.Errorf("open tube run must not be filled black:\n%s", svg)
	}
	if !strings.Contains(svg, `fill="none"`) || !strings.Contains(svg, `stroke="black"`) {
		t.Errorf("open tube run must be stroked (fill=none stroke=black):\n%s", svg)
	}
}

// Bug #01 — a closed loop that is NOT a channel-letter face (a circle / rect
// tube) is still a tube, not a filled region, so it must be stroked too.
func TestToSVGStrokesClosedNonFaceLoop(t *testing.T) {
	svg := toSVGForRun(Run{
		ID:       "loop",
		Polyline: Polyline{Points: [][2]float64{{0, 0}, {50, 0}, {50, 50}, {0, 50}}, Closed: true},
	})
	if strings.Contains(svg, `fill="black"`) {
		t.Errorf("closed non-face loop (circle/rect) must not be filled black:\n%s", svg)
	}
	if !strings.Contains(svg, `stroke="black"`) {
		t.Errorf("closed non-face loop must be stroked:\n%s", svg)
	}
}

// Bug #01 — a channel-letter face IS a deliberate solid silhouette, so it must
// keep its black fill (the distinction the fix preserves).
func TestToSVGFillsChannelLetterFace(t *testing.T) {
	svg := toSVGForRun(Run{
		ID:                  "face",
		Polyline:            Polyline{Points: [][2]float64{{0, 0}, {50, 0}, {50, 50}, {0, 50}}, Closed: true},
		IsChannelLetterFace: true,
	})
	if !strings.Contains(svg, `fill="black"`) {
		t.Errorf("channel-letter face must be filled black:\n%s", svg)
	}
}

// Tier 3 #59 — closed-loop seam continuity. When a closed live arc
// has a blockout that straddles index 0, splitByBlockouts used to
// emit two separate blockout segments (one at the head of the live
// arc, one at the tail) — visually two dashed arcs with a gap at the
// seam where one continuous painted arc was intended. The fix
// recognizes wrap-straddle on a closed loop and merges first+last
// when they're BOTH blockouts. The merged Indices walks the polyline
// in traversal order through the wrap edge (n-1 -> 0), so the SVG
// renderer (and PDF print pipeline that consumes RenderableSegments)
// draws one continuous dashed sleeve including the wrap edge that
// the pre-fix code dropped.
//
// Mirrors web/src/lib/runArcs.test.ts.

func liveIndicesRange(n int) []int {
	out := make([]int, n)
	for i := range out {
		out[i] = i
	}
	return out
}

func segmentShape(segs []pathSegment) []bool {
	out := make([]bool, len(segs))
	for i, s := range segs {
		out[i] = s.IsBlockout
	}
	return out
}

func TestSplitByBlockoutsClosedWrapStraddleMerges(t *testing.T) {
	// 10-point closed live arc, blockout walks 8 -> 9 -> 0 -> 1 -> 2.
	// Pre-fix: 3 segments (block[0,1,2], live[2..7], block[7,8,9]) —
	// the wrap edge 9 -> 0 is missing entirely. Post-fix: 2 segments,
	// merged blockout walks 7 -> 8 -> 9 -> 0 -> 1 -> 2 including the
	// wrap edge.
	live := liveIndicesRange(10)
	segs := splitByBlockouts(
		live,
		[]Blockout{{StartLiveIndex: 8, EndLiveIndex: 2}},
		true,
	)
	if len(segs) != 2 {
		t.Fatalf("want 2 segments, got %d: %+v", len(segs), segs)
	}
	if !segs[0].IsBlockout {
		t.Errorf("segs[0] should be the merged blockout, got IsBlockout=false")
	}
	wantBlock := []int{7, 8, 9, 0, 1, 2}
	if !reflect.DeepEqual(segs[0].Indices, wantBlock) {
		t.Errorf("merged blockout indices: got %v, want %v", segs[0].Indices, wantBlock)
	}
	if segs[1].IsBlockout {
		t.Errorf("segs[1] should be the live segment, got IsBlockout=true")
	}
	wantLive := []int{2, 3, 4, 5, 6, 7}
	if !reflect.DeepEqual(segs[1].Indices, wantLive) {
		t.Errorf("live indices: got %v, want %v", segs[1].Indices, wantLive)
	}
}

func TestSplitByBlockoutsClosedNoBlockoutsUnchanged(t *testing.T) {
	live := liveIndicesRange(10)
	segs := splitByBlockouts(live, nil, true)
	if len(segs) != 1 {
		t.Fatalf("want 1 segment, got %d", len(segs))
	}
	if segs[0].IsBlockout {
		t.Errorf("segs[0].IsBlockout = true, want false")
	}
	if !segs[0].Closed {
		t.Errorf("segs[0].Closed = false, want true (single live segment on a closed loop renders as a closed tube)")
	}
}

func TestSplitByBlockoutsClosedMidLoopBlockoutUnchanged(t *testing.T) {
	// Blockout at [3..5] doesn't wrap. First and last segments are
	// both live; the merge guard short-circuits (only fires when
	// both ends are blockouts) so the 3-segment shape is preserved.
	// Identity invariant: closed loops without wrap-straddle render
	// byte-identically pre- and post-fix.
	live := liveIndicesRange(10)
	segs := splitByBlockouts(
		live,
		[]Blockout{{StartLiveIndex: 3, EndLiveIndex: 5}},
		true,
	)
	if len(segs) != 3 {
		t.Fatalf("want 3 segments, got %d: %+v", len(segs), segs)
	}
	want := []bool{false, true, false}
	if !reflect.DeepEqual(segmentShape(segs), want) {
		t.Errorf("segment shape: got %v, want %v", segmentShape(segs), want)
	}
}

func TestSplitByBlockoutsOpenStartBlockoutUnchanged(t *testing.T) {
	// Open arc: even though first segment is a blockout, closed=false
	// so the merge guard short-circuits. The 2-segment shape is
	// preserved (open polylines never wrap).
	live := liveIndicesRange(10)
	segs := splitByBlockouts(
		live,
		[]Blockout{{StartLiveIndex: 0, EndLiveIndex: 2}},
		false,
	)
	if len(segs) != 2 {
		t.Fatalf("want 2 segments, got %d", len(segs))
	}
	want := []bool{true, false}
	if !reflect.DeepEqual(segmentShape(segs), want) {
		t.Errorf("segment shape: got %v, want %v", segmentShape(segs), want)
	}
}

func TestSplitByBlockoutsClosedTwoNonAdjacentBlockoutsNoFalseMerge(t *testing.T) {
	// Blockouts at [3..5] and [7..8] — neither wraps. First and last
	// segments are both LIVE, so the merge guard short-circuits
	// (only fires when both ends are blockouts). The 5-segment shape
	// is preserved.
	live := liveIndicesRange(10)
	segs := splitByBlockouts(
		live,
		[]Blockout{
			{StartLiveIndex: 3, EndLiveIndex: 5},
			{StartLiveIndex: 7, EndLiveIndex: 8},
		},
		true,
	)
	want := []bool{false, true, false, true, false}
	if !reflect.DeepEqual(segmentShape(segs), want) {
		t.Errorf("segment shape: got %v, want %v", segmentShape(segs), want)
	}
}

func TestSplitByBlockoutsClosedWrapPlusMidMergesOnlyWrap(t *testing.T) {
	// Wrap-straddle [8..2] AND mid-loop [4..5]. Pre-merge emits 5
	// segments [block[0,1,2], live[2,3], block[3,4,5], live[5,6,7],
	// block[7,8,9]]. The wrap-merge collapses the two end blockouts
	// (both IsBlockout=true) into one segment that walks 7 -> 8 ->
	// 9 -> 0 -> 1 -> 2. The mid-loop blockout is left alone. Result:
	// 4 segments, pattern T,F,T,F.
	live := liveIndicesRange(10)
	segs := splitByBlockouts(
		live,
		[]Blockout{
			{StartLiveIndex: 8, EndLiveIndex: 2},
			{StartLiveIndex: 4, EndLiveIndex: 5},
		},
		true,
	)
	if len(segs) != 4 {
		t.Fatalf("want 4 segments, got %d: %+v", len(segs), segs)
	}
	want := []bool{true, false, true, false}
	if !reflect.DeepEqual(segmentShape(segs), want) {
		t.Errorf("segment shape: got %v, want %v", segmentShape(segs), want)
	}
	wantMerged := []int{7, 8, 9, 0, 1, 2}
	if !reflect.DeepEqual(segs[0].Indices, wantMerged) {
		t.Errorf("merged wrap blockout indices: got %v, want %v", segs[0].Indices, wantMerged)
	}
}

// Bug #18 — a closed run's CLOSING segment (the one leaving points[n-1] and
// arriving back at points[0]) carries a type like every other segment, and
// setSegmentType exposes it: a full circle drawn as four arcs is exactly that
// shape. Both SVG writers used to emit a bare Z for it, so the drawn glass was
// a straight chord while FlatPoints, LengthMM, the takeoff and the DXF vertex
// bulge all already walked the curve.
//
// These numbers are pinned in web/src/lib/runArcs.test.ts too. The editor draws
// from indicesToD and the validator, the print pattern and the DXF all derive
// from emitPath — when the two drift the operator is shown one shape and handed
// another, which is the failure the arc twins exist to prevent.
const (
	// One 100 mm chord replaced by its arc: r = 0.625*chord, length =
	// r*4*atan(0.5) = 115.9119 mm. arc_test.go pins the 1.15911 ratio itself.
	bug18ArcMM = 115.9119
	// Flattening error: the validator's adaptive Bezier flattener (0.05 mm
	// chord tolerance) reads a hair short of the true arc length, so every
	// comparison against an exact arc length gets this slack. The pre-fix gap
	// the test actually hunts is 15.9 mm — two orders of magnitude larger.
	bug18TolMM = 0.15
)

// bug18Square renders a 100 mm closed square with the given segment types and
// returns the SVG plus the length the validator measures off it — i.e. the
// glass every downstream consumer believes the design contains.
func bug18Square(t *testing.T, types []string) (string, float64, *Polyline) {
	t.Helper()
	run := Run{
		ID: "sq",
		Polyline: Polyline{
			Points:       [][2]float64{{0, 0}, {100, 0}, {100, 100}, {0, 100}},
			Closed:       true,
			SegmentTypes: types,
		},
	}
	doc := &Doc{Version: SchemaVersion, ViewBoxMM: [4]float64{-50, -50, 250, 250}, Runs: []Run{run}}
	svg := string(ToSVG(doc))
	pls, _, issues, err := validate.ExtractMMPolylines([]byte(svg))
	if err != nil {
		t.Fatalf("extract polylines from %v: %v", types, err)
	}
	if len(issues) != 0 {
		t.Fatalf("unexpected parse issues for %v: %+v", types, issues)
	}
	if len(pls) != 1 {
		t.Fatalf("want 1 polyline for %v, got %d", types, len(pls))
	}
	return svg, pls[0].Length(), &run.Polyline
}

func TestToSVGHonoursClosingSegmentArc(t *testing.T) {
	allArcSVG, allArc, _ := bug18Square(t, []string{"arc", "arc", "arc", "arc"})
	openArcSVG, openArc, _ := bug18Square(t, []string{"arc", "arc", "arc", "line"})

	// The bug in one assertion: four arcs used to measure the same as three
	// arcs plus a straight closing chord, because the fourth was never drawn.
	if allArcSVG == openArcSVG {
		t.Fatalf("closing arc changed nothing in the SVG:\n%s", allArcSVG)
	}
	if got, want := allArc-openArc, bug18ArcMM-100; math.Abs(got-want) > bug18TolMM {
		t.Errorf("closing arc adds %.4f mm of glass, want %.4f mm (pre-fix this was 0)", got, want)
	}

	// Drawn == measured, for every mix. This is what the bug broke: the SVG is
	// what the validator, the PDF and the preview see, LengthMM is what the
	// takeoff bills.
	for _, c := range []struct {
		name  string
		types []string
		want  float64
	}{
		{"four arcs", []string{"arc", "arc", "arc", "arc"}, 4 * bug18ArcMM},
		{"three arcs and a straight close", []string{"arc", "arc", "arc", "line"}, 3*bug18ArcMM + 100},
		{"straight sides, curved close", []string{"line", "line", "line", "arc"}, 300 + bug18ArcMM},
		{"flipped closing arc", []string{"line", "line", "line", "arc_r"}, 300 + bug18ArcMM},
	} {
		svg, drawn, pl := bug18Square(t, c.types)
		if math.Abs(drawn-c.want) > bug18TolMM {
			t.Errorf("%s: SVG measures %.4f mm, want %.4f mm:\n%s", c.name, drawn, c.want, svg)
		}
		if math.Abs(drawn-pl.LengthMM()) > bug18TolMM {
			t.Errorf("%s: SVG measures %.4f mm but LengthMM says %.4f mm — drawn and measured disagree",
				c.name, drawn, pl.LengthMM())
		}
	}

	// The two sides of the closing arc are mirror images, so they measure the
	// same but must not draw the same.
	leftSVG, _, _ := bug18Square(t, []string{"line", "line", "line", "arc"})
	rightSVG, _, _ := bug18Square(t, []string{"line", "line", "line", "arc_r"})
	if leftSVG == rightSVG {
		t.Errorf("arc and arc_r closing segments drew identically:\n%s", leftSVG)
	}

	// Negative control: a run whose closing segment is a line is untouched,
	// byte for byte. The back-compat invariant on existing docs.
	plainSVG, plain, _ := bug18Square(t, nil)
	if !strings.Contains(plainSVG, `d="M0 0 L100 0 L100 100 L0 100 Z"`) {
		t.Errorf("all-line closed square must emit the same path as before:\n%s", plainSVG)
	}
	if math.Abs(plain-400) > 1e-9 {
		t.Errorf("all-line closed square measures %.4f mm, want 400", plain)
	}
}

// Bug #18 — a two-point closed run is the one case where asking
// SegmentIndexBetween for the closing step gives the wrong answer: its
// "b == a-1" case wins over its wrap case and returns segment 0 traversed
// backwards, which would retrace the outbound arc instead of drawing the
// closing one. The emitter takes n-1 directly, exactly as FlatPoints and
// LengthMM do, so the two ends of the lens bow to opposite sides.
func TestToSVGClosingArcOnTwoPointLoop(t *testing.T) {
	run := Run{
		ID: "lens",
		Polyline: Polyline{
			Points:       [][2]float64{{0, 0}, {100, 0}},
			Closed:       true,
			SegmentTypes: []string{"arc", "arc"},
		},
	}
	doc := &Doc{Version: SchemaVersion, ViewBoxMM: [4]float64{-50, -50, 250, 250}, Runs: []Run{run}}
	svg := ToSVG(doc)
	pls, _, _, err := validate.ExtractMMPolylines(svg)
	if err != nil {
		t.Fatal(err)
	}
	if len(pls) != 1 {
		t.Fatalf("want 1 polyline, got %d", len(pls))
	}
	if got, want := pls[0].Length(), 2*bug18ArcMM; math.Abs(got-want) > bug18TolMM {
		t.Errorf("two-arc lens measures %.4f mm, want %.4f mm:\n%s", got, want, svg)
	}
	// Both arcs bow left of their OWN travel, so the closing one leaves the
	// chord on the far side and the lens is two sagittas tall. A retrace would
	// be one. (Measured on the extracted bbox so it does not care what
	// viewBox-to-mm offset the extractor applied.)
	minY, maxY := math.Inf(1), math.Inf(-1)
	for _, p := range pls[0].Points {
		minY = math.Min(minY, p.Y)
		maxY = math.Max(maxY, p.Y)
	}
	if got, want := maxY-minY, 50.0; math.Abs(got-want) > 0.1 {
		t.Errorf("lens is %.4f mm tall, want %.4f (a retraced closing arc gives 25):\n%s", got, want, svg)
	}
}
