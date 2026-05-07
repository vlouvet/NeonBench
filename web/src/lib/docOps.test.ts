import { describe, expect, it, vi } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import * as ops from './docOps';
import { rectToPoints } from './shapes/rect';
import { circleToPoints } from './shapes/circle';
import { threePointArcToPoints } from './shapes/arc';

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

describe('appendRuns', () => {
  it('appends runs and assigns unique sequential ids with the given prefix', () => {
    const newRuns: DesignRun[] = [
      { id: 'ignored-1', polyline: { points: [[0, 0], [1, 1]], closed: false } },
      { id: 'ignored-2', polyline: { points: [[2, 2], [3, 3]], closed: false } },
    ];
    const doc = ops.appendRuns(makeDoc(), newRuns, 'text');
    const tail = doc.runs.slice(-2);
    expect(tail.map((r) => r.id)).toEqual(['text-1', 'text-2']);
    // Original runs preserved.
    expect(doc.runs.length).toBe(makeDoc().runs.length + 2);
  });

  it('skips ids that already exist on the doc', () => {
    const seed = makeDoc();
    seed.runs.push({
      id: 'text-1',
      polyline: { points: [[9, 9], [9, 10]], closed: false },
    });
    const newRuns: DesignRun[] = [
      { id: 'x', polyline: { points: [[0, 0], [1, 1]], closed: false } },
    ];
    const doc = ops.appendRuns(seed, newRuns, 'text');
    const tail = doc.runs[doc.runs.length - 1];
    // Original 'text-1' kept; appended run got 'text-2'.
    expect(tail.id).toBe('text-2');
  });

  it('drawing tools (rect / circle / arc) commit through appendRuns with stable per-prefix counters', () => {
    // Mimics what the canvas does when the user draws a shape. This isn't
    // exercising any UI; it's exercising the shape geometry helpers + the
    // appendRuns pipeline together so we catch a regression in the
    // contract between them (e.g. rect helper drops the closing dup, or
    // appendRuns stops respecting the prefix).
    const blank: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 1000, 500],
      runs: [],
    };
    const r1: DesignRun = { id: 'rect', polyline: { points: rectToPoints(0, 0, 100, 50), closed: true } };
    const c1: DesignRun = { id: 'circle', polyline: { points: circleToPoints(200, 100, 25, 64), closed: true } };
    const a1: DesignRun = {
      id: 'arc',
      polyline: { points: threePointArcToPoints([0, 0], [50, 50], [100, 0]), closed: false },
    };
    let doc = ops.appendRuns(blank, [r1], 'rect');
    doc = ops.appendRuns(doc, [c1], 'circle');
    doc = ops.appendRuns(doc, [a1], 'arc');
    const r2: DesignRun = { id: 'rect', polyline: { points: rectToPoints(10, 10, 60, 40), closed: true } };
    doc = ops.appendRuns(doc, [r2], 'rect');
    expect(doc.runs.map((r) => r.id)).toEqual(['rect-1', 'circle-1', 'arc-1', 'rect-2']);
    // Geometry survived intact — first run is the closed 100x50 rectangle.
    expect(doc.runs[0].polyline.points.length).toBe(5);
    expect(doc.runs[0].polyline.closed).toBe(true);
    // Arc run is open and starts/ends at the user-clicked points.
    expect(doc.runs[2].polyline.closed).toBe(false);
    expect(doc.runs[2].polyline.points[0]).toEqual([0, 0]);
    expect(doc.runs[2].polyline.points.at(-1)).toEqual([100, 0]);
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

describe('insertVertex', () => {
  function lineDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: { points: [[0, 0], [10, 0]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
  }

  it('inserts at midpoint of a 2-vertex segment with 3 vertices, middle = average', () => {
    const next = ops.insertVertex(lineDoc(), 'run-1', 0, 0.5);
    const pts = next.runs[0].polyline.points;
    expect(pts.length).toBe(3);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[1][0]).toBeCloseTo(5, 6);
    expect(pts[1][1]).toBeCloseTo(0, 6);
    expect(pts[2]).toEqual([10, 0]);
  });

  it('custom t = 0.25 produces the expected interpolated point', () => {
    const next = ops.insertVertex(lineDoc(), 'run-1', 0, 0.25);
    const pts = next.runs[0].polyline.points;
    expect(pts[1][0]).toBeCloseTo(2.5, 6);
    expect(pts[1][1]).toBeCloseTo(0, 6);
  });

  it('shifts an electrode at point_index >= insertion+1 up by 1', () => {
    // Build a 5-vertex run with electrode at index 4 (the last vertex).
    // Insert at segment 0 (between indices 0 and 1) — electrode lands
    // at the new index 5.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 0 }, { point_index: 4 }],
          blockouts: [{ start_live_index: 1, end_live_index: 3 }],
          annotations: [
            { kind: 'jump', live_index: 0 },
            { kind: 'support', live_index: 3 },
          ],
          bends: [{ live_index: 0 }, { live_index: 2 }],
        },
      ],
    };
    const next = ops.insertVertex(doc, 'run-1', 0, 0.5);
    const r = next.runs[0];
    expect(r.polyline.points.length).toBe(6);
    // Electrode at point_index 0 is BEFORE the insertion (which splices
    // a new vertex at index 1, between the original vertices 0 and 1) —
    // it stays. Electrode at 4 shifts to 5.
    expect(r.electrodes).toEqual([{ point_index: 0 }, { point_index: 5 }]);
    // Blockout shifts both ends by 1 (both >= 1).
    expect(r.blockouts).toEqual([{ start_live_index: 2, end_live_index: 4 }]);
    // Annotations: live 0 stays, live 3 shifts to 4.
    expect(r.annotations).toEqual([
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 4 },
    ]);
    // Bends: live 0 stays, live 2 shifts to 3.
    expect(r.bends).toEqual([{ live_index: 0 }, { live_index: 3 }]);
  });
});

