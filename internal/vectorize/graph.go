package vectorize

// Skeleton-graph extraction: classify pixels by 8-connected degree, merge
// thick junction clusters, walk each edge into a polyline, and prune short
// spurs left behind by Zhang-Suen.

// PixelClass tags a skeleton pixel by what role it plays in the polyline
// extraction. We carry the original 8-degree separately so the spur-prune
// pass can lower a junction back to interior after a branch is removed.
type PixelClass uint8

const (
	ClassNone     PixelClass = iota // background or out-of-graph
	ClassEndpoint                   // degree 1 — open polyline endpoint
	ClassInterior                   // degree 2 — walks through it
	ClassJunction                   // degree ≥ 3 — splits polylines
)

type pixelGraph struct {
	skel  *BinaryImage
	class []PixelClass
	w, h  int
}

func newPixelGraph(skel *BinaryImage) *pixelGraph {
	g := &pixelGraph{
		skel:  skel,
		class: make([]PixelClass, len(skel.Pix)),
		w:     skel.W,
		h:     skel.H,
	}
	g.classify()
	return g
}

func (g *pixelGraph) idx(x, y int) int { return y*g.w + x }

// degree8 returns the count of 8-connected foreground neighbors of (x,y).
func (g *pixelGraph) degree8(x, y int) int {
	deg := 0
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if dx == 0 && dy == 0 {
				continue
			}
			if g.skel.At(x+dx, y+dy) {
				deg++
			}
		}
	}
	return deg
}

// arcCount returns the number of distinct 8-connected foreground arcs
// touching the perimeter of (x,y). This is the same as Zhang-Suen's A(p):
// 0→1 transitions in the cyclic sequence p2,p3,…,p9,p2.
//
// arcCount == 1 → endpoint or boundary pixel (one arc).
// arcCount == 2 → smooth interior of a 1-px-wide path.
// arcCount ≥ 3 → genuine branching junction.
//
// Using arcCount instead of raw degree avoids classifying "fat corner"
// pixels (where two neighbors happen to be 8-adjacent) as junctions —
// those are still smooth pass-throughs in the underlying topology.
func (g *pixelGraph) arcCount(x, y int) int {
	seq := [9]bool{
		g.skel.At(x, y-1),   // p2 N
		g.skel.At(x+1, y-1), // p3 NE
		g.skel.At(x+1, y),   // p4 E
		g.skel.At(x+1, y+1), // p5 SE
		g.skel.At(x, y+1),   // p6 S
		g.skel.At(x-1, y+1), // p7 SW
		g.skel.At(x-1, y),   // p8 W
		g.skel.At(x-1, y-1), // p9 NW
		g.skel.At(x, y-1),   // wrap to p2
	}
	a := 0
	for k := 0; k < 8; k++ {
		if !seq[k] && seq[k+1] {
			a++
		}
	}
	return a
}

func (g *pixelGraph) classify() {
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			if !g.skel.At(x, y) {
				g.class[g.idx(x, y)] = ClassNone
				continue
			}
			deg := g.degree8(x, y)
			if deg == 0 {
				// Speckle — drop from the skeleton entirely.
				g.skel.Pix[g.idx(x, y)] = false
				g.class[g.idx(x, y)] = ClassNone
				continue
			}
			arcs := g.arcCount(x, y)
			switch {
			case arcs >= 3:
				g.class[g.idx(x, y)] = ClassJunction
			case deg == 1:
				g.class[g.idx(x, y)] = ClassEndpoint
			default:
				g.class[g.idx(x, y)] = ClassInterior
			}
		}
	}
	g.mergeJunctionClusters()
}

