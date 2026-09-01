import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints } from './arcGeom';
import * as arrange from './arrange';

const EPS = 1e-9;

function rect(id: string, x: number, y: number, w: number, h: number): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      closed: true,
    },
  };
}

function docOf(...runs: DesignRun[]): DesignDoc {
  return { version: 1, view_box_mm: [0, 0, 500, 500], runs };
}

// An OPEN run whose single segment is an arc. The chord runs left-to-right
// along y = 0, so at ARC_BULGE 0.5 the arc bows to sagitta = chord/4 on the
// (-dy, dx) side — i.e. +y, well outside the hull of its two vertices.
function arcRun(id = 'arc'): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [0, 0],
        [40, 0],
      ],
      closed: false,
      segment_types: ['arc'],
    },
  };
}

function pointsClose(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= EPS && Math.abs(a[1] - b[1]) <= EPS;
}

// Compare two flattened polylines as POINT SETS. Mirroring a run that has arc
// segments has to reverse its vertex order (see arrange.ts), which reverses —
// and, on a closed run, rotates, changing which vertex is the duplicated
// seam — the flattened sequence. So sequence order is not the invariant; the
// set of sampled points is.
function expectSamePointSet(
  got: [number, number][],
  want: [number, number][],
): void {
  expect(got.length).toBe(want.length);
  const missing = (a: [number, number][], b: [number, number][]) =>
    a.filter((p) => !b.some((q) => pointsClose(p, q)));
  const notInWant = missing(got, want);
  const notInGot = missing(want, got);
  if (notInWant.length > 0 || notInGot.length > 0) {
    throw new Error(
      `flattened point sets differ.\n  in got, not want: ${JSON.stringify(notInWant.slice(0, 4))}` +
        `\n  in want, not got: ${JSON.stringify(notInGot.slice(0, 4))}`,
    );
  }
}

// Stronger form for OPEN runs, where reversal maps the flattened sequence
// exactly onto its reverse — no seam rotation to wash the ordering out.
function expectReversedSequence(
  got: [number, number][],
  want: [number, number][],
): void {
  expect(got.length).toBe(want.length);
  const rev = want.slice().reverse();
  for (let i = 0; i < got.length; i++) {
    expect(got[i][0]).toBeCloseTo(rev[i][0], 9);
    expect(got[i][1]).toBeCloseTo(rev[i][1], 9);
  }
}

describe('runBBoxMM', () => {
  it('is arc-aware — the box contains the bow, not just the vertices', () => {
    const b = arrange.runBBoxMM(arcRun())!;
    // Vertices alone would give a zero-height box on y = 0.
    expect(b.minX).toBeCloseTo(0, 9);
    expect(b.maxX).toBeCloseTo(40, 9);
    expect(b.minY).toBeCloseTo(0, 9);
    // Sagitta is chord/4 = 10mm, on the +y side for a left-to-right chord.
    expect(b.maxY).toBeGreaterThan(9.9);
    expect(b.maxY).toBeCloseTo(10, 6);
  });

  it('falls back to the vertex hull when the run has no arcs', () => {
    const b = arrange.runBBoxMM(rect('r', 5, 7, 10, 20))!;
    expect(b).toEqual({ minX: 5, minY: 7, maxX: 15, maxY: 27 });
  });

  it('unions per-run boxes for a selection', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 50, 20, 10, 10));
    expect(arrange.selectionBBoxMM(doc, ['a', 'b'])).toEqual({
      minX: 0,
      minY: 0,
      maxX: 60,
      maxY: 30,
    });
    expect(arrange.selectionBBoxMM(doc, ['nope'])).toBeNull();
  });
});

