import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun, SegmentKind } from '../api';
import * as ops from './docOps';
import { flattenSegment, segmentTypeAt } from './arcGeom';
import { effectiveBends } from './bends';
import { blockoutSegments, runArcs } from './runArcs';

// Tier 3 #179. Blockouts, annotations and bends are stored as LIVE-WALK
// positions ("k hops in"), and on an open run the live walk is the polyline
// itself. moveOpening rotates that polyline, so the vertex k hops in is a
// different vertex afterwards — and a mark carried over verbatim lands on
// different glass. These tests read every mark back out as WORLD geometry
// (where it is drawn), never as its stored index, because an index assertion
// is exactly what the old doc comment got wrong: the index is unchanged, the
// glass it names is not.

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 1000, 1000],
  runs,
});

type Pt = [number, number];

// A drawn segment as a canonical string: its flattened points from one end to
// the other (so an arc's bow and side are part of its identity), oriented so
// the same glass walked either way gives the same key.
function segKey(run: DesignRun, a: number, b: number): string {
  const pts = run.polyline.points;
  // On an open run the walk steps i -> i+1 and segment i leaves vertex i.
  const lo = Math.min(a, b);
  const flat: Pt[] = [pts[lo], ...flattenSegment(pts[lo], pts[lo + 1], segmentTypeAt(run, lo))];
  const r = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const fwd = flat.map(r).join(' ');
  const bwd = [...flat].reverse().map(r).join(' ');
  return fwd < bwd ? fwd : bwd;
}

type MarkGeometry = {
  annotations: string[];
  bends: string[];
  blocked: string[];
};

