import { describe, expect, it } from 'vitest';
import type { DesignRun, SegmentKind } from '../api';
import { flatRunPoints } from './arcGeom';
import { blockoutSegments, indicesToD } from './runArcs';

// Tier 3 #59 — closed-loop seam continuity. When a closed live arc
// has a blockout that straddles index 0, `blockoutSegments` used to
// emit two separate blockout segments (one at the head of the live
// arc, one at the tail). The fix recognizes wrap-straddle on a closed
// loop and merges first+last when they're BOTH blockouts. The merged
// `liveIndices` walks the polyline in traversal order through the
// wrap edge (n-1 -> 0), so the renderer draws one continuous painted
// arc, including the wrap edge that the pre-fix code dropped.
//
// The merge guard is conservative: only fires when both first and
// last are blockouts. A closed live loop with mid-loop blockouts
// (where first/last are both live) is left unchanged so existing docs
// render byte-identically — the latent wrap-edge gap between two
// adjacent live segments is not visible at the seam-share point and
// changing the segment count would break the identity invariant.

describe('blockoutSegments', () => {
  it('closed live arc with blockout straddling index 0 merges to 2 segments', () => {
    // 10-point closed live arc, blockout walks 8 -> 9 -> 0 -> 1 -> 2.
    // Without the fix: 3 segments (blockout [0..2], live [2..7],
    // blockout [7..9]) — the wrap edge 9 -> 0 is missing entirely.
    // With the fix: 2 segments. The merged blockout walks 7 -> 8 ->
    // 9 -> 0 -> 1 -> 2, including the wrap edge.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 8, end_live_index: 2 }],
      true,
    );
    expect(segs).toHaveLength(2);
    // Merged blockout is emitted first (the wrap-merge consumes both
    // ends and reinserts the merged result at position 0). Live
    // segment follows.
    expect(segs[0].isBlockout).toBe(true);
    expect(segs[0].liveIndices).toEqual([7, 8, 9, 0, 1, 2]);
    expect(segs[1].isBlockout).toBe(false);
    expect(segs[1].liveIndices).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('closed live arc with no blockouts is a single segment (unchanged)', () => {
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(liveIndices, [], true);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBlockout).toBe(false);
    expect(segs[0].liveIndices).toEqual(liveIndices);
  });

  it('closed live arc with one mid-loop blockout (no wrap) is unchanged', () => {
    // Blockout at [3..5] doesn't wrap. First and last segments are
    // both live; the merge guard short-circuits (only fires when both
    // ends are blockouts) so the 3-segment shape is preserved. This
    // is the identity invariant: closed loops without wrap-straddle
    // render byte-identically pre- and post-fix.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 3, end_live_index: 5 }],
      true,
    );
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.isBlockout)).toEqual([false, true, false]);
  });

  it('open live arc with a blockout near the start does not merge', () => {
    // Open arc: even though first segment is blockout, `liveClosed`
    // is false so the merge guard short-circuits and the 2-segment
    // shape is preserved (open polylines never wrap).
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 0, end_live_index: 2 }],
      false,
    );
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.isBlockout)).toEqual([true, false]);
  });

  it('closed live arc with two non-adjacent blockouts does not false-merge', () => {
    // Blockouts at [3..5] and [7..8] — neither wraps. First and last
    // segments are both LIVE, so the merge guard short-circuits (only
    // fires when both ends are blockouts). The 5-segment shape is
    // preserved.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [
        { start_live_index: 3, end_live_index: 5 },
        { start_live_index: 7, end_live_index: 8 },
      ],
      true,
    );
    expect(segs.map((s) => s.isBlockout)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it('closed live arc with wrap-blockout AND mid-loop blockout merges only the wrap pair', () => {
    // Blockouts: wrap-straddle [8..2] AND mid-loop [4..5]. Pre-merge
    // emits 5 segments [block[0,1,2], live[2,3], block[3,4,5],
    // live[5,6,7], block[7,8,9]]. The wrap-merge collapses the two
    // end blockouts (both isBlockout=true) into one segment that
    // walks 7 -> 8 -> 9 -> 0 -> 1 -> 2. The mid-loop blockout is
    // left alone. Result: 4 segments, pattern T,F,T,F.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [
        { start_live_index: 8, end_live_index: 2 },
        { start_live_index: 4, end_live_index: 5 },
      ],
      true,
    );
    expect(segs).toHaveLength(4);
    expect(segs.map((s) => s.isBlockout)).toEqual([true, false, true, false]);
    expect(segs[0].liveIndices).toEqual([7, 8, 9, 0, 1, 2]);
  });
});