describe('alignRuns', () => {
  // a: x 0..10,  y 0..10
  // b: x 20..30, y 40..60
  // c: x 50..90, y 5..15
  // selection bbox: x 0..90, y 0..60 (centre 45, 30)
  const base = () =>
    docOf(rect('a', 0, 0, 10, 10), rect('b', 20, 40, 10, 20), rect('c', 50, 5, 40, 10));

  const boxOf = (doc: DesignDoc, id: string) =>
    arrange.runBBoxMM(doc.runs.find((r) => r.id === id)!)!;

  it('left pins every run to the selection minX', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'left');
    for (const id of ['a', 'b', 'c']) expect(boxOf(out, id).minX).toBeCloseTo(0, 9);
    // Vertical position is untouched.
    expect(boxOf(out, 'b').minY).toBeCloseTo(40, 9);
  });

  it('right pins every run to the selection maxX', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'right');
    for (const id of ['a', 'b', 'c']) expect(boxOf(out, id).maxX).toBeCloseTo(90, 9);
  });

  it('hcenter centres every run on x = 45', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'hcenter');
    for (const id of ['a', 'b', 'c']) {
      const b = boxOf(out, id);
      expect((b.minX + b.maxX) / 2).toBeCloseTo(45, 9);
    }
    expect(boxOf(out, 'a').minX).toBeCloseTo(40, 9);
    expect(boxOf(out, 'c').minX).toBeCloseTo(25, 9);
  });

  it('top pins every run to the selection minY', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'top');
    for (const id of ['a', 'b', 'c']) expect(boxOf(out, id).minY).toBeCloseTo(0, 9);
    expect(boxOf(out, 'b').minX).toBeCloseTo(20, 9);
  });

  it('bottom pins every run to the selection maxY', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'bottom');
    for (const id of ['a', 'b', 'c']) expect(boxOf(out, id).maxY).toBeCloseTo(60, 9);
  });

  it('vcenter centres every run on y = 30', () => {
    const out = arrange.alignRuns(base(), ['a', 'b', 'c'], 'vcenter');
    for (const id of ['a', 'b', 'c']) {
      const b = boxOf(out, id);
      expect((b.minY + b.maxY) / 2).toBeCloseTo(30, 9);
    }
  });

  it('aligns against the arc-aware box, so an arc run lands by its bow', () => {
    // The arc run's true box is y 0..10; its vertices are both on y = 0.
    const doc = docOf(rect('a', 0, 50, 10, 10), arcRun('arc'));
    const out = arrange.alignRuns(doc, ['a', 'arc'], 'bottom');
    const b = arrange.runBBoxMM(out.runs.find((r) => r.id === 'arc')!)!;
    expect(b.maxY).toBeCloseTo(60, 6);
    // Vertices sit 10mm ABOVE the aligned bottom edge, not on it.
    expect(out.runs.find((r) => r.id === 'arc')!.polyline.points[0][1]).toBeCloseTo(50, 6);
  });

  it('is a no-op for fewer than two runs, returning the same doc object', () => {
    const doc = base();
    expect(arrange.alignRuns(doc, ['a'], 'left')).toBe(doc);
    expect(arrange.alignRuns(doc, [], 'left')).toBe(doc);
  });

  it('returns the same doc when everything is already aligned', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 0, 40, 10, 10));
    expect(arrange.alignRuns(doc, ['a', 'b'], 'left')).toBe(doc);
  });
});

describe('distributeRuns', () => {
  // Centres on x: 5, 15, 60, 105. Extremes 5 and 105 pin; interior lands on
  // 5 + 100/3 = 38.333… and 5 + 200/3 = 71.666…
  const base = () =>
    docOf(
      rect('a', 0, 0, 10, 10),
      rect('b', 10, 0, 10, 10),
      rect('c', 50, 0, 20, 10),
      rect('d', 100, 0, 10, 10),
    );

  const centreX = (doc: DesignDoc, id: string) => {
    const b = arrange.runBBoxMM(doc.runs.find((r) => r.id === id)!)!;
    return (b.minX + b.maxX) / 2;
  };

  it('spaces interior centres evenly and leaves the extremes alone', () => {
    const doc = base();
    const out = arrange.distributeRuns(doc, ['a', 'b', 'c', 'd'], 'h');
    expect(centreX(out, 'a')).toBeCloseTo(5, 9);
    expect(centreX(out, 'b')).toBeCloseTo(5 + 100 / 3, 9);
    expect(centreX(out, 'c')).toBeCloseTo(5 + 200 / 3, 9);
    expect(centreX(out, 'd')).toBeCloseTo(105, 9);
    // The pinned extremes come back as the SAME objects, not clones that
    // happen to hold equal numbers.
    expect(out.runs[0]).toBe(doc.runs[0]);
    expect(out.runs[3]).toBe(doc.runs[3]);
  });

  it('never moves the extremes on the other axis either', () => {
    const doc = docOf(
      rect('a', 0, 0, 10, 10),
      rect('b', 0, 5, 10, 10),
      rect('c', 0, 90, 10, 10),
    );
    const out = arrange.distributeRuns(doc, ['a', 'b', 'c'], 'v');
    const cy = (id: string) => {
      const b = arrange.runBBoxMM(out.runs.find((r) => r.id === id)!)!;
      return (b.minY + b.maxY) / 2;
    };
    expect(cy('a')).toBeCloseTo(5, 9);
    expect(cy('b')).toBeCloseTo(50, 9);
    expect(cy('c')).toBeCloseTo(95, 9);
    // x is untouched.
    expect(out.runs.find((r) => r.id === 'b')!.polyline.points[0][0]).toBe(0);
  });

  it('is a no-op for fewer than three runs, returning the same doc object', () => {
    const doc = base();
    expect(arrange.distributeRuns(doc, ['a', 'b'], 'h')).toBe(doc);
    expect(arrange.distributeRuns(doc, ['a'], 'v')).toBe(doc);
  });

  it('is idempotent — a second pass changes nothing', () => {
    const once = arrange.distributeRuns(base(), ['a', 'b', 'c', 'd'], 'h');
    expect(arrange.distributeRuns(once, ['a', 'b', 'c', 'd'], 'h')).toBe(once);
  });
});

