package designdoc

import (
	"bytes"
	"fmt"
	"math"
	"strconv"
	"strings"

	"github.com/vlouvet/neonbench/internal/validate"
)

func sqrt(x float64) float64 { return math.Sqrt(x) }

// defaultPreviewStrokeMM is the stroke width used to render a tube run in the
// canonical SVG when the run carries no explicit diameter. It only affects the
// inline preview's appearance — the validator and print pipeline parse path
// geometry, not paint — and a mid-range neon-tube diameter reads well at
// thumbnail scale.
const defaultPreviewStrokeMM = 6.0

// FromSVG parses an SVG document and returns the structured design doc. Each
// disjoint subpath becomes a Run with no electrodes assigned.
//
// defaultDiameterMM is stored on each run as a starting tube diameter. The
// editor will allow per-run override later.
func FromSVG(svgData []byte, defaultDiameterMM float64) (*Doc, error) {
	polylines, bbox, _, err := validate.ExtractMMPolylines(svgData)
	if err != nil {
		return nil, fmt.Errorf("parse svg: %w", err)
	}
	runs := make([]Run, len(polylines))
	for i, pl := range polylines {
		pts := make([][2]float64, len(pl.Points))
		for j, p := range pl.Points {
			pts[j] = [2]float64{p.X, p.Y}
		}
		runs[i] = Run{
			ID:             fmt.Sprintf("run-%d", i+1),
			Polyline:       Polyline{Points: pts, Closed: pl.Closed},
			TubeDiameterMM: defaultDiameterMM,
		}
	}
	// Convert bbox [minX, minY, maxX, maxY] → [x, y, w, h].
	view := [4]float64{bbox[0], bbox[1], bbox[2] - bbox[0], bbox[3] - bbox[1]}
	return &Doc{Version: SchemaVersion, ViewBoxMM: view, Runs: runs}, nil
}

// ToSVG renders a Doc back to a normalized SVG: width/height in millimeters,
// viewBox in mm-canonical coordinates, no nested transforms, one <path> per
// run. This SVG is what gets sent to the validator, the print pipeline, and
// the inline preview.
//
// Closed runs with exactly two electrodes are emitted as the LIVE arc only
// (the half of the loop the tube physically exists on), per the run's
// direction. Validation and PDF print therefore see only the real tube.
func ToSVG(doc *Doc) []byte {
	var buf bytes.Buffer
	w, h := doc.ViewBoxMM[2], doc.ViewBoxMM[3]
	if w <= 0 {
		w = 1
	}
	if h <= 0 {
		h = 1
	}
	fmt.Fprintf(&buf,
		`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="%smm" height="%smm" viewBox="%s %s %s %s">`,
		fmtFloat(w), fmtFloat(h),
		fmtFloat(doc.ViewBoxMM[0]), fmtFloat(doc.ViewBoxMM[1]),
		fmtFloat(w), fmtFloat(h))
	buf.WriteByte('\n')
	for _, run := range doc.Runs {
		if len(run.Polyline.Points) < 2 {
			continue
		}
		liveIndices, closed := liveArcIndices(run)
		segments := splitByBlockouts(liveIndices, run.Blockouts, closed)
		dbPoints := doublebackWorldPoints(run, liveIndices)
		for _, seg := range segments {
			emitPath(&buf, seg.Indices, &run.Polyline, seg.Closed, seg.IsBlockout, run.TubeDiameterMM, dbPoints, run.IsChannelLetterFace)
		}
	}
	buf.WriteString(`</svg>`)
	return buf.Bytes()
}

// pathSegment is one contiguous run of polyline indices, tagged with whether
// the bender will paint it out (block-out) so the renderer can emit dashed
// vs solid and the validator can apply spacing exemption.
type pathSegment struct {
	Indices    []int
	Closed     bool
	IsBlockout bool
}

// RenderableSegment exposes splitByBlockouts to other packages (printpdf
// in particular). Indices reference run.Polyline.Points.
type RenderableSegment struct {
	Indices    []int
	Closed     bool
	IsBlockout bool
}