// mergeJunctionClusters: BFS over the connected components of pixels
// classified as junctions (8-connected), and within each component pick a
// single canonical junction pixel — the one with the highest degree
// (ties broken by lowest y, then lowest x). Demote the others to interior
// if their degree happens to be 2 once the component is reduced to one
// junction; otherwise keep them as junctions only if they retain ≥3
// distinct branches that don't go through other cluster members.
//
// In practice the simple "keep one, demote the rest to interior" approach
// works because the cluster pixels are mutually adjacent — once we treat
// only one as the splitter, the others just walk through.
func (g *pixelGraph) mergeJunctionClusters() {
	visited := make([]bool, len(g.class))
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			if g.class[g.idx(x, y)] != ClassJunction || visited[g.idx(x, y)] {
				continue
			}
			// BFS the connected cluster of junction pixels.
			cluster := []int{g.idx(x, y)}
			visited[g.idx(x, y)] = true
			head := 0
			for head < len(cluster) {
				cur := cluster[head]
				head++
				cy := cur / g.w
				cx := cur % g.w
				for dy := -1; dy <= 1; dy++ {
					for dx := -1; dx <= 1; dx++ {
						if dx == 0 && dy == 0 {
							continue
						}
						nx, ny := cx+dx, cy+dy
						if nx < 0 || ny < 0 || nx >= g.w || ny >= g.h {
							continue
						}
						ni := g.idx(nx, ny)
						if visited[ni] || g.class[ni] != ClassJunction {
							continue
						}
						visited[ni] = true
						cluster = append(cluster, ni)
					}
				}
			}
			if len(cluster) < 2 {
				continue
			}
			// Keep the LOWEST-degree pixel as the canonical junction
			// (tie-break: smallest y, then smallest x). The lower-degree
			// member of a junction cluster sits at the actual branching
			// point in the underlying skeleton; the higher-degree members
			// are deeper inside, with redundant diagonal connections that
			// inflate their degree. Demote the rest to interior so the
			// walker passes through.
			best := cluster[0]
			bestDeg := g.degree8(best%g.w, best/g.w)
			for _, idx := range cluster[1:] {
				deg := g.degree8(idx%g.w, idx/g.w)
				switch {
				case deg < bestDeg:
					best, bestDeg = idx, deg
				case deg == bestDeg:
					by, bx := best/g.w, best%g.w
					ny, nx := idx/g.w, idx%g.w
					if ny < by || (ny == by && nx < bx) {
						best = idx
					}
				}
			}
			for _, idx := range cluster {
				if idx == best {
					continue
				}
				g.class[idx] = ClassInterior
			}
		}
	}
}

// neighbors4 returns the 4-connected foreground neighbors first, then the
// diagonal 4 — preferring orthogonal hops keeps the walker from
// shortcutting across a 1-pixel corner.
func (g *pixelGraph) neighbors4First(x, y int) [][2]int {
	out := make([][2]int, 0, 8)
	ortho := [4][2]int{{0, -1}, {1, 0}, {0, 1}, {-1, 0}}
	diag := [4][2]int{{-1, -1}, {1, -1}, {1, 1}, {-1, 1}}
	for _, d := range ortho {
		nx, ny := x+d[0], y+d[1]
		if g.skel.At(nx, ny) {
			out = append(out, [2]int{nx, ny})
		}
	}
	for _, d := range diag {
		nx, ny := x+d[0], y+d[1]
		if g.skel.At(nx, ny) {
			out = append(out, [2]int{nx, ny})
		}
	}
	return out
}