describe('mirrorRuns — the arc-handedness invariant', () => {
  // This is the test the whole slice hangs on. `arcFor` bows toward the chord
  // normal (-dy, dx), a handedness-dependent side, so a naive coordinate flip
  // leaves the vertices right and every arc bowing the wrong way. Comparing
  // FLATTENED points is what catches it; comparing polyline.points does not.
  const mirrorPts = (
    pts: [number, number][],
    axis: 'h' | 'v',
    cx: number,
    cy: number,
  ): [number, number][] =>
    pts.map(([x, y]): [number, number] => (axis === 'h' ? [2 * cx - x, y] : [x, 2 * cy - y]));

  for (const axis of ['h', 'v'] as const) {
    it(`mirror '${axis}' of an ARC run flattens to the mirror of the original`, () => {
      const doc = docOf(arcRun('arc'));
      const before = doc.runs[0];
      const box = arrange.runBBoxMM(before)!;
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;

      const out = arrange.mirrorRuns(doc, ['arc'], axis);
      const after = out.runs[0];

      const want = mirrorPts(flatRunPoints(before), axis, cx, cy);
      expectSamePointSet(flatRunPoints(after), want);
      // The run is open, so the ordering invariant holds too.
      expectReversedSequence(flatRunPoints(after), want);

      // Sanity: a naive coordinate flip WOULD pass a vertex-only check
      // (both vertices stay put under an 'h' mirror about the centre), so
      // assert the flattened check had teeth — the arc still bows 10mm, and
      // it bows on the mirrored side.
      const ab = arrange.runBBoxMM(after)!;
      expect(ab.maxY - ab.minY).toBeCloseTo(10, 6);
      expect(ab.maxX - ab.minX).toBeCloseTo(40, 6);
    });

    it(`mirror '${axis}' of a LINE-only run flattens to the mirror of the original`, () => {
      const doc = docOf(rect('a', 3, 7, 11, 23));
      const before = doc.runs[0];
      const box = arrange.runBBoxMM(before)!;
      const cx = (box.minX + box.maxX) / 2;
      const cy = (box.minY + box.maxY) / 2;

      const out = arrange.mirrorRuns(doc, ['a'], axis);
      expectSamePointSet(
        flatRunPoints(out.runs[0]),
        mirrorPts(flatRunPoints(before), axis, cx, cy),
      );
    });
  }

  it('mirrors a MIXED run (arc + line segments) correctly', () => {
    const run: DesignRun = {
      id: 'mixed',
      polyline: {
        points: [
          [0, 0],
          [30, 0],
          [30, 40],
          [0, 40],
        ],
        closed: true,
        segment_types: ['arc', 'line', 'line', 'line'],
      },
    };
    const doc = docOf(run);
    const box = arrange.runBBoxMM(run)!;
    const cx = (box.minX + box.maxX) / 2;
    const out = arrange.mirrorRuns(doc, ['mixed'], 'h');
    expectSamePointSet(
      flatRunPoints(out.runs[0]),
      flatRunPoints(run).map(([x, y]): [number, number] => [2 * cx - x, y]),
    );
    // Segment types on a CLOSED run are reversed AND shifted, not plainly
    // reversed: index i is the segment LEAVING vertex i, so new segment j is
    // old segment (n-2-j) mod n. A plain `.reverse()` would answer
    // ['line','line','line','arc'] and put the curve on the wrong side.
    expect(out.runs[0].polyline.segment_types).toEqual(['line', 'line', 'arc', 'line']);
  });

  it('reverses an open arc run’s segment_types by plain reversal', () => {
    const run: DesignRun = {
      id: 'open',
      polyline: {
        points: [
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0],
        ],
        closed: false,
        segment_types: ['arc', 'line', 'arc'],
      },
    };
    const out = arrange.mirrorRuns(docOf(run), ['open'], 'h');
    expect(out.runs[0].polyline.segment_types).toEqual(['arc', 'line', 'arc']);
    const other: DesignRun = {
      ...run,
      polyline: { ...run.polyline, segment_types: ['arc', 'arc', 'line'] },
    };
    const out2 = arrange.mirrorRuns(docOf(other), ['open'], 'h');
    expect(out2.runs[0].polyline.segment_types).toEqual(['line', 'arc', 'arc']);
  });

  for (const axis of ['h', 'v'] as const) {
    it(`mirroring '${axis}' twice is the identity for an arc run`, () => {
      const doc = docOf(arcRun('arc'), rect('r', 100, 100, 10, 10));
      const once = arrange.mirrorRuns(doc, ['arc', 'r'], axis);
      const twice = arrange.mirrorRuns(once, ['arc', 'r'], axis);
      for (let i = 0; i < doc.runs.length; i++) {
        const a = doc.runs[i];
        const b = twice.runs[i];
        expect(b.polyline.points.length).toBe(a.polyline.points.length);
        for (let j = 0; j < a.polyline.points.length; j++) {
          expect(b.polyline.points[j][0]).toBeCloseTo(a.polyline.points[j][0], 9);
          expect(b.polyline.points[j][1]).toBeCloseTo(a.polyline.points[j][1], 9);
        }
        expect(b.polyline.segment_types).toEqual(a.polyline.segment_types);
      }
    });
  }

  it('carries electrodes, blockouts, annotations and bends across the reversal', () => {
    const run: DesignRun = {
      id: 'deco',
      polyline: {
        points: [
          [0, 0],
          [10, 0],
          [20, 0],
          [30, 0],
          [40, 0],
        ],
        closed: false,
        segment_types: ['arc', 'line', 'line', 'line'],
      },
      electrodes: [{ point_index: 0 }, { point_index: 4 }],
      blockouts: [{ start_live_index: 0, end_live_index: 1 }],
      annotations: [{ kind: 'support', live_index: 3 }],
      bends: [{ live_index: 1 }],
    };
    const out = arrange.mirrorRuns(docOf(run), ['deco'], 'h').runs[0];
    // n = 5, so vertex i -> 4 - i; the live arc is the whole polyline, so
    // live positions flip the same way.
    expect(out.electrodes).toEqual([{ point_index: 4 }, { point_index: 0 }]);
    expect(out.blockouts).toEqual([{ start_live_index: 3, end_live_index: 4 }]);
    expect(out.annotations).toEqual([{ kind: 'support', live_index: 1 }]);
    expect(out.bends).toEqual([{ live_index: 3 }]);
    // Untouched identity / override fields.
    expect(out.id).toBe('deco');
  });

  it('flips an explicit direction so a closed loop keeps the same live arc', () => {
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push([50 + 20 * Math.cos(a), 50 + 20 * Math.sin(a)]);
    }
    const run: DesignRun = {
      id: 'loop',
      polyline: { points: pts, closed: true, segment_types: pts.map(() => 'arc') },
      electrodes: [{ point_index: 0 }, { point_index: 3 }],
      direction: 'forward',
      annotations: [{ kind: 'jump', live_index: 2 }],
    };
    const out = arrange.mirrorRuns(docOf(run), ['loop'], 'h').runs[0];
    expect(out.direction).toBe('backward');
    // Live positions are preserved because the direction flip undoes the
    // vertex renumbering; the annotation stays on the same physical glass.
    expect(out.annotations).toEqual([{ kind: 'jump', live_index: 2 }]);
  });

  it('leaves identity and override fields untouched', () => {
    const run: DesignRun = {
      ...arcRun('keep'),
      group_id: 'g1',
      raceway_id: 'rw1',
      kind: 'jumper',
      is_channel_letter_face: true,
      channel_letter_depth_mm: 90,
      color: 'ruby',
      tube_diameter_mm: 12,
      notes: 'hello',
    };
    const out = arrange.mirrorRuns(docOf(run), ['keep'], 'v').runs[0];
    expect(out.id).toBe('keep');
    expect(out.group_id).toBe('g1');
    expect(out.raceway_id).toBe('rw1');
    expect(out.kind).toBe('jumper');
    expect(out.is_channel_letter_face).toBe(true);
    expect(out.channel_letter_depth_mm).toBe(90);
    expect(out.color).toBe('ruby');
    expect(out.tube_diameter_mm).toBe(12);
    expect(out.notes).toBe('hello');
  });

  it('mirrors the whole selection about the SELECTION bbox, not each run', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 90, 0, 10, 10));
    const out = arrange.mirrorRuns(doc, ['a', 'b'], 'h');
    const ba = arrange.runBBoxMM(out.runs[0])!;
    const bb = arrange.runBBoxMM(out.runs[1])!;
    expect(ba.minX).toBeCloseTo(90, 9);
    expect(bb.minX).toBeCloseTo(0, 9);
  });

  it('is a no-op with nothing selected', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10));
    expect(arrange.mirrorRuns(doc, [], 'h')).toBe(doc);
  });
});

