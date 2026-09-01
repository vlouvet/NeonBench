import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints } from './arcGeom';
import { runArcs } from './runArcs';
import * as sr from './stepRepeat';

// A 40 x 20 mm open rectangle-ish run at (x, y). Straight segments only, so
// its flattened outline is its vertex list — handy for hand-computed cases.
function rect(id: string, x: number, y: number, w = 40, h = 20): DesignRun {
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

// An OPEN run whose single segment is an arc, chord left-to-right along
// y = 0. At ARC_BULGE 0.5 it bows to sagitta = chord/4 on the (-dy, dx) side,
// i.e. well outside the hull of its two vertices — which is exactly the case
// a naive `polyline.points` bbox gets wrong.
function arcRun(id = 'arc', x = 0, y = 0): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [x, y],
        [x + 40, y],
      ],
      closed: false,
      segment_types: ['arc'],
    },
  };
}

function docOf(...runs: DesignRun[]): DesignDoc {
  return { version: 1, view_box_mm: [0, 0, 1000, 1000], runs };
}

const OPTS = (o: Partial<sr.StepRepeatOptions> = {}): sr.StepRepeatOptions => ({
  ...sr.DEFAULT_STEP_REPEAT,
  ...o,
});

function byId(doc: DesignDoc, id: string): DesignRun {
  const r = doc.runs.find((x) => x.id === id);
  if (!r) throw new Error(`no run ${id} in [${doc.runs.map((x) => x.id).join(', ')}]`);
  return r;
}

function added(before: DesignDoc, after: DesignDoc): DesignRun[] {
  const had = new Set(before.runs.map((r) => r.id));
  return after.runs.filter((r) => !had.has(r.id));
}

function minX(run: DesignRun): number {
  return Math.min(...flatRunPoints(run).map((p) => p[0]));
}

function expectTranslated(
  copy: DesignRun,
  src: DesignRun,
  dx: number,
  dy: number,
): void {
  // THE invariant (CLAUDE.md bug class 1): compare the FLATTENED outlines,
  // not `polyline.points`. Field-by-field assertions pass while the drawn
  // shape is wrong; this fails if an arc's bow moves or flips.
  const got = flatRunPoints(copy);
  const want = flatRunPoints(src);
  expect(got.length).toBe(want.length);
  for (let i = 0; i < got.length; i++) {
    expect(got[i][0]).toBeCloseTo(want[i][0] + dx, 9);
    expect(got[i][1]).toBeCloseTo(want[i][1] + dy, 9);
  }
}

