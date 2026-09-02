package printpdf

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// ---------------------------------------------------------------------
// Tier 3 #122 — the seam's own tests, plus the geometric helpers the rest
// of the package's tests use to ask "what did this draw?".
//
// Everything here works on plan values in world millimetres. No PDF is
// rendered, nothing is inflated, and no operator is read back out of a
// content stream — which is the point: the value under test is the same
// one RenderFromDoc executes.
// ---------------------------------------------------------------------

// flattenPath samples a subpath's operators into a world-mm point cloud along
// the stroke: `samples` evenly spaced points per line and per cubic. Lines are
// sampled too, so "does the stroke pass through here?" means the same thing on
// a chord as on a curve — otherwise a straight segment would only ever be
// answered for at its endpoints.
func flattenPath(p strokedPath, samples int) [][2]float64 {
	var out [][2]float64
	var cur [2]float64
	for _, op := range p.Ops {
		switch op.Kind {
		case opMoveTo:
			out = append(out, [2]float64{op.X, op.Y})
		case opLineTo:
			for i := 1; i <= samples; i++ {
				t := float64(i) / float64(samples)
				out = append(out, [2]float64{
					cur[0] + t*(op.X-cur[0]),
					cur[1] + t*(op.Y-cur[1]),
				})
			}
		case opCubicTo:
			for i := 1; i <= samples; i++ {
				t := float64(i) / float64(samples)
				u := 1 - t
				x := u*u*u*cur[0] + 3*u*u*t*op.C1X + 3*u*t*t*op.C2X + t*t*t*op.X
				y := u*u*u*cur[1] + 3*u*u*t*op.C1Y + 3*u*t*t*op.C2Y + t*t*t*op.Y
				out = append(out, [2]float64{x, y})
			}
		}
		cur = [2]float64{op.X, op.Y}
	}
	return out
}

// flattenDrawing samples every subpath of a run's plan.
func flattenDrawing(d runDrawing, samples int) [][2]float64 {
	var out [][2]float64
	for _, p := range d.Paths {
		out = append(out, flattenPath(p, samples)...)
	}
	return out
}

// nearestMM returns the distance in mm from target to the closest sampled
// point of the drawn path. "Does the drawn glass pass through here?" is the
// question a byte count could never answer.
func nearestMM(pts [][2]float64, target [2]float64) float64 {
	best := math.Inf(1)
	for _, p := range pts {
		if d := math.Hypot(p[0]-target[0], p[1]-target[1]); d < best {
			best = d
		}
	}
	return best
}

// withoutCubics returns the plan with every cubic operator removed. On a run
// whose only curve is the closing segment this reproduces exactly the operator
// sequence RenderFromDoc emitted BEFORE Bug #18 was fixed — a straight chord
// home — so it is the negative control that makes the positive assertion mean
// something (CLAUDE.md → Recurring bug classes → 7).
func withoutCubics(d runDrawing) runDrawing {
	out := runDrawing{Label: d.Label}
	for _, p := range d.Paths {
		stripped := strokedPath{RunID: p.RunID, Dashed: p.Dashed, Closed: p.Closed}
		for _, op := range p.Ops {
			if op.Kind != opCubicTo {
				stripped.Ops = append(stripped.Ops, op)
			}
		}
		out.Paths = append(out.Paths, stripped)
	}
	return out
}

// closedSquareRun is the 100 mm closed square Bug #18 was found on:
// (20,20) → (120,20) → (120,120) → (20,120) → close.
func closedSquareRun(types []string) designdoc.Run {
	return designdoc.Run{
		ID: "sq",
		Polyline: designdoc.Polyline{
			Points:       [][2]float64{{20, 20}, {120, 20}, {120, 120}, {20, 120}},
			Closed:       true,
			SegmentTypes: types,
		},
		TubeDiameterMM: 10,
	}
}