describe('splitRun', () => {
  function fiveVertexDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          color: 'classic-red',
          notes: '15kV',
        },
      ],
    };
  }

  it('splits a 5-vertex open run at pointIndex=2 → two open runs of 3 vertices each (with shared vertex)', () => {
    const next = ops.splitRun(fiveVertexDoc(), 'run-1', 2);
    expect(next.runs.length).toBe(2);
    const a = next.runs[0];
    const b = next.runs[1];
    expect(a.id).toBe('run-1-a');
    expect(b.id).toBe('run-1-b');
    expect(a.polyline.points).toEqual([[0, 0], [25, 0], [50, 0]]);
    expect(b.polyline.points).toEqual([[50, 0], [75, 0], [100, 0]]);
    expect(a.polyline.closed).toBe(false);
    expect(b.polyline.closed).toBe(false);
    // Metadata duplicated.
    expect(a.color).toBe('classic-red');
    expect(b.color).toBe('classic-red');
    expect(a.tube_diameter_mm).toBe(10);
    expect(b.tube_diameter_mm).toBe(10);
    expect(a.notes).toBe('15kV');
    expect(b.notes).toBe('15kV');
  });

  it('splitting a closed run produces two open runs', () => {
    // Square loop: 4 distinct vertices marked closed.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'sq',
          polyline: { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true },
        },
      ],
    };
    const next = ops.splitRun(doc, 'sq', 2);
    expect(next.runs.length).toBe(2);
    expect(next.runs[0].polyline.closed).toBe(false);
    expect(next.runs[1].polyline.closed).toBe(false);
  });

  it('partitions electrodes / blockouts / annotations correctly across the split', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 1 }, { point_index: 4 }],
          annotations: [
            { kind: 'jump', live_index: 0 },
            { kind: 'support', live_index: 4 },
          ],
          bends: [{ live_index: 1 }, { live_index: 3 }],
        },
      ],
    };
    // Split at pointIndex = 2.
    const next = ops.splitRun(doc, 'run-1', 2);
    const a = next.runs[0];
    const b = next.runs[1];
    expect(a.electrodes).toEqual([{ point_index: 1 }]);
    expect(b.electrodes).toEqual([{ point_index: 2 }]); // 4 - 2 = 2
    expect(a.annotations).toEqual([{ kind: 'jump', live_index: 0 }]);
    expect(b.annotations).toEqual([{ kind: 'support', live_index: 2 }]); // 4 - 2 = 2
    expect(a.bends).toEqual([{ live_index: 1 }]);
    expect(b.bends).toEqual([{ live_index: 1 }]); // 3 - 2 = 1
  });

  it('drops a blockout straddling the split point with a console.warn', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          blockouts: [{ start_live_index: 1, end_live_index: 3 }],
        },
      ],
    };
    const next = ops.splitRun(doc, 'run-1', 2);
    const a = next.runs[0];
    const b = next.runs[1];
    expect(a.blockouts).toBeUndefined();
    expect(b.blockouts).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('joinRuns', () => {
  function makeRun(id: string, pts: [number, number][]): DesignRun {
    return { id, polyline: { points: pts, closed: false } };
  }

  it('tail-to-head join with no reversal: [A,B,C] + [C,D,E] → [A,B,C,D,E] (duplicate dropped)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        makeRun('a', [[0, 0], [1, 0], [2, 0]]),
        makeRun('b', [[2, 0], [3, 0], [4, 0]]),
      ],
    };
    const next = ops.joinRuns(doc, 'a', 'tail', 'b', 'head');
    expect(next.runs.length).toBe(1);
    expect(next.runs[0].id).toBe('a');
    expect(next.runs[0].polyline.points).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    expect(next.runs[0].polyline.closed).toBe(false);
  });

  it('tail-to-tail: second run is reversed before concatenation', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        makeRun('a', [[0, 0], [1, 0], [2, 0]]),
        // Tail of b is at (2,0); reversing b gives [2,0],[3,0],[4,0].
        makeRun('b', [[4, 0], [3, 0], [2, 0]]),
      ],
    };
    const next = ops.joinRuns(doc, 'a', 'tail', 'b', 'tail');
    expect(next.runs[0].polyline.points).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
  });

  it('head-to-head: first run reversed, then concatenated normally', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        // Both runs share the head vertex (0,0). reverse(a) = [2,0],[1,0],[0,0];
        // concat with b yields [2,0],[1,0],[0,0],[1,0],[2,0] after seam dedup.
        makeRun('a', [[0, 0], [1, 0], [2, 0]]),
        makeRun('b', [[0, 0], [1, 0], [2, 0]]),
      ],
    };
    const next = ops.joinRuns(doc, 'a', 'head', 'b', 'head');
    // reverse(a) ends at (0,0); b starts at (0,0); seam dedupes.
    expect(next.runs[0].polyline.points).toEqual([[2, 0], [1, 0], [0, 0], [1, 0], [2, 0]]);
  });

  it('self-join (head + tail) on a 4-vertex polyline produces a closed run', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [makeRun('a', [[0, 0], [1, 0], [1, 1], [0, 1]])],
    };
    const next = ops.joinRuns(doc, 'a', 'head', 'a', 'tail');
    expect(next.runs.length).toBe(1);
    expect(next.runs[0].polyline.points.length).toBe(4);
    expect(next.runs[0].polyline.closed).toBe(true);
  });

  it('electrodes from both runs end up on the result with correctly transformed indices', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'a',
          polyline: { points: [[0, 0], [1, 0], [2, 0]], closed: false },
          electrodes: [{ point_index: 0 }],
        },
        {
          id: 'b',
          polyline: { points: [[2, 0], [3, 0], [4, 0]], closed: false },
          electrodes: [{ point_index: 2 }],
        },
      ],
    };
    const next = ops.joinRuns(doc, 'a', 'tail', 'b', 'head');
    // After seam dedupe, joined points are [0,0],[1,0],[2,0],[3,0],[4,0].
    // a's electrode at index 0 stays at 0 (physical [0,0]).
    // b's electrode at index 2 (physical [4,0]) lands at index 4 in the
    // joined polyline (aLen=3, bStartIdx=1, so 3 + (2 - 1) = 4).
    expect(next.runs[0].electrodes).toEqual([
      { point_index: 0 },
      { point_index: 4 },
    ]);
    expect(next.runs[0].polyline.points[0]).toEqual([0, 0]);
    expect(next.runs[0].polyline.points[4]).toEqual([4, 0]);
  });
});

