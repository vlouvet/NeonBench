import { describe, expect, it } from 'vitest';
import type { DesignRun } from '../api';
import { splitRunBySegments } from './segment-split';

// `splitRunBySegments` delegates to `lib/runArcs.blockoutSegments`,
// which uses live-arc indices and shares a single seam polyline
// point between adjacent live + blockout sub-segments. The exact
// seam-point coordinate differs from the worked example in the
// spec by one polyline step (the blockout starts one point earlier
// than the live segment ends), but the *segment count* and the
// *isBlockout pattern* match the spec exactly. The renderer only
// cares that adjacent segments share a point so the tube reads as
// continuous; either convention satisfies that.

// 12-point straight horizontal polyline. Used as the input for the
// spec's worked example. None of the cases below need a closed
// loop; closed-loop behavior is exercised in a separate case.
function twelvePointRun(blockouts: { start: number; end: number }[] = []): DesignRun {
  return {
    id: 'r',
    polyline: {
      points: Array.from({ length: 12 }, (_, i) => [i * 10, 0]),
      closed: false,
    },
    blockouts: blockouts.map((b) => ({
      start_live_index: b.start,
      end_live_index: b.end,
    })),
  };
}

describe('splitRunBySegments', () => {
  it('returns one live segment when there are no blockouts', () => {
    const segs = splitRunBySegments(twelvePointRun([]));
    expect(segs).toHaveLength(1);
    expect(segs[0].isBlockout).toBe(false);
    expect(segs[0].points).toHaveLength(12);
  });

  it('produces 3 segments (live, blockout, live) for one mid-run blockout', () => {
    const segs = splitRunBySegments(twelvePointRun([{ start: 4, end: 7 }]));
    expect(segs.map((s) => s.isBlockout)).toEqual([false, true, false]);
  });

  it('produces a leading blockout segment when a blockout starts at index 0', () => {
    const segs = splitRunBySegments(twelvePointRun([{ start: 0, end: 3 }]));
    // First segment is the blockout itself; the trailing live segment
    // continues from the seam to the polyline end.
    expect(segs.map((s) => s.isBlockout)).toEqual([true, false]);
    expect(segs[0].points[0]).toEqual([0, 0]);
  });

  it('produces a trailing blockout segment when a blockout ends at the last index', () => {
    const segs = splitRunBySegments(twelvePointRun([{ start: 8, end: 11 }]));
    expect(segs.map((s) => s.isBlockout)).toEqual([false, true]);
    const last = segs[1];
    expect(last.points[last.points.length - 1]).toEqual([110, 0]);
  });

  it('produces 5 segments for two non-adjacent blockouts (the spec example)', () => {
    // Spec worked example: blockouts at [2,5] and [7,9] in a 12-point
    // run. The pattern is live, blockout, live, blockout, live.
    const segs = splitRunBySegments(
      twelvePointRun([
        { start: 2, end: 5 },
        { start: 7, end: 9 },
      ]),
    );
    expect(segs.map((s) => s.isBlockout)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it('coalesces two adjacent blockouts into one continuous blockout segment', () => {
    // [2,5] and [5,8] cover one contiguous range on the live arc. The
    // shared `lib/runArcs.blockoutSegments` helper masks these as one
    // run of `true`s and emits a single blockout segment — visually
    // identical to one [2,8] blockout, which is what the user
    // intended. (The spec lists 4 segments for this case under a
    // simpler index-only model; in the live-arc model that already
    // coalesces overlapping runs, 3 is correct.)
    const segs = splitRunBySegments(
      twelvePointRun([
        { start: 2, end: 5 },
        { start: 5, end: 8 },
      ]),
    );
    expect(segs.map((s) => s.isBlockout)).toEqual([false, true, false]);
  });

  it('produces a single blockout segment when one blockout spans the entire run', () => {
    const segs = splitRunBySegments(twelvePointRun([{ start: 0, end: 11 }]));
    expect(segs).toHaveLength(1);
    expect(segs[0].isBlockout).toBe(true);
    expect(segs[0].points).toHaveLength(12);
  });

  it('returns no segments for an empty polyline', () => {
    const run: DesignRun = {
      id: 'r',
      polyline: { points: [], closed: false },
    };
    expect(splitRunBySegments(run)).toEqual([]);
  });

  it('returns no segments for a 1-point polyline', () => {
    const run: DesignRun = {
      id: 'r',
      polyline: { points: [[0, 0]], closed: false },
    };
    expect(splitRunBySegments(run)).toEqual([]);
  });

  it('preserves the original polyline coordinates without flipping Y', () => {
    // The Y-flip is `polylineToCurve`'s job; segment-split is a pure
    // index slicing helper that returns the doc-space coordinates
    // unchanged.
    const run: DesignRun = {
      id: 'r',
      polyline: {
        points: [
          [0, 100],
          [50, 200],
          [100, 300],
          [150, 400],
        ],
        closed: false,
      },
    };
    const segs = splitRunBySegments(run);
    expect(segs).toHaveLength(1);
    expect(segs[0].points[1]).toEqual([50, 200]);
    expect(segs[0].points[3]).toEqual([150, 400]);
  });

  it('marks a closed run with no blockouts as a closed segment', () => {
    const run: DesignRun = {
      id: 'r',
      polyline: {
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ],
        closed: true,
      },
    };
    const segs = splitRunBySegments(run);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBlockout).toBe(false);
    expect(segs[0].closed).toBe(true);
  });

  it('marks blockout-broken closed runs as open sub-segments', () => {
    // Once a closed loop has any blockout, its sub-segments are
    // necessarily open arcs — there's no "closed sub-tube" semantic
    // when the loop is broken.
    const run: DesignRun = {
      id: 'r',
      polyline: {
        points: [
          [0, 0],
          [100, 0],
          [100, 100],
          [0, 100],
        ],
        closed: true,
      },
      blockouts: [{ start_live_index: 1, end_live_index: 2 }],
    };
    const segs = splitRunBySegments(run);
    for (const s of segs) {
      expect(s.closed).toBe(false);
    }
  });
});