// TestPlanRunDrawingDrawsClosingSegmentArc is Bug #18's regression test, moved
// off the PDF and onto the seam.
//
// Bug #18: RenderFromDoc walked the steps BETWEEN a segment's indices and then
// closed a closed run with a straight LineTo, so a closing segment marked as an
// arc reached the bender as a chord — while the canvas, the DXF vertex bulge
// and every computed length already said "curve". The old version of this test
// had to inflate the PDF's Flate-compressed content streams and count " c"
// operators, which meant a PDF parser lived in a test file and the assertion
// was two layers removed from the geometry it cared about.
//
// The assertion now is the geometry itself. ArcBulge is 0.5, so an arc's apex
// stands off its chord by chord/4 on the left of travel. The closing segment
// runs (20,120) → (20,20): a 100 mm chord travelling -Y, whose left is +X, so
// the drawn glass must pass through (45, 70). Drawn as a chord it passes
// through (20, 70) instead and never comes within 25 mm of the apex.
func TestPlanRunDrawingDrawsClosingSegmentArc(t *testing.T) {
	const (
		samples  = 64
		apexTolM = 0.01 // the arc is split into two cubics, so the apex is an on-curve join
	)
	apex := [2]float64{45, 70}
	chordMid := [2]float64{20, 70}

	for _, c := range []struct {
		name          string
		curved, chord []string
	}{
		{"straight sides", []string{"line", "line", "line", "arc"}, []string{"line", "line", "line", "line"}},
		{"curved sides", []string{"arc", "arc", "arc", "arc"}, []string{"arc", "arc", "arc", "line"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			curved := planRunDrawing(closedSquareRun(c.curved))
			chord := planRunDrawing(closedSquareRun(c.chord))
			if len(curved.Paths) != 1 || len(chord.Paths) != 1 {
				t.Fatalf("expected one subpath per plan, got %d and %d — the assertions below would be vacuous",
					len(curved.Paths), len(chord.Paths))
			}

			// The drawn glass reaches the closing arc's apex.
			curvedPts := flattenDrawing(curved, samples)
			if got := nearestMM(curvedPts, apex); got > apexTolM {
				t.Errorf("curved closing segment: drawn path misses the arc apex %v by %.3f mm — "+
					"the closing segment was drawn as a chord", apex, got)
			}

			// ... and the chord variant does not, but does run through the
			// chord's midpoint. Two-sided, so a renderer that curved
			// everything unconditionally would fail here.
			chordPts := flattenDrawing(chord, samples)
			if got := nearestMM(chordPts, apex); got < 20 {
				t.Errorf("straight closing segment: drawn path came within %.3f mm of the arc apex %v — "+
					"expected it to stay on the chord", got, apex)
			}
			if got := nearestMM(chordPts, chordMid); got > apexTolM {
				t.Errorf("straight closing segment: drawn path misses the chord midpoint %v by %.3f mm",
					chordMid, got)
			}

			// Operator-level corroboration: designdoc.ArcCubics emits exactly
			// two cubics per arc, so curving one more segment adds exactly two.
			if got := curved.cubicCount() - chord.cubicCount(); got != 2 {
				t.Errorf("curving the closing segment added %d cubic operators, want 2 (%d vs %d)",
					got, curved.cubicCount(), chord.cubicCount())
			}

			// NEGATIVE CONTROL. Strip the cubics and the plan becomes the
			// operator sequence Bug #18 shipped. The apex assertion above has
			// to fail on it, or it was never testing anything.
			broken := withoutCubics(curved)
			if got := nearestMM(flattenDrawing(broken, samples), apex); got <= apexTolM {
				t.Errorf("negative control: the pre-Bug-#18 operator sequence still reaches the apex "+
					"(%.3f mm) — the assertion above is vacuous", got)
			}
		})
	}
}

// TestPlanRunDrawingClosesTheSubpath pins the tail the renderer emits after a
// closing arc: the subpath still returns to its start point. The returning
// LineTo is geometrically redundant once the arc lands there, but it is part of
// what gets drawn, and dropping it would be a rendering change wearing a
// refactor's clothes.
func TestPlanRunDrawingClosesTheSubpath(t *testing.T) {
	for _, types := range [][]string{
		{"line", "line", "line", "line"},
		{"line", "line", "line", "arc"},
	} {
		plan := planRunDrawing(closedSquareRun(types))
		if len(plan.Paths) != 1 {
			t.Fatalf("%v: expected one subpath, got %d", types, len(plan.Paths))
		}
		p := plan.Paths[0]
		if !p.Closed {
			t.Errorf("%v: subpath not marked closed", types)
		}
		first, last := p.Ops[0], p.Ops[len(p.Ops)-1]
		if last.Kind != opLineTo || last.X != first.X || last.Y != first.Y {
			t.Errorf("%v: subpath ends with %v(%g,%g), want a LineTo back to the start (%g,%g)",
				types, last.Kind, last.X, last.Y, first.X, first.Y)
		}
	}
}