describe('insertDoubleback', () => {
  // A simple horizontal three-vertex run we can drop a hairpin into. Tube
  // diameter 10mm so the project-default math is easy to reason about
  // (1.5× = 15mm depth, 1.0× = 10mm gap mouth).
  function horizDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: { points: [[0, 0], [100, 0], [100, 50]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
  }

  it('inserts 4 new vertices forming a downward U on a horizontal segment', () => {
    // Segment 0 runs from (0,0) → (100,0); insertion at t=0.5 should
    // drop a hairpin centered at x=50 toward +y (the "left" side of
    // forward = (1,0) is (-fy,fx) = (0,1), which is +y).
    const doc = ops.insertDoubleback(horizDoc(), 'run-1', 0, 0.5);
    const pts = doc.runs[0].polyline.points;
    // Original 3 + 4 inserted = 7.
    expect(pts.length).toBe(7);
    // Endpoints unchanged.
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[6]).toEqual([100, 50]);
    // Hairpin vertices A=1, B=2, C=3, D=4.
    const [ax, ay] = pts[1];
    const [bx, by] = pts[2];
    const [cx, cy] = pts[3];
    const [dx, dy] = pts[4];
    // A and D sit on the segment line (y=0); B and C drop down by 15mm.
    expect(ay).toBeCloseTo(0, 6);
    expect(dy).toBeCloseTo(0, 6);
    expect(by).toBeCloseTo(15, 6);
    expect(cy).toBeCloseTo(15, 6);
    // The U is centered on x=50 with mouth width = gap = 10mm.
    expect(ax).toBeCloseTo(45, 6);
    expect(bx).toBeCloseTo(45, 6);
    expect(cx).toBeCloseTo(55, 6);
    expect(dx).toBeCloseTo(55, 6);
  });

  it('default depth = 1.5× run tube diameter', () => {
    // Tube diameter 8 → depth should be 12mm.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r',
          polyline: { points: [[0, 0], [100, 0]], closed: false },
          tube_diameter_mm: 8,
        },
      ],
    };
    const next = ops.insertDoubleback(doc, 'r', 0, 0.5);
    const pts = next.runs[0].polyline.points;
    // B is at index 2; its y is the U-depth.
    expect(pts[2][1]).toBeCloseTo(12, 6);
    // Gap is 1.0× = 8mm; A=(46,0), D=(54,0).
    expect(pts[1][0]).toBeCloseTo(46, 6);
    expect(pts[4][0]).toBeCloseTo(54, 6);
  });

  it('custom depth + gap params override the defaults', () => {
    const doc = ops.insertDoubleback(horizDoc(), 'run-1', 0, 0.5, 30, 4);
    const pts = doc.runs[0].polyline.points;
    // B at index 2 dropped by depth=30.
    expect(pts[2][1]).toBeCloseTo(30, 6);
    // U mouth = 4mm centered at x=50 → A=48, D=52.
    expect(pts[1][0]).toBeCloseTo(48, 6);
    expect(pts[4][0]).toBeCloseTo(52, 6);
  });

  it('shifts electrodes / blockouts / annotations / bends past the insertion by 4', () => {
    // Build a run with an electrode before the insertion and one after,
    // plus a blockout, annotation, and bend on each side. Insertion at
    // segment 0 (between point indices 0 and 1) should leave the
    // before-insertion anchors untouched and bump the after-insertion
    // ones up by 4.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            // 5 vertices: indices 0..4. Segment 0 is (0,0)→(25,0); the
            // hairpin gets spliced between vertices 0 and 1.
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 0 }, { point_index: 4 }],
          blockouts: [{ start_live_index: 0, end_live_index: 2 }, { start_live_index: 3, end_live_index: 4 }],
          annotations: [
            { kind: 'jump', live_index: 0 },
            { kind: 'support', live_index: 3 },
          ],
          bends: [{ live_index: 0 }, { live_index: 2 }],
        },
      ],
    };
    const next = ops.insertDoubleback(doc, 'run-1', 0, 0.5);
    const r = next.runs[0];
    // 5 + 4 inserted = 9 vertices.
    expect(r.polyline.points.length).toBe(9);
    // Electrode at point_index 0 stayed (it's BEFORE the insertion, which
    // splices between indices 0 and 1). Electrode at 4 shifted to 8.
    expect(r.electrodes).toEqual([{ point_index: 0 }, { point_index: 8 }]);
    // Blockout starting at live 0 stays; the end at live 2 (>=1) bumps
    // by 4 to 6. The second blockout (3..4) bumps to (7..8).
    expect(r.blockouts).toEqual([
      { start_live_index: 0, end_live_index: 6 },
      { start_live_index: 7, end_live_index: 8 },
    ]);
    expect(r.annotations).toEqual([
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 7 },
    ]);
    expect(r.bends).toEqual([{ live_index: 0 }, { live_index: 6 }]);
  });

  it('side="right" mirrors the U onto the opposite side of the segment', () => {
    const doc = ops.insertDoubleback(horizDoc(), 'run-1', 0, 0.5, undefined, undefined, 'right');
    const pts = doc.runs[0].polyline.points;
    // Right side of forward (1,0) is (fy,-fx) = (0,-1), so B and C drop
    // to negative y instead of positive.
    expect(pts[2][1]).toBeCloseTo(-15, 6);
    expect(pts[3][1]).toBeCloseTo(-15, 6);
  });
});

