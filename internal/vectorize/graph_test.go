package vectorize

import "testing"

// drawT builds a "T" skeleton in a 11×9 image: a 9-wide horizontal bar at
// y=2 and a 5-tall vertical bar centered at x=5 going from y=2 to y=6.
//
//	. . . . . . . . . . .
//	. . . . . . . . . . .
//	. # # # # # # # # # .   ← top bar (y=2)
//	. . . . . # . . . . .   ← spine
//	. . . . . # . . . . .
//	. . . . . # . . . . .
//	. . . . . # . . . . .
//	. . . . . . . . . . .
//	. . . . . . . . . . .
func drawT() *BinaryImage {
	b := NewBinaryImage(11, 9)
	for x := 1; x <= 9; x++ {
		b.Set(x, 2, true)
	}
	for y := 3; y <= 6; y++ {
		b.Set(5, y, true)
	}
	return b
}

func TestPixelClassificationT(t *testing.T) {
	g := newPixelGraph(drawT())
	endpoints, junctions, interior := 0, 0, 0
	for _, c := range g.class {
		switch c {
		case ClassEndpoint:
			endpoints++
		case ClassJunction:
			junctions++
		case ClassInterior:
			interior++
		}
	}
	if endpoints != 3 {
		t.Errorf("T should have 3 endpoints (left bar end, right bar end, spine bottom), got %d", endpoints)
	}
	if junctions != 1 {
		t.Errorf("T should have exactly 1 junction (after cluster merge), got %d", junctions)
	}
	if interior < 5 {
		t.Errorf("T should have at least 5 interior pixels, got %d", interior)
	}
}

func TestExtractPolylinesT(t *testing.T) {
	g := newPixelGraph(drawT())
	polys := g.extractPolylines()
	if len(polys) != 3 {
		t.Errorf("T should produce 3 polylines (left bar arm, right bar arm, spine), got %d", len(polys))
	}
	for _, p := range polys {
		if len(p) < 2 {
			t.Errorf("polyline should have ≥2 points, got %d", len(p))
		}
	}
}

func TestExtractPolylinesO(t *testing.T) {
	// Pre-thinned 1-px-wide ring (already a topological loop). The
	// extractor should produce a single closed polyline.
	b := NewBinaryImage(7, 7)
	ring := [][2]int{
		{2, 1}, {3, 1}, {4, 1},
		{5, 2},
		{5, 3}, {5, 4},
		{4, 5}, {3, 5}, {2, 5},
		{1, 4}, {1, 3}, {1, 2},
	}
	for _, p := range ring {
		b.Set(p[0], p[1], true)
	}
	g := newPixelGraph(b)
	polys := g.extractPolylines()
	if len(polys) != 1 {
		t.Fatalf("ring should produce 1 polyline, got %d", len(polys))
	}
	p := polys[0]
	if p[0] != p[len(p)-1] {
		t.Errorf("ring polyline should be closed (first == last), got %v vs %v", p[0], p[len(p)-1])
	}
}

func TestPlusShapeIsOneJunction(t *testing.T) {
	// Clean 1-px-wide "+": single horizontal bar + single vertical bar
	// crossing at (3,3). Should classify as exactly 1 junction with A=4
	// transitions.
	b := NewBinaryImage(7, 7)
	for x := 0; x < 7; x++ {
		b.Set(x, 3, true)
	}
	for y := 0; y < 7; y++ {
		b.Set(3, y, true)
	}
	g := newPixelGraph(b)
	junctions := 0
	for _, c := range g.class {
		if c == ClassJunction {
			junctions++
		}
	}
	if junctions != 1 {
		t.Errorf("clean + should have exactly 1 junction (arc-count = 4), got %d", junctions)
	}
}

func TestAdjacentJunctionsClusterMerge(t *testing.T) {
	// Zigzag junction cluster: two 8-adjacent pixels both classify as
	// junctions (arc-count ≥ 3) due to the kink in the geometry. After
	// merge, exactly one remains.
	b := NewBinaryImage(5, 5)
	pix := [][2]int{
		{1, 1}, // arm up
		{1, 2}, {1, 3}, {1, 4}, // spine through cluster
		{2, 2}, // diagonal kink at first junction
		{0, 3}, // off-spine arm
	}
	for _, p := range pix {
		b.Set(p[0], p[1], true)
	}
	g := newPixelGraph(b)
	junctions := 0
	for _, c := range g.class {
		if c == ClassJunction {
			junctions++
		}
	}
	if junctions != 1 {
		t.Errorf("zigzag junction cluster should collapse to 1 junction after merge, got %d", junctions)
	}
}

func TestSpurPrune(t *testing.T) {
	// Long horizontal bar with a 4-pixel spur sticking up from the
	// middle. Threshold 6 — the spur is below threshold and should
	// disappear, leaving a single open polyline along the bar.
	b := NewBinaryImage(15, 7)
	for x := 1; x <= 13; x++ {
		b.Set(x, 4, true)
	}
	// Spur of 4 pixels going up from (7,4)
	for y := 0; y < 4; y++ {
		b.Set(7, 3-y, true)
	}
	g := newPixelGraph(b)
	polys := g.extractPolylines()
	survived, _ := prunePolylines(g, polys, 6)
	// After prune: just the bar (one open polyline). Could be 1 or 2 if
	// the bar itself was split at the (now-removed) junction; we accept
	// both since post-prune we'd reclassify and re-walk in production.
	if len(survived) > 2 {
		t.Errorf("after prune expected ≤2 polylines (the bar), got %d", len(survived))
	}
	for _, p := range survived {
		// Spur length was 4 px; survivors should all be longer.
		if len(p) <= 4 {
			t.Errorf("survivor too short (%d px); spur should have been pruned", len(p))
		}
	}
}