describe('stepRepeatPlan', () => {
  it('gap mode adds the selection extent to the pitch; centre mode does not', () => {
    const doc = docOf(rect('r1', 0, 0, 40, 20));
    const gap = sr.stepRepeatPlan(doc, ['r1'], OPTS({ countX: 3, pitchXMM: 10 }));
    const centre = sr.stepRepeatPlan(
      doc,
      ['r1'],
      OPTS({ countX: 3, pitchXMM: 10, pitchMode: 'centre' }),
    );
    expect(centre.stepXMM).toBe(10);
    expect(gap.stepXMM).toBe(50);
    // Differ by exactly the bbox dimension.
    expect(gap.stepXMM - centre.stepXMM).toBe(40);
  });

  it('measures the gap off the ARC-AWARE bbox, not the raw vertices', () => {
    // The arc run's vertices span x 0..40 and the bow does not widen that,
    // so the Y axis is where the bow is the whole story: the raw points have
    // zero height, while the flattened outline is a full sagitta tall.
    const doc = docOf(arcRun('a1'));
    const raw = doc.runs[0].polyline.points;
    expect(Math.max(...raw.map((p) => p[1])) - Math.min(...raw.map((p) => p[1]))).toBe(0);

    const plan = sr.stepRepeatPlan(doc, ['a1'], OPTS({ countX: 1, countY: 2, pitchYMM: 5 }));
    const box = plan.source!;
    const trueH = box.maxY - box.minY;
    expect(trueH).toBeGreaterThan(9);
    // gap mode: step = true height + gap. A raw-points bbox would have given
    // 0 + 5 = 5 and stacked the copy straight through the original.
    expect(plan.stepYMM).toBeCloseTo(trueH + 5, 9);
  });

  it('reports the total extent of the finished array', () => {
    const doc = docOf(rect('r1', 100, 50, 40, 20));
    const plan = sr.stepRepeatPlan(
      doc,
      ['r1'],
      OPTS({ countX: 3, countY: 2, pitchXMM: 10, pitchYMM: 5 }),
    );
    expect(plan.stepXMM).toBe(50);
    expect(plan.stepYMM).toBe(25);
    // 3 columns on a 50 mm step: 40 + 2*50 = 140 wide. 2 rows on 25: 20 + 25.
    expect(plan.widthMM).toBeCloseTo(140, 9);
    expect(plan.heightMM).toBeCloseTo(45, 9);
    expect(plan.extent).toEqual({ minX: 100, maxX: 240, minY: 50, maxY: 95 });
    expect(plan.cells).toBe(6);
    expect(plan.copies).toBe(5);
    expect(plan.newRuns).toBe(5);
  });

  it('refuses a runaway array above MAX_ARRAY_RUNS', () => {
    const doc = docOf(rect('r1', 0, 0), rect('r2', 100, 0));
    // 21 x 21 cells = 440 copies x 2 runs = 880 new runs.
    const plan = sr.stepRepeatPlan(doc, ['r1', 'r2'], OPTS({ countX: 21, countY: 21 }));
    expect(plan.newRuns).toBe(880);
    expect(plan.error).toMatch(/880 runs; the limit is 400/);
    expect(sr.stepRepeat(doc, ['r1', 'r2'], OPTS({ countX: 21, countY: 21 }))).toBe(doc);
    // One under the cap is fine.
    expect(
      sr.stepRepeatPlan(doc, ['r1', 'r2'], OPTS({ countX: 10, countY: 10 })).error,
    ).toBeNull();
  });

  it('explains an empty, locked or degenerate selection', () => {
    const doc = docOf(rect('r1', 0, 0));
    expect(sr.stepRepeatPlan(null, ['r1'], OPTS()).error).toMatch(/No design loaded/);
    expect(sr.stepRepeatPlan(doc, [], OPTS()).error).toMatch(/at least one run/);
    expect(sr.stepRepeatPlan(doc, ['r1'], OPTS({ countX: 1, countY: 1 })).error).toMatch(
      /count above 1/,
    );
    expect(sr.stepRepeatPlan(doc, ['r1'], OPTS({ countX: 0 })).error).toMatch(
      /whole numbers/,
    );
    expect(sr.stepRepeatPlan(doc, ['r1'], OPTS({ countX: NaN })).error).toMatch(
      /whole numbers/,
    );
    expect(sr.stepRepeatPlan(doc, ['r1'], OPTS({ pitchXMM: NaN })).error).toMatch(
      /millimetres/,
    );

    const locked: DesignDoc = {
      ...docOf({ ...rect('r1', 0, 0), group_id: 'g1' }),
      groups: [{ id: 'g1', name: 'Trim', locked: true }],
    };
    expect(sr.stepRepeatPlan(locked, ['r1'], OPTS({ countX: 3 })).error).toMatch(
      /locked layer/,
    );
    expect(sr.stepRepeat(locked, ['r1'], OPTS({ countX: 3 }))).toBe(locked);
  });

  it('warns when the step is tighter than the selection', () => {
    const doc = docOf(rect('r1', 0, 0, 40, 20));
    const tight = sr.stepRepeatPlan(
      doc,
      ['r1'],
      OPTS({ countX: 3, pitchXMM: 30, pitchMode: 'centre' }),
    );
    expect(tight.error).toBeNull();
    expect(tight.warning).toMatch(/overlap horizontally/);
    // A gap-mode array can never overlap on a positive gap.
    expect(sr.stepRepeatPlan(doc, ['r1'], OPTS({ countX: 3, pitchXMM: 0 })).warning).toBeNull();
  });

  it('disabledReason mirrors the plan error', () => {
    const doc = docOf(rect('r1', 0, 0));
    expect(sr.disabledReason(doc, ['r1'], OPTS({ countX: 3 }))).toBeNull();
    expect(sr.disabledReason(doc, [], OPTS({ countX: 3 }))).toMatch(/at least one run/);
  });
});

