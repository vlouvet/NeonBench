import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun, SegmentKind } from '../api';
import * as ops from './docOps';
import { flattenSegment, segmentIndexBetween, segmentTypeAt } from './arcGeom';
import { effectiveBends } from './bends';
import { blockoutSegments, runArcs } from './runArcs';

// Tier 3 #181. The breakOpen twin of moveOpeningMarks.test.ts (#179).
//
// Blockouts, annotations and bends are stored as LIVE-WALK positions ("k hops
// in"). breakOpen rewrites a closed loop as an open polyline walked from the
// break vertex, so the vertex k hops in is a different vertex afterwards, and
// a mark carried over verbatim lands on different glass. Three things make
// this harder than moveOpening:
//
//  - the OLD walk can be closed (a loop with no electrodes), so a blockout
//    span can wrap through the seam, and position 0 can paint the closing
//    segment;
//  - with two electrodes the old walk is only PART of the loop, and with
//    direction 'backward' it runs against the vertex order;
//  - the geometric-loop input (an open run ending on a copy of its start,
//    which the text tool mints) is first normalised by closeGeometricLoop.
//
// Every mark is read back as WORLD geometry, resolved the way the renderers
// resolve it, never as its stored index.

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 1000, 1000],
  runs,
});

type Pt = [number, number];
const fmt = (p: Pt) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;

// One drawn segment as a canonical string: its flattened points end to end
// (so an arc's bow and side are part of its identity), oriented so the same
// glass walked either way gives the same key. Works on closed runs (the wrap
// segment) and on walks that step backwards.
function segKey(run: DesignRun, a: number, b: number): string {
  const pts = run.polyline.points as Pt[];
  const n = pts.length;
  const hit = segmentIndexBetween(a, b, n, !!run.polyline.closed);
  if (!hit) throw new Error(`walk step ${a} -> ${b} is not a segment`);
  const s = hit.seg;
  const flat: Pt[] = [pts[s], ...flattenSegment(pts[s], pts[(s + 1) % n], segmentTypeAt(run, s))];
  const fwd = flat.map(fmt).join(' ');
  const bwd = [...flat].reverse().map(fmt).join(' ');
  return fwd < bwd ? fwd : bwd;
}

type MarkGeometry = { annotations: string[]; bends: string[]; blocked: string[] };

// Where every mark is DRAWN: runArcs for the walk, blockoutSegments (the TS
// twin of Go's splitByBlockouts, closed-seam merge included) for the painted
// glass, effectiveBends for bend callouts.
function markGeometry(run: DesignRun): MarkGeometry {
  const arcs = runArcs(run);
  const pts = run.polyline.points as Pt[];
  const blocked: string[] = [];
  for (const seg of blockoutSegments(arcs.live, run.blockouts, arcs.liveClosed)) {
    if (!seg.isBlockout) continue;
    for (let i = 1; i < seg.liveIndices.length; i++) {
      blocked.push(segKey(run, seg.liveIndices[i - 1], seg.liveIndices[i]));
    }
  }
  return {
    annotations: (run.annotations ?? []).map((a) => `${a.kind}@${fmt(pts[arcs.live[a.live_index]])}`),
    bends: effectiveBends(run).map((b) => fmt([b.x, b.y])),
    blocked: blocked.sort(),
  };
}

// Distinct, non-collinear vertices with mixed arc kinds ('arc' and 'arc_r'
// both present, bug class 7), so no two segments share a key.
const POINTS: Pt[] = [
  [0, 0], [0, 100], [20, 180], [80, 210], [150, 210], [210, 180], [230, 100], [230, 0],
];
const TYPES: SegmentKind[] = ['line', 'arc', 'line', 'arc_r', 'line', 'arc', 'line', 'arc_r'];
const N = POINTS.length;

// A closed loop with no electrodes: the live walk is the whole loop and is
// CLOSED. Paint (blockoutSegments: position j paints the segment arriving at
// j, and the closing segment only when the seam merge fires):
//   [6, 1] wraps the seam -> segments 5, 6, 7 (closing) and 0;
//   [3, 3]                -> segment 2.
// Segments 1, 3 and 4 stay unpainted on purpose: a fully painted loop would
// make any rotation invisible to the invariant.
function loop(): DesignRun {
  return {
    id: 'L',
    polyline: { points: structuredClone(POINTS), closed: true, segment_types: [...TYPES] },
    blockouts: [
      { start_live_index: 6, end_live_index: 1 },
      { start_live_index: 3, end_live_index: 3 },
    ],
    annotations: [
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 2 },
      { kind: 'doubleback', live_index: 4 },
      { kind: 'drop_bend', live_index: 7 },
    ],
    bends: [{ live_index: 1 }, { live_index: 3 }, { live_index: 6 }],
  };
}