// extractPolylines walks the skeleton and emits open polylines (one per
// edge between endpoint/junction nodes) plus closed polylines for any
// pure loops that are left over after edge-walking.
func (g *pixelGraph) extractPolylines() [][]point {
	visited := make([]bool, len(g.class))
	out := [][]point{}

	isStart := func(c PixelClass) bool { return c == ClassEndpoint || c == ClassJunction }

	// Edges first: start at each endpoint/junction and walk every
	// branch. Junction pixels themselves are NOT marked visited (they
	// may be the start of multiple branches).
	for sy := 0; sy < g.h; sy++ {
		for sx := 0; sx < g.w; sx++ {
			si := g.idx(sx, sy)
			if !isStart(g.class[si]) {
				continue
			}
			for _, n := range g.neighbors4First(sx, sy) {
				ni := g.idx(n[0], n[1])
				if visited[ni] {
					continue
				}
				// Don't dive into another junction directly — it'll
				// produce a degenerate 2-vertex polyline. Emit it once
				// per direction by ordering the endpoints, but only
				// if the start pixel index is less than the neighbor.
				if g.class[ni] == ClassJunction {
					if si < ni {
						out = append(out, []point{{sx, sy}, {n[0], n[1]}})
					}
					continue
				}
				walk := []point{{sx, sy}, {n[0], n[1]}}
				visited[ni] = true
				cx, cy := n[0], n[1]
				prevX, prevY := sx, sy
				for g.class[g.idx(cx, cy)] == ClassInterior {
					nbrs := g.neighbors4First(cx, cy)
					var nxt [2]int
					found := false
					for _, m := range nbrs {
						if m[0] == prevX && m[1] == prevY {
							continue
						}
						mi := g.idx(m[0], m[1])
						if visited[mi] {
							continue
						}
						nxt = m
						found = true
						break
					}
					if !found {
						break
					}
					walk = append(walk, point{nxt[0], nxt[1]})
					mi := g.idx(nxt[0], nxt[1])
					if g.class[mi] != ClassJunction {
						visited[mi] = true
					}
					prevX, prevY = cx, cy
					cx, cy = nxt[0], nxt[1]
				}
				out = append(out, walk)
			}
		}
	}

	// Pure loops: connected components of unvisited interior pixels with
	// no endpoints/junctions reachable. Walk them as closed polylines.
	for y := 0; y < g.h; y++ {
		for x := 0; x < g.w; x++ {
			i := g.idx(x, y)
			if visited[i] || g.class[i] != ClassInterior {
				continue
			}
			loop := []point{{x, y}}
			visited[i] = true
			prevX, prevY := -1, -1
			cx, cy := x, y
			for {
				nbrs := g.neighbors4First(cx, cy)
				var nxt [2]int
				found := false
				for _, m := range nbrs {
					if m[0] == prevX && m[1] == prevY {
						continue
					}
					mi := g.idx(m[0], m[1])
					if visited[mi] {
						// Wrapping around to the start closes the loop.
						if m[0] == x && m[1] == y && len(loop) > 2 {
							found = false
						}
						continue
					}
					nxt = m
					found = true
					break
				}
				if !found {
					break
				}
				loop = append(loop, point{nxt[0], nxt[1]})
				visited[g.idx(nxt[0], nxt[1])] = true
				prevX, prevY = cx, cy
				cx, cy = nxt[0], nxt[1]
			}
			if len(loop) >= 3 {
				// Mark closed by appending the start point at the end —
				// the polyline.go converter recognizes this.
				loop = append(loop, point{x, y})
				out = append(out, loop)
			}
		}
	}
	return out
}

// prunePolylines drops any open polyline whose junction-end is at a
// junction node and whose pixel length is below threshold. Returns the
// surviving polylines and a flag indicating whether any were pruned.
func prunePolylines(g *pixelGraph, polys [][]point, minLenPx int) ([][]point, bool) {
	if minLenPx < 1 {
		return polys, false
	}
	survivors := make([][]point, 0, len(polys))
	pruned := false
	for _, p := range polys {
		if len(p) < 2 {
			continue
		}
		// Closed polylines repeat their start point at the end; spur
		// prune doesn't apply.
		if len(p) >= 3 && p[0] == p[len(p)-1] {
			survivors = append(survivors, p)
			continue
		}
		startCls := g.class[g.idx(p[0].X, p[0].Y)]
		endCls := g.class[g.idx(p[len(p)-1].X, p[len(p)-1].Y)]
		// A spur is an open branch whose junction end terminates in a
		// junction and whose other end is a leaf endpoint, with pixel
		// length below threshold.
		isSpur := len(p) <= minLenPx &&
			((startCls == ClassJunction && endCls == ClassEndpoint) ||
				(startCls == ClassEndpoint && endCls == ClassJunction))
		if isSpur {
			pruned = true
			continue
		}
		survivors = append(survivors, p)
	}
	return survivors, pruned
}

type point struct{ X, Y int }