// Bug #18 — a closed run's CLOSING segment (the one leaving points[n-1] and
// arriving back at points[0]) carries a type like every other segment, and
// setSegmentType exposes it: a full circle drawn as four arcs is exactly that
// shape. `indicesToD` used to emit a bare `Z` for it, so the canvas drew a
// straight chord while flatRunPoints — and therefore the arc-aware run length
// (Tier 3 #111) and the curve-aware hit test (Tier 3 #87) — already walked the
// curve.
//
// The numbers here are the ones internal/designdoc/convert_test.go pins on the
// Go side. The editor draws from indicesToD; the validator, the print pattern
// and the DXF derive from emitPath. When the two drift the operator is shown
// one shape and handed another.

// One 100 mm chord replaced by its arc: r = 0.625 * chord, length =
// r * 4*atan(0.5) = 115.9119 mm. arcGeom.test.ts pins the 1.15911 ratio itself.
const BUG18_ARC_MM = 115.9119;

// Walk an emitted `d`, flattening cubics, and return the drawn length. This is
// the point of the test: measure what was DRAWN, not what the doc says. A
// vertex-or-chord measurement is exactly the thing that reported 447.69 for
// both of the runs below while they differed by a whole arc.
function drawnLengthMM(d: string, samplesPerCubic = 256): number {
  const toks = d.split(' ');
  let i = 0;
  const num = () => Number(toks[i++]);
  let cur: [number, number] = [0, 0];
  let subStart: [number, number] = [0, 0];
  let total = 0;
  const step = (p: [number, number]) => {
    total += Math.hypot(p[0] - cur[0], p[1] - cur[1]);
    cur = p;
  };
  while (i < toks.length) {
    const cmd = toks[i][0];
    if (cmd === 'Z') {
      // Z is a straight line home. After a drawn closing arc the pen is
      // already there and it costs nothing — which is the fix in one line.
      step(subStart);
      i++;
      continue;
    }
    toks[i] = toks[i].slice(1); // strip the command letter off its first number
    if (cmd === 'M') {
      cur = [num(), num()];
      subStart = cur;
    } else if (cmd === 'L') {
      step([num(), num()]);
    } else if (cmd === 'C') {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), x = num(), y = num();
      const p0 = cur;
      for (let s = 1; s <= samplesPerCubic; s++) {
        const u = s / samplesPerCubic;
        const m = 1 - u;
        step([
          m ** 3 * p0[0] + 3 * m * m * u * c1x + 3 * m * u * u * c2x + u ** 3 * x,
          m ** 3 * p0[1] + 3 * m * m * u * c1y + 3 * m * u * u * c2y + u ** 3 * y,
        ]);
      }
    } else {
      throw new Error(`unexpected path token ${toks[i]}`);
    }
  }
  return total;
}

function closedSquare(types?: SegmentKind[]): DesignRun {
  return {
    id: 'sq',
    polyline: {
      points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      closed: true,
      ...(types ? { segment_types: types } : {}),
    },
  } as unknown as DesignRun;
}

function squareD(types?: SegmentKind[]): string {
  const run = closedSquare(types);
  return indicesToD([0, 1, 2, 3], run.polyline.points, true, run);
}

