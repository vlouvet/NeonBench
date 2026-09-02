package printpdf

import "github.com/vlouvet/neonbench/internal/designdoc"

// This file is the answer to "what path did this render actually draw?".
//
// Tier 3 #122. Until it existed, `internal/printpdf` could only be tested
// through the bytes it emitted: the suite compared PDF byte-length deltas and
// said so in its own comments. A byte count cannot tell a curve from a slightly
// longer straight line, which is exactly how Bug #18 survived — RenderFromDoc
// closed a closed run with a straight LineTo while the DXF bulge, the canvas
// and every length already said "arc", and nothing in this package could see
// the difference.
//
// The seam is a pure function: planRunDrawing turns one run into the ordered
// list of path operators the main pattern will stroke for it, in WORLD
// millimetres. RenderFromDoc then does nothing but project each coordinate
// through the tile's world→page projector and hand it to gofpdf. So the drawn
// geometry is assertable with no PDF, no compression, and no parser — and the
// thing the tests assert on is the same value the renderer executes, not a
// re-implementation of it.
//
// The types are unexported on purpose: every test in this package is an
// in-package test, and Tier 3 #122's scope is explicit that a testability seam
// must not widen what real callers see.
//
// Two rules keep this honest:
//
//   - Coordinates stay in world mm. The projection is per-coordinate and
//     affine, so projecting the plan is arithmetically identical to projecting
//     during the walk — that is what lets the refactor be byte-for-byte
//     invisible (TestRenderFromDocGoldenBytes pins it).
//   - The plan describes what is drawn, in the order it is drawn, including
//     operators that are geometrically redundant (a closed subpath's final
//     LineTo back to the start still follows a closing arc's cubics). Dropping
//     one would be a rendering change wearing a refactor's clothes.

// pathOpKind is the path-construction operator a pathOp carries.
type pathOpKind uint8

const (
	opMoveTo pathOpKind = iota
	opLineTo
	opCubicTo
)

func (k pathOpKind) String() string {
	switch k {
	case opMoveTo:
		return "M"
	case opLineTo:
		return "L"
	case opCubicTo:
		return "C"
	}
	return "?"
}

// pathOp is one path-construction operator in world millimetres. C1/C2 are
// meaningful only for opCubicTo; X, Y is the operator's end point for all
// three kinds.
type pathOp struct {
	Kind pathOpKind
	X, Y float64
	C1X  float64
	C1Y  float64
	C2X  float64
	C2Y  float64
}

// strokedPath is one subpath the renderer strokes with a single DrawPath("D").
// Dashed is the 2 mm / 1 mm pattern the renderer sets around it — blockout
// sleeves and jumpers are drawn dashed so they read as "not lit glass" at a
// glance on the printed pattern.
type strokedPath struct {
	RunID  string
	Dashed bool
	// Closed reports that the subpath's final operator returns to its
	// start point. Carried for assertions; the returning operator is
	// already present in Ops.
	Closed bool
	Ops    []pathOp
}

// cubicCount reports how many cubic-Bezier operators the subpath carries.
// designdoc.ArcCubics emits exactly two per arc segment, so this is the
// "did it draw a curve?" question Bug #18 needed and could not ask.
func (p strokedPath) cubicCount() int {
	n := 0
	for _, op := range p.Ops {
		if op.Kind == opCubicTo {
			n++
		}
	}
	return n
}

// runLabel is a text callout the main pattern anchors at a world-mm point.
// Only jumpers carry one today ("JUMPER" at the splice midpoint); the
// renderer owns the font and the page-space nudge that keeps the glyphs off
// the dashed line.
type runLabel struct {
	X, Y float64
	Text string
}

// runDrawing is everything the main pattern draws for one run.
type runDrawing struct {
	Paths []strokedPath
	Label *runLabel // nil unless the run is a labelled jumper
}

// cubicCount reports the total cubic-Bezier operators across every subpath.
func (d runDrawing) cubicCount() int {
	n := 0
	for _, p := range d.Paths {
		n += p.cubicCount()
	}
	return n
}

