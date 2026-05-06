import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import * as ops from './docOps';

// Build a minimal doc with one open polyline, one closed polyline, and
// dense-enough vertex counts that bend detection has something to find.
function makeDoc(): DesignDoc {
  // Open run: zig-zag with three corners (forms three ~90° bends).
  const openPts: [number, number][] = [];
  for (let i = 0; i <= 10; i++) openPts.push([i, 0]);
  for (let i = 1; i <= 10; i++) openPts.push([10, i]);
  for (let i = 1; i <= 10; i++) openPts.push([10 - i, 10]);

  // Closed run: 24-vertex octagon-ish circle (so we can flip direction).
  const closedPts: [number, number][] = [];
  const N = 24;
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2;
    closedPts.push([50 + 5 * Math.cos(a), 50 + 5 * Math.sin(a)]);
  }

  const runs: DesignRun[] = [
    {
      id: 'run-1',
      polyline: { points: openPts, closed: false },
      tube_diameter_mm: 10,
    },
    {
      id: 'run-2',
      polyline: { points: closedPts, closed: true },
      tube_diameter_mm: 10,
    },
  ];
  return {
    version: 1,
    view_box_mm: [0, 0, 60, 60],
    runs,
  };
}

describe('electrode ops', () => {
  it('placeElectrode adds the first electrode', () => {
    const next = ops.placeElectrode(makeDoc(), 'run-1', 5);
    expect(next.runs[0].electrodes).toEqual([{ point_index: 5 }]);
  });

  it('placeElectrode replaces the closer of two existing electrodes', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 0);
    doc = ops.placeElectrode(doc, 'run-1', 30);
    doc = ops.placeElectrode(doc, 'run-1', 5);
    // 5 is closer to 0 than to 30, so [0, 30] becomes [5, 30].
    expect(doc.runs[0].electrodes).toEqual([{ point_index: 5 }, { point_index: 30 }]);
  });

  it('placeElectrode on a closed run with two electrodes auto-sets direction', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-2', 0);
    expect(doc.runs[1].direction).toBeUndefined();
    doc = ops.placeElectrode(doc, 'run-2', 12);
    expect(doc.runs[1].direction).toMatch(/forward|backward/);
  });

  it('flipDirection toggles forward<->backward', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-2', 0);
    doc = ops.placeElectrode(doc, 'run-2', 12);
    const before = doc.runs[1].direction!;
    doc = ops.flipDirection(doc, 'run-2');
    const after = doc.runs[1].direction;
    expect(after).not.toEqual(before);
  });

  it('deleteElectrode removes the indexed entry', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 1);
    doc = ops.placeElectrode(doc, 'run-1', 5);
    doc = ops.deleteElectrode(doc, 'run-1', 0);
    expect(doc.runs[0].electrodes).toEqual([{ point_index: 5 }]);
  });

  it('clearElectrodes empties the list', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 1);
    doc = ops.clearElectrodes(doc, 'run-1');
    expect(doc.runs[0].electrodes).toEqual([]);
  });
});

describe('blockout ops', () => {
  it('placeBlockout normalizes start <= end', () => {
    const doc = ops.placeBlockout(makeDoc(), 'run-1', 9, 3);
    expect(doc.runs[0].blockouts).toEqual([{ start_live_index: 3, end_live_index: 9 }]);
  });

  it('deleteBlockout removes the indexed entry', () => {
    let doc = makeDoc();
    doc = ops.placeBlockout(doc, 'run-1', 1, 3);
    doc = ops.placeBlockout(doc, 'run-1', 5, 7);
    doc = ops.deleteBlockout(doc, 'run-1', 0);
    expect(doc.runs[0].blockouts).toEqual([{ start_live_index: 5, end_live_index: 7 }]);
  });
});

describe('annotation ops', () => {
  it('placeAnnotation appends a kind+live_index entry', () => {
    let doc = ops.placeAnnotation(makeDoc(), 'run-1', 'jump', 4);
    doc = ops.placeAnnotation(doc, 'run-1', 'support', 7);
    doc = ops.placeAnnotation(doc, 'run-1', 'doubleback', 12);
    expect(doc.runs[0].annotations).toEqual([
      { kind: 'jump', live_index: 4 },
      { kind: 'support', live_index: 7 },
      { kind: 'doubleback', live_index: 12 },
    ]);
  });

  it('deleteAnnotation removes the indexed entry', () => {
    let doc = ops.placeAnnotation(makeDoc(), 'run-1', 'jump', 4);
    doc = ops.placeAnnotation(doc, 'run-1', 'support', 7);
    doc = ops.deleteAnnotation(doc, 'run-1', 0);
    expect(doc.runs[0].annotations).toEqual([{ kind: 'support', live_index: 7 }]);
  });
});