// Where every mark on the run is DRAWN, resolved the way the renderers
// resolve it: runArcs for the walk, blockoutSegments for the painted glass
// (the TS twin of Go's splitByBlockouts), effectiveBends for bend callouts.
function markGeometry(run: DesignRun): MarkGeometry {
  const arcs = runArcs(run);
  const pts = run.polyline.points;
  const at = (k: number) => {
    const p = pts[arcs.live[k]];
    return `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  };
  const blocked: string[] = [];
  for (const seg of blockoutSegments(arcs.live, run.blockouts, arcs.liveClosed)) {
    if (!seg.isBlockout) continue;
    for (let i = 1; i < seg.liveIndices.length; i++) {
      blocked.push(segKey(run, seg.liveIndices[i - 1], seg.liveIndices[i]));
    }
  }
  return {
    annotations: (run.annotations ?? []).map((a) => `${a.kind}@${at(a.live_index)}`),
    bends: effectiveBends(run).map((b) => `${b.x.toFixed(6)},${b.y.toFixed(6)}`),
    blocked: blocked.sort(),
  };
}

const marks = {
  // Painted mask positions (blockoutSegments: position j paints the segment
  // ARRIVING at vertex j): [0, 2] -> segments 0-1, and exercises the start-at-0
  // edge; [4, 4] is a single-position blockout -> segment 3; [6, 2] is a
  // reversed span, which an open run clamps to the end -> segments 5-6.
  // Segments 2 and 4 stay unpainted on purpose: a fully painted run would
  // make any rotation invisible to the invariant.
  blockouts: [
    { start_live_index: 0, end_live_index: 2 },
    { start_live_index: 4, end_live_index: 4 },
    { start_live_index: 6, end_live_index: 2 },
  ],
  annotations: [
    { kind: 'jump' as const, live_index: 0 },
    { kind: 'support' as const, live_index: 2 },
    { kind: 'doubleback' as const, live_index: 4 },
    { kind: 'drop_bend' as const, live_index: 7 },
  ],
  bends: [{ live_index: 1 }, { live_index: 3 }, { live_index: 6 }],
};

// A horseshoe: 8 distinct, non-collinear vertices with mixed arc kinds, so a
// segment's key cannot collide with another's (bug class 7: 'arc' and 'arc_r'
// both present).
function horseshoe(): DesignRun {
  return {
    id: 'h',
    polyline: {
      points: [[0, 0], [0, 100], [20, 180], [80, 210], [150, 210], [210, 180], [230, 100], [230, 0]],
      closed: false,
      segment_types: ['line', 'arc', 'line', 'arc_r', 'line', 'arc', 'line'],
    },
    electrodes: [{ point_index: 0 }, { point_index: 7 }],
    ...structuredClone(marks),
  };
}

// The same 8 vertices closed into a loop and broken open the way breakOpen
// leaves it: walked from vertex 0 and ending on a duplicate of it. This is
// the isGeometricLoop branch of moveOpening (PR #224).
function brokenOpenLoop(): DesignRun {
  const h = horseshoe();
  const pts = h.polyline.points as Pt[];
  const types: SegmentKind[] = [...(h.polyline.segment_types ?? []), 'arc_r'];
  return {
    ...h,
    id: 'h',
    polyline: { points: [...pts, pts[0]], closed: false, segment_types: types },
    electrodes: [{ point_index: 0 }, { point_index: pts.length }],
    annotations: [...marks.annotations, { kind: 'support', live_index: 8 }],
  };
}

// What the code did before #179: rotate the points, carry every mark through
// untouched. Used as the negative control — the invariant must reject it.
function withMarksCarriedVerbatim(moved: DesignRun, src: DesignRun): DesignRun {
  return { ...moved, blockouts: src.blockouts, annotations: src.annotations, bends: src.bends };
}

describe('moveOpening keeps every mark on the same glass (Tier 3 #179)', () => {
  describe('open run', () => {
    const src = horseshoe();
    const n = src.polyline.points.length;
    const before = markGeometry(src);

    it('fixture is not vacuous: some glass painted, some not, every mark resolves', () => {
      expect(before.blocked.length).toBeGreaterThan(0);
      expect(before.blocked.length).toBeLessThan(n - 1);
      expect(before.annotations).toHaveLength(marks.annotations.length);
      expect(before.bends).toHaveLength(marks.bends.length);
    });

    for (let k = 0; k < n; k++) {
      it(`opening moved to vertex ${k}`, () => {
        const out = ops.moveOpening(docOf(src), 'h', k).runs[0];
        expect(ops.segmentTypesWellFormed(out)).toBe(true);
        const after = markGeometry(out);

        // Point marks sit on a vertex, and every vertex survives the move.
        expect(after.annotations).toEqual(before.annotations);
        expect(after.bends).toEqual(before.bends);

        // Painted glass: everything that was painted is still painted,
        // EXCEPT old segment k-1, which this op turns into the new opening —
        // that glass no longer exists to paint. The old opening becomes drawn
        // glass and nothing painted it, so nothing new appears.
        const lost = k === 0 ? null : segKey(src, k - 1, k);
        const want = before.blocked.filter((s) => s !== lost);
        expect(after.blocked).toEqual(want);
      });
    }

    it('negative control: carrying the marks verbatim moves them on the glass', () => {
      const out = ops.moveOpening(docOf(src), 'h', 3).runs[0];
      const old = markGeometry(withMarksCarriedVerbatim(out, src));
      expect(old.annotations).not.toEqual(before.annotations);
      expect(old.bends).not.toEqual(before.bends);
      expect(old.blocked).not.toEqual(before.blocked.filter((s) => s !== segKey(src, 2, 3)));
    });
  });

  describe('broken-open loop', () => {
    const src = brokenOpenLoop();
    const n = src.polyline.points.length;
    const before = markGeometry(src);

    for (let k = 0; k < n; k++) {
      it(`opening moved to vertex ${k}`, () => {
        const out = ops.moveOpening(docOf(src), 'h', k).runs[0];
        expect(ops.segmentTypesWellFormed(out)).toBe(true);
        expect(ops.isGeometricLoop(out)).toBe(true);
        const after = markGeometry(out);
        // A loop loses no glass when its opening moves, so nothing may be
        // lost or gained: positions are equal, full stop.
        expect(after.annotations).toEqual(before.annotations);
        expect(after.bends).toEqual(before.bends);
        expect(after.blocked).toEqual(before.blocked);
      });
    }

    it('negative control: carrying the marks verbatim moves them on the glass', () => {
      const out = ops.moveOpening(docOf(src), 'h', 3).runs[0];
      const old = markGeometry(withMarksCarriedVerbatim(out, src));
      expect(old.annotations).not.toEqual(before.annotations);
      expect(old.bends).not.toEqual(before.bends);
      expect(old.blocked).not.toEqual(before.blocked);
    });

    // The paint wraps the old opening (segments 7, 0, 1 of the loop), so most
    // moves have to split a span across the new seam. Without this the
    // packing branch could be dead code and every case above still pass.
    it('splits a span the new seam falls inside', () => {
      const out = ops.moveOpening(docOf(src), 'h', 1).runs[0];
      expect(out.blockouts!.length).toBeGreaterThan(src.blockouts!.length);
    });
  });
});