// LiveArcIndices returns the polyline indices of the run's live tube and
// whether the resulting arc is closed. Exported so renderers can locate
// the tube geometry without re-implementing the closed-loop split.
func LiveArcIndices(run Run) ([]int, bool) {
	return liveArcIndices(run)
}

// RenderableSegments returns the run split into alternating alive/blockout
// segments along the live arc — same data ToSVG uses to emit alive vs
// dashed paths.
func RenderableSegments(run Run) []RenderableSegment {
	if len(run.Polyline.Points) < 2 {
		return nil
	}
	liveIndices, closed := liveArcIndices(run)
	segs := splitByBlockouts(liveIndices, run.Blockouts, closed)
	out := make([]RenderableSegment, len(segs))
	for i, s := range segs {
		out[i] = RenderableSegment{Indices: s.Indices, Closed: s.Closed, IsBlockout: s.IsBlockout}
	}
	return out
}

// splitByBlockouts walks the live-arc indices and emits alternating
// alive / blockout segments based on the run's Blockouts list. Blockout
// indices are interpreted as positions WITHIN the live arc (so [3, 7] means
// "starting at the third live-arc sample, run for 5 samples"), so this
// transparently handles both open and closed runs.
func splitByBlockouts(liveIndices []int, blockouts []Blockout, closed bool) []pathSegment {
	n := len(liveIndices)
	if n == 0 {
		return nil
	}
	if len(blockouts) == 0 {
		return []pathSegment{{Indices: liveIndices, Closed: closed}}
	}
	mask := make([]bool, n)
	for _, b := range blockouts {
		s, e := clampLiveIndex(b.StartLiveIndex, n), clampLiveIndex(b.EndLiveIndex, n)
		if s == e {
			mask[s] = true
			continue
		}
		// Walk forward from s to e (inclusive). For open runs we don't wrap;
		// for closed runs we do.
		i := s
		for {
			mask[i] = true
			if i == e {
				break
			}
			i++
			if i >= n {
				if !closed {
					break
				}
				i = 0
			}
		}
	}
	var out []pathSegment
	cur := pathSegment{IsBlockout: mask[0]}
	for j := 0; j < n; j++ {
		if mask[j] != cur.IsBlockout && len(cur.Indices) > 0 {
			out = append(out, cur)
			// Bridge: include the boundary point at the start of the new segment.
			cur = pathSegment{IsBlockout: mask[j], Indices: []int{liveIndices[j-1]}}
		}
		cur.Indices = append(cur.Indices, liveIndices[j])
	}
	if len(cur.Indices) > 0 {
		out = append(out, cur)
	}
	// Tier 3 #59 — closed-loop seam continuity. When a blockout
	// straddles index 0 of a closed live arc, the loop above emits
	// two separate blockout segments (one starting at index 0, one
	// ending at index n-1) that conceptually represent ONE continuous
	// painted arc through the wrap edge. Merge them so downstream
	// consumers (ToSVG above, RenderableSegments for the printpdf
	// pipeline, the 3D preview's segment-split via the JS mirror)
	// emit one continuous dashed sleeve instead of two.
	//
	// Guard: only fire on closed loops AND only when BOTH end
	// segments are blockouts. Open arcs never wrap (short-circuit).
	// Closed loops with mid-loop blockouts (first/last both live)
	// are left unchanged to preserve the identity invariant — those
	// rendered correctly pre-fix because two adjacent live tubes
	// meet at the seam-share point even though the wrap edge is
	// technically missing. Don't change segment counts for docs
	// that were already rendering correctly.
	//
	// Merge formula: append first.Indices to last.Indices, no slice.
	// Pre-merge `last` ends at polyline index n-1 (no trailing seam-
	// share — j=n-1 was the loop's final iteration) and `first`
	// starts at polyline index 0 (no leading seam-share — j=0 was
	// the loop's first iteration). On a closed loop those two
	// indices are adjacent via the wrap edge n-1 -> 0, so we
	// concatenate WITHOUT dropping a duplicate.
	if closed && len(out) >= 2 {
		first := out[0]
		last := out[len(out)-1]
		if first.IsBlockout && last.IsBlockout {
			merged := pathSegment{
				IsBlockout: true,
				Indices:    append(append([]int{}, last.Indices...), first.Indices...),
			}
			tail := append([]pathSegment{merged}, out[1:len(out)-1]...)
			out = tail
		}
	}
	if closed && len(out) == 1 && !out[0].IsBlockout {
		out[0].Closed = true
	}
	return out
}

