package designdoc

import (
	"reflect"
	"strings"
	"testing"
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