describe('bend ops', () => {
  it('first placeBend snapshots auto-detected list and adds the new bend', () => {
    // Pick a live index well clear of the auto-detected corners so the
    // 2-sample dedup window doesn't swallow the new entry.
    const doc = ops.placeBend(makeDoc(), 'run-1', 25, 10);
    expect(doc.runs[0].bends!.length).toBeGreaterThan(0);
    expect(doc.runs[0].bends!.some((b) => b.live_index === 25)).toBe(true);
  });

  it('placeBend ignores adds within 2 samples of an existing bend', () => {
    const doc = ops.placeBend(makeDoc(), 'run-1', 5, 10);
    const sameAgain = ops.placeBend(doc, 'run-1', 6, 10);
    expect(sameAgain.runs[0].bends).toEqual(doc.runs[0].bends);
  });

  it('deleteBend removes by index from the manual list', () => {
    let doc = ops.placeBend(makeDoc(), 'run-1', 5, 10);
    const before = doc.runs[0].bends!.length;
    doc = ops.deleteBend(doc, 'run-1', 0, 10);
    expect(doc.runs[0].bends!.length).toBe(before - 1);
  });

  it('resetBends drops the override (back to auto-detect)', () => {
    let doc = ops.placeBend(makeDoc(), 'run-1', 5, 10);
    expect(doc.runs[0].bends).toBeDefined();
    doc = ops.resetBends(doc, 'run-1');
    expect(doc.runs[0].bends).toBeUndefined();
  });
});

describe('color/diameter/notes ops', () => {
  it('setRunColor sets the color', () => {
    const doc = ops.setRunColor(makeDoc(), 'run-1', 'classic-red');
    expect(doc.runs[0].color).toBe('classic-red');
  });

  it('setRunColor("") clears the field entirely', () => {
    let doc = ops.setRunColor(makeDoc(), 'run-1', 'classic-red');
    doc = ops.setRunColor(doc, 'run-1', '');
    expect(doc.runs[0].color).toBeUndefined();
  });

  it('setRunDiameter sets the override', () => {
    const doc = ops.setRunDiameter(makeDoc(), 'run-1', 12);
    expect(doc.runs[0].tube_diameter_mm).toBe(12);
  });

  it('setRunDiameter(null) clears the override', () => {
    const doc = ops.setRunDiameter(makeDoc(), 'run-1', null);
    expect(doc.runs[0].tube_diameter_mm).toBeUndefined();
  });

  it('setRunNotes stores text and trims-empty clears', () => {
    let doc = ops.setRunNotes(makeDoc(), 'run-1', '15kV @ 60mA');
    expect(doc.runs[0].notes).toBe('15kV @ 60mA');
    doc = ops.setRunNotes(doc, 'run-1', '   ');
    expect(doc.runs[0].notes).toBeUndefined();
  });
});

describe('label/dimension ops', () => {
  it('placeLabel appends to doc.labels', () => {
    const doc = ops.placeLabel(makeDoc(), 5, 5, 'transformer');
    expect(doc.labels).toEqual([{ x: 5, y: 5, text: 'transformer' }]);
  });

  it('deleteLabel removes the indexed entry', () => {
    let doc = ops.placeLabel(makeDoc(), 5, 5, 'a');
    doc = ops.placeLabel(doc, 6, 6, 'b');
    doc = ops.deleteLabel(doc, 0);
    expect(doc.labels).toEqual([{ x: 6, y: 6, text: 'b' }]);
  });

  it('placeDimension stores both endpoints and optional note', () => {
    const doc = ops.placeDimension(makeDoc(), 0, 0, 10, 0, 'min spacing');
    expect(doc.dimensions).toEqual([{ x1: 0, y1: 0, x2: 10, y2: 0, note: 'min spacing' }]);
  });

  it('placeDimension omits note when empty', () => {
    const doc = ops.placeDimension(makeDoc(), 0, 0, 10, 0);
    expect(doc.dimensions![0].note).toBeUndefined();
  });
});