describe("indicesToD honours a closed run's closing segment (Bug #18)", () => {
  it('draws the closing arc instead of a straight Z', () => {
    const allArc = squareD(['arc', 'arc', 'arc', 'arc']);
    const openArc = squareD(['arc', 'arc', 'arc', 'line']);

    // The bug in one assertion: four arcs used to draw — and measure —
    // identically to three arcs plus a straight closing chord.
    expect(allArc).not.toBe(openArc);
    expect(drawnLengthMM(allArc) - drawnLengthMM(openArc)).toBeCloseTo(BUG18_ARC_MM - 100, 2);

    // Both paths still close.
    expect(allArc.endsWith(' Z')).toBe(true);
    expect(openArc.endsWith(' Z')).toBe(true);
    // Two cubics per arc, so the closing arc is the difference between them.
    expect(allArc.split('C').length - 1).toBe(8);
    expect(openArc.split('C').length - 1).toBe(6);
  });

  it('agrees with flatRunPoints, which already walked the closing arc', () => {
    for (const types of [
      ['arc', 'arc', 'arc', 'arc'],
      ['arc', 'arc', 'arc', 'line'],
      ['line', 'line', 'line', 'arc'],
      ['line', 'line', 'line', 'arc_r'],
    ] as SegmentKind[][]) {
      const run = closedSquare(types);
      const arcs = types.filter((t) => t === 'arc' || t === 'arc_r').length;
      const want = arcs * BUG18_ARC_MM + (4 - arcs) * 100;
      const drawn = drawnLengthMM(squareD(types));
      expect(drawn).toBeCloseTo(want, 2);

      // flatRunPoints is a coarser sampler (5 degree steps, so it reads a hair
      // short), but drawn and measured must land on the same glass — that
      // agreement is the whole point of the fix.
      const fp = flatRunPoints(run);
      let flat = 0;
      for (let i = 1; i < fp.length; i++) {
        flat += Math.hypot(fp[i][0] - fp[i - 1][0], fp[i][1] - fp[i - 1][1]);
      }
      expect(Math.abs(drawn - flat)).toBeLessThan(0.2);
    }
  });

  it('draws the two sides of a closing arc differently', () => {
    // arc and arc_r are mirror images: same length, opposite bow. They must not
    // collapse to the same path.
    expect(squareD(['line', 'line', 'line', 'arc'])).not.toBe(
      squareD(['line', 'line', 'line', 'arc_r']),
    );
  });

  it('leaves a straight closing segment byte-identical', () => {
    // Negative control — the back-compat invariant for every existing doc.
    expect(squareD()).toBe('M0 0 L100 0 L100 100 L0 100 Z');
    expect(squareD(['line', 'line', 'line', 'line'])).toBe('M0 0 L100 0 L100 100 L0 100 Z');
    expect(squareD(['arc', 'line', 'line', 'line']).endsWith('L0 100 Z')).toBe(true);
  });

  it('closes a two-point loop with its own segment, not a retrace', () => {
    // The one case where asking segmentIndexBetween for the closing step gives
    // the wrong answer: its `b === a - 1` case wins over the wrap case at
    // n === 2 and returns segment 0 reversed, which retraces the outbound arc.
    // Taking n-1 directly (as flatRunPoints does) draws the closing arc, and
    // because each bows left of its OWN travel the two make a lens.
    const run = {
      id: 'lens',
      polyline: {
        points: [[0, 0], [100, 0]],
        closed: true,
        segment_types: ['arc', 'arc'],
      },
    } as unknown as DesignRun;
    const d = indicesToD([0, 1], run.polyline.points, true, run);
    expect(drawnLengthMM(d)).toBeCloseTo(2 * BUG18_ARC_MM, 2);
    // A retrace would leave every sample on one side of the chord.
    const fp = flatRunPoints(run);
    expect(Math.min(...fp.map((p) => p[1]))).toBeLessThan(-24);
    expect(Math.max(...fp.map((p) => p[1]))).toBeGreaterThan(24);
  });

  it('leaves the walk unclosed when the caller says it is open', () => {
    // The inactive half of an electrode-split loop is drawn open, and the
    // closing segment is not part of it.
    const run = closedSquare(['arc', 'arc', 'arc', 'arc']);
    const open = indicesToD([0, 1, 2, 3], run.polyline.points, false, run);
    expect(open).not.toContain('Z');
    expect(open.split('C').length - 1).toBe(6);
  });
});