describe('reorderRuns', () => {
  const base = () =>
    docOf(rect('a', 0, 0, 1, 1), rect('b', 0, 0, 1, 1), rect('c', 0, 0, 1, 1), rect('d', 0, 0, 1, 1));
  const order = (doc: DesignDoc) => doc.runs.map((r) => r.id);

  it('front moves to the END of the array (drawn last = on top)', () => {
    expect(order(arrange.reorderRuns(base(), ['a'], 'front'))).toEqual(['b', 'c', 'd', 'a']);
  });

  it('back moves to the START of the array', () => {
    expect(order(arrange.reorderRuns(base(), ['d'], 'back'))).toEqual(['d', 'a', 'b', 'c']);
  });

  it('forward steps one position toward the front', () => {
    expect(order(arrange.reorderRuns(base(), ['a'], 'forward'))).toEqual(['b', 'a', 'c', 'd']);
  });

  it('backward steps one position toward the back', () => {
    expect(order(arrange.reorderRuns(base(), ['d'], 'backward'))).toEqual(['a', 'b', 'd', 'c']);
  });

  it('front-of-front and back-of-back are no-ops returning the same doc', () => {
    const doc = base();
    expect(arrange.reorderRuns(doc, ['d'], 'front')).toBe(doc);
    expect(arrange.reorderRuns(doc, ['d'], 'forward')).toBe(doc);
    expect(arrange.reorderRuns(doc, ['a'], 'back')).toBe(doc);
    expect(arrange.reorderRuns(doc, ['a'], 'backward')).toBe(doc);
    expect(arrange.reorderRuns(doc, ['a', 'b', 'c', 'd'], 'front')).toBe(doc);
  });

  it('preserves relative order among the moved runs and among the rest', () => {
    expect(order(arrange.reorderRuns(base(), ['a', 'c'], 'front'))).toEqual(['b', 'd', 'a', 'c']);
    expect(order(arrange.reorderRuns(base(), ['b', 'd'], 'back'))).toEqual(['b', 'd', 'a', 'c']);
  });

  it('moves a multi-run selection as a block without jumping siblings', () => {
    // a,b selected: both step forward one, staying adjacent and in order.
    expect(order(arrange.reorderRuns(base(), ['a', 'b'], 'forward'))).toEqual([
      'c', 'a', 'b', 'd',
    ]);
    // c,d each step back ONE — 'b' hops over the block, it is not sent to
    // the end. A second pass would give ['c','d','a','b'].
    expect(order(arrange.reorderRuns(base(), ['c', 'd'], 'backward'))).toEqual([
      'a', 'c', 'd', 'b',
    ]);
    expect(
      order(arrange.reorderRuns(arrange.reorderRuns(base(), ['c', 'd'], 'backward'), ['c', 'd'], 'backward')),
    ).toEqual(['c', 'd', 'a', 'b']);
  });

  it('is a no-op with an empty selection', () => {
    const doc = base();
    expect(arrange.reorderRuns(doc, [], 'front')).toBe(doc);
    expect(arrange.reorderRuns(doc, ['unknown'], 'front')).toBe(doc);
  });

  it('does not clone the run objects it moves', () => {
    const doc = base();
    const a = doc.runs[0];
    expect(arrange.reorderRuns(doc, ['a'], 'front').runs[3]).toBe(a);
  });
});