// The same loop with two electrodes at vertices 1 and 4. Forward walks
// 1,2,3,4 (4 positions); backward walks 1,0,7,6,5,4 (6 positions), against
// the vertex order. Marks are sized to the walk; position 2's arriving
// segment is left unpainted.
function electrodeLoop(direction: 'forward' | 'backward'): DesignRun {
  const L = direction === 'forward' ? 4 : 6;
  return {
    id: 'L',
    polyline: { points: structuredClone(POINTS), closed: true, segment_types: [...TYPES] },
    electrodes: [{ point_index: 1 }, { point_index: 4 }],
    direction,
    blockouts: [
      { start_live_index: 1, end_live_index: 1 },
      { start_live_index: 3, end_live_index: L - 1 },
    ],
    annotations: [
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 2 },
      { kind: 'doubleback', live_index: L - 1 },
    ],
    bends: [{ live_index: 1 }, { live_index: L - 2 }],
  };
}

// The text tool's shape: an OPEN run whose last vertex is a copy of its
// first. breakOpen closes it (closeGeometricLoop) before breaking it. The
// open walk has 9 positions; [0, 2] paints segments 0-1 in both layouts.
//
//  'closing segment painted': [7, 8] paints 6-7, so paint sits on segment 7,
//    the one arriving at the duplicate (vertex 8 IS vertex 0).
//  'closing segment bare': [6, 7] paints 5-6 and segment 7 is NOT painted.
//    That is the trap: once closeGeometricLoop has closed the walk,
//    positions 0 and 7 are both painted, so the seam merge paints segment 7
//    as well. Marks have to be read off the run breakOpen was given, not the
//    normalised one.
const GEOMETRIC_LAYOUTS = {
  'closing segment painted': { start_live_index: 7, end_live_index: 8 },
  'closing segment bare': { start_live_index: 6, end_live_index: 7 },
};
function geometricLoop(layout: keyof typeof GEOMETRIC_LAYOUTS): DesignRun {
  return {
    id: 'L',
    polyline: {
      points: [...structuredClone(POINTS), [0, 0]],
      closed: false,
      segment_types: [...TYPES],
    },
    blockouts: [
      { start_live_index: 0, end_live_index: 2 },
      { ...GEOMETRIC_LAYOUTS[layout] },
    ],
    annotations: [
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 4 },
      { kind: 'drop_bend', live_index: 8 },
    ],
    bends: [{ live_index: 3 }, { live_index: 5 }],
  };
}

// What the code did before #181: rewrite the points, carry every mark through
// untouched. The negative control: the invariant must reject it.
function withMarksCarriedVerbatim(out: DesignRun, src: DesignRun): DesignRun {
  return { ...out, blockouts: src.blockouts, annotations: src.annotations, bends: src.bends };
}

// Breaking a loop open loses no glass: the new open walk ends on a duplicate
// of the break vertex, so every loop segment is still drawn. Nothing becomes
// an opening, nothing is dropped, so the mark geometry is equal full stop.
function expectSameGlass(src: DesignRun, k: number) {
  const before = markGeometry(src);
  const out = ops.breakOpen(docOf(src), 'L', k).runs[0];
  expect(out.polyline.closed).toBe(false);
  expect(ops.segmentTypesWellFormed(out)).toBe(true);
  const after = markGeometry(out);
  expect(after.annotations, `annotations, break at ${k}`).toEqual(before.annotations);
  expect(after.bends, `bends, break at ${k}`).toEqual(before.bends);
  expect(after.blocked, `painted glass, break at ${k}`).toEqual(before.blocked);
}

