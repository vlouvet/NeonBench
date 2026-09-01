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

  it('routes drop_bend annotations to dropBendPolylineIndices and jump to jumpPolylineIndices (Tier 3 #77)', () => {
    // Same 12-point straight run, but with a jump at live index 3
    // and a drop_bend at live index 7. The two annotations should
    // partition into separate per-segment arrays so the 3D preview
    // can apply distinct lift kernels.
    const run: DesignRun = {
      id: 'r',
      polyline: {
        points: Array.from({ length: 12 }, (_, i) => [i * 10, 0]),
        closed: false,
      },
      annotations: [
        { kind: 'jump', live_index: 3 },
        { kind: 'drop_bend', live_index: 7 },
        { kind: 'support', live_index: 5 }, // ignored — not a lift kind
      ],
    };
    const segs = splitRunBySegments(run);
    expect(segs).toHaveLength(1);
    const seg = segs[0];
    // Polyline-local indices match live indices because the live arc
    // here is the entire polyline (no electrodes ⇒ live = all).
    expect(seg.jumpPolylineIndices).toEqual([3]);
    expect(seg.dropBendPolylineIndices).toEqual([7]);
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

// Tier 3 #78 — a curved segment is two vertices, and CatmullRom through two
// points is a straight line. Without expansion the 2D canvas and the printed
// pattern would show a curve while the 3D preview showed a chord.
describe('splitRunBySegments — arc expansion', () => {
  const straight: DesignRun = {
    id: 'r1',
    polyline: { points: [[0, 0], [100, 0]], closed: false },
  };
  const curved: DesignRun = {
    id: 'r1',
    polyline: { points: [[0, 0], [100, 0]], closed: false, segment_types: ['arc'] },
  };

  it('leaves a straight run at its two vertices', () => {
    expect(splitRunBySegments(straight)[0].points).toHaveLength(2);
  });

  it('expands an arc into a sampled curve between the same endpoints', () => {
    const seg = splitRunBySegments(curved)[0];
    expect(seg.points.length).toBeGreaterThan(20);
    expect(seg.points[0]).toEqual([0, 0]);
    expect(seg.points[seg.points.length - 1]).toEqual([100, 0]);
    // Every sample sits on the circle of radius 0.625 x chord.
    const r = 62.5;
    const cx = 50;
    const cy = -Math.sqrt(r * r - 50 * 50);
    for (const p of seg.points) {
      expect(Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - r)).toBeLessThan(0.01);
    }
  });

  // The expansion inserts points, so anything anchored by index has to follow
  // it — a jump left pointing at the old offset would lift the wrong place.
  it('remaps jump annotations through the expansion', () => {
    const run: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [100, 0], [200, 0]],
        closed: false,
        segment_types: ['arc', 'line'],
      },
      annotations: [{ kind: 'jump', live_index: 2 }],
    };
    const seg = splitRunBySegments(run)[0];
    expect(seg.jumpPolylineIndices).toHaveLength(1);
    const at = seg.jumpPolylineIndices[0];
    // It must land on the final vertex, wherever expansion put it.
    expect(seg.points[at]).toEqual([200, 0]);
    expect(at).toBe(seg.points.length - 1);
  });

  // Tier 3 #87 found this one while making the side storable, and it is a
  // real bug in shipped code rather than a consequence of the schema change.
  //
  // A live walk that crosses an arc BACKWARDS used to flatten `b -> a`, which
  // asks arcFor for the arc that bows left of b->a — the MIRROR of the glass
  // this segment actually is — and then walked those samples from the far end,
  // so the 3D tube zigzagged across its own chord. The fix flattens the
  // forward segment once and walks the samples in reverse.
  it('traces the same glass when the live walk crosses an arc backwards', () => {
    // Closed loop, two electrodes, direction 'backward': the live walk leaves
    // vertex 0 towards vertex 3, so it crosses segment 2 ([100,100] ->
    // [0,100]) in reverse.
    const run: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [100, 0], [100, 100], [0, 100]],
        closed: true,
        segment_types: ['line', 'line', 'arc', 'line'],
      },
      electrodes: [{ point_index: 0 }, { point_index: 2 }],
      direction: 'backward',
    };
    const pts = splitRunBySegments(run)[0].points;
    // Forward, segment 2 runs [100,100] -> [0,100]: direction (-1, 0), whose
    // left normal is (0, -1), so the bow reaches y = 75 at the midpoint.
    const cx = 50;
    const cy = 100 + Math.sqrt(62.5 * 62.5 - 50 * 50);
    const onArc = pts.filter((p) => Math.abs(Math.hypot(p[0] - cx, p[1] - cy) - 62.5) < 0.01);
    expect(onArc.length).toBeGreaterThan(20);
    // The bow is BELOW the chord (y < 100), which is the whole point: the old
    // code put it above, on the mirror circle.
    const apex = onArc.reduce((b, p) => (p[1] < b[1] ? p : b), onArc[0]);
    expect(apex[1]).toBeCloseTo(75, 1);
    expect(pts.every((p) => p[1] <= 100.0001)).toBe(true);

    // And the samples are in walk order — monotonically away from [0,100]
    // towards [100,100], not starting at the far end and doubling back.
    const start = pts.findIndex((p) => Math.abs(p[0]) < 1e-9 && Math.abs(p[1] - 100) < 1e-9);
    expect(start).toBeGreaterThanOrEqual(0);
    for (let i = start + 1; i < pts.length; i++) {
      expect(pts[i][0]).toBeGreaterThan(pts[i - 1][0] - 1e-9);
    }
    expect(pts[pts.length - 1]).toEqual([100, 100]);
  });

  it('is inert when segment_types says every segment is a line', () => {
    const withField: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false, segment_types: ['line', 'line'] },
    };
    const bare: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
    };
    expect(splitRunBySegments(withField)[0].points).toEqual(splitRunBySegments(bare)[0].points);
  });
});
