import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import * as ops from './docOps';
import { hersheyTextToRuns } from './hershey/text';

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 600, 600],
  runs,
});

const line = (id: string, pts: [number, number][]): DesignRun => ({
  id,
  polyline: { points: pts, closed: false },
});

const allIds = (d: DesignDoc) => d.runs.map((r) => r.id);

function totalLengthMM(d: DesignDoc, ids?: string[]): number {
  return d.runs
    .filter((r) => !ids || ids.includes(r.id))
    .reduce((acc, r) => acc + ops.runLengthMM(r), 0);
}

describe('joinTouchingRuns', () => {
  it('welds two runs whose ends coincide', () => {
    const doc = docOf(line('a', [[0, 0], [100, 0]]), line('b', [[100, 0], [100, 80]]));
    const out = ops.joinTouchingRuns(doc, ['a', 'b']);
    expect(out.joined).toBe(1);
    expect(out.runsAfter).toBe(1);
    expect(out.doc.runs).toHaveLength(1);
    expect(out.doc.runs[0].polyline.points).toHaveLength(3); // seam vertex dropped
  });

  it('chains three strokes into one tube in a single call', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 80], [0, 80]]),
    );
    const out = ops.joinTouchingRuns(doc, ['a', 'b', 'c']);
    expect(out.joined).toBe(2);
    expect(out.doc.runs).toHaveLength(1);
    expect(totalLengthMM(out.doc)).toBeCloseTo(totalLengthMM(doc), 9);
  });

  it('leaves runs whose ends are further apart than the tolerance', () => {
    const doc = docOf(line('a', [[0, 0], [100, 0]]), line('b', [[105, 0], [105, 80]]));
    expect(ops.joinTouchingRuns(doc, ['a', 'b'], 1).joined).toBe(0);
    expect(ops.joinTouchingRuns(doc, ['a', 'b'], 6).joined).toBe(1);
  });

  it('touches nothing outside the selection', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 80], [0, 80]]),
    );
    const out = ops.joinTouchingRuns(doc, ['a', 'b']);
    expect(out.joined).toBe(1);
    expect(allIds(out.doc)).toContain('c');
    expect(out.doc.runs).toHaveLength(2);
  });

  // A closed run has no endpoints to offer. Reported rather than silently
  // ignored, so a selection that does nothing says why.
  it('reports closed runs instead of pretending they took part', () => {
    const closed: DesignRun = {
      id: 'loop',
      polyline: { points: [[0, 0], [50, 0], [50, 50]], closed: true },
    };
    const out = ops.joinTouchingRuns(docOf(closed, line('a', [[0, 0], [-40, 0]])), ['loop', 'a']);
    expect(out.joined).toBe(0);
    expect(out.skippedClosed).toBe(1);
  });

  // A run whose own ends meet is already one continuous tube. Closing it into
  // a loop is a topology change with its own gesture (Tier 1 #127).
  it('never self-joins a run whose own ends meet', () => {
    const selfTouch = line('s', [[0, 0], [100, 0], [100, 100], [0, 0]]);
    const out = ops.joinTouchingRuns(docOf(selfTouch), ['s']);
    expect(out.joined).toBe(0);
    expect(out.doc.runs[0].polyline.closed).toBeFalsy();
  });

  it('is a no-op on an empty or single-run selection', () => {
    const doc = docOf(line('a', [[0, 0], [100, 0]]));
    expect(ops.joinTouchingRuns(doc, []).doc).toBe(doc);
    expect(ops.joinTouchingRuns(doc, ['a']).doc).toBe(doc);
  });

  // Zero is a legitimate setting meaning "exactly coincident only", which
  // font-derived geometry often is. A non-finite or negative one is a caller
  // bug and declines rather than welding glass on the strength of a NaN.
  it('treats a zero tolerance as exact-match, and refuses a nonsense one', () => {
    const exact = docOf(line('a', [[0, 0], [100, 0]]), line('b', [[100, 0], [100, 80]]));
    expect(ops.joinTouchingRuns(exact, ['a', 'b'], 0).joined).toBe(1);

    const near = docOf(line('a', [[0, 0], [100, 0]]), line('b', [[100.5, 0], [100.5, 80]]));
    expect(ops.joinTouchingRuns(near, ['a', 'b'], 0).joined).toBe(0);

    for (const bad of [NaN, -5, Infinity]) {
      const out = ops.joinTouchingRuns(exact, ['a', 'b'], bad);
      expect(out.joined).toBe(0);
      expect(out.doc).toBe(exact);
    }
  });

  // Determinism: the same selection must weld the same way every time, or the
  // same design comes off the bench differently on two afternoons. Three
  // strokes meeting at ONE corner is the ambiguous case — only two of them can
  // become one path, and which two must not depend on click order.
  it('resolves a three-way corner the same way whatever the selection order', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 0], [200, 40]]),
    );
    const shape = (d: DesignDoc) =>
      JSON.stringify(d.runs.map((r) => [r.id, r.polyline.points]));
    const orders = [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'a', 'c'], ['c', 'a', 'b']];
    const results = orders.map((o) => shape(ops.joinTouchingRuns(doc, o).doc));
    for (const r of results) expect(r).toBe(results[0]);
    // Exactly one weld is possible at a three-way corner.
    expect(ops.joinTouchingRuns(doc, ['a', 'b', 'c']).joined).toBe(1);
  });

  // Greedy-closest has consequences, and they are the right ones: a weld
  // CONSUMES both endpoints, so the runner-up is left out rather than being
  // dragged across the sign to a free end that has since moved.
  it('takes the closest pair first, and the runner-up stays separate', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('far', [[100.9, 0], [100.9, 50]]),
      line('near', [[100.1, 0], [100.1, -50]]),
    );
    const out = ops.joinTouchingRuns(doc, ['a', 'far', 'near'], 1);
    expect(out.joined).toBe(1); // 0.1mm wins over 0.9mm
    expect(allIds(out.doc).sort()).toEqual(['a', 'far']); // joinRuns keeps runA's id
    // The weld took 'near', not 'far': the merged run reaches y = -50.
    const merged = out.doc.runs.find((r) => r.id === 'a')!;
    expect(merged.polyline.points.some(([, y]) => y === -50)).toBe(true);
    // 'far's free end is now ~50mm from anything, so a second pass finds none.
    expect(ops.joinTouchingRuns(out.doc, allIds(out.doc), 1).joined).toBe(0);
  });

  it('preserves total glass length across every weld', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 80], [0, 80]]),
      line('d', [[0, 80], [0, 0]]),
    );
    const out = ops.joinTouchingRuns(doc, allIds(doc));
    expect(out.doc.runs).toHaveLength(1);
    expect(totalLengthMM(out.doc)).toBeCloseTo(totalLengthMM(doc), 9);
  });

  // The class of bug that shipped twice: a private concatenation path forgets
  // a sibling field. This op folds through joinRuns, so the carry is joinRuns'.
  it('carries run classification through a chained weld', () => {
    const face = (id: string, pts: [number, number][]): DesignRun => ({
      ...line(id, pts),
      is_channel_letter_face: true,
      channel_letter_depth_mm: 76.2,
      raceway_id: 'rw1',
    });
    const doc = docOf(
      face('a', [[0, 0], [100, 0]]),
      face('b', [[100, 0], [100, 80]]),
      face('c', [[100, 80], [0, 80]]),
    );
    const out = ops.joinTouchingRuns(doc, ['a', 'b', 'c']);
    const merged = out.doc.runs[0];
    expect(merged.is_channel_letter_face).toBe(true);
    expect(merged.channel_letter_depth_mm).toBe(76.2);
    expect(merged.raceway_id).toBe('rw1');
  });

  it('carries segment_types through a chained weld', () => {
    const arc = (id: string, pts: [number, number][], t: ('line' | 'arc')[]): DesignRun => ({
      id,
      polyline: { points: pts, closed: false, segment_types: t },
    });
    const doc = docOf(
      arc('a', [[0, 0], [100, 0]], ['arc']),
      arc('b', [[100, 0], [100, 80]], ['line']),
    );
    const merged = ops.joinTouchingRuns(doc, ['a', 'b']).doc.runs[0];
    expect(ops.segmentTypesWellFormed(merged)).toBe(true);
    expect(merged.polyline.segment_types).toHaveLength(
      merged.polyline.points.length - 1,
    );
  });
});