describe('breakOpen keeps every mark on the same glass (Tier 3 #181)', () => {
  describe('closed loop, no electrodes (closed walk)', () => {
    const src = loop();
    const before = markGeometry(src);

    it('fixture is not vacuous: the seam is painted, some glass is not, every mark resolves', () => {
      expect(before.blocked).toContain(segKey(src, N - 1, 0));
      expect(before.blocked).toHaveLength(5);
      expect(before.annotations).toHaveLength(4);
      expect(before.bends).toHaveLength(3);
    });

    for (let k = 0; k < N; k++) {
      it(`break at vertex ${k}`, () => expectSameGlass(src, k));
    }

    it('negative control: carrying the marks verbatim moves them on the glass', () => {
      for (const k of [1, 3, 5]) {
        const out = ops.breakOpen(docOf(src), 'L', k).runs[0];
        const old = markGeometry(withMarksCarriedVerbatim(out, src));
        expect(old.annotations, `break at ${k}`).not.toEqual(before.annotations);
        expect(old.bends, `break at ${k}`).not.toEqual(before.bends);
        expect(old.blocked, `break at ${k}`).not.toEqual(before.blocked);
      }
      // Even vertex 0, where every vertex keeps its index, was wrong for a
      // span through the seam: on the open walk [6, 1] can no longer wrap,
      // so it lost segment 0.
      const out0 = ops.breakOpen(docOf(src), 'L', 0).runs[0];
      const old0 = markGeometry(withMarksCarriedVerbatim(out0, src));
      expect(old0.annotations).toEqual(before.annotations);
      expect(old0.blocked).not.toEqual(before.blocked);
    });

    // The output walk is one position LONGER than the closed walk (it ends
    // on a duplicate), so an index the renderers skipped before — position
    // N on an N-vertex loop — would name real glass if carried verbatim.
    // A mark that named no glass is dropped rather than invented.
    it('drops a mark that was on no glass instead of letting it land on some', () => {
      const run = loop();
      run.annotations = [{ kind: 'support', live_index: N }];
      run.bends = [{ live_index: 1 }, { live_index: N }];
      const out = ops.breakOpen(docOf(run), 'L', 3).runs[0];
      expect(out.annotations).toEqual([]);
      expect(out.bends).toHaveLength(1);
    });
  });

  for (const direction of ['forward', 'backward'] as const) {
    describe(`closed loop, two electrodes, ${direction} walk`, () => {
      const src = electrodeLoop(direction);
      const before = markGeometry(src);

      it('fixture is not vacuous: the walk runs the intended way', () => {
        const live = runArcs(src).live;
        expect(live).toEqual(direction === 'forward' ? [1, 2, 3, 4] : [1, 0, 7, 6, 5, 4]);
        expect(before.blocked.length).toBeGreaterThan(0);
        expect(before.blocked.length).toBeLessThan(live.length - 1);
        expect(before.annotations).toHaveLength(3);
        expect(before.bends).toHaveLength(2);
      });

      for (let k = 0; k < N; k++) {
        it(`break at vertex ${k}`, () => expectSameGlass(src, k));
      }

      it('negative control: carrying the marks verbatim moves them on the glass', () => {
        // Vertex 1 is the first electrode, so a forward walk keeps its
        // numbering there; vertex 6 shifts both walks.
        const out = ops.breakOpen(docOf(src), 'L', 6).runs[0];
        const old = markGeometry(withMarksCarriedVerbatim(out, src));
        expect(old.annotations).not.toEqual(before.annotations);
        expect(old.bends).not.toEqual(before.bends);
        expect(old.blocked).not.toEqual(before.blocked);
      });
    });
  }

  for (const layout of Object.keys(GEOMETRIC_LAYOUTS) as (keyof typeof GEOMETRIC_LAYOUTS)[]) {
    describe(`geometric loop (open run ending on a copy of its start), ${layout}`, () => {
      const src = geometricLoop(layout);
      const before = markGeometry(src);

      it('fixture is not vacuous', () => {
        expect(ops.isGeometricLoop(src)).toBe(true);
        expect(before.blocked).toHaveLength(4);
        const closing = segKey(src, N - 1, N);
        if (layout === 'closing segment painted') expect(before.blocked).toContain(closing);
        else expect(before.blocked).not.toContain(closing);
        expect(before.annotations).toHaveLength(3);
        expect(before.bends).toHaveLength(2);
      });

      // Index N is the duplicate; breakOpen treats it as vertex 0.
      for (let k = 0; k <= N; k++) {
        it(`break at vertex ${k}`, () => expectSameGlass(src, k));
      }

      it('negative control: carrying the marks verbatim moves them on the glass', () => {
        const out = ops.breakOpen(docOf(src), 'L', 3).runs[0];
        const old = markGeometry(withMarksCarriedVerbatim(out, src));
        expect(old.annotations).not.toEqual(before.annotations);
        expect(old.bends).not.toEqual(before.bends);
        expect(old.blocked).not.toEqual(before.blocked);
      });
    });
  }
});