// TestPlanRunDrawingArcsMatchDesigndoc pins the arc twins at the printpdf
// boundary: the curve the printed pattern draws for an arc segment is the same
// circle designdoc computes for it (CLAUDE.md → Recurring bug classes → 4 — the
// bender must be handed the shape the operator was shown). Sampling the plan's
// cubics and asking designdoc for the arc's centre and radius is a genuinely
// independent check: ArcCubics builds control points, ArcFor builds a circle.
func TestPlanRunDrawingArcsMatchDesigndoc(t *testing.T) {
	run := designdoc.Run{
		ID: "r",
		Polyline: designdoc.Polyline{
			Points:       [][2]float64{{0, 0}, {100, 0}, {100, 80}},
			SegmentTypes: []string{designdoc.SegmentArc, designdoc.SegmentArcR},
		},
	}
	plan := planRunDrawing(run)
	if len(plan.Paths) != 1 {
		t.Fatalf("expected one subpath, got %d", len(plan.Paths))
	}
	if got := plan.cubicCount(); got != 4 {
		t.Fatalf("expected 4 cubics for two arc segments, got %d", got)
	}

	for i, segType := range run.Polyline.SegmentTypes {
		p0, p1 := run.Polyline.Points[i], run.Polyline.Points[i+1]
		// ArcFlipped, not `== SegmentArcR`: the house rule after Tier 3 #87
		// widened the enum and quietly emptied two regression tests
		// (CLAUDE.md → Recurring bug classes → 7).
		arc, ok := designdoc.ArcFor(p0, p1, designdoc.ArcFlipped(segType))
		if !ok {
			t.Fatalf("segment %d: designdoc has no arc for it", i)
		}
		// The two cubics for this segment are ops 1+2i and 2+2i (op 0 is the
		// MoveTo). Sample them and require every point on the circle.
		sub := strokedPath{Ops: append([]pathOp{{Kind: opMoveTo, X: p0[0], Y: p0[1]}}, plan.Paths[0].Ops[1+2*i:3+2*i]...)}
		for _, pt := range flattenPath(sub, 40) {
			r := math.Hypot(pt[0]-arc.CX, pt[1]-arc.CY)
			if math.Abs(r-arc.RadiusMM) > 0.05 {
				t.Errorf("segment %d (%s): drawn point %v is %.3f mm from the centre, want %.3f",
					i, segType, pt, r, arc.RadiusMM)
				break
			}
		}
	}
}

// TestPlanRunDrawingDashesBlockoutsAndJumpers pins which strokes come out
// dashed. Blockout sleeves and jumpers are the two things on the pattern that
// are NOT lit glass, and the dash is how the bender tells them apart at 1:1.
func TestPlanRunDrawingDashesBlockoutsAndJumpers(t *testing.T) {
	run := designdoc.Run{
		ID: "r1",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {40, 0}, {80, 0}, {120, 0}, {160, 0}},
		},
		Blockouts: []designdoc.Blockout{{StartLiveIndex: 2, EndLiveIndex: 3}},
	}
	plan := planRunDrawing(run)
	if len(plan.Paths) < 2 {
		t.Fatalf("a blockout should split the run into at least two subpaths, got %d", len(plan.Paths))
	}
	dashed := 0
	for _, p := range plan.Paths {
		if p.Dashed {
			dashed++
		}
	}
	if dashed == 0 {
		t.Error("no subpath came out dashed — the blockout sleeve would print as lit glass")
	}
	if dashed == len(plan.Paths) {
		t.Error("every subpath came out dashed — the lit glass would print as sleeve")
	}
	if plan.Label != nil {
		t.Errorf("a primary run got a %q label", plan.Label.Text)
	}
}

// TestDocDrawingCoversEveryRun pins that the plan is per-run and in doc order,
// which is the order RenderFromDoc strokes them in (later runs draw over
// earlier ones).
func TestDocDrawingCoversEveryRun(t *testing.T) {
	doc := goldenDoc()
	plans := docDrawing(doc)
	if len(plans) != len(doc.Runs) {
		t.Fatalf("planned %d runs, doc has %d", len(plans), len(doc.Runs))
	}
	for i, p := range plans {
		if len(p.Paths) == 0 {
			t.Errorf("run %q planned no subpaths", doc.Runs[i].ID)
			continue
		}
		if got := p.Paths[0].RunID; got != doc.Runs[i].ID {
			t.Errorf("plan %d carries run id %q, want %q", i, got, doc.Runs[i].ID)
		}
	}
}