// planRunDrawing returns the world-mm drawing plan for one run of the main
// print pattern: the stroked subpaths in emission order, plus the jumper
// callout when there is one.
//
// The walk is the one designdoc.RenderableSegments hands us — alive stretches
// and blockout sleeves alternate, and a segment can run backwards around a
// closed run, so which polyline segment joins two consecutive indices is
// resolved through designdoc.SegmentIndexBetween rather than assumed.
func planRunDrawing(run designdoc.Run) runDrawing {
	isJumper := run.Kind == "jumper"
	var out runDrawing

	for _, seg := range designdoc.RenderableSegments(run) {
		if len(seg.Indices) < 2 {
			continue
		}
		path := strokedPath{
			RunID:  run.ID,
			Dashed: seg.IsBlockout || isJumper,
			Closed: seg.Closed,
		}
		start := run.Polyline.Points[seg.Indices[0]]
		path.Ops = append(path.Ops, pathOp{Kind: opMoveTo, X: start[0], Y: start[1]})

		// Tier 3 #78 — an arc segment draws as the same two cubics the SVG
		// writer emits, so the printed pattern and the on-screen curve are
		// the same geometry.
		nPts := len(run.Polyline.Points)
		for i := 1; i < len(seg.Indices); i++ {
			prev := seg.Indices[i-1]
			cur := seg.Indices[i]
			p := run.Polyline.Points[cur]
			segIdx, reversed, ok := designdoc.SegmentIndexBetween(prev, cur, nPts, run.Polyline.Closed)
			if ok && designdoc.IsArcType(run.Polyline.SegmentType(segIdx)) {
				cubics := designdoc.ArcCubics(
					run.Polyline.Points[segIdx],
					run.Polyline.Points[(segIdx+1)%nPts],
					run.Polyline.SegmentType(segIdx),
					reversed,
				)
				if len(cubics) > 0 {
					for _, c := range cubics {
						path.Ops = append(path.Ops, pathOp{
							Kind: opCubicTo,
							C1X:  c.C1X, C1Y: c.C1Y,
							C2X: c.C2X, C2Y: c.C2Y,
							X: c.X, Y: c.Y,
						})
					}
					continue
				}
			}
			path.Ops = append(path.Ops, pathOp{Kind: opLineTo, X: p[0], Y: p[1]})
		}

		// Bug #18 — the closing segment of a closed run is a segment like any
		// other and may be an arc. The walk above only asks about steps
		// between two entries of seg.Indices, so this one has to ask
		// separately or the bender is handed a straight chord where the
		// screen, the DXF bulge and every length already say curve. Same tail
		// as emitPath in internal/designdoc/convert.go — n-1 taken directly
		// (SegmentIndexBetween answers the non-wrap segment at n == 2), and
		// guarded on the walk really being the whole polyline in index order.
		if seg.Closed && len(seg.Indices) == nPts &&
			seg.Indices[0] == 0 && seg.Indices[nPts-1] == nPts-1 {
			if si := nPts - 1; designdoc.IsArcType(run.Polyline.SegmentType(si)) {
				for _, c := range designdoc.ArcCubics(
					run.Polyline.Points[si],
					run.Polyline.Points[0],
					run.Polyline.SegmentType(si),
					false,
				) {
					path.Ops = append(path.Ops, pathOp{
						Kind: opCubicTo,
						C1X:  c.C1X, C1Y: c.C1Y,
						C2X: c.C2X, C2Y: c.C2Y,
						X: c.X, Y: c.Y,
					})
				}
			}
		}
		if seg.Closed {
			path.Ops = append(path.Ops, pathOp{Kind: opLineTo, X: start[0], Y: start[1]})
		}
		out.Paths = append(out.Paths, path)
	}

	if isJumper && len(run.Polyline.Points) >= 2 {
		// Midpoint label "JUMPER" — world-mm midpoint of the 2-vertex
		// polyline. Per spec we don't bother orienting along the jumper axis
		// (jumpers are short — the axis-aligned label reads fine).
		p1 := run.Polyline.Points[0]
		p2 := run.Polyline.Points[len(run.Polyline.Points)-1]
		out.Label = &runLabel{X: (p1[0] + p2[0]) / 2, Y: (p1[1] + p2[1]) / 2, Text: "JUMPER"}
	}

	return out
}

// docDrawing plans every run in a doc, in the order RenderFromDoc draws them.
func docDrawing(doc *designdoc.Doc) []runDrawing {
	out := make([]runDrawing, 0, len(doc.Runs))
	for _, run := range doc.Runs {
		out = append(out, planRunDrawing(run))
	}
	return out
}