func clampLiveIndex(i, n int) int {
	if n == 0 {
		return 0
	}
	if i < 0 {
		i = 0
	}
	if i >= n {
		i = n - 1
	}
	return i
}

// doublebackWorldPoints resolves a run's "doubleback" annotations to world
// (mm) coordinates so the validator can suppress bend-radius issues at
// those points without re-deriving live-arc index ↔ polyline index mapping.
func doublebackWorldPoints(run Run, liveIndices []int) []string {
	if len(run.Annotations) == 0 || len(liveIndices) == 0 {
		return nil
	}
	n := len(liveIndices)
	var pairs []string
	for _, a := range run.Annotations {
		if a.Kind != "doubleback" {
			continue
		}
		li := a.LiveIndex
		if li < 0 || li >= n {
			continue
		}
		idx := liveIndices[li]
		if idx < 0 || idx >= len(run.Polyline.Points) {
			continue
		}
		p := run.Polyline.Points[idx]
		pairs = append(pairs, fmt.Sprintf("%s,%s", fmtFloat(p[0]), fmtFloat(p[1])))
	}
	return pairs
}

func emitPath(buf *bytes.Buffer, indices []int, pl *Polyline, closed, isBlockout bool, diameterMM float64, dbPoints []string, isChannelLetterFace bool) {
	points := pl.Points
	if len(indices) < 2 {
		return
	}
	diameterAttr := ""
	if diameterMM > 0 {
		diameterAttr = fmt.Sprintf(` data-tube-diameter-mm="%s"`, fmtFloat(diameterMM))
	}
	dbAttr := ""
	if len(dbPoints) > 0 {
		// Space-separated x,y pairs so the validator can split cheaply.
		dbAttr = fmt.Sprintf(` data-doubleback-mm="%s"`, strings.Join(dbPoints, " "))
	}
	// Tier 3 #26: surface the channel-letter face flag on the SVG so
	// the validator's perimeter-vs-blank rule can identify which
	// polylines it should evaluate. Blockout segments inherit the
	// flag too — the perimeter rule sums every contributing segment
	// of a face run anyway.
	faceAttr := ""
	if isChannelLetterFace {
		faceAttr = ` data-channel-letter-face="1"`
	}
	switch {
	case isBlockout:
		fmt.Fprintf(buf, `<path fill="none" stroke="black" stroke-width="0.6" stroke-dasharray="2 1.2" data-kind="blockout"%s%s%s d="`, diameterAttr, dbAttr, faceAttr)
	case isChannelLetterFace && closed:
		// A channel-letter face is a deliberate solid silhouette (its
		// perimeter drives the returns-strip), so fill it.
		fmt.Fprintf(buf, `<path fill="black" fill-rule="evenodd" stroke="none"%s%s%s d="`, diameterAttr, dbAttr, faceAttr)
	default:
		// A live tube run — an open path OR a closed loop (circle/rect). It's
		// a tube, not a region, so stroke it at ~tube thickness instead of
		// filling the interior solid black, which turned every open run (and
		// every closed loop) into a blob in the inline preview. fill-vs-stroke
		// is irrelevant to the validator and print pipeline — both parse path
		// geometry, not paint (validate.ExtractMMPolylines).
		strokeMM := diameterMM
		if strokeMM <= 0 {
			strokeMM = defaultPreviewStrokeMM
		}
		fmt.Fprintf(buf, `<path fill="none" stroke="black" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"%s%s%s d="`, fmtFloat(strokeMM), diameterAttr, dbAttr, faceAttr)
	}
	// Tier 3 #78 — a step across an arc segment emits cubics instead of an L.
	// The walk can run either way around a closed run, so which segment joins
	// two positions (and whether it is crossed backwards) is resolved rather
	// than assumed.
	n := len(points)
	for j, idx := range indices {
		p := points[idx]
		if j == 0 {
			fmt.Fprintf(buf, "M%s %s ", fmtFloat(p[0]), fmtFloat(p[1]))
			continue
		}
		prev := indices[j-1]
		seg, reversed, ok := SegmentIndexBetween(prev, idx, n, pl.Closed)
		if ok && pl.SegmentType(seg) == SegmentArc {
			cubics := ArcCubics(points[seg], points[(seg+1)%n], reversed)
			if len(cubics) > 0 {
				for _, c := range cubics {
					fmt.Fprintf(buf, "C%s %s %s %s %s %s ",
						fmtFloat(c.C1X), fmtFloat(c.C1Y),
						fmtFloat(c.C2X), fmtFloat(c.C2Y),
						fmtFloat(c.X), fmtFloat(c.Y))
				}
				continue
			}
		}
		fmt.Fprintf(buf, "L%s %s ", fmtFloat(p[0]), fmtFloat(p[1]))
	}
	if closed {
		buf.WriteByte('Z')
	}
	buf.WriteString(`"/>`)
	buf.WriteByte('\n')
}

