import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { runLengthMM } from './docOps';
import { selectionMetrics } from './selectionMetrics';

// Same fixture shape arrange.test.ts uses: a two-vertex chord on y = 0 whose
// segment is an arc. At ARC_BULGE 0.5 the sagitta is chord/4, so the glass
// reaches y = 10 on a 40mm chord while BOTH VERTICES sit on y = 0.
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

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 500, 500],
  runs,
});

// The raw-vertex box the old selectionResizeBox computed, kept here so the
// regression can be stated as a comparison rather than a bare number.
function rawVertexBox(run: DesignRun) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of run.polyline.points) {
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
  }
  return { minX, minY, maxX, maxY };
}

describe('selectionMetrics', () => {
  it('answers null for an empty or unresolvable selection', () => {
    expect(selectionMetrics(docOf(rect('a', 0, 0, 10, 10)), [])).toBeNull();
    expect(selectionMetrics(docOf(rect('a', 0, 0, 10, 10)), ['nope'])).toBeNull();
  });

  it('measures a single straight run off its vertices', () => {
    const m = selectionMetrics(docOf(rect('a', 5, 7, 10, 20)), ['a'])!;
    expect(m.runCount).toBe(1);
    expect(m.widthMM).toBeCloseTo(10, 9);
    expect(m.heightMM).toBeCloseTo(20, 9);
    expect(m.closedCount).toBe(1);
  });

  it('unions across a multi-run selection', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 90, 40, 10, 10));
    const m = selectionMetrics(doc, ['a', 'b'])!;
    expect(m.runCount).toBe(2);
    expect(m.widthMM).toBeCloseTo(100, 9);
    expect(m.heightMM).toBeCloseTo(50, 9);
  });

  it('ignores runs outside the selection', () => {
    const doc = docOf(rect('a', 0, 0, 10, 10), rect('b', 900, 900, 10, 10));
    const m = selectionMetrics(doc, ['a'])!;
    expect(m.widthMM).toBeCloseTo(10, 9);
    expect(m.runCount).toBe(1);
  });

  // ---- the regression this row exists for --------------------------------

  // The old resize box walked raw vertices. For this run that is a box of
  // ZERO HEIGHT, which is below MIN_RESIZE_MM (2), so the whole overlay
  // returned null: selecting an arc run gave no resize handles and no move
  // handle, with nothing on screen explaining why.
  it('contains the arc bow that a raw-vertex box misses entirely', () => {
    const raw = rawVertexBox(arcRun());
    expect(raw.maxY - raw.minY).toBe(0); // what the bug looked like

    const m = selectionMetrics(docOf(arcRun()), ['arc'])!;
    expect(m.widthMM).toBeCloseTo(40, 9);
    expect(m.heightMM).toBeCloseTo(10, 6); // sagitta = chord / 4
    expect(m.heightMM).toBeGreaterThan(2); // clears MIN_RESIZE_MM
  });

  it('never measures smaller than the raw vertex hull', () => {
    for (const run of [arcRun(), rect('r', 5, 7, 10, 20)]) {
      const raw = rawVertexBox(run);
      const m = selectionMetrics(docOf(run), [run.id])!;
      expect(m.bbox.minX).toBeLessThanOrEqual(raw.minX + 1e-9);
      expect(m.bbox.minY).toBeLessThanOrEqual(raw.minY + 1e-9);
      expect(m.bbox.maxX).toBeGreaterThanOrEqual(raw.maxX - 1e-9);
      expect(m.bbox.maxY).toBeGreaterThanOrEqual(raw.maxY - 1e-9);
    }
  });

  // ---- length semantics ---------------------------------------------------

  it('sums each run through runLengthMM, so the panel agrees with the badge', () => {
    const doc = docOf(rect('a', 0, 0, 10, 20), arcRun('arc'));
    const m = selectionMetrics(doc, ['a', 'arc'])!;
    const expected = doc.runs.reduce((acc, r) => acc + runLengthMM(r), 0);
    expect(m.lengthMM).toBeCloseTo(expected, 9);
  });

  // The documented choice: a closed run contributes its WHOLE perimeter,
  // including the closing chord — not the lit arc between its electrodes.
  it('counts a closed run’s full perimeter, closing chord included', () => {
    const m = selectionMetrics(docOf(rect('a', 0, 0, 10, 20)), ['a'])!;
    expect(m.lengthMM).toBeCloseTo(60, 9); // 10+20+10+20, not 50
    expect(m.closedCount).toBe(1);
  });

  // Electrodes split a closed loop into a live and an inactive arc. Both are
  // glass, so neither the count nor the length may change when they appear.
  it('is unchanged by electrodes on a closed run', () => {
    const bare = rect('a', 0, 0, 10, 20);
    const wired: DesignRun = { ...bare, electrodes: [{ point_index: 0 }, { point_index: 2 }] };
    const a = selectionMetrics(docOf(bare), ['a'])!;
    const b = selectionMetrics(docOf(wired), ['a'])!;
    expect(b.lengthMM).toBeCloseTo(a.lengthMM, 9);
    expect(b.closedCount).toBe(1);
  });

  it('reports an open run’s length without a closing chord', () => {
    const open: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [30, 0], [30, 40]], closed: false },
    };
    const m = selectionMetrics(docOf(open), ['o'])!;
    expect(m.lengthMM).toBeCloseTo(70, 9); // NOT 120 — no closing chord
    expect(m.closedCount).toBe(0);
  });
});