// ---------------------------------------------------------------------------
// The demo case
// ---------------------------------------------------------------------------

describe('rowmans "OPEN" at 200mm', () => {
  const runs = hersheyTextToRuns({ text: 'OPEN', capHeightMM: 200, originX: 0, originY: 0 });
  const doc = (): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 1200, 600],
    runs: runs.map((r, i) => ({
      id: `t${i}`,
      polyline: { points: r.points.map((p) => [...p] as [number, number]), closed: false },
    })),
  });

  it('starts at ten runs for four letters', () => {
    expect(doc().runs).toHaveLength(10);
  });

  // FIVE IS THE FLOOR, not a shortfall. E's middle bar and P's bowl tail land
  // partway along another stroke — T-junctions, which need a vertex inserted
  // into the target first and are a different physical joint.
  it('welds ten runs down to five, and loses no glass doing it', () => {
    const before = doc();
    const out = ops.joinTouchingRuns(before, allIds(before));
    expect(out.runsAfter).toBe(5);
    expect(out.joined).toBe(5);
    expect(totalLengthMM(out.doc)).toBeCloseTo(totalLengthMM(before), 6);
  });

  it('is idempotent — a second pass finds nothing left to weld', () => {
    const before = doc();
    const once = ops.joinTouchingRuns(before, allIds(before));
    const twice = ops.joinTouchingRuns(once.doc, allIds(once.doc));
    expect(twice.joined).toBe(0);
  });

  it('leaves every welded piece saveable', () => {
    const before = doc();
    const out = ops.joinTouchingRuns(before, allIds(before));
    for (const r of out.doc.runs) expect(ops.segmentTypesWellFormed(r)).toBe(true);
  });
});
