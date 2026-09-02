import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import * as ops from './docOps';
import { availableActionsForVertex } from './nodeMenuItems';
import { hersheyTextToRuns } from './hershey/text';

// Tier 1 #127. The bug the demo hit: the inline text tool mints every run
// `closed: false`, and rowmans' `O` is a single stroke whose first and last
// vertex are the SAME coordinate. Both routes to opening it were gated on the
// flag, so both declined — the tool silently, the menu by omission.

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 500, 500],
  runs,
});

// A square walked back to its start: 5 points, 4 distinct, ends coincide.
function loopRun(id = 'loop'): DesignRun {
  return {
    id,
    polyline: {
      points: [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]],
      closed: false,
      segment_types: ['line', 'arc', 'line', 'arc_r'],
    },
  };
}

/** Total path length, walked from the points themselves — the geometry
 *  assertion the array-length check cannot make. */
function walkLengthMM(run: DesignRun): number {
  const p = run.polyline.points;
  let acc = 0;
  for (let i = 1; i < p.length; i++) acc += Math.hypot(p[i][0] - p[i - 1][0], p[i][1] - p[i - 1][1]);
  if (run.polyline.closed && p.length > 1) {
    acc += Math.hypot(p[0][0] - p[p.length - 1][0], p[0][1] - p[p.length - 1][1]);
  }
  return acc;
}

describe('isGeometricLoop', () => {
  it('accepts an open run whose ends coincide', () => {
    expect(ops.isGeometricLoop(loopRun())).toBe(true);
  });

  it('accepts ends that merely meet within the weld tolerance', () => {
    const r = loopRun();
    r.polyline.points[4] = [0.009, 0]; // inside COINCIDENT_MM
    expect(ops.isGeometricLoop(r)).toBe(true);
    r.polyline.points[4] = [0.011, 0]; // outside it
    expect(ops.isGeometricLoop(r)).toBe(false);
  });

  it('rejects a run already flagged closed — there is nothing to infer', () => {
    const r = loopRun();
    r.polyline.closed = true;
    expect(ops.isGeometricLoop(r)).toBe(false);
  });

  it('rejects an open run whose ends are apart', () => {
    expect(ops.isGeometricLoop({
      id: 'o', polyline: { points: [[0, 0], [50, 0], [50, 50]], closed: false },
    })).toBe(false);
  });

  // Two coincident vertices are a zero-length segment, not a shape.
  it('rejects a two-point run however coincident', () => {
    expect(ops.isGeometricLoop({
      id: 't', polyline: { points: [[0, 0], [0, 0]], closed: false },
    })).toBe(false);
  });
});

describe('closeGeometricLoop', () => {
  it('drops the trailing duplicate and sets closed', () => {
    const out = ops.closeGeometricLoop(docOf(loopRun()), 'loop').runs[0];
    expect(out.polyline.closed).toBe(true);
    expect(out.polyline.points).toHaveLength(4); // 5 in, duplicate gone
    expect(out.polyline.points[0]).toEqual([0, 0]);
  });

  // THE TRAP. Setting `closed` on all 5 points would leave a closing segment
  // from p[4] to p[0] — the same coordinate — a zero-length segment needing a
  // 5th segment_types entry that should never exist. Done correctly the array
  // is untouched and STILL 4 LONG. Both spellings pass a length check, so the
  // assertion has to be about geometry.
  it('needs no segment_types edit, and the length check cannot prove it', () => {
    const before = loopRun();
    const after = ops.closeGeometricLoop(docOf(before), 'loop').runs[0];

    expect(after.polyline.segment_types).toEqual(before.polyline.segment_types);
    expect(ops.segmentTypesWellFormed(after)).toBe(true);

    // The real proof: no zero-length segment survives, and the glass is the
    // same length it was.
    const p = after.polyline.points;
    for (let i = 0; i < p.length; i++) {
      const q = p[(i + 1) % p.length];
      expect(Math.hypot(q[0] - p[i][0], q[1] - p[i][1])).toBeGreaterThan(ops.COINCIDENT_MM);
    }
    expect(walkLengthMM(after)).toBeCloseTo(walkLengthMM(before), 9);
  });

  it('remaps every reference to the dropped vertex onto vertex 0', () => {
    const run: DesignRun = {
      ...loopRun(),
      electrodes: [{ point_index: 4 }, { point_index: 2 }],
      blockouts: [{ start_live_index: 4, end_live_index: 1 }],
      annotations: [{ kind: 'jump', live_index: 4 }],
      bends: [{ live_index: 4 }],
    };
    const out = ops.closeGeometricLoop(docOf(run), 'loop').runs[0];
    expect(out.electrodes).toEqual([{ point_index: 0 }, { point_index: 2 }]);
    expect(out.blockouts).toEqual([{ start_live_index: 0, end_live_index: 1 }]);
    expect(out.annotations![0].live_index).toBe(0);
    expect(out.bends).toEqual([{ live_index: 0 }]);
    // Nothing may point past the shortened array.
    for (const e of out.electrodes!) expect(e.point_index).toBeLessThan(out.polyline.points.length);
  });

  it('is a no-op on anything that is not a geometric loop', () => {
    const closed = docOf({ ...loopRun(), polyline: { ...loopRun().polyline, closed: true } });
    expect(ops.closeGeometricLoop(closed, 'loop')).toBe(closed);
    const open = docOf({ id: 'o', polyline: { points: [[0, 0], [9, 9], [0, 5]], closed: false } });
    expect(ops.closeGeometricLoop(open, 'o')).toBe(open);
  });
});