describe('locked layers', () => {
  const lockedDoc = (): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 500, 500],
    runs: [
      { ...rect('a', 0, 0, 10, 10), group_id: 'g-locked' },
      rect('b', 40, 0, 10, 10),
      rect('c', 80, 0, 10, 10),
    ],
    groups: [
      { id: 'g-locked', name: 'Locked', locked: true },
    ],
  });

  it('excludes a locked-group run from align while its neighbours move', () => {
    const doc = lockedDoc();
    const out = arrange.alignRuns(doc, ['a', 'b', 'c'], 'left');
    // 'a' is untouched — same object, same coordinates.
    expect(out.runs[0]).toBe(doc.runs[0]);
    // 'b' and 'c' align to each other's box (minX 40), NOT to the locked
    // run's minX 0 — a run that can't move can't set the target edge.
    expect(arrange.runBBoxMM(out.runs[1])!.minX).toBeCloseTo(40, 9);
    expect(arrange.runBBoxMM(out.runs[2])!.minX).toBeCloseTo(40, 9);
  });

  it('excludes locked runs from distribute, mirror and reorder', () => {
    const doc = lockedDoc();
    // Only two arrangeable runs left, so distribute is a no-op.
    expect(arrange.distributeRuns(doc, ['a', 'b', 'c'], 'h')).toBe(doc);
    const mirrored = arrange.mirrorRuns(doc, ['a', 'b', 'c'], 'h');
    expect(mirrored.runs[0]).toBe(doc.runs[0]);
    expect(arrange.reorderRuns(doc, ['a'], 'front')).toBe(doc);
  });

  it('leaves hidden (but unlocked) runs in the selection', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 500, 500],
      runs: [
        { ...rect('a', 0, 0, 10, 10), group_id: 'g-hidden' },
        rect('b', 40, 0, 10, 10),
      ],
      groups: [{ id: 'g-hidden', name: 'Hidden', visible: false }],
    };
    expect(arrange.arrangeableRunIds(doc, ['a', 'b'])).toEqual(['a', 'b']);
  });
});

describe('disabledReason', () => {
  const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 20, 0, 10, 10));

  it('explains a too-small selection', () => {
    expect(arrange.disabledReason(doc, ['a'], 'align')).toMatch(/at least 2/);
    expect(arrange.disabledReason(doc, ['a', 'b'], 'distribute')).toMatch(/at least 3/);
    expect(arrange.disabledReason(doc, [], 'mirror')).toMatch(/Select a run/);
  });

  it('is null when the op is available', () => {
    expect(arrange.disabledReason(doc, ['a', 'b'], 'align')).toBeNull();
    expect(arrange.disabledReason(doc, ['a'], 'mirror')).toBeNull();
    expect(arrange.disabledReason(doc, ['a'], 'reorder')).toBeNull();
  });

  it('calls out a locked layer rather than silently doing nothing', () => {
    const locked: DesignDoc = {
      ...doc,
      runs: [{ ...doc.runs[0], group_id: 'g' }, doc.runs[1]],
      groups: [{ id: 'g', name: 'L', locked: true }],
    };
    expect(arrange.disabledReason(locked, ['a', 'b'], 'align')).toMatch(/locked layer/);
    expect(arrange.disabledReason(locked, ['a'], 'mirror')).toMatch(/locked layer/);
  });
});