// liveArcIndices returns the polyline indices that make up the run's live
// tube — i.e. the actual physical tube path. For closed runs with two
// electrodes, the loop is split at the electrodes and only one arc is live;
// the other half exists only as design intent. For everything else, the
// whole polyline is live.
func liveArcIndices(run Run) (indices []int, closed bool) {
	n := len(run.Polyline.Points)
	if n == 0 {
		return nil, false
	}
	if !run.Polyline.Closed || len(run.Electrodes) != 2 {
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out, run.Polyline.Closed
	}
	a := run.Electrodes[0].PointIndex
	b := run.Electrodes[1].PointIndex
	if a < 0 || a >= n || b < 0 || b >= n {
		// Defensive: invalid electrode indices fall back to whole loop.
		out := make([]int, n)
		for i := range out {
			out[i] = i
		}
		return out, true
	}
	dir := run.Direction
	if dir == "" {
		dir = defaultDirection(run)
	}
	if dir == "backward" {
		return arcBackward(a, b, n), false
	}
	return arcForward(a, b, n), false
}

func arcForward(a, b, n int) []int {
	out := []int{a}
	for i := (a + 1) % n; ; i = (i + 1) % n {
		out = append(out, i)
		if i == b {
			break
		}
	}
	return out
}

func arcBackward(a, b, n int) []int {
	out := []int{a}
	for i := (a - 1 + n) % n; ; i = (i - 1 + n) % n {
		out = append(out, i)
		if i == b {
			break
		}
	}
	return out
}

func defaultDirection(run Run) string {
	if !run.Polyline.Closed || len(run.Electrodes) != 2 {
		return "forward"
	}
	n := len(run.Polyline.Points)
	a := run.Electrodes[0].PointIndex
	b := run.Electrodes[1].PointIndex
	fwdLen := arcLengthOf(arcForward(a, b, n), run.Polyline.Points)
	bwdLen := arcLengthOf(arcBackward(a, b, n), run.Polyline.Points)
	if bwdLen > fwdLen {
		return "backward"
	}
	return "forward"
}

func arcLengthOf(indices []int, points [][2]float64) float64 {
	var total float64
	for i := 1; i < len(indices); i++ {
		dx := points[indices[i]][0] - points[indices[i-1]][0]
		dy := points[indices[i]][1] - points[indices[i-1]][1]
		total += sqrt(dx*dx + dy*dy)
	}
	return total
}

// fmtFloat trims trailing zeros so the SVG isn't bloated by 14 decimals on
// every coordinate.
func fmtFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', -1, 64)
}