describe('neonize', () => {
  function squareDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'sq',
          polyline: {
            points: [
              [0, 0],
              [100, 0],
              [100, 100],
              [0, 100],
            ],
            closed: true,
          },
          color: 'classic-red',
          tube_diameter_mm: 12,
          notes: '15kV @ 60mA',
        },
      ],
    };
  }

  it('replaces a closed square run with two parallel offset runs (outer 120×120, inner 80×80)', () => {
    const { doc, warning } = ops.neonize(squareDoc(), 'sq', 20);
    expect(warning).toBeUndefined();
    expect(doc.runs.length).toBe(2);
    expect(doc.runs.find((r) => r.id === 'sq')).toBeUndefined();
    const outer = doc.runs.find((r) => r.id === 'sq-outer')!;
    const inner = doc.runs.find((r) => r.id === 'sq-inner')!;
    expect(outer.polyline.closed).toBe(true);
    expect(inner.polyline.closed).toBe(true);
    // Outer bbox = -10..110 each axis (square + 10mm halo).
    const oXs = outer.polyline.points.map((p) => p[0]);
    const oYs = outer.polyline.points.map((p) => p[1]);
    expect(Math.min(...oXs)).toBeCloseTo(-10, 6);
    expect(Math.max(...oXs)).toBeCloseTo(110, 6);
    expect(Math.min(...oYs)).toBeCloseTo(-10, 6);
    expect(Math.max(...oYs)).toBeCloseTo(110, 6);
    // Inner bbox = 10..90 each axis (square - 10mm inset).
    const iXs = inner.polyline.points.map((p) => p[0]);
    const iYs = inner.polyline.points.map((p) => p[1]);
    expect(Math.min(...iXs)).toBeCloseTo(10, 6);
    expect(Math.max(...iXs)).toBeCloseTo(90, 6);
    expect(Math.min(...iYs)).toBeCloseTo(10, 6);
    expect(Math.max(...iYs)).toBeCloseTo(90, 6);
  });

  it('returns a warning and leaves the doc untouched when the run is open', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'open',
          polyline: { points: [[0, 0], [50, 0], [100, 0]], closed: false },
        },
      ],
    };
    const result = ops.neonize(doc, 'open', 10);
    expect(result.warning).toBeDefined();
    expect(result.warning!.length).toBeGreaterThan(0);
    expect(result.doc).toBe(doc); // strict identity: no-op
  });

  it('preserves color, tube_diameter_mm, and notes on both new runs', () => {
    const { doc } = ops.neonize(squareDoc(), 'sq', 20);
    const outer = doc.runs.find((r) => r.id === 'sq-outer')!;
    const inner = doc.runs.find((r) => r.id === 'sq-inner')!;
    expect(outer.color).toBe('classic-red');
    expect(inner.color).toBe('classic-red');
    expect(outer.tube_diameter_mm).toBe(12);
    expect(inner.tube_diameter_mm).toBe(12);
    expect(outer.notes).toBe('15kV @ 60mA');
    expect(inner.notes).toBe('15kV @ 60mA');
  });

  it('non-existent runId returns the doc unchanged with no warning', () => {
    const doc = squareDoc();
    const result = ops.neonize(doc, 'does-not-exist', 10);
    expect(result.warning).toBeUndefined();
    expect(result.doc).toBe(doc);
  });
});