describe('path-op simplify', () => {
  it('drops collinear vertices below epsilon', () => {
    // Long straight line with a single bump: simplify should keep ends + bump.
    const pts: [number, number][] = [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 5], [6, 0], [7, 0], [8, 0], [9, 0],
    ];
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [{ id: 'run-1', polyline: { points: pts, closed: false } }],
    };
    const next = ops.simplifyRun(doc, 'run-1', 0.5);
    expect(next.runs[0].polyline.points.length).toBeLessThan(pts.length);
    // Endpoints + bump apex must survive.
    expect(next.runs[0].polyline.points[0]).toEqual([0, 0]);
    expect(next.runs[0].polyline.points.at(-1)).toEqual([9, 0]);
    expect(next.runs[0].polyline.points.some((p) => p[0] === 5 && p[1] === 5)).toBe(true);
  });

  it('preserves electrode positions through the index remap', () => {
    const pts: [number, number][] = [
      [0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 5], [6, 0], [7, 0], [8, 0], [9, 0],
    ];
    let doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [{ id: 'run-1', polyline: { points: pts, closed: false }, electrodes: [{ point_index: 5 }] }],
    };
    doc = ops.simplifyRun(doc, 'run-1', 0.5);
    const r = doc.runs[0];
    const ePoint = r.polyline.points[r.electrodes![0].point_index];
    expect(ePoint).toEqual([5, 5]);
  });

  it('no-op when epsilon <= 0', () => {
    const pts: [number, number][] = [[0, 0], [1, 1], [2, 2], [3, 3]];
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 5, 5],
      runs: [{ id: 'run-1', polyline: { points: pts, closed: false } }],
    };
    const next = ops.simplifyRun(doc, 'run-1', 0);
    expect(next).toBe(doc);
  });
});

describe('path-op reverse', () => {
  it('reverses point order and flips electrode anchors', () => {
    let doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'run-1',
          polyline: { points: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 4 }],
        },
      ],
    };
    doc = ops.reverseRun(doc, 'run-1');
    expect(doc.runs[0].polyline.points).toEqual([[4, 0], [3, 0], [2, 0], [1, 0], [0, 0]]);
    // Electrodes still point at the same physical [0,0] and [4,0] points.
    const flip = doc.runs[0].electrodes!.map((e) => doc.runs[0].polyline.points[e.point_index]);
    expect(flip).toEqual(expect.arrayContaining([[0, 0], [4, 0]]));
  });
});

describe('vertex ops', () => {
  it('moveVertex updates the indexed point', () => {
    const doc = ops.moveVertex(makeDoc(), 'run-1', 0, 1.5, 1.5);
    expect(doc.runs[0].polyline.points[0]).toEqual([1.5, 1.5]);
  });

  it('moveVertex no-ops on identical coords (preserves doc reference)', () => {
    const doc = makeDoc();
    const next = ops.moveVertex(doc, 'run-1', 0, doc.runs[0].polyline.points[0][0], doc.runs[0].polyline.points[0][1]);
    expect(next.runs[0]).toBe(doc.runs[0]);
  });

  it('deleteVertex removes the point and shifts higher electrode references', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 5);  // before delete
    doc = ops.placeElectrode(doc, 'run-1', 10); // after delete (will shift to 9)
    doc = ops.deleteVertex(doc, 'run-1', 7);    // delete index 7
    const r = doc.runs[0];
    expect(r.electrodes).toEqual([{ point_index: 5 }, { point_index: 9 }]);
  });

  it('deleteVertex removes the electrode that pointed at the deleted vertex', () => {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 5);
    doc = ops.deleteVertex(doc, 'run-1', 5);
    expect(doc.runs[0].electrodes).toEqual([]);
  });

  it('deleteVertex refuses to drop a closed polyline below 3 points', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 1, 1],
      runs: [
        {
          id: 'run-x',
          polyline: { points: [[0, 0], [1, 0], [0, 1]], closed: true },
        },
      ],
    };
    const next = ops.deleteVertex(doc, 'run-x', 0);
    expect(next.runs[0].polyline.points.length).toBe(3);
  });
});