describe('breakOpen on a geometric loop', () => {
  // Closing drops a point and breaking adds it back, so this is a ROTATION of
  // the same array — not a resize. The count is the invariant.
  it('preserves the point count', () => {
    const before = loopRun();
    const after = ops.breakOpen(docOf(before), 'loop', 2).runs[0];
    expect(after.polyline.points).toHaveLength(before.polyline.points.length);
    expect(after.polyline.closed).toBe(false);
  });

  it('starts and ends the walk at the chosen vertex, and loses no glass', () => {
    const before = loopRun();
    const after = ops.breakOpen(docOf(before), 'loop', 2).runs[0];
    expect(after.polyline.points[0]).toEqual([100, 100]); // vertex 2
    expect(after.polyline.points[after.polyline.points.length - 1]).toEqual([100, 100]);
    expect(walkLengthMM(after)).toBeCloseTo(walkLengthMM(before), 9);
  });

  it('places electrodes on both new ends', () => {
    const after = ops.breakOpen(docOf(loopRun()), 'loop', 2).runs[0];
    expect(after.electrodes).toEqual([
      { point_index: 0 },
      { point_index: after.polyline.points.length - 1 },
    ]);
  });

  it('rotates segment_types with the walk rather than merely keeping it long', () => {
    const after = ops.breakOpen(docOf(loopRun()), 'loop', 2).runs[0];
    // Closed order was [line, arc, line, arc_r]; starting at vertex 2 rotates
    // it to [line, arc_r, line, arc].
    expect(after.polyline.segment_types).toEqual(['line', 'arc_r', 'line', 'arc']);
    expect(ops.segmentTypesWellFormed(after)).toBe(true);
  });

  // The duplicate terminator is exactly under vertex 0 on screen, so it is the
  // vertex an operator is most likely to click. It must not be out of range.
  it('accepts a click on the duplicate terminator', () => {
    const before = loopRun();
    const last = before.polyline.points.length - 1;
    const viaDup = ops.breakOpen(docOf(before), 'loop', last).runs[0];
    const viaZero = ops.breakOpen(docOf(before), 'loop', 0).runs[0];
    expect(viaDup.polyline.points).toEqual(viaZero.polyline.points);
  });

  it('still refuses a run that is genuinely open, and says why', () => {
    const open = docOf({ id: 'o', polyline: { points: [[0, 0], [50, 0], [50, 50]], closed: false } });
    expect(() => ops.breakOpen(open, 'o', 1)).toThrow(/ends do not meet/);
  });
});

describe('the node menu offers it', () => {
  it('offers "Break loop open here" on a geometric loop', () => {
    const ids = availableActionsForVertex(docOf(loopRun()), 'loop', 1).map((i) => i.id);
    expect(ids).toContain('break-loop-open');
  });

  it('still offers "Split run here" too — the run really is open', () => {
    const ids = availableActionsForVertex(docOf(loopRun()), 'loop', 1).map((i) => i.id);
    expect(ids).toContain('split-run');
  });

  it('offers neither break nor a false hint on an ordinary open run', () => {
    const open = docOf({ id: 'o', polyline: { points: [[0, 0], [50, 0], [50, 50]], closed: false } });
    const ids = availableActionsForVertex(open, 'o', 1).map((i) => i.id);
    expect(ids).not.toContain('break-loop-open');
  });
});

// ---------------------------------------------------------------------------
// The demo case, end to end, from the real font data
// ---------------------------------------------------------------------------

describe('rowmans "OPEN" at 200mm — the shape Rudy actually typed', () => {
  const runs = hersheyTextToRuns({
    text: 'OPEN',
    capHeightMM: 200,
    originX: 0,
    originY: 0,
  });

  const oRun = (): DesignRun => ({
    id: 'o',
    polyline: { points: runs[0].points.map((p) => [...p] as [number, number]), closed: false },
  });

  it('emits ten runs for four letters, none of them flagged closed', () => {
    expect(runs).toHaveLength(10); // O 1, P 2, E 4, N 3
    for (const r of runs) expect(r.points.length).toBeGreaterThan(1);
  });

  // 121 points, not the 21 in the raw font JSON: `hersheyTextToRuns` smooths
  // the glyph on the way out. The count is incidental; the gap is the point.
  it('the O is a geometric loop that the closed flag does not know about', () => {
    const o = oRun();
    expect(o.polyline.points.length).toBe(121);
    expect(o.polyline.closed).toBeFalsy();
    const a = o.polyline.points[0];
    const b = o.polyline.points[o.polyline.points.length - 1];
    expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBe(0); // exactly, not nearly
    expect(ops.isGeometricLoop(o)).toBe(true);
  });

  it('breaks open at a chosen vertex, keeping every millimetre of glass', () => {
    const o = oRun();
    const n = o.polyline.points.length;
    const after = ops.breakOpen(docOf(o), 'o', 7).runs[0];
    expect(after.polyline.points).toHaveLength(n); // rotation, not resize
    expect(after.polyline.closed).toBe(false);
    expect(after.electrodes).toEqual([{ point_index: 0 }, { point_index: n - 1 }]);
    expect(after.polyline.points[0]).toEqual(o.polyline.points[7]);
    expect(walkLengthMM(after)).toBeCloseTo(walkLengthMM(o), 6);
  });

  // What the operator gets is a tube with two ends, which is the entire point
  // of the exercise: it can now carry electrodes and be bent from one stick.
  it('leaves a run that Move Opening can then re-position', () => {
    const after = ops.breakOpen(docOf(oRun()), 'o', 7);
    expect(() => ops.moveOpening(after, 'o', 12)).not.toThrow();
  });

  // Every other glyph in the word is a plain stroke and must stay one.
  it('does not mistake P, E or N strokes for loops', () => {
    for (const r of runs.slice(1)) {
      expect(ops.isGeometricLoop({ id: 'x', polyline: { points: r.points, closed: false } })).toBe(false);
    }
  });
});