describe('stepRepeat', () => {
  it('3 x 1 array places copies at hand-computed positions', () => {
    const doc = docOf(rect('r1', 10, 0, 40, 20));
    // gap 10 on a 40-wide selection -> 50 mm centres.
    const out = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 3, pitchXMM: 10 }));
    expect(out.runs).toHaveLength(3);
    // The original is untouched, in place, and keeps its id.
    expect(out.runs[0]).toBe(doc.runs[0]);
    const copies = added(doc, out);
    expect(copies.map((r) => minX(r))).toEqual([60, 110]);
    expectTranslated(copies[0], doc.runs[0], 50, 0);
    expectTranslated(copies[1], doc.runs[0], 100, 0);
  });

  it('gap and centre modes differ by exactly the bbox dimension', () => {
    const doc = docOf(rect('r1', 0, 0, 40, 20));
    const gap = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 2, pitchXMM: 10 }));
    const centre = sr.stepRepeat(
      doc,
      ['r1'],
      OPTS({ countX: 2, pitchXMM: 10, pitchMode: 'centre' }),
    );
    expect(minX(added(doc, gap)[0]) - minX(added(doc, centre)[0])).toBeCloseTo(40, 9);
  });

  it('2 x 2 array fills the grid row-major and leaves cell (0,0) alone', () => {
    const doc = docOf(rect('r1', 0, 0, 40, 20));
    const out = sr.stepRepeat(
      doc,
      ['r1'],
      OPTS({ countX: 2, countY: 2, pitchXMM: 10, pitchYMM: 5 }),
    );
    const copies = added(doc, out);
    expect(copies).toHaveLength(3);
    const at = (r: DesignRun): [number, number] => [
      Math.min(...flatRunPoints(r).map((p) => p[0])),
      Math.min(...flatRunPoints(r).map((p) => p[1])),
    ];
    // Steps: 50 across, 25 down. Cells (1,0), (0,1), (1,1).
    expect(at(copies[0])).toEqual([50, 0]);
    expect(at(copies[1])).toEqual([0, 25]);
    expect(at(copies[2])).toEqual([50, 25]);
  });

  it('1 x 1 is a no-op that preserves doc identity', () => {
    const doc = docOf(rect('r1', 0, 0));
    expect(sr.stepRepeat(doc, ['r1'], OPTS({ countX: 1, countY: 1 }))).toBe(doc);
    // Same for the trivially-empty selections.
    expect(sr.stepRepeat(doc, [], OPTS({ countX: 3 }))).toBe(doc);
    expect(sr.stepRepeat(doc, ['nope'], OPTS({ countX: 3 }))).toBe(doc);
  });

  it('arrays an ARC run to the right shape, not just the right vertices', () => {
    const doc = docOf(arcRun('a1'));
    const out = sr.stepRepeat(doc, ['a1'], OPTS({ countX: 3, pitchXMM: 10 }));
    const copies = added(doc, out);
    const step = sr.stepRepeatPlan(doc, ['a1'], OPTS({ countX: 3, pitchXMM: 10 })).stepXMM;
    expect(step).toBe(50);
    expectTranslated(copies[0], doc.runs[0], step, 0);
    expectTranslated(copies[1], doc.runs[0], 2 * step, 0);
    // The bow survives as an ARC, not as a flattened line.
    for (const c of copies) {
      expect(c.polyline.segment_types).toEqual(['arc']);
      expect(c.polyline.segment_types).not.toBe(doc.runs[0].polyline.segment_types);
    }
  });

  it('carries the classification fields but NOT raceway_id', () => {
    const src: DesignRun = {
      ...rect('r1', 0, 0),
      is_channel_letter_face: true,
      channel_letter_depth_mm: 90,
      kind: 'jumper',
      raceway_id: 'rw-1',
      color: '#ff00aa',
      tube_diameter_mm: 15,
      notes: 'front face',
      direction: 'backward',
    };
    const doc = docOf(src);
    const out = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 2 }));
    const copy = added(doc, out)[0];

    expect(copy.is_channel_letter_face).toBe(true);
    expect(copy.channel_letter_depth_mm).toBe(90);
    expect(copy.kind).toBe('jumper');
    expect(copy.color).toBe('#ff00aa');
    expect(copy.tube_diameter_mm).toBe(15);
    expect(copy.notes).toBe('front face');
    expect(copy.direction).toBe('backward');

    // The whole point of this task: a copy 500 mm away is not bolted to the
    // source's raceway, and inheriting the id would put it on that raceway's
    // unfolded strip page — a real fabrication artifact for hardware it is
    // not mounted to. The KEY must be gone, not merely empty.
    expect(copy.raceway_id).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(copy, 'raceway_id')).toBe(false);
    // ... and the source keeps its own.
    expect(byId(out, 'r1').raceway_id).toBe('rw-1');
  });

  it('carries electrodes, blockouts, annotations and bends onto the same relative geometry', () => {
    const src: DesignRun = {
      id: 'r1',
      polyline: {
        points: [
          [0, 0],
          [40, 0],
          [40, 20],
          [0, 20],
        ],
        closed: false,
      },
      electrodes: [{ point_index: 0 }, { point_index: 3 }],
      blockouts: [{ start_live_index: 1, end_live_index: 2 }],
      annotations: [{ kind: 'jump', live_index: 2 }],
      bends: [{ live_index: 1 }],
    };
    const doc = docOf(src);
    const out = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 2, pitchXMM: 10 }));
    const copy = added(doc, out)[0];
    const dx = 50;

    // Indices are unchanged — translation renumbers nothing...
    expect(copy.electrodes).toEqual(src.electrodes);
    expect(copy.blockouts).toEqual(src.blockouts);
    expect(copy.annotations).toEqual(src.annotations);
    expect(copy.bends).toEqual(src.bends);
    // ... but cloned, so an in-place edit of one can never reach the other.
    expect(copy.electrodes).not.toBe(src.electrodes);
    expect(copy.electrodes![0]).not.toBe(src.electrodes![0]);
    expect(copy.blockouts![0]).not.toBe(src.blockouts![0]);

    // The assertion that actually matters: each index still ADDRESSES the
    // same relative place on the tube.
    const srcLive = runArcs(src).live;
    const copyLive = runArcs(copy).live;
    expect(copyLive).toEqual(srcLive);
    const posOf = (r: DesignRun, live: number[], li: number): [number, number] =>
      r.polyline.points[live[li]];
    for (const li of [1, 2]) {
      const a = posOf(src, srcLive, li);
      const b = posOf(copy, copyLive, li);
      expect(b[0]).toBeCloseTo(a[0] + dx, 9);
      expect(b[1]).toBeCloseTo(a[1], 9);
    }
    for (const e of copy.electrodes!) {
      const a = src.polyline.points[e.point_index];
      const b = copy.polyline.points[e.point_index];
      expect(b[0]).toBeCloseTo(a[0] + dx, 9);
      expect(b[1]).toBeCloseTo(a[1], 9);
    }
  });

  it('gives every run in the finished doc a unique id', () => {
    // Deliberately gappy id space: nextRunId fills holes before extending.
    const doc = docOf(rect('r1', 0, 0), rect('r3', 0, 40), rect('r7', 0, 80));
    const out = sr.stepRepeat(
      doc,
      ['r1', 'r3', 'r7'],
      OPTS({ countX: 3, countY: 2, pitchXMM: 10, pitchYMM: 10 }),
    );
    expect(out.runs).toHaveLength(3 + 5 * 3);
    const ids = out.runs.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    // The pre-existing ids are untouched.
    expect(ids.slice(0, 3)).toEqual(['r1', 'r3', 'r7']);
    // The gaps get filled first — this is the Tier 3 #89 interaction, pinned
    // so the day the allocator becomes high-water-mark this test says so.
    expect(ids.slice(3, 6)).toEqual(['r2', 'r4', 'r5']);
  });

  it('puts each cell in its own new group when the source was grouped', () => {
    const doc: DesignDoc = {
      ...docOf(
        { ...rect('r1', 0, 0, 10, 20), group_id: 'g1' },
        { ...rect('r2', 12, 0, 10, 20), group_id: 'g1' },
      ),
      groups: [{ id: 'g1', name: 'E' }],
    };
    const out = sr.stepRepeat(doc, ['r1', 'r2'], OPTS({ countX: 3, pitchXMM: 10 }));
    const copies = added(doc, out);
    expect(copies).toHaveLength(4);

    // The source group is not swollen: still exactly its two runs.
    expect(out.runs.filter((r) => r.group_id === 'g1').map((r) => r.id)).toEqual([
      'r1',
      'r2',
    ]);
    // Each cell's two runs share one FRESH group; the two cells differ.
    const cellA = copies.slice(0, 2).map((r) => r.group_id);
    const cellB = copies.slice(2, 4).map((r) => r.group_id);
    expect(cellA[0]).toBe(cellA[1]);
    expect(cellB[0]).toBe(cellB[1]);
    expect(cellA[0]).not.toBe(cellB[0]);
    expect(cellA[0]).not.toBe('g1');
    expect(out.groups?.map((g) => g.name)).toEqual(['E', 'E copy 1', 'E copy 2']);
    const gids = out.groups!.map((g) => g.id);
    expect(new Set(gids).size).toBe(gids.length);
  });

  it('leaves ungrouped runs ungrouped and never invents a groups key', () => {
    const doc = docOf(rect('r1', 0, 0));
    const out = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 2 }));
    const copy = added(doc, out)[0];
    expect(Object.prototype.hasOwnProperty.call(copy, 'group_id')).toBe(false);
    // A doc that never had `groups` must not grow the key — that is the
    // byte-identical-JSON back-compat invariant.
    expect(Object.prototype.hasOwnProperty.call(out, 'groups')).toBe(false);
  });

  it('inherits a hidden source group’s visibility onto the copy groups', () => {
    const doc: DesignDoc = {
      ...docOf({ ...rect('r1', 0, 0), group_id: 'g1' }),
      groups: [{ id: 'g1', name: 'Ghost', visible: false }],
    };
    const out = sr.stepRepeat(doc, ['r1'], OPTS({ countX: 2 }));
    expect(out.groups?.[1]).toEqual({ id: 'g2', name: 'Ghost copy 1', visible: false });
  });

  it('skips locked runs but still arrays the rest of the selection', () => {
    const doc: DesignDoc = {
      ...docOf(rect('r1', 0, 0), { ...rect('r2', 0, 40), group_id: 'g1' }),
      groups: [{ id: 'g1', name: 'Trim', locked: true }],
    };
    const out = sr.stepRepeat(doc, ['r1', 'r2'], OPTS({ countX: 2, pitchXMM: 10 }));
    const copies = added(doc, out);
    expect(copies).toHaveLength(1);
    expectTranslated(copies[0], byId(doc, 'r1'), 50, 0);
  });
});
