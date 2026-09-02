import { describe, expect, it, vi } from 'vitest';
import type { DesignDoc, DesignRun, SegmentKind } from '../api';
import * as ops from './docOps';
import { rectToPoints } from './shapes/rect';
import { circleToPoints } from './shapes/circle';
import {
  flatRunPoints,
  flattenSegment,
  isArcKind,
  segmentCount,
  segmentIndexBetween,
  segmentLengthMM,
  segmentTypeAt,
  walkSegmentLengthMM,
} from './arcGeom';
import { blockoutSegments, runArcs } from './runArcs';
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

// ---------------------------------------------------------------------------
// The segment_types length invariant, shared so the whole suite can assert it.
//
// `ops.segmentTypesWellFormed` is the TypeScript twin of the check
// `(*Polyline).UnmarshalJSON` runs in internal/designdoc/types.go. Until
// Bug #17 that decoder was the ONLY thing in the system that checked it, and
// it checks at SAVE time: an op that leaves the array the wrong length hands
// back an editor that looks like it is working and 400s on the next save.
// Asserting it here says which op broke it, at the op.
//
// Use `expectWellFormedRun` after ANY op that changes a run's point count or
// point order. It is deliberately silent about a run with no array at all —
// that is a pre-#78 run and means "every segment straight" — so pair it with
// an assertion that the arcs you expect are still there, or it passes
// vacuously on a run whose segment_types the op simply dropped.
// ---------------------------------------------------------------------------
function expectWellFormedRun(run: DesignRun) {
  const st = run.polyline.segment_types;
  const want = run.polyline.closed
    ? run.polyline.points.length
    : run.polyline.points.length - 1;
  expect(
    ops.segmentTypesWellFormed(run),
    `run ${run.id}: segment_types ${JSON.stringify(st)} (${st?.length ?? 'absent'}) `
    + `against ${run.polyline.points.length} points, closed=${run.polyline.closed}, `
    + `want ${want} entries`,
  ).toBe(true);
}

function expectWellFormedDoc(doc: DesignDoc) {
  for (const r of doc.runs) expectWellFormedRun(r);
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

describe('setElectrodeHousing', () => {
  function docWithElectrode(): DesignDoc {
    let doc = makeDoc();
    doc = ops.placeElectrode(doc, 'run-1', 5);
    return doc;
  }

  it('sets a stock 15-shell housing and strips the bore (library is authoritative)', () => {
    const doc = docWithElectrode();
    const next = ops.setElectrodeHousing(doc, 'run-1', 0, {
      housing_type: 'shell-15',
      elevation_mm: 50,
    });
    const e = next.runs[0].electrodes![0] as { point_index: number; housing_type?: string; bore_diameter_mm?: number; elevation_mm?: number };
    expect(e.point_index).toBe(5);
    expect(e.housing_type).toBe('shell-15');
    // Bore for stock shells is sourced from the library at read time
    // and intentionally not persisted on the doc.
    expect(e.bore_diameter_mm).toBeUndefined();
    expect(e.elevation_mm).toBe(50);
  });

  it('drops a user-supplied bore when picking a stock shell', () => {
    const doc = docWithElectrode();
    const next = ops.setElectrodeHousing(doc, 'run-1', 0, {
      housing_type: 'shell-19',
      bore_diameter_mm: 99, // ignored
    });
    const e = next.runs[0].electrodes![0] as { housing_type?: string; bore_diameter_mm?: number };
    expect(e.housing_type).toBe('shell-19');
    expect(e.bore_diameter_mm).toBeUndefined();
  });

  it('accepts a custom housing with an arbitrary positive bore', () => {
    const doc = docWithElectrode();
    const next = ops.setElectrodeHousing(doc, 'run-1', 0, {
      housing_type: 'custom',
      bore_diameter_mm: 11.0,
      elevation_mm: 75,
    });
    const e = next.runs[0].electrodes![0] as { housing_type?: string; bore_diameter_mm?: number; elevation_mm?: number };
    expect(e.housing_type).toBe('custom');
    expect(e.bore_diameter_mm).toBe(11.0);
    expect(e.elevation_mm).toBe(75);
  });

  it('throws OperationError when custom housing has no bore', () => {
    const doc = docWithElectrode();
    expect(() =>
      ops.setElectrodeHousing(doc, 'run-1', 0, {
        housing_type: 'custom',
      }),
    ).toThrow(/bore_diameter_mm/);
  });

  it('throws OperationError when custom housing has zero or negative bore', () => {
    const doc = docWithElectrode();
    expect(() =>
      ops.setElectrodeHousing(doc, 'run-1', 0, {
        housing_type: 'custom',
        bore_diameter_mm: 0,
      }),
    ).toThrow(/bore_diameter_mm/);
    expect(() =>
      ops.setElectrodeHousing(doc, 'run-1', 0, {
        housing_type: 'custom',
        bore_diameter_mm: -2,
      }),
    ).toThrow(/bore_diameter_mm/);
  });

  it('throws OperationError on an unknown housing_type', () => {
    const doc = docWithElectrode();
    expect(() =>
      ops.setElectrodeHousing(doc, 'run-1', 0, {
        housing_type: 'shell-25' as 'custom', // bypass type guard for the test
      }),
    ).toThrow(/invalid housing_type/);
  });

  it('clears every housing field when housing_type is empty', () => {
    let doc = docWithElectrode();
    doc = ops.setElectrodeHousing(doc, 'run-1', 0, {
      housing_type: 'custom',
      bore_diameter_mm: 11,
      elevation_mm: 80,
    });
    doc = ops.setElectrodeHousing(doc, 'run-1', 0, { housing_type: '' });
    const e = doc.runs[0].electrodes![0] as { point_index: number; housing_type?: string; bore_diameter_mm?: number; elevation_mm?: number };
    expect(e.point_index).toBe(5);
    expect(e.housing_type).toBeUndefined();
    expect(e.bore_diameter_mm).toBeUndefined();
    expect(e.elevation_mm).toBeUndefined();
  });

  it('returns the input doc unchanged for an out-of-range electrode index', () => {
    const doc = docWithElectrode();
    const next = ops.setElectrodeHousing(doc, 'run-1', 99, {
      housing_type: 'shell-15',
    });
    expect(next.runs[0].electrodes![0]).toEqual({ point_index: 5 });
  });

  it('round-trips through JSON cleanly', () => {
    const doc = docWithElectrode();
    const set = ops.setElectrodeHousing(doc, 'run-1', 0, {
      housing_type: 'custom',
      bore_diameter_mm: 11,
      elevation_mm: 75,
    });
    const round = JSON.parse(JSON.stringify(set)) as DesignDoc;
    const e = round.runs[0].electrodes![0] as { housing_type?: string; bore_diameter_mm?: number; elevation_mm?: number };
    expect(e.housing_type).toBe('custom');
    expect(e.bore_diameter_mm).toBe(11);
    expect(e.elevation_mm).toBe(75);
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

describe('insertChannelLetterRuns', () => {
  it('appends every emitted run under the "letter-N" id prefix and preserves face flags', () => {
    const wizardOut: DesignRun[] = [
      {
        id: 'letter-0-face',
        polyline: { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true },
        is_channel_letter_face: true,
      },
      {
        id: 'letter-0-outer',
        polyline: { points: [[-1, -1], [11, -1], [11, 11], [-1, 11]], closed: true },
      },
    ];
    const doc = ops.insertChannelLetterRuns(makeDoc(), wizardOut);
    const tail = doc.runs.slice(-2);
    expect(tail.map((r) => r.id)).toEqual(['letter-1', 'letter-2']);
    expect(tail[0].is_channel_letter_face).toBe(true);
    expect(tail[1].is_channel_letter_face).toBeUndefined();
  });

  it('overrides every emitted run\'s raceway_id when the caller supplies one', () => {
    const wizardOut: DesignRun[] = [
      {
        id: 'a',
        polyline: { points: [[0, 0], [10, 0], [10, 10]], closed: true },
        raceway_id: 'wizard-default',
      },
      {
        id: 'b',
        polyline: { points: [[2, 2], [8, 2], [8, 8]], closed: true },
      },
    ];
    const doc = ops.insertChannelLetterRuns(makeDoc(), wizardOut, 'OPEN-sign');
    const tail = doc.runs.slice(-2);
    for (const r of tail) expect(r.raceway_id).toBe('OPEN-sign');
  });

  it('returns a doc with the input unchanged when given an empty runs array', () => {
    const before = makeDoc();
    const after = ops.insertChannelLetterRuns(before, []);
    expect(after.runs.length).toBe(before.runs.length);
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
    // Tier 3 #25: numeric flat-id scheme. The doc had `run-1` which
    // doesn't match the `r<n>` pattern, so the lowest unused integers
    // are 1 and 2.
    expect(a.id).toBe('r1');
    expect(b.id).toBe('r2');
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

  it('preserves a straddling blockout as two pieces, one on each new run', () => {
    // 10-point open run with blockout [2, 7] split at point index 5.
    // Run-a covers polyline indices 0..5 (6 points); the blockout's
    // run-a piece is [2, 4] (split point excluded). Run-b covers 5..9
    // renumbered to 0..4 (5 points); its blockout piece is [0, 2].
    const pts: [number, number][] = [];
    for (let i = 0; i < 10; i++) pts.push([i * 10, 0]);
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: { points: pts, closed: false },
          tube_diameter_mm: 10,
          blockouts: [{ start_live_index: 2, end_live_index: 7 }],
        },
      ],
    };
    const next = ops.splitRun(doc, 'run-1', 5);
    const a = next.runs[0];
    const b = next.runs[1];
    expect(a.blockouts).toEqual([{ start_live_index: 2, end_live_index: 4 }]);
    expect(b.blockouts).toEqual([{ start_live_index: 0, end_live_index: 2 }]);
  });

  it('with a blockout that ends exactly at the split point does not synthesize an empty piece', () => {
    // Blockout [2, 5] split at 5: hi == pointIndex, so it's NOT
    // straddling — it stays entirely on run-a. Run-b inherits no
    // blockout from this source.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [
              [0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [50, 0],
              [60, 0], [70, 0], [80, 0], [90, 0],
            ],
            closed: false,
          },
          tube_diameter_mm: 10,
          blockouts: [{ start_live_index: 2, end_live_index: 5 }],
        },
      ],
    };
    const next = ops.splitRun(doc, 'run-1', 5);
    const a = next.runs[0];
    const b = next.runs[1];
    expect(a.blockouts).toEqual([{ start_live_index: 2, end_live_index: 5 }]);
    expect(b.blockouts).toBeUndefined();
  });

  it('produces sequential numeric IDs (Tier 3 #25)', () => {
    // Doc has a single run named "r1" — the `r<n>` scheme is in use, so
    // the lowest unused integers are 2 and 3. No `-a`/`-b` suffixes.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r1',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
        },
      ],
    };
    const next = ops.splitRun(doc, 'r1', 2);
    expect(next.runs.map((r) => r.id)).toEqual(['r2', 'r3']);
    // Original `r1` is removed.
    expect(next.runs.find((r) => r.id === 'r1')).toBeUndefined();
  });

  it('repeated splits stay flat (no nested suffixes from a legacy id)', () => {
    // A doc with a legacy `<id>-a` from a pre-Tier-3-#25 split. New
    // splits use the numeric scheme, regardless of the source run's
    // name — so a second split of the legacy run still produces
    // r1/r2/etc, not `<id>-a-a` / `<id>-a-b`.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'legacy-a',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
        },
      ],
    };
    const next = ops.splitRun(doc, 'legacy-a', 2);
    expect(next.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
  });
});

describe('nextRunId', () => {
  it('returns r1 on an empty doc', () => {
    const doc: DesignDoc = { version: 1, view_box_mm: [0, 0, 10, 10], runs: [] };
    expect(ops.nextRunId(doc)).toBe('r1');
  });

  it('skips taken ids and returns the lowest unused', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        { id: 'r1', polyline: { points: [[0, 0], [1, 0]], closed: false } },
        { id: 'r3', polyline: { points: [[0, 0], [1, 0]], closed: false } },
      ],
    };
    expect(ops.nextRunId(doc)).toBe('r2');
  });

  it('ignores ids that don\'t match the prefix', () => {
    // text-1 / circle-2 are foreign to the `r<n>` namespace, so the
    // first allocated id is still r1.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        { id: 'text-1', polyline: { points: [[0, 0], [1, 0]], closed: false } },
        { id: 'circle-2', polyline: { points: [[0, 0], [1, 0]], closed: false } },
      ],
    };
    expect(ops.nextRunId(doc)).toBe('r1');
  });

  it('respects a custom prefix', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        { id: 'cut-1', polyline: { points: [[0, 0], [1, 0]], closed: false } },
        { id: 'cut-2', polyline: { points: [[0, 0], [1, 0]], closed: false } },
      ],
    };
    expect(ops.nextRunId(doc, 'cut-')).toBe('cut-3');
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

describe('autoDoublebackAllTerminations (Tier 2 #72)', () => {
  // Build a 4-letter sign — 4 open runs, each with two electrodes (head
  // + tail). Eight terminations total → 8 doublebacks should land in a
  // single batch. We keep each "letter" as a simple horizontal arc so
  // the U-bend math is easy to inspect, but the auto-batch is
  // letter-shape-agnostic — it just sweeps the doc.
  function fourLetterDoc(): DesignDoc {
    const runs: DesignRun[] = [];
    for (let k = 0; k < 4; k++) {
      const y = k * 30;
      runs.push({
        id: `letter-${k}`,
        // 5 vertices so insertDoubleback at segment 0 has somewhere to
        // grow into and the hairpin-detector has its 4-vertex window.
        polyline: {
          points: [
            [0, y],
            [25, y],
            [50, y],
            [75, y],
            [100, y],
          ],
          closed: false,
        },
        tube_diameter_mm: 10,
        electrodes: [{ point_index: 0 }, { point_index: 4 }],
      });
    }
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 120],
      runs,
    };
  }

  it('inserts a doubleback at every electrode termination on every open run', () => {
    const res = ops.autoDoublebackAllTerminations(fourLetterDoc());
    // 4 letters × 2 terminations each = 8.
    expect(res.added).toBe(8);
    expect(res.skipped).toBe(0);
    for (const run of res.doc.runs) {
      // Original 5 vertices + 4 added per termination × 2 terminations = 13.
      expect(run.polyline.points.length).toBe(13);
    }
  });

  it('returns the same doc reference when no electrodes are present (zero-electrode case)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r',
          polyline: { points: [[0, 0], [10, 0], [20, 0]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
    const res = ops.autoDoublebackAllTerminations(doc);
    expect(res.added).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.doc).toBe(doc); // structural identity for editDoc short-circuit
  });

  it('skips closed runs entirely (no endpoints → no terminations)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'loop',
          polyline: {
            points: [[0, 0], [10, 0], [10, 10], [0, 10]],
            closed: true,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
        },
      ],
    };
    const res = ops.autoDoublebackAllTerminations(doc);
    expect(res.added).toBe(0);
    expect(res.doc).toBe(doc);
  });

  it('is idempotent: re-running on an already-doublebacked doc adds zero', () => {
    const first = ops.autoDoublebackAllTerminations(fourLetterDoc());
    expect(first.added).toBe(8);
    const second = ops.autoDoublebackAllTerminations(first.doc);
    expect(second.added).toBe(0);
    // Skipped = 8 (every termination already wears a hairpin).
    expect(second.skipped).toBe(8);
    // No mutation → same doc reference.
    expect(second.doc).toBe(first.doc);
  });

  it('skips terminations that already have a doubleback within ~tubeDiameter (mixed case)', () => {
    // Manually doubleback the FIRST run's head, then auto-batch.
    let doc = fourLetterDoc();
    doc = ops.insertDoubleback(doc, 'letter-0', 0, 0.0, undefined, undefined, 'left');
    const res = ops.autoDoublebackAllTerminations(doc);
    // 8 total terminations; 1 already has a hairpin → 7 added.
    expect(res.added).toBe(7);
    expect(res.skipped).toBe(1);
  });

  it('honours custom depth + gap defaults', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 200, 200],
      runs: [
        {
          id: 'r',
          polyline: {
            points: [
              [0, 0],
              [50, 0],
              [100, 0],
              [150, 0],
              [200, 0],
            ],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 0 }, { point_index: 4 }],
        },
      ],
    };
    const res = ops.autoDoublebackAllTerminations(doc, {
      depthMM: 30,
      gapMM: 6,
    });
    expect(res.added).toBe(2);
    const r = res.doc.runs[0];
    // The HEAD hairpin: applied LAST after the tail (so tail vertices
    // sit at the end of the polyline). Vertex 0 is the head endpoint
    // (electrode); the next 4 are the head hairpin's A B C D.
    const head = r.polyline.points.slice(1, 5);
    // |A-B| = depth = 30; A and D on segment line (y=0).
    const ab = Math.hypot(head[1][0] - head[0][0], head[1][1] - head[0][1]);
    const ad = Math.hypot(head[3][0] - head[0][0], head[3][1] - head[0][1]);
    expect(ab).toBeCloseTo(30, 5);
    expect(ad).toBeCloseTo(6, 5);
  });

  it('one-electrode open run: only the relevant endpoint gets a hairpin', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 0 }],
        },
      ],
    };
    const res = ops.autoDoublebackAllTerminations(doc);
    expect(res.added).toBe(1);
    // 5 original + 4 hairpin = 9.
    expect(res.doc.runs[0].polyline.points.length).toBe(9);
  });

  it('mid-polyline electrodes on an open run are not terminations and are skipped', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r',
          polyline: {
            points: [[0, 0], [25, 0], [50, 0], [75, 0], [100, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
          electrodes: [{ point_index: 2 }], // dead-center, not an endpoint
        },
      ],
    };
    const res = ops.autoDoublebackAllTerminations(doc);
    expect(res.added).toBe(0);
    expect(res.doc).toBe(doc);
  });
});

describe('autoHousingAllElectrodes (Tier 2 #72)', () => {
  // Same 4-letter / 8-electrode shape as the auto-doubleback batch.
  function fourLetterDoc(): DesignDoc {
    const runs: DesignRun[] = [];
    for (let k = 0; k < 4; k++) {
      const y = k * 30;
      runs.push({
        id: `letter-${k}`,
        polyline: {
          points: [[0, y], [100, y]],
          closed: false,
        },
        tube_diameter_mm: 10,
        electrodes: [{ point_index: 0 }, { point_index: 1 }],
      });
    }
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 120],
      runs,
    };
  }

  it('sets a stock shell on every electrode (24-electrode equivalent batch)', () => {
    const res = ops.autoHousingAllElectrodes(fourLetterDoc(), {
      housing_type: 'shell-15',
    });
    expect(res.applied).toBe(8);
    expect(res.skipped).toBe(0);
    for (const run of res.doc.runs) {
      for (const e of run.electrodes ?? []) {
        expect((e as { housing_type?: string }).housing_type).toBe('shell-15');
      }
    }
  });

  it('skips electrodes that already have a housing set (preserves per-pin edits)', () => {
    // Manually housing the first letter's first pin, then sweep.
    let doc = fourLetterDoc();
    doc = ops.setElectrodeHousing(doc, 'letter-0', 0, {
      housing_type: 'shell-19',
    });
    const res = ops.autoHousingAllElectrodes(doc, {
      housing_type: 'shell-15',
    });
    expect(res.applied).toBe(7);
    expect(res.skipped).toBe(1);
    // First pin keeps its existing 19-shell; remaining 7 get 15-shell.
    const first = res.doc.runs[0].electrodes![0] as { housing_type?: string };
    expect(first.housing_type).toBe('shell-19');
    const second = res.doc.runs[0].electrodes![1] as { housing_type?: string };
    expect(second.housing_type).toBe('shell-15');
  });

  it('returns the same doc reference for a doc with zero electrodes', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'r',
          polyline: { points: [[0, 0], [10, 0]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
    const res = ops.autoHousingAllElectrodes(doc, { housing_type: 'shell-15' });
    expect(res.applied).toBe(0);
    expect(res.skipped).toBe(0);
    expect(res.doc).toBe(doc);
  });

  it('is idempotent: re-running adds zero', () => {
    const first = ops.autoHousingAllElectrodes(fourLetterDoc(), {
      housing_type: 'shell-15',
    });
    expect(first.applied).toBe(8);
    const second = ops.autoHousingAllElectrodes(first.doc, {
      housing_type: 'shell-15',
    });
    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(8);
    expect(second.doc).toBe(first.doc);
  });

  it('supports a custom housing across the batch', () => {
    const res = ops.autoHousingAllElectrodes(fourLetterDoc(), {
      housing_type: 'custom',
      bore_diameter_mm: 11.5,
      elevation_mm: 50,
    });
    expect(res.applied).toBe(8);
    for (const run of res.doc.runs) {
      for (const e of run.electrodes ?? []) {
        const eh = e as { housing_type?: string; bore_diameter_mm?: number; elevation_mm?: number };
        expect(eh.housing_type).toBe('custom');
        expect(eh.bore_diameter_mm).toBe(11.5);
        expect(eh.elevation_mm).toBe(50);
      }
    }
  });

  it('propagates OperationError when the input housing is invalid (custom w/o bore)', () => {
    expect(() =>
      ops.autoHousingAllElectrodes(fourLetterDoc(), {
        housing_type: 'custom',
        // no bore — setElectrodeHousing rejects on the first call.
      }),
    ).toThrow(/bore_diameter_mm/);
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

  it('neonizes an open polyline into two parallel offset runs with butt caps', () => {
    // Horizontal open run with one corner. Tier 3 #27: open-polyline
    // neonize emits two parallel runs, no closing geometry.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'open',
          polyline: { points: [[0, 0], [50, 0], [100, 0]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
    const result = ops.neonize(doc, 'open', 10);
    expect(result.warning).toBeUndefined();
    expect(result.doc.runs.length).toBe(2);
    const outer = result.doc.runs.find((r) => r.id === 'open-outer');
    const inner = result.doc.runs.find((r) => r.id === 'open-inner');
    expect(outer).toBeDefined();
    expect(inner).toBeDefined();
    expect(outer!.polyline.closed).toBe(false);
    expect(inner!.polyline.closed).toBe(false);
    // Both endpoints are butt caps offset by ±5mm perpendicular to the
    // (purely horizontal) source.
    expect(outer!.polyline.points[0][0]).toBeCloseTo(0, 6);
    expect(outer!.polyline.points.at(-1)![0]).toBeCloseTo(100, 6);
    expect(inner!.polyline.points[0][0]).toBeCloseTo(0, 6);
    expect(inner!.polyline.points.at(-1)![0]).toBeCloseTo(100, 6);
    // outer is on one side, inner the other — different y signs.
    expect(Math.sign(outer!.polyline.points[0][1]))
      .not.toBe(Math.sign(inner!.polyline.points[0][1]));
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

  it('stitch=true produces one continuous run instead of two', () => {
    const { doc } = ops.neonize(squareDoc(), 'sq', 20, { stitch: true });
    expect(doc.runs.length).toBe(1);
    expect(doc.runs[0].id).toBe('sq-stitched');
    expect(doc.runs[0].polyline.closed).toBe(false);
    // Length ≈ outer (4 pts) + 2 hairpin verts + reversed inner (4 pts)
    // + 2 hairpin verts + return-to-start = 13 vertices for a square.
    expect(doc.runs[0].polyline.points.length).toBeGreaterThanOrEqual(10);
  });

  it('stitch=true on an open polyline produces a single run', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'open',
          polyline: { points: [[0, 0], [50, 0], [100, 0]], closed: false },
          tube_diameter_mm: 10,
        },
      ],
    };
    const result = ops.neonize(doc, 'open', 10, { stitch: true });
    expect(result.doc.runs.length).toBe(1);
    expect(result.doc.runs[0].id).toBe('open-stitched');
    expect(result.doc.runs[0].polyline.closed).toBe(false);
  });

  it('cornerStyles option threads through to the offset geometry', () => {
    // Square with one beveled corner: the beveled corner adds an extra
    // output vertex on each offset (so vertex counts grow by 1 each).
    const { doc: defaultDoc } = ops.neonize(squareDoc(), 'sq', 20);
    const { doc: beveledDoc } = ops.neonize(squareDoc(), 'sq', 20, {
      cornerStyles: ['miter', 'bevel', 'miter', 'miter'],
    });
    const defaultOuter = defaultDoc.runs.find((r) => r.id === 'sq-outer')!;
    const beveledOuter = beveledDoc.runs.find((r) => r.id === 'sq-outer')!;
    expect(beveledOuter.polyline.points.length).toBe(
      defaultOuter.polyline.points.length + 1,
    );
  });

  it('auto-trims self-intersection on the inner offset (no warning when fully cleaned)', () => {
    // Concave peanut shape whose inner offset would loop without the
    // trim heuristic. After trim the result should not surface a self-
    // intersection warning.
    const peanut: [number, number][] = [
      [0, 0], [40, 0], [40, 15], [60, 15], [60, 0], [100, 0],
      [100, 40], [60, 40], [60, 25], [40, 25], [40, 40], [0, 40],
    ];
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 50],
      runs: [{ id: 'p', polyline: { points: peanut, closed: true } }],
    };
    const result = ops.neonize(doc, 'p', 16);
    // The trim should clean up the inner offset; no self-intersection
    // warning should remain.
    expect(result.warning ?? '').not.toMatch(/Inner offset self-intersects/);
  });
});

describe('channel-letter polish ops (Tier 3 #26)', () => {
  function faceDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'face-1',
          polyline: { points: [[0, 0], [10, 0], [10, 5], [0, 5]], closed: true },
          is_channel_letter_face: true,
        },
      ],
    };
  }

  it('setRunChannelLetterDepth writes a positive override', () => {
    const next = ops.setRunChannelLetterDepth(faceDoc(), 'face-1', 75);
    expect(next.runs[0].channel_letter_depth_mm).toBe(75);
  });

  it('setRunChannelLetterDepth(null) clears the override', () => {
    const seeded = ops.setRunChannelLetterDepth(faceDoc(), 'face-1', 75);
    const next = ops.setRunChannelLetterDepth(seeded, 'face-1', null);
    expect(next.runs[0].channel_letter_depth_mm).toBeUndefined();
  });

  it('setRunChannelLetterDepth(0) clears the override (0 = "use project default")', () => {
    const seeded = ops.setRunChannelLetterDepth(faceDoc(), 'face-1', 75);
    const next = ops.setRunChannelLetterDepth(seeded, 'face-1', 0);
    expect(next.runs[0].channel_letter_depth_mm).toBeUndefined();
  });

  it('setRunRacewayID labels the run with a trimmed string', () => {
    const next = ops.setRunRacewayID(faceDoc(), 'face-1', '  main  ');
    expect(next.runs[0].raceway_id).toBe('main');
  });

  it('setRunRacewayID("") clears the label', () => {
    const seeded = ops.setRunRacewayID(faceDoc(), 'face-1', 'main');
    const next = ops.setRunRacewayID(seeded, 'face-1', '');
    expect(next.runs[0].raceway_id).toBeUndefined();
  });

  it('setRunChannelLetterFace(false) wipes channel-letter metadata', () => {
    let doc = ops.setRunChannelLetterDepth(faceDoc(), 'face-1', 90);
    doc = ops.setRunRacewayID(doc, 'face-1', 'main');
    const next = ops.setRunChannelLetterFace(doc, 'face-1', false);
    expect(next.runs[0].is_channel_letter_face).toBeUndefined();
    expect(next.runs[0].channel_letter_depth_mm).toBeUndefined();
    expect(next.runs[0].raceway_id).toBeUndefined();
  });
});

// breakOpen / moveOpening — Tier 3 #61 (NW #130). Both ops convert a
// closed loop's "start vertex" into an electrode opening (or move an
// existing opening to a new vertex) without changing the underlying
// physical shape of the tube. The test cases below verify that the
// rewritten polyline traces the same arc, that electrodes land at the
// right indices, and that live-arc-relative metadata (blockouts /
// annotations / bends) carries over without manual remap.
describe('breakOpen', () => {
  function closedTriangleDoc(): DesignDoc {
    const runs: DesignRun[] = [
      {
        id: 'tri',
        polyline: {
          points: [
            [0, 0],
            [10, 0],
            [5, 10],
          ],
          closed: true,
        },
        tube_diameter_mm: 10,
      },
    ];
    return { version: 1, view_box_mm: [0, 0, 20, 20], runs };
  }

  it('converts a 3-point closed triangle into a 4-point open polyline with electrodes at the duplicated vertices', () => {
    const next = ops.breakOpen(closedTriangleDoc(), 'tri', 1);
    const tri = next.runs[0];
    expect(tri.polyline.closed).toBe(false);
    // Walk starts at vertex 1 (10,0), goes 2 (5,10), wraps to 0 (0,0),
    // then duplicates the start vertex at the end to preserve geometry.
    expect(tri.polyline.points).toEqual([
      [10, 0],
      [5, 10],
      [0, 0],
      [10, 0],
    ]);
    expect(tri.electrodes).toEqual([
      { point_index: 0 },
      { point_index: 3 },
    ]);
    // Direction is dropped — meaningless once the run is open.
    expect(tri.direction).toBeUndefined();
  });

  it('preserves blockout live-arc indices through the rewrite', () => {
    // Use a 6-vertex closed hexagonal loop with a blockout that spans
    // live indices 2..3 (a fixed step count along the active arc).
    const N = 6;
    const closedPts: [number, number][] = [];
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      closedPts.push([10 + 5 * Math.cos(a), 10 + 5 * Math.sin(a)]);
    }
    const before: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 20, 20],
      runs: [
        {
          id: 'hex',
          polyline: { points: closedPts, closed: true },
          blockouts: [{ start_live_index: 2, end_live_index: 3 }],
        },
      ],
    };
    const after = ops.breakOpen(before, 'hex', 0);
    const hex = after.runs[0];
    expect(hex.polyline.closed).toBe(false);
    expect(hex.polyline.points).toHaveLength(N + 1);
    // Live indices are walk-relative, so the same blockout is still
    // 2 steps in to 3 steps in along the new live walk.
    expect(hex.blockouts).toEqual([{ start_live_index: 2, end_live_index: 3 }]);
  });

  it('throws when the run is already open', () => {
    const openDoc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'open',
          polyline: { points: [[0, 0], [5, 0], [10, 0]], closed: false },
        },
      ],
    };
    expect(() => ops.breakOpen(openDoc, 'open', 1)).toThrow(/already open/);
  });
});

describe('moveOpening', () => {
  function eightPointOpenDoc(): DesignDoc {
    // 8-vertex open polyline tracing a horseshoe; electrodes at [0, 7]
    // (the natural state after a breakOpen).
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i++) pts.push([i, 0]);
    return {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'horseshoe',
          polyline: { points: pts, closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 7 }],
        },
      ],
    };
  }

  it('rotates the polyline so the chosen vertex becomes the new start; electrodes land at [0, last]', () => {
    const before = eightPointOpenDoc();
    const after = ops.moveOpening(before, 'horseshoe', 4);
    const run = after.runs[0];
    // New polyline: [4, 5, 6, 7, 0, 1, 2, 3] from the original points.
    expect(run.polyline.points).toEqual([
      [4, 0],
      [5, 0],
      [6, 0],
      [7, 0],
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ]);
    expect(run.polyline.closed).toBe(false);
    expect(run.electrodes).toEqual([
      { point_index: 0 },
      { point_index: 7 },
    ]);
    // The geometry walked from the new index 0 should match the prior
    // walk starting at vertex 4 — verify by sampling.
    const beforeWalk = before.runs[0].polyline.points;
    for (let i = 0; i < run.polyline.points.length; i++) {
      const beforeIdx = (4 + i) % beforeWalk.length;
      expect(run.polyline.points[i]).toEqual(beforeWalk[beforeIdx]);
    }
  });

  it('preserves blockout live-arc indices because they are walk-relative', () => {
    const before = eightPointOpenDoc();
    const seeded: DesignDoc = {
      ...before,
      runs: [
        {
          ...before.runs[0],
          blockouts: [{ start_live_index: 2, end_live_index: 5 }],
        },
      ],
    };
    const after = ops.moveOpening(seeded, 'horseshoe', 3);
    const run = after.runs[0];
    expect(run.blockouts).toEqual([{ start_live_index: 2, end_live_index: 5 }]);
  });

  it('throws on a closed run or a run with fewer than two electrodes', () => {
    const closed: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'loop',
          polyline: { points: [[0, 0], [5, 0], [5, 5], [0, 5]], closed: true },
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
        },
      ],
    };
    expect(() => ops.moveOpening(closed, 'loop', 1)).toThrow(/closed/);

    const oneElectrode: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        {
          id: 'half',
          polyline: { points: [[0, 0], [5, 0], [10, 0]], closed: false },
          electrodes: [{ point_index: 0 }],
        },
      ],
    };
    expect(() => ops.moveOpening(oneElectrode, 'half', 1)).toThrow(/electrode/);
  });
});

describe('connectTubes', () => {
  // Two short open polylines, each with electrodes at both ends. The
  // first electrode of run-a sits at (0,0); the second electrode of
  // run-b sits at (50,5). Jumper from a.E1 → b.E1 should land at
  // (10,0)→(40,5) (the tail of run-a, the head of run-b).
  function twoOpenRuns(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          id: 'run-a',
          polyline: { points: [[0, 0], [5, 0], [10, 0]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
          tube_diameter_mm: 12,
        },
        {
          id: 'run-b',
          polyline: { points: [[40, 5], [45, 5], [50, 5]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
          tube_diameter_mm: 8,
        },
      ],
    };
  }

  it('emits a 2-vertex jumper whose endpoints exactly match the clicked electrode world coords', () => {
    const next = ops.connectTubes(twoOpenRuns(), 'run-a', 1, 'run-b', 0);
    expect(next.runs).toHaveLength(3);
    const jumper = next.runs[next.runs.length - 1];
    expect(jumper.id).toBe('j1');
    expect(jumper.kind).toBe('jumper');
    expect(jumper.polyline.closed).toBe(false);
    expect(jumper.polyline.points).toEqual([
      [10, 0], // run-a electrode index 1 (point_index 2) → (10, 0)
      [40, 5], // run-b electrode index 0 (point_index 0) → (40, 5)
    ]);
    // No electrodes on the jumper itself — wired, not glass-open.
    expect(jumper.electrodes ?? []).toEqual([]);
    // Diameter is intentionally NOT inherited from either source run;
    // the project tube spec applies (per V1 spec).
    expect(jumper.tube_diameter_mm).toBeUndefined();
  });

  it('handles a closed run with electrode at point_index 0', () => {
    const closed: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          id: 'loop',
          polyline: {
            points: [
              [20, 20],
              [25, 20],
              [25, 25],
              [20, 25],
            ],
            closed: true,
          },
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
          direction: 'forward',
        },
        {
          id: 'open',
          polyline: { points: [[0, 0], [5, 0], [10, 0]], closed: false },
          electrodes: [{ point_index: 0 }],
        },
      ],
    };
    const next = ops.connectTubes(closed, 'loop', 0, 'open', 0);
    const jumper = next.runs[next.runs.length - 1];
    // Closed-run electrode at index 0 (point_index 0) → world (20, 20).
    // Open-run electrode at index 0 (point_index 0) → world (0, 0).
    expect(jumper.polyline.points).toEqual([
      [20, 20],
      [0, 0],
    ]);
    expect(jumper.kind).toBe('jumper');
  });

  it('does not inherit a diameter when source runs disagree (project default applies)', () => {
    // Source runs declare different per-run diameter overrides; the
    // jumper does NOT pick either one — V1 jumpers fall back to the
    // project tube spec (per spec: "inherits a sensible diameter
    // default; project tube spec, with a per-jumper override slot
    // reserved").
    const next = ops.connectTubes(twoOpenRuns(), 'run-a', 0, 'run-b', 1);
    const jumper = next.runs[next.runs.length - 1];
    expect(jumper.tube_diameter_mm).toBeUndefined();
  });

  it('inherits raceway_id when both source runs share one', () => {
    const grouped: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          id: 'run-a',
          polyline: { points: [[0, 0], [10, 0]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 1 }],
          raceway_id: 'A',
        },
        {
          id: 'run-b',
          polyline: { points: [[40, 0], [50, 0]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 1 }],
          raceway_id: 'A',
        },
        {
          id: 'run-c',
          polyline: { points: [[40, 20], [50, 20]], closed: false },
          electrodes: [{ point_index: 0 }, { point_index: 1 }],
          raceway_id: 'B',
        },
      ],
    };
    const sameGroup = ops.connectTubes(grouped, 'run-a', 1, 'run-b', 0);
    expect(sameGroup.runs[sameGroup.runs.length - 1].raceway_id).toBe('A');

    // Mismatched groups → jumper carries no raceway_id.
    const crossGroup = ops.connectTubes(grouped, 'run-a', 1, 'run-c', 0);
    expect(crossGroup.runs[crossGroup.runs.length - 1].raceway_id).toBeUndefined();
  });

  it('throws OperationError when fromRunId === toRunId (no self-jumpers)', () => {
    const doc = twoOpenRuns();
    expect(() => ops.connectTubes(doc, 'run-a', 0, 'run-a', 1)).toThrow(
      /run to itself/,
    );
  });

  it('allocates fresh j1, j2, j3 ids on repeated calls', () => {
    let doc = twoOpenRuns();
    doc = ops.connectTubes(doc, 'run-a', 0, 'run-b', 0);
    doc = ops.connectTubes(doc, 'run-a', 1, 'run-b', 1);
    doc = ops.connectTubes(doc, 'run-a', 0, 'run-b', 1);
    const ids = doc.runs.filter((r) => r.kind === 'jumper').map((r) => r.id);
    expect(ids).toEqual(['j1', 'j2', 'j3']);
  });

  it('honors an explicit diameter_mm_override when supplied', () => {
    const next = ops.connectTubes(
      twoOpenRuns(),
      'run-a',
      1,
      'run-b',
      0,
      { diameter_mm_override: 16 },
    );
    expect(next.runs[next.runs.length - 1].tube_diameter_mm).toBe(16);
  });
});

// Tier 3 #33b — group binding ops (groupRuns / dissolveGroup /
// renameGroup). Build a minimal three-run doc so we can exercise
// every membership branch (group/dissolve/replace) without hauling
// in the full geometry from `makeDoc`.
describe('group ops', () => {
  function threeRunDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 50],
      runs: [
        { id: 'r1', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'r2', polyline: { points: [[0, 5], [10, 5]], closed: false } },
        { id: 'r3', polyline: { points: [[0, 10], [10, 10]], closed: false } },
      ],
    };
  }

  it('nextGroupId allocates the lowest unused id', () => {
    expect(ops.nextGroupId(threeRunDoc())).toBe('g1');
    const doc: DesignDoc = {
      ...threeRunDoc(),
      groups: [
        { id: 'g1', name: 'A' },
        { id: 'g3', name: 'C' },
      ],
    };
    // Should fill the gap at g2, not skip to g4.
    expect(ops.nextGroupId(doc)).toBe('g2');
  });

  it('groupRuns appends a Group entry and stamps group_id on members', () => {
    const { doc, groupId } = ops.groupRuns(threeRunDoc(), ['r1', 'r2'], 'Trim');
    expect(groupId).toBe('g1');
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Trim' }]);
    expect(doc.runs[0].group_id).toBe('g1');
    expect(doc.runs[1].group_id).toBe('g1');
    expect(doc.runs[2].group_id).toBeUndefined();
  });

  it('groupRuns ignores run ids that are not in the doc', () => {
    // A stale selection from a deleted run shouldn't throw — the
    // group still gets created (the UI layer guards the empty case)
    // but only existing runs get the FK.
    const { doc, groupId } = ops.groupRuns(threeRunDoc(), ['r1', 'ghost'], 'Half');
    expect(groupId).toBe('g1');
    expect(doc.runs[0].group_id).toBe('g1');
    expect(doc.runs.find((r) => r.id === 'ghost')).toBeUndefined();
  });

  it('groupRuns is immutable — input doc is not mutated', () => {
    const before = threeRunDoc();
    const beforeRuns = before.runs;
    ops.groupRuns(before, ['r1', 'r2'], 'Trim');
    expect(before.runs).toBe(beforeRuns); // same reference
    expect(before.runs[0].group_id).toBeUndefined();
    expect(before.groups).toBeUndefined();
  });

  it('dissolveGroup clears member FKs and drops the entry', () => {
    let doc = threeRunDoc();
    doc = ops.groupRuns(doc, ['r1', 'r2', 'r3'], 'All').doc;
    doc = ops.dissolveGroup(doc, 'g1');
    expect(doc.groups).toEqual([]);
    for (const r of doc.runs) {
      expect(r.group_id).toBeUndefined();
    }
  });

  it('dissolveGroup is a no-op for a missing groupId', () => {
    const before = threeRunDoc();
    const after = ops.dissolveGroup(before, 'g99');
    expect(after).toBe(before); // exact same reference
  });

  it('dissolveGroup drops the entry even when no runs reference it', () => {
    // Synthetic state: a group entry with no member runs (could
    // happen if every member was re-grouped elsewhere). Dissolving
    // that empty group should still remove the entry.
    const doc: DesignDoc = {
      ...threeRunDoc(),
      groups: [{ id: 'g1', name: 'Empty' }],
    };
    const after = ops.dissolveGroup(doc, 'g1');
    expect(after.groups).toEqual([]);
  });

  it('renameGroup updates the display name only', () => {
    let doc = threeRunDoc();
    doc = ops.groupRuns(doc, ['r1', 'r2'], 'Trim').doc;
    doc = ops.renameGroup(doc, 'g1', 'Front face');
    expect(doc.groups).toEqual([{ id: 'g1', name: 'Front face' }]);
    // Member FKs unchanged.
    expect(doc.runs[0].group_id).toBe('g1');
    expect(doc.runs[1].group_id).toBe('g1');
  });

  it('renameGroup is a no-op for a missing groupId or unchanged name', () => {
    let doc = threeRunDoc();
    doc = ops.groupRuns(doc, ['r1'], 'Trim').doc;
    expect(ops.renameGroup(doc, 'g99', 'X')).toBe(doc);
    expect(ops.renameGroup(doc, 'g1', 'Trim')).toBe(doc);
  });

  it('re-grouping already-grouped runs replaces the prior group_id', () => {
    // Spec test case: group [r1, r2] as A, then group [r2, r3] as B
    // → r2 belongs to B; A is unchanged but only owns r1.
    let doc = threeRunDoc();
    const a = ops.groupRuns(doc, ['r1', 'r2'], 'A');
    doc = a.doc;
    const b = ops.groupRuns(doc, ['r2', 'r3'], 'B');
    doc = b.doc;
    // Both group entries persist; the second got a fresh id.
    expect(a.groupId).toBe('g1');
    expect(b.groupId).toBe('g2');
    expect(doc.groups).toEqual([
      { id: 'g1', name: 'A' },
      { id: 'g2', name: 'B' },
    ]);
    // r1 still in A; r2 moved to B; r3 in B.
    expect(doc.runs[0].group_id).toBe('g1');
    expect(doc.runs[1].group_id).toBe('g2');
    expect(doc.runs[2].group_id).toBe('g2');
  });

  it('JSON round-trip preserves group_id and Doc.groups', () => {
    let doc = threeRunDoc();
    doc = ops.groupRuns(doc, ['r1', 'r2'], 'Trim').doc;
    const round = JSON.parse(JSON.stringify(doc)) as DesignDoc;
    expect(round.groups).toEqual([{ id: 'g1', name: 'Trim' }]);
    expect(round.runs[0].group_id).toBe('g1');
    expect(round.runs[1].group_id).toBe('g1');
    expect(round.runs[2].group_id).toBeUndefined();
  });

  it('loads a pre-33b doc literal with no groups field', () => {
    // Hand-written pre-33b JSON shape — the deserializer should fill
    // group_id with undefined and leave Doc.groups undefined. This
    // pins the back-compat promise for any row persisted before
    // this PR.
    const old = JSON.parse(`{
      "version": 1,
      "view_box_mm": [0, 0, 100, 50],
      "runs": [
        {"id": "r1", "polyline": {"points": [[0,0],[10,0]], "closed": false}},
        {"id": "r2", "polyline": {"points": [[0,5],[10,5]], "closed": false}}
      ]
    }`) as DesignDoc;
    expect(old.groups).toBeUndefined();
    expect(old.runs[0].group_id).toBeUndefined();
    // groupRuns on a pre-33b doc should still work — the spec
    // mandates loading these unchanged.
    const { doc, groupId } = ops.groupRuns(old, ['r1', 'r2'], 'New');
    expect(groupId).toBe('g1');
    expect(doc.groups).toEqual([{ id: 'g1', name: 'New' }]);
    expect(doc.runs[0].group_id).toBe('g1');
  });
});

// Tier 3 #33c — Layers panel ops (setGroupVisible / setGroupLocked).
// Both flags are display-only filters carried on Doc.Groups; the canvas
// honors them but validation / save / PDF / DXF do not. These tests pin
// the value-shape contract (undefined vs explicit false), the no-op
// invariants (missing groupId, unchanged value), and the JSON
// back-compat promise (pre-33c group literal interpreted as visible).
describe('layer visibility + lock ops', () => {
  function twoGroupDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 50],
      runs: [
        {
          id: 'r1',
          group_id: 'g1',
          polyline: { points: [[0, 0], [10, 0]], closed: false },
        },
        {
          id: 'r2',
          group_id: 'g1',
          polyline: { points: [[0, 5], [10, 5]], closed: false },
        },
        {
          id: 'r3',
          group_id: 'g2',
          polyline: { points: [[0, 10], [10, 10]], closed: false },
        },
      ],
      groups: [
        { id: 'g1', name: 'Trim' },
        { id: 'g2', name: 'Strokes' },
      ],
    };
  }

  it('setGroupVisible(false) writes visible:false on the target group', () => {
    const before = twoGroupDoc();
    const after = ops.setGroupVisible(before, 'g1', false);
    expect(after.groups?.[0].visible).toBe(false);
    expect(after.groups?.[1].visible).toBeUndefined();
    // Other state (name, runs, FKs) untouched.
    expect(after.groups?.[0].name).toBe('Trim');
    expect(after.runs).toBe(before.runs); // same reference (immutable)
  });

  it('setGroupVisible(true) drops the visible field entirely', () => {
    let doc = twoGroupDoc();
    doc = ops.setGroupVisible(doc, 'g1', false);
    expect(doc.groups?.[0].visible).toBe(false);
    doc = ops.setGroupVisible(doc, 'g1', true);
    expect(doc.groups?.[0].visible).toBeUndefined();
    // Round-trip: re-marshal should not leak a visible:true key.
    expect(JSON.stringify(doc.groups?.[0])).not.toContain('"visible"');
  });

  it('setGroupVisible no-ops on missing groupId', () => {
    const before = twoGroupDoc();
    expect(ops.setGroupVisible(before, '', false)).toBe(before);
    expect(ops.setGroupVisible(before, 'gZ', false)).toBe(before);
  });

  it('setGroupVisible no-ops when the value is unchanged', () => {
    const before = twoGroupDoc();
    // unchanged: visible was already undefined; setting visible=true
    // is the same shape and should short-circuit.
    expect(ops.setGroupVisible(before, 'g1', true)).toBe(before);
    const hidden = ops.setGroupVisible(before, 'g1', false);
    expect(ops.setGroupVisible(hidden, 'g1', false)).toBe(hidden);
  });

  it('setGroupLocked writes locked:true and drops the key on false', () => {
    let doc = twoGroupDoc();
    doc = ops.setGroupLocked(doc, 'g2', true);
    expect(doc.groups?.[1].locked).toBe(true);
    // Round-trip-clean encode of the unlocked group.
    expect(JSON.stringify(doc.groups?.[0])).not.toContain('"locked"');
    doc = ops.setGroupLocked(doc, 'g2', false);
    expect(doc.groups?.[1].locked).toBeUndefined();
    expect(JSON.stringify(doc.groups?.[1])).not.toContain('"locked"');
  });

  it('setGroupLocked no-ops on missing groupId / unchanged value', () => {
    const before = twoGroupDoc();
    expect(ops.setGroupLocked(before, '', true)).toBe(before);
    expect(ops.setGroupLocked(before, 'gZ', true)).toBe(before);
    // Unchanged: locked was already undefined (i.e. false); set false
    // again should short-circuit.
    expect(ops.setGroupLocked(before, 'g1', false)).toBe(before);
  });

  it('setGroupVisible and setGroupLocked are independent', () => {
    let doc = twoGroupDoc();
    doc = ops.setGroupVisible(doc, 'g1', false);
    doc = ops.setGroupLocked(doc, 'g1', true);
    expect(doc.groups?.[0].visible).toBe(false);
    expect(doc.groups?.[0].locked).toBe(true);
    // Toggling lock off doesn't restore visibility.
    doc = ops.setGroupLocked(doc, 'g1', false);
    expect(doc.groups?.[0].visible).toBe(false);
    expect(doc.groups?.[0].locked).toBeUndefined();
  });

  it('JSON round-trip preserves visible:false and locked:true', () => {
    let doc = twoGroupDoc();
    doc = ops.setGroupVisible(doc, 'g1', false);
    doc = ops.setGroupLocked(doc, 'g2', true);
    const round = JSON.parse(JSON.stringify(doc)) as DesignDoc;
    expect(round.groups?.[0].visible).toBe(false);
    expect(round.groups?.[0].locked).toBeUndefined();
    expect(round.groups?.[1].visible).toBeUndefined();
    expect(round.groups?.[1].locked).toBe(true);
  });

  it('loads a pre-33c doc literal: groups with no visible/locked → treated as visible+unlocked', () => {
    // Hand-written pre-33c JSON shape — Doc.Groups exists (33b
    // shipped) but no visible / locked keys. Consumers must treat
    // visible===undefined as "visible" (the back-compat invariant).
    const old = JSON.parse(`{
      "version": 1,
      "view_box_mm": [0, 0, 100, 50],
      "runs": [
        {"id": "r1", "group_id": "g1", "polyline": {"points": [[0,0],[10,0]], "closed": false}}
      ],
      "groups": [{"id": "g1", "name": "Trim"}]
    }`) as DesignDoc;
    expect(old.groups?.[0].visible).toBeUndefined();
    expect(old.groups?.[0].locked).toBeUndefined();
    // The setGroupVisible(true) op against the pre-33c literal is a
    // no-op (already visible); setGroupVisible(false) writes through.
    expect(ops.setGroupVisible(old, 'g1', true)).toBe(old);
    const hidden = ops.setGroupVisible(old, 'g1', false);
    expect(hidden.groups?.[0].visible).toBe(false);
  });
});

// Tier 3 #48 — multi-vertex select + drag follow-up. moveVertices
// applies a batch of (pointIndex → XY) writes in one op so a node-edit
// drag of N selected vertices stays one undo-stack entry. Out-of-range
// or no-op writes are silently dropped; if everything was a no-op, the
// run is returned unchanged so editDoc's structural compare can short-
// circuit the dirty bump.
describe('moveVertices', () => {
  function makePolyDoc(): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
        },
      ],
    };
  }

  it('translates two vertices by the same delta in a single op', () => {
    const next = ops.moveVertices(makePolyDoc(), 'run-1', [
      { pointIndex: 1, x: 12, y: 5 },
      { pointIndex: 2, x: 22, y: 5 },
    ]);
    expect(next.runs[0].polyline.points).toEqual([
      [0, 0], [12, 5], [22, 5], [30, 0], [40, 0],
    ]);
  });

  it('returns the same doc when every write is a no-op', () => {
    const doc = makePolyDoc();
    const next = ops.moveVertices(doc, 'run-1', [
      { pointIndex: 1, x: 10, y: 0 },
      { pointIndex: 99, x: 0, y: 0 }, // out of range
    ]);
    expect(next).toBe(doc);
  });

  it('drops out-of-range writes silently while applying the rest', () => {
    const next = ops.moveVertices(makePolyDoc(), 'run-1', [
      { pointIndex: 0, x: 1, y: 1 },
      { pointIndex: 99, x: 9, y: 9 },
    ]);
    expect(next.runs[0].polyline.points[0]).toEqual([1, 1]);
    expect(next.runs[0].polyline.points.length).toBe(5);
  });

  it('empty writes list is a no-op (returns same doc reference)', () => {
    const doc = makePolyDoc();
    expect(ops.moveVertices(doc, 'run-1', [])).toBe(doc);
  });

  it('non-existent run is a no-op (returns same doc reference)', () => {
    const doc = makePolyDoc();
    expect(ops.moveVertices(doc, 'nope', [{ pointIndex: 0, x: 1, y: 1 }])).toBe(doc);
  });
});

// Tier 3 #48 — vertex-merge on drop. mergeVertices folds two vertices
// on the same run into one. Used by the canvas when a node-edit drag
// drops a vertex within the snap-to-vertex radius of another vertex on
// the same run. The kept vertex's XY survives; the dropped vertex's
// references are remapped onto it.
describe('mergeVertices', () => {
  it('drops one vertex and keeps the other (5-point line, merge 1 into 2)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [10.1, 0], [20, 0], [30, 0]],
            closed: false,
          },
          tube_diameter_mm: 10,
        },
      ],
    };
    // Keep index 1 ([10, 0]); drop index 2 ([10.1, 0]).
    const next = ops.mergeVertices(doc, 'run-1', 1, 2);
    expect(next.runs[0].polyline.points).toEqual([
      [0, 0], [10, 0], [20, 0], [30, 0],
    ]);
  });

  it('rewrites electrode references onto the kept vertex and shifts higher refs down', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [10.1, 0], [20, 0], [30, 0]],
            closed: false,
          },
          electrodes: [{ point_index: 2 }, { point_index: 4 }],
        },
      ],
    };
    // Merge 1 ← 2: electrode at 2 maps to 1; electrode at 4 shifts to 3.
    const next = ops.mergeVertices(doc, 'run-1', 1, 2);
    expect(next.runs[0].electrodes).toEqual([
      { point_index: 1 },
      { point_index: 3 },
    ]);
  });

  it('preserves blockouts whose ends straddle or coincide with the merged vertex', () => {
    // Blockout [2, 4] with a merge of indices 2 and 3 (drop 3).
    // Both endpoints remap: 2 stays at 2 (kept), 4 shifts to 3.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0], [25, 0], [30, 0]],
            closed: false,
          },
          blockouts: [{ start_live_index: 2, end_live_index: 4 }],
        },
      ],
    };
    const next = ops.mergeVertices(doc, 'run-1', 2, 3);
    expect(next.runs[0].blockouts).toEqual([
      { start_live_index: 2, end_live_index: 3 },
    ]);
  });

  it('preserves annotations and bends through the merge', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]],
            closed: false,
          },
          annotations: [
            { kind: 'jump', live_index: 0 },
            { kind: 'support', live_index: 4 },
          ],
          bends: [{ live_index: 2 }, { live_index: 3 }],
        },
      ],
    };
    // Merge 2 ← 3: bend at 3 collapses onto 2; bend at 2 stays.
    // Annotations: 0 stays; 4 shifts to 3.
    const next = ops.mergeVertices(doc, 'run-1', 2, 3);
    expect(next.runs[0].annotations).toEqual([
      { kind: 'jump', live_index: 0 },
      { kind: 'support', live_index: 3 },
    ]);
    expect(next.runs[0].bends).toEqual([
      { live_index: 2 },
      { live_index: 2 },
    ]);
  });

  it('refuses to drop a closed polyline below 3 points', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 1, 1],
      runs: [
        {
          id: 'tri',
          polyline: { points: [[0, 0], [1, 0], [0, 1]], closed: true },
        },
      ],
    };
    const next = ops.mergeVertices(doc, 'tri', 0, 1);
    // Triangle would collapse to a 2-vertex closed polyline — skip.
    expect(next.runs[0].polyline.points.length).toBe(3);
  });

  it('refuses to drop an open polyline below 2 points', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 1, 1],
      runs: [
        {
          id: 'seg',
          polyline: { points: [[0, 0], [1, 0]], closed: false },
        },
      ],
    };
    const next = ops.mergeVertices(doc, 'seg', 0, 1);
    expect(next.runs[0].polyline.points.length).toBe(2);
  });

  it('indexA === indexB is a no-op (returns same doc)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0]],
            closed: false,
          },
        },
      ],
    };
    expect(ops.mergeVertices(doc, 'run-1', 1, 1)).toBe(doc);
  });

  it('dedups electrodes that collapse onto the same vertex post-merge', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [10.1, 0], [20, 0], [30, 0]],
            closed: false,
          },
          electrodes: [{ point_index: 1 }, { point_index: 2 }],
        },
      ],
    };
    // Merge 1 ← 2: both electrodes remap to point_index 1; the dup is
    // dropped so we don't end up with two electrodes on one vertex.
    const next = ops.mergeVertices(doc, 'run-1', 1, 2);
    expect(next.runs[0].electrodes).toEqual([{ point_index: 1 }]);
  });
});

// Tier 3 #48 — opt-in legacy-id rename. Older docs that pre-date the
// flat numeric splitRun ids carry `<base>-a` / `<base>-b` (and nested
// `<base>-a-a`) suffixes. renameLegacyRunIds rewrites every match to
// the next free `r<n>` slot; non-matching ids are untouched. The op is
// idempotent — a second call on a migrated doc returns the same
// reference.
describe('renameLegacyRunIds', () => {
  it('returns the same doc when no run id matches the legacy pattern', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        { id: 'r1', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'r2', polyline: { points: [[0, 5], [10, 5]], closed: false } },
        { id: 'text-1', polyline: { points: [[0, 9], [10, 9]], closed: false } },
      ],
    };
    expect(ops.renameLegacyRunIds(doc)).toBe(doc);
  });

  it('renames `<base>-a` / `<base>-b` to the next free numeric slot', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        { id: 'r1', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'old-a', polyline: { points: [[0, 1], [10, 1]], closed: false } },
        { id: 'old-b', polyline: { points: [[0, 2], [10, 2]], closed: false } },
      ],
    };
    const next = ops.renameLegacyRunIds(doc);
    // r1 is taken so the rename starts at r2 / r3.
    expect(next.runs.map((r) => r.id)).toEqual(['r1', 'r2', 'r3']);
  });

  it('skips reserved numeric slots when renaming', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        { id: 'r2', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'old-a', polyline: { points: [[0, 1], [10, 1]], closed: false } },
        { id: 'r5', polyline: { points: [[0, 2], [10, 2]], closed: false } },
        { id: 'old-b', polyline: { points: [[0, 3], [10, 3]], closed: false } },
      ],
    };
    const next = ops.renameLegacyRunIds(doc);
    // r2 and r5 are taken; legacy ids get r1 then r3 (next free
    // integers in order).
    expect(next.runs.map((r) => r.id)).toEqual(['r2', 'r1', 'r5', 'r3']);
  });

  it('handles nested legacy suffixes (`-a-a`, `-a-b`, etc.)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        { id: 'old-a-a', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'old-a-b', polyline: { points: [[0, 1], [10, 1]], closed: false } },
      ],
    };
    const next = ops.renameLegacyRunIds(doc);
    expect(next.runs.map((r) => r.id)).toEqual(['r1', 'r2']);
  });

  it('is idempotent — re-running on the migrated doc returns the same reference', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        { id: 'old-a', polyline: { points: [[0, 0], [10, 0]], closed: false } },
        { id: 'old-b', polyline: { points: [[0, 1], [10, 1]], closed: false } },
      ],
    };
    const once = ops.renameLegacyRunIds(doc);
    const twice = ops.renameLegacyRunIds(once);
    expect(twice).toBe(once);
  });

  it('preserves run metadata through the rename', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        {
          id: 'old-a',
          polyline: { points: [[0, 0], [10, 0]], closed: false },
          color: 'classic-red',
          tube_diameter_mm: 12,
          electrodes: [{ point_index: 0 }, { point_index: 1 }],
          notes: '15kV',
        },
      ],
    };
    const next = ops.renameLegacyRunIds(doc);
    expect(next.runs[0].id).toBe('r1');
    expect(next.runs[0].color).toBe('classic-red');
    expect(next.runs[0].tube_diameter_mm).toBe(12);
    expect(next.runs[0].electrodes).toEqual([
      { point_index: 0 },
      { point_index: 1 },
    ]);
    expect(next.runs[0].notes).toBe('15kV');
  });
});

describe('scale ops (resize handles)', () => {
  it('scalePoints scales about the origin anchor', () => {
    const out = ops.scalePoints(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      2,
      3,
      0,
      0,
    );
    expect(out).toEqual([
      [0, 0],
      [20, 0],
      [20, 30],
    ]);
  });

  it('scalePoints keeps the anchor fixed and supports non-uniform scale', () => {
    const anchor: [number, number] = [10, 10];
    const out = ops.scalePoints([[10, 10], [20, 10], [10, 30]], 2, 0.5, anchor[0], anchor[1]);
    expect(out[0]).toEqual([10, 10]); // anchor unmoved
    expect(out[1]).toEqual([30, 10]); // x: 10 + (20-10)*2
    expect(out[2]).toEqual([10, 20]); // y: 10 + (30-10)*0.5
  });

  it('setRunsPoints replaces only the named runs, leaving others untouched', () => {
    const doc = makeDoc();
    const newPts: [number, number][] = [
      [1, 1],
      [2, 2],
    ];
    const next = ops.setRunsPoints(doc, [{ runId: 'run-1', points: newPts }]);
    expect(next.runs[0].polyline.points).toEqual(newPts);
    expect(next.runs[1]).toBe(doc.runs[1]); // run-2 reference unchanged
    expect(next).not.toBe(doc);
  });

  it('setRunsPoints is a no-op for unknown run ids', () => {
    const doc = makeDoc();
    expect(ops.setRunsPoints(doc, [{ runId: 'nope', points: [[0, 0]] }])).toBe(doc);
    expect(ops.setRunsPoints(doc, [])).toBe(doc);
  });
});

// Bug #10 — switching the project tube spec left runs pinned to the old
// diameter. That field is not cosmetic: it drives bend clustering, the
// takeoff's glass grouping and the ø printed on the pattern, so a stale value
// orders the wrong stock and misinforms the bender.
describe('clearRunDiametersMatching', () => {
  it('clears runs still carrying the old spec diameter so they inherit', () => {
    const doc = makeDoc(); // both runs seeded at 10mm
    const next = ops.clearRunDiametersMatching(doc, 10);
    expect(next.runs.every((r) => r.tube_diameter_mm === undefined)).toBe(true);
  });

  it('leaves a deliberate override at a different diameter alone', () => {
    const doc = makeDoc();
    const withOverride = ops.setRunDiameter(doc, 'run-2', 15);
    const next = ops.clearRunDiametersMatching(withOverride, 10);
    expect(next.runs.find((r) => r.id === 'run-1')?.tube_diameter_mm).toBeUndefined();
    expect(next.runs.find((r) => r.id === 'run-2')?.tube_diameter_mm).toBe(15);
  });

  // Callers use identity to decide whether the doc changed (and therefore
  // whether to re-validate the live doc), so a no-op must not clone.
  it('returns the same object when nothing matches', () => {
    const doc = makeDoc();
    expect(ops.clearRunDiametersMatching(doc, 8)).toBe(doc);
  });

  it('ignores a nonsensical old diameter rather than clearing everything', () => {
    const doc = makeDoc();
    expect(ops.clearRunDiametersMatching(doc, 0)).toBe(doc);
    expect(ops.clearRunDiametersMatching(doc, Number.NaN)).toBe(doc);
  });

  it('does not mutate the input doc', () => {
    const doc = makeDoc();
    ops.clearRunDiametersMatching(doc, 10);
    expect(doc.runs[0].tube_diameter_mm).toBe(10);
  });
});

// Tier 2 #75 — the max_segment_length validator tells the operator a tube is
// too long and then leaves them to walk every warning and splitRun by hand.
// These pin the geometry, because "evenly by arc length" is the whole claim.
describe('autoSplitOverlongTubes', () => {
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 4000, 4000],
    runs,
  });

  // A straight run along +X of exactly `lengthMM`, sampled at `n` vertices.
  function lineDoc(lengthMM: number, n = 2): DesignDoc {
    const points: [number, number][] = [];
    for (let i = 0; i < n; i++) points.push([(i / (n - 1)) * lengthMM, 0]);
    return docOf([{ id: 'r1', polyline: { points, closed: false } }]);
  }

  // Arc-aware (Tier 3 #111): on the line-only docs below this is the same
  // chord sum it always was, and on the arc docs it is the number the Go
  // validator would report.
  const lengthsOf = (doc: DesignDoc) => doc.runs.map((r) => ops.runLengthMM(r));

  it('splits 1500mm into 2 pieces of ~750mm against a 1000mm limit', () => {
    const res = ops.autoSplitOverlongTubes(lineDoc(1500), 1000);
    expect(res.runsSplit).toBe(1);
    expect(res.piecesCreated).toBe(2);
    expect(res.doc.runs).toHaveLength(2);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(750, 6);
  });

  it('splits 2500mm into 3 pieces of ~833mm against a 1000mm limit', () => {
    const res = ops.autoSplitOverlongTubes(lineDoc(2500), 1000);
    expect(res.piecesCreated).toBe(3);
    expect(res.doc.runs).toHaveLength(3);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(2500 / 3, 6);
  });

  it('splits 3500mm into 4 pieces against a 1000mm limit', () => {
    const res = ops.autoSplitOverlongTubes(lineDoc(3500), 1000);
    expect(res.piecesCreated).toBe(4);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(875, 6);
  });

  // The postcondition the button actually promises. An exact multiple is the
  // dangerous case: nominal piece length lands *on* the limit, and the
  // validator's test is a strict `>`, so a picometre of float drift would
  // hand the operator back the same error they just clicked to clear.
  it('leaves no run over the limit, including at exact multiples', () => {
    for (const [len, limit] of [[2000, 1000], [3000, 1000], [1000, 500], [2400, 800]]) {
      const res = ops.autoSplitOverlongTubes(lineDoc(len), limit);
      for (const L of lengthsOf(res.doc)) expect(L).toBeLessThanOrEqual(limit);
    }
  });

  it('is idempotent — a second pass over the split doc is a no-op', () => {
    const first = ops.autoSplitOverlongTubes(lineDoc(2500), 1000);
    const second = ops.autoSplitOverlongTubes(first.doc, 1000);
    expect(second.runsSplit).toBe(0);
    expect(second.doc).toBe(first.doc);
  });

  it('leaves compliant runs untouched and returns the input doc', () => {
    const doc = lineDoc(900);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.runsSplit).toBe(0);
    expect(res.doc).toBe(doc);
  });

  // Arc length, not endpoint distance: this run doubles back on itself, so
  // its Euclidean span is 0 while its arc length is 2000mm.
  it('measures arc length, not the straight-line span', () => {
    const doc = docOf([
      { id: 'r1', polyline: { points: [[0, 0], [1000, 0], [0, 0]], closed: false } },
    ]);
    const res = ops.autoSplitOverlongTubes(doc, 900);
    expect(res.piecesCreated).toBe(3);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(2000 / 3, 6);
  });

  // Cuts land mid-segment on a serpentine, so the pieces must still come out
  // even — this is what "evenly distributed along arc length" has to mean.
  it('cuts mid-segment when the split point falls between vertices', () => {
    const doc = docOf([
      {
        id: 'r1',
        polyline: { points: [[0, 0], [1000, 0], [1000, 1000], [0, 1000]], closed: false },
      },
    ]);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.piecesCreated).toBe(3);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(1000, 6);
  });

  // A decorative closed loop has no electrodes; the spec says open it into N
  // arcs and let the operator place electrodes afterwards.
  it('opens an electrodeless closed loop and splits it into open arcs', () => {
    const pts: [number, number][] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
    const doc = docOf([{ id: 'r1', polyline: { points: pts, closed: true } }]);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    // Perimeter is 4000mm including the closing segment.
    expect(res.piecesCreated).toBe(4);
    expect(res.doc.runs.every((r) => r.polyline.closed === false)).toBe(true);
    expect(res.doc.runs.every((r) => (r.electrodes?.length ?? 0) === 0)).toBe(true);
    for (const L of lengthsOf(res.doc)) expect(L).toBeCloseTo(1000, 6);
  });

  // Which piece inherits which electrode has no non-arbitrary answer once the
  // live arc is gone, so we decline and say so rather than mangling it.
  it('skips a closed run that carries electrodes, and reports the skip', () => {
    const pts: [number, number][] = [[0, 0], [1000, 0], [1000, 1000], [0, 1000]];
    const doc = docOf([
      {
        id: 'r1',
        polyline: { points: pts, closed: true },
        electrodes: [{ point_index: 0 }, { point_index: 2 }],
      },
    ]);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.runsSplit).toBe(0);
    expect(res.skippedClosedWithElectrodes).toBe(1);
    expect(res.doc.runs).toHaveLength(1);
    expect(res.doc.runs[0].polyline.closed).toBe(true);
  });

  it('splits only the violating runs in a mixed doc', () => {
    const doc = docOf([
      { id: 'short', polyline: { points: [[0, 0], [500, 0]], closed: false } },
      { id: 'long', polyline: { points: [[0, 50], [2500, 50]], closed: false } },
      { id: 'alsoshort', polyline: { points: [[0, 99], [100, 99]], closed: false } },
    ]);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.runsSplit).toBe(1);
    expect(res.doc.runs).toHaveLength(5);
    // The compliant runs keep their ids and their position in the list.
    expect(res.doc.runs[0].id).toBe('short');
    expect(res.doc.runs[4].id).toBe('alsoshort');
  });

  it('carries color, diameter and notes onto every piece', () => {
    const doc = docOf([
      {
        id: 'r1',
        polyline: { points: [[0, 0], [2500, 0]], closed: false },
        color: '#ff0066',
        tube_diameter_mm: 15,
        notes: 'ruby 15mm',
      },
    ]);
    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.doc.runs).toHaveLength(3);
    for (const r of res.doc.runs) {
      expect(r.color).toBe('#ff0066');
      expect(r.tube_diameter_mm).toBe(15);
      expect(r.notes).toBe('ruby 15mm');
    }
  });

  it('does not mutate the input doc', () => {
    const doc = lineDoc(2500);
    ops.autoSplitOverlongTubes(doc, 1000);
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].polyline.points).toHaveLength(2);
  });

  it('ignores a non-positive limit rather than splitting forever', () => {
    const doc = lineDoc(2500);
    expect(ops.autoSplitOverlongTubes(doc, 0).doc).toBe(doc);
    expect(ops.autoSplitOverlongTubes(doc, -5).doc).toBe(doc);
    expect(ops.autoSplitOverlongTubes(doc, Number.NaN).doc).toBe(doc);
  });

  // Tier 3 #111. A 900mm chord marked 'arc' is 1043mm of glass — the Go
  // validator says so (probed: 1043.2042). Before this fix the TS side asked
  // the chord, saw 900, and left the run alone against a 1000mm limit while
  // RuleMaxSegmentLength kept flagging it. This test FAILS on the pre-#111
  // code (runsSplit 0), which is what makes it worth having.
  const arcDoc = (chordMM: number): DesignDoc =>
    docOf([
      {
        id: 'r1',
        polyline: { points: [[0, 0], [chordMM, 0]], closed: false, segment_types: ['arc'] },
      },
    ]);

  it('splits a run whose ARC length is over the limit though its chord is not', () => {
    const doc = arcDoc(900);
    // The premise, asserted rather than assumed: chord under, glass over.
    expect(ops.chordLengthMM(doc.runs[0].polyline.points, false)).toBeCloseTo(900, 9);
    expect(ops.runLengthMM(doc.runs[0])).toBeGreaterThan(1000);

    const res = ops.autoSplitOverlongTubes(doc, 1000);
    expect(res.runsSplit).toBe(1);
    expect(res.doc.runs).toHaveLength(2);
    for (const L of lengthsOf(res.doc)) expect(L).toBeLessThanOrEqual(1000);
  });

  // The piece count comes from the arc length (11 pieces for 1043mm at a
  // 100mm limit) but the cuts are placed in the chord metric the walk
  // actually measures. Handing the walk the arc length instead pushes every
  // cut ~16% too far and the 10th falls off the end of the tube, at which
  // point the whole split is abandoned and the run stays overlong — a
  // regression the earlier "is it over the limit" test cannot see.
  //
  // The whole run is ONE arc segment, so the first cut lands inside it and
  // straightens it (Bug #17's decision: a cut inside an arc straightens that
  // segment and only that segment). Every piece is therefore straight and the
  // doc keeps exactly the chord — which is the original glass minus the bow of
  // the one segment that was cut, a number rather than a tolerance.
  it('still cuts a long arc run into enough pieces to clear the limit', () => {
    const before = ops.runLengthMM(arcDoc(900).runs[0]);
    const res = ops.autoSplitOverlongTubes(arcDoc(900), 100);
    expect(res.runsSplit).toBe(1);
    expect(res.piecesCreated).toBe(11);
    expect(res.doc.runs).toHaveLength(11);
    for (const L of lengthsOf(res.doc)) expect(L).toBeLessThanOrEqual(100);

    // Tier 3 #111 left this assertion unwritten because straightening every
    // arc made it false. Post-Bug #17 the loss is bounded and computable: the
    // one arc the cuts went through, and nothing else.
    const after = lengthsOf(res.doc).reduce((a, b) => a + b, 0);
    expect(after).toBeCloseTo(900, 6);
    expect(before - after).toBeCloseTo(before - 900, 9);
  });

  // The other half of the same decision, and the case the fix exists for: when
  // the cuts land ON vertices nothing is straightened, so every arc survives
  // and the doc keeps every millimetre of glass. Pre-fix this returned four
  // straight 300mm pieces and 190mm of tube vanished from the takeoff.
  it('keeps the arcs when the cuts land on vertices, and the glass with them', () => {
    const curvy: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [300, 0], [600, 0], [900, 0], [1200, 0]],
        closed: false,
        segment_types: ['arc', 'arc_r', 'arc', 'arc'],
      },
    };
    const before = ops.runLengthMM(curvy);
    const res = ops.autoSplitOverlongTubes(docOf([curvy]), 348);
    expect(res.piecesCreated).toBe(4);
    for (const r of res.doc.runs) {
      expect(r.polyline.points).toHaveLength(2);
      expect(isArcKind(segmentTypeAt(r, 0))).toBe(true);
    }
    // Both sides of the bow survive as themselves — a fix that carried the
    // array but normalised 'arc_r' to 'arc' would mirror that curve.
    expect(res.doc.runs.map((r) => r.polyline.segment_types))
      .toEqual([['arc'], ['arc_r'], ['arc'], ['arc']]);
    const after = lengthsOf(res.doc).reduce((a, b) => a + b, 0);
    expect(after).toBeCloseTo(before, 6);
    for (const L of lengthsOf(res.doc)) expect(L).toBeLessThanOrEqual(348);
  });

  // The coincidence Bug #17 breaks, and the reason the retry loop is not
  // decoration. `pieces` comes from the ARC-AWARE length while the cuts are
  // placed in the CHORD metric; until arcs survived a split those two agreed
  // after the cut, because every piece came back straight. Now they don't:
  // two chord-equal pieces of this run are 600mm of chord each, but the first
  // is an intact arc measuring 695mm of glass, still over the limit. The
  // postcondition catches it and n+1 clears it.
  it('retries with more pieces when chord-equal pieces still exceed the limit', () => {
    const mixed: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [600, 0], [1200, 0]],
        closed: false,
        segment_types: ['arc', 'line'],
      },
    };
    const L = ops.runLengthMM(mixed);
    const nominal = Math.max(2, Math.ceil(L / 650));
    expect(nominal).toBe(2);

    const res = ops.autoSplitOverlongTubes(docOf([mixed]), 650);
    expect(res.runsSplit).toBe(1);
    // One retry: n=2 leaves a 695mm arc piece, n=3 does not. Asserted as a
    // COUNT rather than "it converged", because the budget is n+2 and knowing
    // how much of it a real case eats is the point.
    expect(res.piecesCreated).toBe(nominal + 1);
    for (const pieceLength of lengthsOf(res.doc)) {
      expect(pieceLength).toBeLessThanOrEqual(650);
    }

    // At a limit one arc-bow higher the first attempt succeeds and the arc
    // survives whole — the retry is a response to the geometry, not a tax on
    // every curved run.
    const easier = ops.autoSplitOverlongTubes(docOf([mixed]), 700);
    expect(easier.piecesCreated).toBe(2);
    expect(easier.doc.runs[0].polyline.segment_types).toEqual(['arc']);
  });

  // KNOWN LIMIT, pinned deliberately (Bug #17). The retry is bounded at n+2
  // and the cuts are placed in the chord metric, so a piece can contain a
  // whole intact arc plus a length of line: its glass exceeds its chord by the
  // arc's bow no matter how the lattice shifts, and if the lattice keeps
  // missing the arc across all three attempts the op gives up and leaves the
  // run ALONE. That needs the run to be ~15x the limit with a short arc on it
  // — 2100mm against a 125mm limit here — so it is out of reach at the stock
  // 2500mm/3000mm tube-spec limits without a 37-metre polyline.
  //
  // Declining is the honest failure: the operator sees the run still flagged.
  // The pre-fix code "succeeded" here by straightening the arc and silently
  // dropping 16mm of glass from the takeoff. The fix for the underlying
  // mismatch is an arc-aware cut walk (splitRunAtArcLength sums chords), not
  // a wider retry budget, and it is filed rather than guessed at here.
  it('declines rather than lying when the retry budget cannot clear an arc', () => {
    const stubborn: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [2000, 0], [2100, 0]],
        closed: false,
        segment_types: ['line', 'arc'],
      },
    };
    const doc = docOf([stubborn]);
    const L = ops.runLengthMM(stubborn);
    expect(L).toBeGreaterThan(125);
    const res = ops.autoSplitOverlongTubes(doc, 125);
    expect(res.runsSplit).toBe(0);
    expect(res.piecesCreated).toBe(0);
    // Left exactly as found — no half-cut doc, no straightened arc.
    expect(res.doc).toBe(doc);
    expect(res.doc.runs[0].polyline.segment_types).toEqual(['line', 'arc']);
  });

  // Every piece the pass emits has to be saveable, whatever route it took.
  it('emits well-formed segment_types on every piece it creates', () => {
    const shapes: DesignRun[] = [
      { id: 'a', polyline: { points: [[0, 0], [900, 0]], closed: false, segment_types: ['arc'] } },
      {
        id: 'b',
        polyline: {
          points: [[0, 0], [300, 0], [600, 0], [900, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
      },
      {
        id: 'c',
        polyline: {
          points: [[0, 0], [300, 0], [300, 300], [0, 300]],
          closed: true,
          segment_types: ['arc', 'arc', 'arc', 'line'],
        },
      },
    ];
    for (const limit of [100, 250, 400, 700]) {
      expectWellFormedDoc(ops.autoSplitOverlongTubes(docOf(shapes), limit).doc);
    }
  });

  it('measures a closed arc-bearing loop as glass before deciding to open it', () => {
    const loop: DesignRun = {
      id: 'r1',
      polyline: {
        points: [[0, 0], [300, 0], [300, 300], [0, 300]],
        closed: true,
        segment_types: ['arc', 'arc', 'arc', 'line'],
      },
    };
    // Chord perimeter 1200; as glass it is ~1343 (three 300mm chords bowed).
    expect(ops.chordLengthMM(loop.polyline.points, true)).toBeCloseTo(1200, 9);
    expect(ops.runLengthMM(loop)).toBeGreaterThan(1300);

    const res = ops.autoSplitOverlongTubes(docOf([loop]), 1250);
    expect(res.runsSplit).toBe(1);
    expect(res.doc.runs.every((r) => r.polyline.closed === false)).toBe(true);
    for (const L of lengthsOf(res.doc)) expect(L).toBeLessThanOrEqual(1250);
  });
});

describe('chordLengthMM', () => {
  // Mirrors internal/validate/geometry.go — the closing segment counts for a
  // closed polyline. This one measures the points it is handed and nothing
  // else; runLengthMM below is what a caller holding a RUN must ask.
  it('counts the closing segment only when closed', () => {
    const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
    expect(ops.chordLengthMM(square, false)).toBeCloseTo(30, 9);
    expect(ops.chordLengthMM(square, true)).toBeCloseTo(40, 9);
  });

  it('is zero for a degenerate polyline', () => {
    expect(ops.chordLengthMM([], false)).toBe(0);
    expect(ops.chordLengthMM([[5, 5]], true)).toBe(0);
  });
});

// Tier 3 #111 — the TS side measured an arc as its chord while the Go
// validator measured the curve, so the auto-split and the overlong badge could
// both call a run fixed that came back flagged.
//
// These are Go/TS AGREEMENT tests. The `GO_*` constants below were measured on
// 2026-09-01 by pushing the same run through the real Go pipeline —
// `designdoc.ToSVG` → `validate.ExtractMMPolylines` → `(*Polyline).Length()` —
// not derived from the arc formula, because the two sides flatten with
// different samplers (Go emits cubics and subdivides them adaptively: 33
// points for the 100mm chord below; arcGeom walks the circle at 5°: 23). They
// agree to about 3 parts in 10,000, which is what the tolerances allow. A
// tolerance loose enough to admit the chord answer would make these vacuous,
// so each one also asserts the chord answer is nowhere near.
describe('runLengthMM (arc-aware run length)', () => {
  const GO_OPEN_ARC_100_MM = 115.8964;
  const GO_CLOSED_SQUARE_3ARCS_MM = 447.6891;
  const GO_OPEN_ARC_900_MM = 1043.2042;

  const openArc = (segType: SegmentKind = 'arc'): DesignRun => ({
    id: 'r1',
    polyline: { points: [[0, 0], [100, 0]], closed: false, segment_types: [segType] },
  });
  const closedSquare = (segment_types?: SegmentKind[]): DesignRun => ({
    id: 'r1',
    polyline: {
      points: [[0, 0], [100, 0], [100, 100], [0, 100]],
      closed: true,
      ...(segment_types ? { segment_types } : {}),
    },
  });

  it('agrees with the Go validator on a single arc segment', () => {
    const got = ops.runLengthMM(openArc());
    expect(Math.abs(got - GO_OPEN_ARC_100_MM)).toBeLessThan(0.05);
    // The failure this replaces: the chord is 15.9mm short of the glass, so a
    // tolerance that admitted it would be admitting the bug.
    expect(ops.chordLengthMM(openArc().polyline.points, false)).toBeCloseTo(100, 9);
    expect(Math.abs(100 - GO_OPEN_ARC_100_MM)).toBeGreaterThan(1);
  });

  it('measures a flipped arc identically — the side moves glass, not length', () => {
    expect(ops.runLengthMM(openArc('arc_r'))).toBe(ops.runLengthMM(openArc('arc')));
  });

  it('is exactly the chord sum for a line-only run — a provable no-op', () => {
    const line: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [300, 0], [300, 400]], closed: false },
    };
    expect(ops.runLengthMM(line)).toBe(ops.chordLengthMM(line.polyline.points, false));
    expect(ops.runLengthMM(line)).toBe(700);
    // Same with an all-'line' segment_types array, which is inert by design.
    const declared: DesignRun = {
      ...line,
      polyline: { ...line.polyline, segment_types: ['line', 'line'] },
    };
    expect(ops.runLengthMM(declared)).toBe(700);
  });

  // flatRunPoints returns two DIFFERENT shapes for a closed run, and passing
  // `closed` is right for both — for opposite reasons. Pin the shapes here so
  // a change to either function can't silently drop or double-count the
  // closing chord.
  it('counts a closed run’s closing chord exactly once — with arcs and without', () => {
    const plain = closedSquare();
    // No arcs: the live vertex array, which does NOT repeat points[0].
    expect(flatRunPoints(plain)).toBe(plain.polyline.points);
    expect(ops.runLengthMM(plain)).toBeCloseTo(400, 9);

    const curved = closedSquare(['arc', 'arc', 'arc', 'line']);
    const flat = flatRunPoints(curved);
    // Has arcs: the flattened array already ENDS at points[0], so the closing
    // chord it adds is zero-length.
    expect(flat[flat.length - 1]).toEqual(curved.polyline.points[0]);
    const got = ops.runLengthMM(curved);
    expect(Math.abs(got - GO_CLOSED_SQUARE_3ARCS_MM)).toBeLessThan(0.1);
    // Neither of the two ways to get the closing chord wrong: 100mm dropped
    // (measuring the flattened array as open) or 100mm counted twice.
    expect(Math.abs(got - (GO_CLOSED_SQUARE_3ARCS_MM - 100))).toBeGreaterThan(50);
    expect(Math.abs(got - (GO_CLOSED_SQUARE_3ARCS_MM + 100))).toBeGreaterThan(50);
  });

  it('agrees with the Go validator on a 900mm chord too', () => {
    const long: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [900, 0]], closed: false, segment_types: ['arc'] },
    };
    const got = ops.runLengthMM(long);
    expect(Math.abs(got - GO_OPEN_ARC_900_MM) / GO_OPEN_ARC_900_MM).toBeLessThan(0.001);
    expect(got).toBeGreaterThan(1000); // the chord (900) is under; the glass is not
  });

  it('is zero for a degenerate run', () => {
    expect(ops.runLengthMM({ id: 'r1', polyline: { points: [], closed: false } })).toBe(0);
    expect(ops.runLengthMM({ id: 'r1', polyline: { points: [[5, 5]], closed: true } })).toBe(0);
  });
});

// Tier 2 #74 — the raceway guideline. Every tube crossing one horizontal line
// gets cut there, so the pieces below it terminate in a single back-channel
// strip. The geometry claim is "cut exactly where the glass meets the line",
// and the operational claim is "clicking twice does not cut twice".
describe('racewayCrossings', () => {
  it('finds a single crossing mid-segment and reports where', () => {
    const c = ops.racewayCrossings([[0, 0], [0, 100]], false, 25);
    expect(c).toHaveLength(1);
    expect(c[0].segmentIndex).toBe(0);
    expect(c[0].t).toBeCloseTo(0.25, 9);
  });

  it('finds both crossings of a tube that dips below and comes back', () => {
    const pts: [number, number][] = [[0, 100], [50, 0], [100, 100]];
    const c = ops.racewayCrossings(pts, false, 50);
    expect(c).toHaveLength(2);
    expect(c[0].segmentIndex).toBe(0);
    expect(c[1].segmentIndex).toBe(1);
  });

  it('returns nothing when the line misses the polyline entirely', () => {
    expect(ops.racewayCrossings([[0, 0], [100, 0]], false, 50)).toEqual([]);
    expect(ops.racewayCrossings([[0, 80], [100, 90]], false, 50)).toEqual([]);
  });

  // A vertex sitting on the line is a crossing — the operator put the raceway
  // there. It must be reported once, not twice (arriving and leaving).
  it('reports a vertex on the line exactly once', () => {
    const pts: [number, number][] = [[0, 100], [50, 50], [100, 0]];
    const c = ops.racewayCrossings(pts, false, 50);
    expect(c).toHaveLength(1);
    expect(c[0]).toEqual({ segmentIndex: 1, t: 0 });
  });

  // A tangent touch still counts. "It only grazes the line" is not a
  // distinction that survives contact with a bending table.
  it('counts a vertex that touches the line and turns back', () => {
    const pts: [number, number][] = [[0, 100], [50, 50], [100, 100]];
    expect(ops.racewayCrossings(pts, false, 50)).toHaveLength(1);
  });

  // Both endpoints of an open run are excluded. This is the whole basis of
  // idempotency, not a cosmetic tidy-up.
  it('excludes both endpoints of an open run', () => {
    const pts: [number, number][] = [[0, 50], [50, 0], [100, 50]];
    expect(ops.racewayCrossings(pts, false, 50)).toEqual([]);
  });

  it('walks the closing segment of a closed run', () => {
    // Square straddling y=50; the line cuts the two vertical sides, one of
    // which IS the closing segment.
    const sq: [number, number][] = [[0, 0], [100, 0], [100, 100], [0, 100]];
    const c = ops.racewayCrossings(sq, true, 50);
    expect(c).toHaveLength(2);
    expect(c.map((x) => x.segmentIndex)).toEqual([1, 3]);
  });

  // Vertex 0 of a closed run is a legitimate split point — it is not an
  // endpoint, because the loop continues through it.
  it('includes vertex 0 of a closed run when it lies on the line', () => {
    const sq: [number, number][] = [[0, 50], [100, 50], [100, 100], [0, 100]];
    const c = ops.racewayCrossings(sq, true, 50);
    expect(c.some((x) => x.segmentIndex === 0 && x.t === 0)).toBe(true);
  });

  it('handles a segment lying along the line by reporting both its ends', () => {
    const pts: [number, number][] = [[0, 0], [20, 50], [80, 50], [100, 0]];
    const c = ops.racewayCrossings(pts, false, 50);
    expect(c.map((x) => x.segmentIndex)).toEqual([1, 2]);
  });

  it('ignores a degenerate polyline', () => {
    expect(ops.racewayCrossings([], false, 0)).toEqual([]);
    expect(ops.racewayCrossings([[0, 0]], false, 0)).toEqual([]);
  });
});

describe('raceway guideline ops', () => {
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 200, 200],
    runs,
  });

  const withLine = (runs: DesignRun[], y: number): DesignDoc =>
    ops.addRacewayGuideline(docOf(runs), y);

  const vertical = (id: string, x: number, y0: number, y1: number): DesignRun => ({
    id,
    polyline: { points: [[x, y0], [x, y1]], closed: false },
  });

  it('allocates rw1, rw2, … and reuses a freed slot', () => {
    let doc = docOf([]);
    doc = ops.addRacewayGuideline(doc, 10);
    doc = ops.addRacewayGuideline(doc, 20);
    expect(doc.guidelines?.map((g) => g.id)).toEqual(['rw1', 'rw2']);
    doc = ops.removeGuideline(doc, 'rw1');
    doc = ops.addRacewayGuideline(doc, 30);
    expect(doc.guidelines?.map((g) => g.id).sort()).toEqual(['rw1', 'rw2']);
  });

  it('drops the guidelines key entirely once the last one goes', () => {
    let doc = ops.addRacewayGuideline(docOf([]), 10);
    doc = ops.removeGuideline(doc, 'rw1');
    expect('guidelines' in doc).toBe(false);
  });

  it('leaves the doc alone for an unknown or unchanged guideline', () => {
    const doc = ops.addRacewayGuideline(docOf([]), 10);
    expect(ops.removeGuideline(doc, 'nope')).toBe(doc);
    expect(ops.moveGuideline(doc, 'nope', 5)).toBe(doc);
    expect(ops.moveGuideline(doc, 'rw1', 10)).toBe(doc);
    expect(ops.moveGuideline(doc, 'rw1', 11).guidelines?.[0].y_mm).toBe(11);
  });

  it('splits one crossing tube into two pieces sharing the raceway id', () => {
    const doc = withLine([vertical('a', 10, 0, 100)], 40);
    const res = ops.splitTubesAtRaceway(doc, 'rw1');
    expect(res.runsSplit).toBe(1);
    expect(res.piecesCreated).toBe(2);
    expect(res.doc.runs).toHaveLength(2);
    expect(res.doc.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
    // Cut exactly on the line, not near it.
    for (const r of res.doc.runs) {
      const ys = r.polyline.points.map((p) => p[1]);
      expect(Math.min(...ys) === 40 || Math.max(...ys) === 40).toBe(true);
    }
  });

  it('leaves a tube that does not reach the line untouched', () => {
    const doc = withLine([vertical('a', 10, 0, 30)], 40);
    const res = ops.splitTubesAtRaceway(doc, 'rw1');
    expect(res.runsSplit).toBe(0);
    expect(res.doc).toBe(doc);
  });

  it('splits a tube crossing twice into three pieces, all tagged', () => {
    const zig: DesignRun = {
      id: 'a',
      polyline: { points: [[0, 100], [50, 0], [100, 100]], closed: false },
    };
    const res = ops.splitTubesAtRaceway(withLine([zig], 50), 'rw1');
    expect(res.piecesCreated).toBe(3);
    expect(res.doc.runs).toHaveLength(3);
    expect(res.doc.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
  });

  // The claim that matters operationally: clicking the button twice does not
  // cut the glass twice.
  it('is idempotent — a second split at the same line is a no-op', () => {
    const doc = withLine([vertical('a', 10, 0, 100), vertical('b', 20, 0, 100)], 40);
    const first = ops.splitTubesAtRaceway(doc, 'rw1');
    expect(first.runsSplit).toBe(2);
    const second = ops.splitTubesAtRaceway(first.doc, 'rw1');
    expect(second.runsSplit).toBe(0);
    expect(second.doc).toBe(first.doc);
  });

  it('splits only the tubes that cross, in a mixed design', () => {
    const doc = withLine(
      [vertical('crosses', 10, 0, 100), vertical('above', 20, 60, 100), vertical('below', 30, 0, 20)],
      40,
    );
    const res = ops.splitTubesAtRaceway(doc, 'rw1');
    expect(res.runsSplit).toBe(1);
    expect(res.doc.runs).toHaveLength(4);
    expect(res.doc.runs.filter((r) => r.raceway_id === 'rw1')).toHaveLength(2);
    expect(res.doc.runs.find((r) => r.id === 'above')?.raceway_id).toBeUndefined();
  });

  // A letter's face outline is a closed loop; a raceway through an "O" is
  // ordinary work, so closed runs must be handled rather than skipped.
  it('opens a closed loop at the line and cuts it into arcs', () => {
    const sq: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    };
    const res = ops.splitTubesAtRaceway(withLine([sq], 50), 'rw1');
    expect(res.runsSplit).toBe(1);
    expect(res.piecesCreated).toBe(2);
    expect(res.doc.runs.every((r) => r.polyline.closed === false)).toBe(true);
    expect(res.doc.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
    // Both pieces must start and end on the line.
    for (const r of res.doc.runs) {
      const pts = r.polyline.points;
      expect(pts[0][1]).toBeCloseTo(50, 6);
      expect(pts[pts.length - 1][1]).toBeCloseTo(50, 6);
    }
  });

  it('preserves the closed loop’s total length when opening and cutting it', () => {
    const sq: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    };
    const before = ops.runLengthMM(sq);
    const res = ops.splitTubesAtRaceway(withLine([sq], 50), 'rw1');
    const after = res.doc.runs.reduce((acc, r) => acc + ops.runLengthMM(r), 0);
    expect(after).toBeCloseTo(before, 6);
  });

  it('is idempotent on a closed loop too', () => {
    const sq: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    };
    const first = ops.splitTubesAtRaceway(withLine([sq], 50), 'rw1');
    const second = ops.splitTubesAtRaceway(first.doc, 'rw1');
    expect(second.runsSplit).toBe(0);
    expect(second.doc).toBe(first.doc);
  });

  // Which piece inherits which electrode has no non-arbitrary answer once the
  // live arc is gone, so we decline and say so.
  it('skips a closed run carrying electrodes, and reports the skip', () => {
    const sq: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
      electrodes: [{ point_index: 0 }, { point_index: 2 }],
    };
    const res = ops.splitTubesAtRaceway(withLine([sq], 50), 'rw1');
    expect(res.runsSplit).toBe(0);
    expect(res.skippedClosedWithElectrodes).toBe(1);
    expect(res.doc.runs).toHaveLength(1);
    expect(res.doc.runs[0].polyline.closed).toBe(true);
  });

  it('carries color, diameter and notes onto every piece', () => {
    const run: DesignRun = {
      id: 'a',
      polyline: { points: [[10, 0], [10, 100]], closed: false },
      color: '#00e5ff',
      tube_diameter_mm: 15,
      notes: 'blue 15mm',
    };
    const res = ops.splitTubesAtRaceway(withLine([run], 40), 'rw1');
    expect(res.doc.runs).toHaveLength(2);
    for (const r of res.doc.runs) {
      expect(r.color).toBe('#00e5ff');
      expect(r.tube_diameter_mm).toBe(15);
      expect(r.notes).toBe('blue 15mm');
    }
  });

  it('does nothing for an unknown guideline id', () => {
    const doc = withLine([vertical('a', 10, 0, 100)], 40);
    expect(ops.splitTubesAtRaceway(doc, 'nope').doc).toBe(doc);
  });

  it('does not mutate the input doc', () => {
    const doc = withLine([vertical('a', 10, 0, 100)], 40);
    ops.splitTubesAtRaceway(doc, 'rw1');
    expect(doc.runs).toHaveLength(1);
    expect(doc.runs[0].polyline.points).toHaveLength(2);
  });

  // Removing the line must not un-cut the glass or silently regroup the PDF.
  it('keeps geometry and raceway tags when the guideline is deleted', () => {
    const res = ops.splitTubesAtRaceway(withLine([vertical('a', 10, 0, 100)], 40), 'rw1');
    const after = ops.removeGuideline(res.doc, 'rw1');
    expect(after.runs).toHaveLength(2);
    expect(after.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
  });
});

// Cutting a tube changes where the glass ends, not what it is. splitRun used
// to carry only colour/diameter/notes, so a channel-letter face lost its face
// flag on the way through — and groupByRaceway (internal/printpdf/raceway.go)
// buckets only runs that are BOTH a face and raceway-tagged, so the combined
// strip page silently stopped being emitted. No error, just a missing page.
describe('splitRun classification', () => {
  const faceRun: DesignRun = {
    id: 'face',
    polyline: { points: [[10, 0], [10, 50], [10, 100]], closed: false },
    color: '#ff0000',
    tube_diameter_mm: 12,
    notes: 'letter O',
    is_channel_letter_face: true,
    channel_letter_depth_mm: 120,
    raceway_id: 'rw1',
    group_id: 'g1',
  };
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 200, 200],
    runs,
  });

  it('carries every classification field onto both pieces', () => {
    const after = ops.splitRun(docOf([faceRun]), 'face', 1);
    expect(after.runs).toHaveLength(2);
    for (const r of after.runs) {
      expect(r.is_channel_letter_face).toBe(true);
      expect(r.channel_letter_depth_mm).toBe(120);
      expect(r.raceway_id).toBe('rw1');
      expect(r.group_id).toBe('g1');
      expect(r.color).toBe('#ff0000');
      expect(r.tube_diameter_mm).toBe(12);
      expect(r.notes).toBe('letter O');
    }
  });

  it('keeps a jumper a jumper', () => {
    const jumper: DesignRun = {
      id: 'j1',
      polyline: { points: [[0, 0], [10, 0], [20, 0]], closed: false },
      kind: 'jumper',
    };
    const after = ops.splitRun(docOf([jumper]), 'j1', 1);
    expect(after.runs.every((r) => r.kind === 'jumper')).toBe(true);
  });

  // `direction` only means anything on a closed run, and both pieces are open.
  it('drops direction, which is meaningless once the run is open', () => {
    const loop: DesignRun = {
      id: 'o',
      polyline: { points: [[0, 0], [10, 0], [10, 10], [0, 10]], closed: true },
      direction: 'backward',
    };
    const after = ops.splitRun(docOf([loop]), 'o', 2);
    expect(after.runs.every((r) => r.direction === undefined)).toBe(true);
  });

  it('does not invent fields the source run never had', () => {
    const plain: DesignRun = {
      id: 'p',
      polyline: { points: [[0, 0], [10, 0], [20, 0]], closed: false },
    };
    const after = ops.splitRun(docOf([plain]), 'p', 1);
    for (const r of after.runs) {
      expect(r.is_channel_letter_face).toBeUndefined();
      expect(r.raceway_id).toBeUndefined();
      expect(r.group_id).toBeUndefined();
      expect(r.kind).toBeUndefined();
    }
  });

  // The end-to-end consequence: a face run cut at the raceway must still be
  // a face run, or the strip page it was cut for never renders.
  it('leaves raceway-split face pieces eligible for the combined strip page', () => {
    const doc = ops.addRacewayGuideline(
      docOf([{ ...faceRun, raceway_id: undefined, polyline: { points: [[10, 0], [10, 100]], closed: false } }]),
      50,
    );
    const res = ops.splitTubesAtRaceway(doc, 'rw1');
    expect(res.runsSplit).toBe(1);
    // Both conditions groupByRaceway requires.
    expect(res.doc.runs.every((r) => r.is_channel_letter_face === true)).toBe(true);
    expect(res.doc.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
  });
});

// Tier 3 #78 — an arc changes what is drawn BETWEEN two vertices. The vertex
// list must not move, because electrodes, bends, blockouts and annotations all
// index into it.
describe('setSegmentType', () => {
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 400, 400],
    runs,
  });
  const line3 = (): DesignRun => ({
    id: 'r1',
    polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
  });

  it('allocates the array lazily, filled with line', () => {
    const next = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    expect(next.runs[0].polyline.segment_types).toEqual(['line', 'arc']);
  });

  // Back-compat is not decoration here: the Go decoder validates the array's
  // length, so a doc that carries a redundant all-line array is just noise
  // that can drift out of sync. Dropping it keeps old docs byte-identical.
  it('drops the array again when the last arc is straightened', () => {
    let doc = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    doc = ops.convertSegmentToLine(doc, 'r1', 1);
    expect('segment_types' in doc.runs[0].polyline).toBe(false);
  });

  it('never changes the vertex list', () => {
    const before = line3();
    const next = ops.convertSegmentToArc(docOf([before]), 'r1', 0);
    expect(next.runs[0].polyline.points).toEqual(before.polyline.points);
  });

  it('leaves index-anchored data untouched', () => {
    const run: DesignRun = {
      ...line3(),
      electrodes: [{ point_index: 0 }, { point_index: 2 }],
      bends: [{ live_index: 1 }],
      annotations: [{ kind: 'support', live_index: 1 }],
    };
    const next = ops.convertSegmentToArc(docOf([run]), 'r1', 1).runs[0];
    expect(next.electrodes).toEqual(run.electrodes);
    expect(next.bends).toEqual(run.bends);
    expect(next.annotations).toEqual(run.annotations);
  });

  it('keeps the array exactly one entry per segment', () => {
    // Open: points-1. Closed: points, because the closing segment counts.
    const open = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    expect(open.runs[0].polyline.segment_types).toHaveLength(2);
    const closedRun: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0], [100, 100]], closed: true },
    };
    const closed = ops.convertSegmentToArc(docOf([closedRun]), 'r1', 2);
    expect(closed.runs[0].polyline.segment_types).toHaveLength(3);
    expect(closed.runs[0].polyline.segment_types?.[2]).toBe('arc');
  });

  it('refuses an out-of-range segment, and a no-op returns the same doc', () => {
    const doc = docOf([line3()]);
    expect(ops.convertSegmentToArc(doc, 'r1', -1)).toBe(doc);
    expect(ops.convertSegmentToArc(doc, 'r1', 2)).toBe(doc); // only 2 segments: 0,1
    expect(ops.convertSegmentToArc(doc, 'nope', 0)).toBe(doc);
    expect(ops.convertSegmentToLine(doc, 'r1', 0)).toBe(doc); // already a line
  });

  // A circle needs two distinct endpoints. Marking a zero-length segment as an
  // arc would leave it flagged curved and silently drawn straight everywhere.
  it('refuses to curve a zero-length segment', () => {
    const dup: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [0, 0], [100, 0]], closed: false },
    };
    const doc = docOf([dup]);
    expect(ops.convertSegmentToArc(doc, 'r1', 0)).toBe(doc);
    expect(ops.convertSegmentToArc(doc, 'r1', 1)).not.toBe(doc);
  });

  it('converts several segments independently', () => {
    let doc = docOf([{
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0], [200, 0], [300, 0]], closed: false },
    }]);
    doc = ops.convertSegmentToArc(doc, 'r1', 0);
    doc = ops.convertSegmentToArc(doc, 'r1', 2);
    expect(doc.runs[0].polyline.segment_types).toEqual(['arc', 'line', 'arc']);
    doc = ops.convertSegmentToLine(doc, 'r1', 0);
    expect(doc.runs[0].polyline.segment_types).toEqual(['line', 'line', 'arc']);
  });

  it('does not mutate the input doc', () => {
    const doc = docOf([line3()]);
    ops.convertSegmentToArc(doc, 'r1', 1);
    expect(doc.runs[0].polyline.segment_types).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Tier 3 #87 — flipSegmentArc
  // -------------------------------------------------------------------------

  it('flips one arc to the other side and back', () => {
    let doc = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    doc = ops.flipSegmentArc(doc, 'r1', 1);
    expect(doc.runs[0].polyline.segment_types).toEqual(['line', 'arc_r']);
    doc = ops.flipSegmentArc(doc, 'r1', 1);
    expect(doc.runs[0].polyline.segment_types).toEqual(['line', 'arc']);
  });

  it('moves the drawn glass to the mirror of where it was, and nowhere else', () => {
    const doc = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    const before = flatRunPoints(doc.runs[0]);
    const after = flatRunPoints(ops.flipSegmentArc(doc, 'r1', 1).runs[0]);
    expect(after).toHaveLength(before.length);
    // Segment 1 runs [100,0] -> [200,0] along y = 0, so the flip is a
    // reflection in y = 0 of exactly that segment's samples.
    expectSamePoints(after, before.map(([x, y]) => [x, -y] as [number, number]));
    // The chord is unmoved: the vertex list never changes under a flip.
    expect(ops.flipSegmentArc(doc, 'r1', 1).runs[0].polyline.points)
      .toEqual(doc.runs[0].polyline.points);
  });

  it('does not change the run length — a flip moves glass, it does not add any', () => {
    const doc = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    const len = (d: DesignDoc) => {
      const r = d.runs[0];
      let total = 0;
      for (let i = 0; i < r.polyline.points.length - 1; i++) {
        total += walkSegmentLengthMM(r, i, i + 1);
      }
      return total;
    };
    expect(len(ops.flipSegmentArc(doc, 'r1', 1))).toBeCloseTo(len(doc), 12);
  });

  it('is a no-op on a straight segment, a bad index and a missing run', () => {
    const doc = ops.convertSegmentToArc(docOf([line3()]), 'r1', 1);
    expect(ops.flipSegmentArc(doc, 'r1', 0)).toBe(doc); // segment 0 is a line
    expect(ops.flipSegmentArc(doc, 'r1', 9)).toBe(doc);
    expect(ops.flipSegmentArc(doc, 'r1', -1)).toBe(doc);
    expect(ops.flipSegmentArc(doc, 'nope', 1)).toBe(doc);
    expect(ops.flipSegmentArc(docOf([line3()]), 'r1', 1)).toBeTruthy();
    expect(ops.flipSegmentArc(docOf([line3()]), 'r1', 1).runs[0].polyline.segment_types)
      .toBeUndefined();
  });

  it('leaves index-anchored data untouched, exactly as convert does', () => {
    const run: DesignRun = {
      ...line3(),
      electrodes: [{ point_index: 0 }, { point_index: 2 }],
      bends: [{ live_index: 1 }],
      annotations: [{ kind: 'support', live_index: 1 }],
    };
    const doc = ops.convertSegmentToArc(docOf([run]), 'r1', 1);
    const next = ops.flipSegmentArc(doc, 'r1', 1).runs[0];
    expect(next.electrodes).toEqual(run.electrodes);
    expect(next.bends).toEqual(run.bends);
    expect(next.annotations).toEqual(run.annotations);
  });
});

// ---------------------------------------------------------------------------
// Bug #11 — reverseRun and arc segments.
//
// Reversing a run changes the direction of travel. `segment_types[i]`
// describes the segment LEAVING vertex i, so the flags have to travel with
// the chords they describe or the curvature lands on the wrong piece of
// glass — which is what the bug reported.
//
// Arc handedness used to be the one part of the shape a reversal could not
// preserve: "arc" always bows left of travel, so a single reverse mirrored
// every arc about its (unchanged) chord. Tier 3 #87 gave the schema a signed
// side ('arc' / 'arc_r'), and reversedRun now flips it as it remaps — so the
// KNOWN-LIMITATION test that pinned the mirroring has been replaced by the
// real geometric invariant at the bottom of this block.
// ---------------------------------------------------------------------------

const REV_EPS = 1e-9;

function nearPt(a: [number, number], b: [number, number]): boolean {
  return Math.abs(a[0] - b[0]) <= REV_EPS && Math.abs(a[1] - b[1]) <= REV_EPS;
}

function expectSamePoints(got: [number, number][], want: [number, number][]) {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) {
    expect(
      nearPt(got[i], want[i]),
      `point ${i}: got [${got[i]}], want [${want[i]}]`,
    ).toBe(true);
  }
}

// expectSameClosedCurve compares two flattened CLOSED walks as curves rather
// than as lists.
//
// Reversing a closed run is `points.slice().reverse()`, so the reversed run
// starts at the ORIGINAL LAST vertex, not at the original first one. Its
// flattened walk is therefore the reversed original walk rotated to a
// different start — the same glass, entered at a different point. Comparing
// the two lists element-for-element would fail on that rotation alone and say
// nothing about the shape, which is the thing under test.
//
// The rotation is not fuzzy-matched: `got[0]` is a VERTEX, every vertex
// appears exactly once in a flattened walk (FlattenSegment lands exactly on
// its declared endpoint), and the assertion below insists on that uniqueness
// before rotating.
function expectSameClosedCurve(got: [number, number][], want: [number, number][]) {
  expect(nearPt(got[0], got[got.length - 1])).toBe(true);
  expect(nearPt(want[0], want[want.length - 1])).toBe(true);
  const g = got.slice(0, -1);
  const w = want.slice(0, -1);
  expect(g.length).toBe(w.length);
  const starts = w.map((p, i) => (nearPt(p, g[0]) ? i : -1)).filter((i) => i >= 0);
  expect(starts, `got[0] = [${g[0]}] should appear exactly once in the expected walk`)
    .toHaveLength(1);
  expectSamePoints(g, w.slice(starts[0]).concat(w.slice(0, starts[0])));
}

// arcChords describes where the curvature lives independently of walk
// direction: one canonical key per arc segment, built from the UNORDERED pair
// of endpoints. Same set before and after means every arc is still on the
// chord the user drew it on.
function arcChords(run: DesignRun): string[] {
  const pts = run.polyline.points;
  const n = pts.length;
  const segs = run.polyline.closed ? n : n - 1;
  const out: string[] = [];
  for (let i = 0; i < segs; i++) {
    // isArcKind, not `!== 'arc'`: a reversal now yields 'arc_r', and a bare
    // equality check would report "no arcs here" and pass vacuously.
    if (!isArcKind(segmentTypeAt(run, i))) continue;
    const a = `${pts[i][0]},${pts[i][1]}`;
    const b = `${pts[(i + 1) % n][0]},${pts[(i + 1) % n][1]}`;
    out.push([a, b].sort().join('|'));
  }
  return out.sort();
}

function openArcRun(): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 60, 60],
    runs: [
      {
        id: 'run-1',
        polyline: {
          points: [[0, 0], [10, 0], [10, 10], [20, 10], [20, 20]],
          closed: false,
          segment_types: ['line', 'arc', 'line', 'arc'],
        },
        electrodes: [{ point_index: 0 }, { point_index: 4 }],
      },
    ],
  };
}

function closedArcRun(): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 60, 60],
    runs: [
      {
        id: 'run-1',
        polyline: {
          points: [[0, 0], [30, 0], [30, 30], [0, 30]],
          closed: true,
          segment_types: ['arc', 'line', 'line', 'line'],
        },
      },
    ],
  };
}

describe('reverseRun and arc segments (Bug #11)', () => {
  it('moves segment_types with the chords on an OPEN run (new j = old n-2-j)', () => {
    const doc = openArcRun();
    const rev = ops.reverseRun(doc, 'run-1').runs[0];
    // Tier 3 #87 — the remap carries the segment AND the flip carries the
    // side. Both inputs were 'arc' (left of the old travel direction), so
    // reversed they are 'arc_r' (right of the new one) — the same glass.
    expect(rev.polyline.segment_types).toEqual(['arc_r', 'line', 'arc_r', 'line']);
    expect(arcChords(rev)).toEqual(arcChords(doc.runs[0]));
  });

  it('moves segment_types with the chords on a CLOSED run (new j = old (n-2-j) mod n)', () => {
    const doc = closedArcRun();
    const rev = ops.reverseRun(doc, 'run-1').runs[0];
    // n = 4, so new j takes old (2-j) mod 4: [old2, old1, old0, old3].
    expect(rev.polyline.segment_types).toEqual(['line', 'line', 'arc_r', 'line']);
    expect(arcChords(rev)).toEqual(arcChords(doc.runs[0]));
  });

  it('is an involution on the stored side, not just on the geometry', () => {
    for (const doc of [openArcRun(), closedArcRun()]) {
      const twice = ops.reverseRun(ops.reverseRun(doc, 'run-1'), 'run-1').runs[0];
      expect(twice.polyline.segment_types).toEqual(doc.runs[0].polyline.segment_types);
    }
  });

  it('leaves a line-only run exactly as it always reversed', () => {
    const doc: DesignDoc = {
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
    const rev = ops.reverseRun(doc, 'run-1').runs[0];
    expect(rev.polyline.points).toEqual([[4, 0], [3, 0], [2, 0], [1, 0], [0, 0]]);
    expect(rev.electrodes).toEqual([{ point_index: 4 }, { point_index: 0 }]);
    // A pre-#78 run must not grow a segment_types array: the Go decoder
    // validates its length, and an all-'line' array is not what round-trips.
    expect('segment_types' in rev.polyline).toBe(false);
  });

  it('reversing twice restores the run exactly — points, flags, anchors, shape', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          ...openArcRun().runs[0],
          blockouts: [{ start_live_index: 0, end_live_index: 2 }],
          annotations: [{ kind: 'jump', live_index: 1 }],
          bends: [{ live_index: 3 }],
        },
      ],
    };
    const once = ops.reverseRun(doc, 'run-1');
    const twice = ops.reverseRun(once, 'run-1');
    expect(twice.runs[0]).toEqual(doc.runs[0]);
    expectSamePoints(flatRunPoints(twice.runs[0]), flatRunPoints(doc.runs[0]));
    // And the intermediate really did change something.
    expect(once.runs[0].polyline.points).not.toEqual(doc.runs[0].polyline.points);
  });

  it('lands electrode, blockout, annotation and bend anchors on the same physical points', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          ...openArcRun().runs[0],
          blockouts: [{ start_live_index: 0, end_live_index: 2 }],
          annotations: [{ kind: 'jump', live_index: 1 }],
          bends: [{ live_index: 3 }],
        },
      ],
    };
    const before = doc.runs[0];
    const rev = ops.reverseRun(doc, 'run-1').runs[0];
    const at = (r: DesignRun, live: number) => r.polyline.points[runArcs(r).live[live]];

    // Electrodes keep their own identity: electrodes[0] is still the tube end
    // that sits at [0, 0].
    expect(rev.electrodes!.map((e) => rev.polyline.points[e.point_index]))
      .toEqual([[0, 0], [20, 20]]);
    // The blockout still covers the first three vertices of the glass, now
    // reached from the other end of the walk.
    expect(at(rev, rev.blockouts![0].start_live_index))
      .toEqual(at(before, before.blockouts![0].end_live_index));
    expect(at(rev, rev.blockouts![0].end_live_index))
      .toEqual(at(before, before.blockouts![0].start_live_index));
    expect(at(rev, rev.annotations![0].live_index))
      .toEqual(at(before, before.annotations![0].live_index));
    expect(rev.annotations![0].kind).toBe('jump');
    expect(at(rev, rev.bends![0].live_index))
      .toEqual(at(before, before.bends![0].live_index));
  });

  it('flips direction on a closed two-electrode run so the same half stays lit', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          id: 'run-1',
          polyline: { points: [[0, 0], [30, 0], [30, 30], [0, 30]], closed: true },
          electrodes: [{ point_index: 0 }, { point_index: 2 }],
          direction: 'forward',
          blockouts: [{ start_live_index: 0, end_live_index: 1 }],
          bends: [{ live_index: 1 }],
        },
      ],
    };
    const before = doc.runs[0];
    const rev = ops.reverseRun(doc, 'run-1').runs[0];
    expect(rev.direction).toBe('backward');

    const livePts = (r: DesignRun) => runArcs(r).live.map((i) => r.polyline.points[i]);
    // Same half of the loop, in the same order: the walk is anchored to
    // electrodes[0], which keeps its identity across the reversal. Without
    // the direction flip the OTHER half of the loop would light up — which is
    // the whole reason the flip is here.
    expect(livePts(rev)).toEqual(livePts(before));
    expect(livePts({ ...rev, direction: 'forward' })).not.toEqual(livePts(before));

    // And because the walk did not turn around, live-anchored children must
    // stay exactly where they were rather than being flipped to L-1-k.
    expect(rev.blockouts).toEqual(before.blockouts);
    expect(rev.bends).toEqual(before.bends);
  });

  it('leaves direction alone on an open run', () => {
    const doc = openArcRun();
    expect(ops.reverseRun(doc, 'run-1').runs[0].direction).toBeUndefined();
  });

  // THE INVARIANT — Tier 3 #87. This replaces the KNOWN-LIMITATION test PR
  // #149 left here, which pinned the opposite behaviour: that a single reverse
  // MIRRORED each arc about its chord, because a boolean "arc" could not say
  // which side the bow fell on. The schema can now say it, `reversedRun` flips
  // it with the reversal, and reversing has become what it always claimed to
  // be — a change of travel direction that does not move any glass.
  //
  // Deliberately geometric rather than field-by-field: field assertions pass
  // while the drawn shape is wrong, which is exactly how Bug #11 shipped.
  describe('reversing preserves the drawn curve exactly', () => {
    const cases: [string, DesignDoc][] = [
      ['a single open arc', {
        version: 1,
        view_box_mm: [0, 0, 20, 20],
        runs: [{
          id: 'run-1',
          polyline: { points: [[0, 0], [10, 0]], closed: false, segment_types: ['arc'] },
        }],
      }],
      ['an open run with arcs on both sides', {
        version: 1,
        view_box_mm: [0, 0, 60, 60],
        runs: [{
          id: 'run-1',
          polyline: {
            points: [[0, 0], [10, 0], [10, 10], [20, 10], [20, 20]],
            closed: false,
            segment_types: ['arc', 'line', 'arc_r', 'arc'],
          },
        }],
      }],
      ['a closed run, where the segment remap wraps', {
        version: 1,
        view_box_mm: [0, 0, 60, 60],
        runs: [{
          id: 'run-1',
          polyline: {
            points: [[0, 0], [30, 0], [30, 30], [0, 30]],
            closed: true,
            segment_types: ['arc', 'line', 'arc_r', 'arc'],
          },
        }],
      }],
      ['the open-arc fixture the rest of this block uses', openArcRun()],
      ['the closed-arc fixture the rest of this block uses', closedArcRun()],
    ];

    for (const [name, doc] of cases) {
      it(`flatRunPoints(reverse(r)) equals flatRunPoints(r) reversed — ${name}`, () => {
        const run = doc.runs[0];
        const before = flatRunPoints(run);
        const after = flatRunPoints(ops.reverseRun(doc, 'run-1').runs[0]);
        // Guard against a vacuous pass: the fixture must actually bow off its
        // own chords, or "same points" would only be saying "still straight".
        expect(before.length).toBeGreaterThan(run.polyline.points.length);
        const want = before.slice().reverse();
        if (run.polyline.closed) expectSameClosedCurve(after, want);
        else expectSamePoints(after, want);
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Bug #14 — joinRuns' reversal corrupts arcs and inverts blockout ranges.
//
// joinRuns reverses one or both inputs so the join is always conceptually
// tail-to-head. It did that with a local `reversedRun` helper that predated
// arc segments: it never moved `polyline.segment_types`, and it flipped
// blockout range endpoints without swapping them, so a reversed range came
// back running end -> start. The join half then never gave the merged run a
// `segment_types` array at all, so every arc on BOTH inputs decayed to a
// straight chord regardless of reversal.
//
// As with Bug #11, arc HANDEDNESS cannot be preserved here: `arcFor` always
// bows to the left of travel and `segment_types` cannot say otherwise, so a
// reversed arc is drawn mirrored about its (unchanged) chord. These tests pin
// WHICH chords are curved — via arcChords — not which side the bow falls on.
// The signed arc side is Tier 3 #87.
// ---------------------------------------------------------------------------

// Run A for the endpoint-combination table: an arc leaving [0,0] and a line
// up to [10,10]. head = [0,0], tail = [10,10].
function joinArcRunA(): DesignRun {
  return {
    id: 'a',
    polyline: {
      points: [[0, 0], [10, 0], [10, 10]],
      closed: false,
      segment_types: ['arc', 'line'],
    },
  };
}

// One B per endpoint combination, positioned so the two chosen endpoints
// coincide and the seam vertex is dropped. Every B carries exactly one arc.
const JOIN_COMBOS: {
  name: string;
  endpointA: 'head' | 'tail';
  endpointB: 'head' | 'tail';
  b: DesignRun;
}[] = [
  {
    name: 'tail-to-head (neither run reversed)',
    endpointA: 'tail',
    endpointB: 'head',
    b: {
      id: 'b',
      polyline: {
        points: [[10, 10], [20, 10], [30, 10]],
        closed: false,
        segment_types: ['line', 'arc'],
      },
    },
  },
  {
    name: 'tail-to-tail (B reversed)',
    endpointA: 'tail',
    endpointB: 'tail',
    b: {
      id: 'b',
      polyline: {
        points: [[30, 10], [20, 10], [10, 10]],
        closed: false,
        segment_types: ['arc', 'line'],
      },
    },
  },
  {
    name: 'head-to-head (A reversed)',
    endpointA: 'head',
    endpointB: 'head',
    b: {
      id: 'b',
      polyline: {
        points: [[0, 0], [-10, 0], [-20, 0]],
        closed: false,
        segment_types: ['line', 'arc'],
      },
    },
  },
  {
    name: 'head-to-tail (both reversed)',
    endpointA: 'head',
    endpointB: 'tail',
    b: {
      id: 'b',
      polyline: {
        points: [[-20, 0], [-10, 0], [0, 0]],
        closed: false,
        segment_types: ['arc', 'line'],
      },
    },
  },
];

function joinDoc(b: DesignRun): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 60, 60],
    runs: [joinArcRunA(), b],
  };
}

describe('joinRuns and arc segments (Bug #14)', () => {
  for (const combo of JOIN_COMBOS) {
    it(`keeps both arcs on their own chords — ${combo.name}`, () => {
      const doc = joinDoc(combo.b);
      const next = ops.joinRuns(doc, 'a', combo.endpointA, 'b', combo.endpointB);
      expect(next.runs.length).toBe(1);
      const joined = next.runs[0];
      // Seam vertex dropped: 3 + 3 - 1.
      expect(joined.polyline.points.length).toBe(5);
      // The Go decoder rejects a segment_types array that is not exactly
      // SegmentCount long, so a short or absent array is a 400 on save.
      expect(joined.polyline.segment_types?.length).toBe(4);
      // Both input arcs are still curved, and on the same unordered chords.
      expect(arcChords(joined)).toEqual(
        [...arcChords(doc.runs[0]), ...arcChords(combo.b)].sort(),
      );
    });

    // Tier 3 #87 — the stronger claim the signed side makes possible. Bug #14
    // could only pin WHICH chords were curved, because a reversed input had
    // its bows mirrored and there was no way to say otherwise. Now the drawn
    // glass itself has to survive, for every endpoint combination.
    it(`keeps every bow on the side it was drawn — ${combo.name}`, () => {
      const doc = joinDoc(combo.b);
      const joined = ops.joinRuns(doc, 'a', combo.endpointA, 'b', combo.endpointB).runs[0];
      const drawn = flatRunPoints(joined);
      // Every sample of each input's own curve must appear in the joined
      // curve. Order and direction are the join's business; position is not.
      for (const input of [doc.runs[0], combo.b]) {
        for (const p of flatRunPoints(input)) {
          expect(
            drawn.some((q) => nearPt(q, p)),
            `${combo.name}: sample [${p}] from run ${input.id} is not on the joined curve`,
          ).toBe(true);
        }
      }
      // Teeth: these fixtures really do bow, so the check is not vacuous.
      expect(drawn.length).toBeGreaterThan(joined.polyline.points.length + 20);
    });
  }

  it('a tail-to-head join is exactly the two flattened shapes concatenated', () => {
    // No reversal here, so the bow limitation does not apply and the true
    // geometric invariant holds: the drawn curve must not move at all.
    const combo = JOIN_COMBOS[0];
    const doc = joinDoc(combo.b);
    const flatA = flatRunPoints(doc.runs[0]);
    const flatB = flatRunPoints(combo.b);
    const joined = ops.joinRuns(doc, 'a', 'tail', 'b', 'head').runs[0];
    expectSamePoints(flatRunPoints(joined), [...flatA, ...flatB.slice(1)]);
  });

  it('a blockout on the reversed run comes back forward-running, not inverted', () => {
    const b = JOIN_COMBOS[1].b; // [[30,10],[20,10],[10,10]], joined at its tail
    const doc = joinDoc({
      ...b,
      // Live index == polyline index on an open run with no electrodes.
      // Live 0..1 is the physical stretch [30,10] -> [20,10].
      blockouts: [{ start_live_index: 0, end_live_index: 1 }],
    });
    const joined = ops.joinRuns(doc, 'a', 'tail', 'b', 'tail').runs[0];
    const bo = joined.blockouts![0];
    expect(bo.start_live_index).toBeLessThan(bo.end_live_index);
    // Same physical glass: [20,10] through [30,10].
    const pts = joined.polyline.points;
    expect(pts[bo.start_live_index]).toEqual([20, 10]);
    expect(pts[bo.end_live_index]).toEqual([30, 10]);
    // And the real consumer paints both of them, not just one end.
    const live = runArcs(joined);
    const painted = blockoutSegments(live.live, joined.blockouts, live.liveClosed)
      .filter((s) => s.isBlockout)
      .flatMap((s) => s.liveIndices.map((i) => joined.polyline.points[i]));
    expect(painted).toEqual(expect.arrayContaining([[20, 10], [30, 10]]));
  });

  it('electrodes, annotations and bends on the reversed run keep their points', () => {
    const b = JOIN_COMBOS[1].b; // [[30,10],[20,10],[10,10]]
    const doc = joinDoc({
      ...b,
      electrodes: [{ point_index: 0 }], // physical [30,10]
      annotations: [{ kind: 'support', live_index: 2 }], // physical [10,10]
      bends: [{ live_index: 1 }], // physical [20,10]
    });
    const joined = ops.joinRuns(doc, 'a', 'tail', 'b', 'tail').runs[0];
    const pts = joined.polyline.points;
    expect(pts[joined.electrodes![0].point_index]).toEqual([30, 10]);
    expect(pts[joined.annotations![0].live_index]).toEqual([10, 10]);
    expect(pts[joined.bends![0].live_index]).toEqual([20, 10]);
  });

  it('self-join closes the loop and grows segment_types for the new closing segment', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        {
          id: 'a',
          polyline: {
            points: [[0, 0], [10, 0], [10, 10], [0, 10]],
            closed: false,
            segment_types: ['arc', 'line', 'line'],
          },
        },
      ],
    };
    const joined = ops.joinRuns(doc, 'a', 'head', 'a', 'tail').runs[0];
    expect(joined.polyline.closed).toBe(true);
    // A closed run has one segment per vertex — the array has to grow with it
    // or the document no longer decodes.
    expect(joined.polyline.segment_types).toEqual(['arc', 'line', 'line', 'line']);
    expect(arcChords(joined)).toEqual(arcChords(doc.runs[0]));
  });

  it('a line-only join is unchanged and does not grow a segment_types array', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 10, 10],
      runs: [
        { id: 'a', polyline: { points: [[0, 0], [1, 0], [2, 0]], closed: false } },
        { id: 'b', polyline: { points: [[4, 0], [3, 0], [2, 0]], closed: false } },
      ],
    };
    const joined = ops.joinRuns(doc, 'a', 'tail', 'b', 'tail').runs[0];
    expect(joined.polyline.points).toEqual([[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]]);
    expect(joined.polyline.segment_types).toBeUndefined();
  });

  it('a bridged join (endpoints do not coincide) marks the new gap segment a line', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 60, 60],
      runs: [
        joinArcRunA(),
        {
          id: 'b',
          polyline: {
            points: [[40, 40], [50, 40], [50, 50]],
            closed: false,
            segment_types: ['arc', 'line'],
          },
        },
      ],
    };
    const joined = ops.joinRuns(doc, 'a', 'tail', 'b', 'head').runs[0];
    expect(joined.polyline.points.length).toBe(6);
    // a:[arc,line] + bridge:line + b:[arc,line]
    expect(joined.polyline.segment_types).toEqual(['arc', 'line', 'line', 'arc', 'line']);
  });
});

// ---------------------------------------------------------------------------
// Bug #16 — Neonize offsets an arc run's CHORDS, not its curve.
//
// `neonize` fed `src.polyline.points` straight to the offset primitives at all
// four call sites and never consulted `polyline.segment_types`. An arc's
// sagitta is a quarter of its chord (ARC_BULGE 0.5), so a 200 mm arc put the
// generated parallel path 50 mm off the glass — a clean parallel outline of a
// shape nobody drew.
//
// The regression that would hurt most is the line-only one: three shipped
// parity rows (NW #131 Neonize, #141 Parallel Tube Layout, #123 Auto Tube
// Layout) rest on this operation, so a line-only run has to come out
// byte-identical to what it did before the fix. That test is first on purpose.
// ---------------------------------------------------------------------------
describe('neonize and arc segments (Bug #16)', () => {
  // Minimum distance from p to the polyline through pts (segments, not
  // vertices — a vertex-only measure calls a point beside a long straight
  // "far away" when it is sitting right on the glass).
  function distToPath(p: [number, number], pts: [number, number][], closed = false): number {
    let best = Infinity;
    const n = pts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const abx = b[0] - a[0];
      const aby = b[1] - a[1];
      const len2 = abx * abx + aby * aby;
      let t = len2 > 0 ? ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
      if (d < best) best = d;
    }
    return best;
  }

  // Densely resample an emitted offset path so the check covers the whole
  // path, not just its vertices. Pre-fix the offset of a 2-vertex arc run IS
  // its two endpoints, and both of those sit at exactly spacing/2 from the
  // curve — a vertex-only assertion passes on the broken code.
  function densify(pts: [number, number][], closed = false): [number, number][] {
    const out: [number, number][] = [];
    const n = pts.length;
    const last = closed ? n : n - 1;
    for (let i = 0; i < last; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % n];
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 2));
      for (let k = 0; k < steps; k++) {
        out.push([a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps]);
      }
    }
    out.push(pts[n - 1]);
    return out;
  }

  function arcRunDoc(
    points: [number, number][],
    segment_types: ('line' | 'arc' | 'arc_r')[],
    closed = false,
  ): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 400, 400],
      runs: [{
        id: 'a',
        polyline: { points, closed, segment_types },
        tube_diameter_mm: 12,
      }],
    };
  }

  // ---- THE REGRESSION PIN. Written and run first, on purpose. -------------
  it('a line-only OPEN run neonizes byte-identically to the pre-fix output', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 200, 200],
      runs: [{
        id: 'zig',
        polyline: {
          points: [[0, 0], [40, 0], [40, 30], [90, 30], [90, 90]],
          closed: false,
        },
        tube_diameter_mm: 12,
      }],
    };
    const { doc: out } = ops.neonize(doc, 'zig', 20);
    // Captured from the pre-fix implementation. flatRunPoints returns the
    // ORIGINAL array when a run has no arcs, so the flatten must be a no-op
    // here — down to the last digit.
    expect(out.runs[0].polyline.points).toEqual([[0, -10], [50, -10], [50, 20], [100, 20], [100, 90]]);
    expect(out.runs[1].polyline.points).toEqual([[0, 10], [30, 10], [30, 40], [80, 40], [80, 90]]);
  });

  it('a line-only run with an explicit all-line segment_types is also unchanged', () => {
    const withTypes = arcRunDoc(
      [[0, 0], [40, 0], [40, 30], [90, 30], [90, 90]],
      ['line', 'line', 'line', 'line'],
    );
    const { doc: out } = ops.neonize(withTypes, 'a', 20);
    expect(out.runs[0].polyline.points).toEqual([[0, -10], [50, -10], [50, 20], [100, 20], [100, 90]]);
    expect(out.runs[1].polyline.points).toEqual([[0, 10], [30, 10], [30, 40], [80, 40], [80, 90]]);
  });

  it('a line-only CLOSED square is unchanged (outer 120x120, inner 80x80)', () => {
    const sq = arcRunDoc([[0, 0], [100, 0], [100, 100], [0, 100]], ['line', 'line', 'line', 'line'], true);
    const { doc: out } = ops.neonize(sq, 'a', 20);
    const xs = out.runs[0].polyline.points.map((p) => p[0]);
    const ys = out.runs[0].polyline.points.map((p) => p[1]);
    expect(Math.min(...xs)).toBeCloseTo(-10, 6);
    expect(Math.max(...xs)).toBeCloseTo(110, 6);
    expect(Math.min(...ys)).toBeCloseTo(-10, 6);
    expect(Math.max(...ys)).toBeCloseTo(110, 6);
  });

  // ---- THE INVARIANT ------------------------------------------------------
  it('every point of both offsets sits spacing/2 from the TRUE CURVE, not the chord', () => {
    // One 200 mm arc. Bulge 0.5 puts its apex 50 mm off the chord, so the
    // pre-fix offset (a straight line 10 mm off the chord) misses the glass
    // by tens of mm at mid-span — and reports ~100 mm here, because the
    // nearest point on the real curve is then an endpoint.
    const doc = arcRunDoc([[0, 0], [200, 0]], ['arc']);
    const truth = flatRunPoints(doc.runs[0]);
    const { doc: out } = ops.neonize(doc, 'a', 20);
    for (const run of [out.runs[0], out.runs[1]]) {
      for (const p of densify(run.polyline.points)) {
        const d = distToPath(p, truth);
        expect(d).toBeGreaterThan(10 - 0.3);
        expect(d).toBeLessThan(10 + 0.3);
      }
    }
  });

  it('the offsets follow the bow: an arc run yields curved paths, not two-point chords', () => {
    const { doc: out } = ops.neonize(arcRunDoc([[0, 0], [200, 0]], ['arc']), 'a', 20);
    // Pre-fix both offsets were exactly 2 points — the chord's endpoints.
    expect(out.runs[0].polyline.points.length).toBeGreaterThan(10);
    expect(out.runs[1].polyline.points.length).toBeGreaterThan(10);
    // 'arc' bows to the LEFT of travel: (dx,dy)=(200,0) → normal (0,1), so the
    // apex is at (100, +50) and the offset pair straddles it at 40 and 60.
    // Pre-fix, offsetting the chord put the whole pair between -10 and +10.
    const ys = [...out.runs[0].polyline.points, ...out.runs[1].polyline.points].map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(60, 1);
    // The butt caps are normal to the CURVE's tangent at the endpoints, and an
    // arc leaves its chord at half the included angle (53.13°), so the ends
    // tilt below y=0 rather than sitting on it. -10*cos(53.13°) = -6, plus the
    // half-sample rotation the flattened first segment introduces.
    expect(Math.min(...ys)).toBeGreaterThan(-7);
    expect(Math.min(...ys)).toBeLessThan(-5);
  });

  it('an arc_r run offsets to the other side (the flipped bow is honoured)', () => {
    const doc = arcRunDoc([[0, 0], [200, 0]], ['arc_r']);
    const truth = flatRunPoints(doc.runs[0]);
    const { doc: out } = ops.neonize(doc, 'a', 20);
    const ys = [...out.runs[0].polyline.points, ...out.runs[1].polyline.points].map((p) => p[1]);
    // Exact mirror of the 'arc' case: apex at (100, -50), offsets at -40/-60.
    expect(Math.min(...ys)).toBeCloseTo(-60, 1);
    expect(Math.max(...ys)).toBeLessThan(7);
    expect(Math.max(...ys)).toBeGreaterThan(5);
    for (const run of [out.runs[0], out.runs[1]]) {
      for (const p of densify(run.polyline.points)) {
        const d = distToPath(p, truth);
        expect(d).toBeGreaterThan(10 - 0.3);
        expect(d).toBeLessThan(10 + 0.3);
      }
    }
  });

  it('a CLOSED run with arc sides yields inner and outer paths that never cross the source', () => {
    // Even-odd point-in-polygon against the FLATTENED source. "Does not
    // cross" is the containment statement: every outer-offset point outside
    // the puffy source, every inner-offset point inside it. Measuring a
    // distance instead would trip on the legitimate miter clamping at the
    // four sharp corners where two bows meet.
    function inside(p: [number, number], poly: [number, number][]): boolean {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i];
        const [xj, yj] = poly[j];
        if ((yi > p[1]) !== (yj > p[1])
          && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    }
    // arc_r bows to the RIGHT of travel, which on this vertex order is
    // outward — a puffy square, 50 mm of sagitta per 200 mm side. (Plain
    // 'arc' would bow all four sides inward until opposite bows touch.)
    const doc = arcRunDoc(
      [[0, 0], [200, 0], [200, 200], [0, 200]],
      ['arc_r', 'arc_r', 'arc_r', 'arc_r'],
      true,
    );
    const truth = flatRunPoints(doc.runs[0]);
    const { doc: out } = ops.neonize(doc, 'a', 20);
    const [outerRun, innerRun] = [out.runs[0], out.runs[1]];
    expect(outerRun.polyline.closed).toBe(true);
    expect(innerRun.polyline.closed).toBe(true);
    for (const p of densify(outerRun.polyline.points, true)) {
      expect(inside(p, truth)).toBe(false);
    }
    for (const p of densify(innerRun.polyline.points, true)) {
      expect(inside(p, truth)).toBe(true);
    }
    // Negative control: the pre-fix behaviour offset the CHORDS, i.e. the
    // plain 200×200 square. Its +10 expansion is [-10,210]², which lies
    // inside the puffy source along every side — so the old output failed
    // the containment above rather than passing it vacuously.
    expect(inside([-5, 100], truth)).toBe(true);
  });

  it('flattening density keeps the OFFSET within a sane chord error without exploding the vertex count', () => {
    // Eight arc segments — a stand-in for a curve-heavy OpenType glyph.
    const pts: [number, number][] = [];
    const types: ('line' | 'arc' | 'arc_r')[] = [];
    for (let i = 0; i <= 8; i++) {
      pts.push([i * 50, 0]);
      if (i < 8) types.push('arc');
    }
    const { doc: out } = ops.neonize(arcRunDoc(pts, types), 'a', 20);
    const n = out.runs[0].polyline.points.length;
    // arcGeom samples an arc every 5 degrees over its ~106.26 degree sweep =
    // 22 points per segment. Eight arcs is ~176 — bounded, not exponential.
    expect(n).toBeGreaterThan(100);
    expect(n).toBeLessThan(260);

    // Chord error of the emitted offset against the true offset circle, on a
    // SINGLE arc — a junction between two arcs turns the path by the full
    // included angle (106.26°) and its miter spike is not a flattening error.
    // Chord 200 → radius 125 about (100, -75); the two offsets ride
    // concentric at 135 and 115. Measure each sampled SEGMENT's midpoint:
    // the sagitta of the flattening is r*(1-cos(step/2)) ≈ 0.12 mm at 135 mm
    // with arcGeom's 5° step. That is 0.06% of the arc — fine for a bender,
    // and it does not grow with the vertex count.
    const single = ops.neonize(arcRunDoc([[0, 0], [200, 0]], ['arc']), 'a', 20).doc;
    const r = 125;
    const cx = 100;
    const cy = -75;
    let maxErr = 0;
    let measured = 0;
    for (const run of [single.runs[0], single.runs[1]]) {
      const p = run.polyline.points;
      // Skip the first and last emitted segment: those carry the butt caps,
      // which sit off the ring by construction.
      for (let i = 1; i < p.length - 2; i++) {
        const mx = (p[i][0] + p[i + 1][0]) / 2;
        const my = (p[i][1] + p[i + 1][1]) / 2;
        // |ring - r| is 10 on both sides; the residual is the chord error.
        maxErr = Math.max(maxErr, Math.abs(Math.abs(Math.hypot(mx - cx, my - cy) - r) - 10));
        measured++;
      }
    }
    expect(measured).toBeGreaterThan(20); // the sample actually found segments
    expect(maxErr).toBeLessThan(0.2);
  });

  it('the stitched variant is built from the flattened curve too', () => {
    const doc = arcRunDoc([[0, 0], [200, 0]], ['arc']);
    const truth = flatRunPoints(doc.runs[0]);
    const { doc: out } = ops.neonize(doc, 'a', 20, { stitch: true });
    expect(out.runs.length).toBe(1);
    const stitched = out.runs[0].polyline.points;
    expect(stitched.length).toBeGreaterThan(20);
    // The hairpins at each end sit outside the spacing band by design, so
    // check the body of each parallel leg rather than every vertex.
    const onBand = stitched.filter((p) => {
      const d = distToPath(p, truth);
      return d > 10 - 0.3 && d < 10 + 0.3;
    });
    expect(onBand.length).toBeGreaterThan(stitched.length / 2);
  });

  it('the emitted runs carry NO segment_types — the offset of an arc is not representable', () => {
    // An offset circular arc IS a circular arc of a different radius, but
    // segment_types can only express the one fixed bulge implied by a chord.
    // So the offset ships flattened, and must not claim otherwise: a stale
    // array here is exactly the wrong-length blob the Go decoder 400s on.
    const { doc: out } = ops.neonize(arcRunDoc([[0, 0], [200, 0]], ['arc']), 'a', 20);
    expect(out.runs[0].polyline.segment_types).toBeUndefined();
    expect(out.runs[1].polyline.segment_types).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Bug #15 — joinRuns dropped the merged run's classification fields.
//
// The merged run was built from an allow-list of three fields (diameter,
// color, notes) under a comment that read as if it were complete. The five
// missing ones — is_channel_letter_face, channel_letter_depth_mm, raceway_id,
// group_id, kind — are the ones that drive the PDF strip pages, the raceway
// grouping, the layer membership and the 3D render. Joining the two halves of
// a channel-letter face silently stopped emitting its return-strip page: the
// same loss PR #140 fixed for splitRun, arrived at from the other direction.
// ---------------------------------------------------------------------------
describe('joinRuns carries classification (Bug #15)', () => {
  function run(id: string, pts: [number, number][], extra: Partial<DesignRun> = {}): DesignRun {
    return { id, polyline: { points: pts, closed: false }, ...extra };
  }
  function pair(a: Partial<DesignRun>, b: Partial<DesignRun> = {}): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        run('a', [[0, 0], [10, 0], [20, 0]], a),
        run('b', [[20, 0], [30, 0], [40, 0]], b),
      ],
    };
  }
  const join = (doc: DesignDoc) => ops.joinRuns(doc, 'a', 'tail', 'b', 'head').runs[0];

  it('two channel-letter faces merge into a face and keep the depth override', () => {
    const joined = join(pair(
      { is_channel_letter_face: true, channel_letter_depth_mm: 90 },
      { is_channel_letter_face: true, channel_letter_depth_mm: 90 },
    ));
    expect(joined.is_channel_letter_face).toBe(true);
    expect(joined.channel_letter_depth_mm).toBe(90);
  });

  it('a face joined to a NON-face is still a face (the either-side rule)', () => {
    // Losing the strip page is the expensive error, so the flag survives from
    // whichever side has it — including when that side is runB.
    expect(join(pair({ is_channel_letter_face: true }, {})).is_channel_letter_face).toBe(true);
    expect(join(pair({}, { is_channel_letter_face: true })).is_channel_letter_face).toBe(true);
  });

  it('channel_letter_depth_mm comes from B when A has none', () => {
    const joined = join(pair({ is_channel_letter_face: true }, { channel_letter_depth_mm: 75 }));
    expect(joined.channel_letter_depth_mm).toBe(75);
  });

  it('a channel_letter_depth_mm disagreement takes A and warns rather than silently picking', () => {
    const warned: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
      warned.push(String(m));
    });
    const joined = join(pair({ channel_letter_depth_mm: 90 }, { channel_letter_depth_mm: 120 }));
    spy.mockRestore();
    expect(joined.channel_letter_depth_mm).toBe(90);
    expect(warned.join(' ')).toMatch(/depth/i);
  });

  it('raceway_id and group_id survive from A, and from B when A has none', () => {
    expect(join(pair({ raceway_id: 'gl1' }, {})).raceway_id).toBe('gl1');
    expect(join(pair({}, { raceway_id: 'gl1' })).raceway_id).toBe('gl1');
    expect(join(pair({ raceway_id: 'gl1' }, { raceway_id: 'gl2' })).raceway_id).toBe('gl1');
    expect(join(pair({ group_id: 'g1' }, {})).group_id).toBe('g1');
    expect(join(pair({}, { group_id: 'g2' })).group_id).toBe('g2');
    expect(join(pair({ group_id: 'g1' }, { group_id: 'g2' })).group_id).toBe('g1');
  });

  it('jumper + jumper stays a jumper', () => {
    expect(join(pair({ kind: 'jumper' }, { kind: 'jumper' })).kind).toBe('jumper');
  });

  it('jumper + live tube is a LIVE TUBE, not a jumper', () => {
    // The counter-intuitive one, and the only field where "inherit runA's"
    // would be actively wrong. A jumper is glass-sleeved lead wire; welding it
    // to live glass makes the union live, so the result must not claim to be
    // dark. Inheriting A would have made the A-first case a jumper.
    //
    // Note this assertion also passed on the BROKEN code, which dropped `kind`
    // outright — it is only meaningful paired with the jumper+jumper case
    // above, which failed. Bug class 7: an assertion that cannot fail is not
    // a test.
    expect(join(pair({ kind: 'jumper' }, {})).kind ?? '').toBe('');
    expect(join(pair({}, { kind: 'jumper' })).kind ?? '').toBe('');
    expect(join(pair({ kind: 'jumper' }, { kind: '' })).kind ?? '').toBe('');
  });

  it('joining two plain runs is unchanged — no classification keys appear', () => {
    const joined = join(pair({}, {}));
    expect('is_channel_letter_face' in joined).toBe(false);
    expect('channel_letter_depth_mm' in joined).toBe(false);
    expect('raceway_id' in joined).toBe(false);
    expect('group_id' in joined).toBe(false);
    expect('kind' in joined).toBe(false);
    expect(joined.polyline.points).toEqual([[0, 0], [10, 0], [20, 0], [30, 0], [40, 0]]);
  });

  it('classification survives every endpoint combination, not just tail-to-head', () => {
    // head/tail combinations route through reversedRun first; the carry has to
    // happen after that, on the reversed copies, or the reversal loses it.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [
        run('a', [[0, 0], [10, 0], [20, 0]], { is_channel_letter_face: true, raceway_id: 'gl1' }),
        run('b', [[40, 0], [30, 0], [20, 0]], { group_id: 'g1' }),
      ],
    };
    for (const [ea, eb] of [['tail', 'tail'], ['head', 'head'], ['head', 'tail']] as const) {
      const merged = ops.joinRuns(doc, 'a', ea, 'b', eb).runs[0];
      expect(merged.is_channel_letter_face).toBe(true);
      expect(merged.raceway_id).toBe('gl1');
      expect(merged.group_id).toBe('g1');
    }
  });

  it('a self-join (closing a run into a loop) keeps everything it already had', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [run('a', [[0, 0], [10, 0], [10, 10], [0, 10]], {
        is_channel_letter_face: true,
        channel_letter_depth_mm: 90,
        raceway_id: 'gl1',
        group_id: 'g1',
        kind: 'jumper',
      })],
    };
    const closed = ops.joinRuns(doc, 'a', 'head', 'a', 'tail').runs[0];
    expect(closed.polyline.closed).toBe(true);
    expect(closed.is_channel_letter_face).toBe(true);
    expect(closed.channel_letter_depth_mm).toBe(90);
    expect(closed.raceway_id).toBe('gl1');
    expect(closed.group_id).toBe('g1');
    expect(closed.kind).toBe('jumper');
  });

  it('splitRun still carries the same five fields (the shared helper did not regress PR #140)', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [run('a', [[0, 0], [10, 0], [20, 0], [30, 0]], {
        is_channel_letter_face: true,
        channel_letter_depth_mm: 90,
        raceway_id: 'gl1',
        group_id: 'g1',
        kind: 'jumper',
      })],
    };
    const halves = ops.splitRun(doc, 'a', 2).runs;
    expect(halves.length).toBe(2);
    for (const h of halves) {
      expect(h.is_channel_letter_face).toBe(true);
      expect(h.channel_letter_depth_mm).toBe(90);
      expect(h.raceway_id).toBe('gl1');
      expect(h.group_id).toBe('g1');
      expect(h.kind).toBe('jumper');
      // `direction` is deliberately NOT carried — it means something only on
      // a closed run with two electrodes, and both halves are open.
      expect('direction' in h).toBe(false);
    }
  });

  it('splitting a plain run still produces no classification keys', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [run('a', [[0, 0], [10, 0], [20, 0], [30, 0]])],
    };
    for (const h of ops.splitRun(doc, 'a', 2).runs) {
      expect('is_channel_letter_face' in h).toBe(false);
      expect('raceway_id' in h).toBe(false);
      expect('group_id' in h).toBe(false);
      expect('kind' in h).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 3 #110 — what NEONIZE's output inherits.
//
// The fifth instance of CLAUDE.md bug class 1, and the first one where "carry
// everything" is the wrong fix. splitRun and joinRuns produce a run of the same
// nature as their input, so a dropped field there is pure loss. neonize is not
// that op: it consumes a channel-letter face OUTLINE and emits the TUBE PATHS
// that light it, replacing the source. The output is a different kind of object
// from the input, so each field gets its own answer (see CARRY_NEONIZED in
// docOps.ts):
//
//   is_channel_letter_face  NO — tubes are glass, not sheet metal
//   channel_letter_depth_mm NO — describes how far the FACE projects
//   raceway_id              YES — the glass really does land in that box
//   group_id                YES — the offsets are the same logical letter
//   kind                    YES — a neonized jumper stays a jumper
//   direction               NO  — the emitted path is not the source's walk
//
// The face flag is the expensive one and it goes BOTH ways. Dropping it is what
// broke splitRun in PR #140 (no strip page for metal that IS being cut);
// carrying it here would emit a return-strip page for metal that is NOT being
// cut — the fabricator gets a drawing for a part that does not exist. Both
// strip-page paths in internal/printpdf/render.go gate on IsChannelLetterFace
// (the per-run loop directly, the shared-raceway one through groupByRaceway),
// so "no run in the output carries the flag" is the same condition as "the PDF
// grows no strip pages".
// ---------------------------------------------------------------------------
describe('neonize classification carry (Tier 3 #110)', () => {
  // A channel-letter face outline with every classification field set.
  // `kind: 'jumper'` on a face is contrived — no shop draws a face as a jumper
  // — but it is the only way to watch `kind` carry at all, and the two fields
  // are independent.
  function faceDoc(extra: Partial<DesignRun> = {}): DesignDoc {
    return {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [{
        id: 'face',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][],
          closed: true,
        },
        tube_diameter_mm: 12,
        is_channel_letter_face: true,
        channel_letter_depth_mm: 90,
        raceway_id: 'gl1',
        group_id: 'g1',
        kind: 'jumper',
        ...extra,
      }],
    };
  }
  const emitted = (doc: DesignDoc) => doc.runs.filter((r) => r.id !== 'face');

  it('the fixture really is fully classified (guards the negatives below)', () => {
    // Bug class 7 defence: every "did NOT carry" assertion in this block is
    // vacuous if the source never had the field. Pin the fixture once.
    const src = faceDoc().runs[0];
    expect(src.is_channel_letter_face).toBe(true);
    expect(src.channel_letter_depth_mm).toBe(90);
    expect(src.raceway_id).toBe('gl1');
    expect(src.group_id).toBe('g1');
    expect(src.kind).toBe('jumper');
  });

  it('the emitted tubes are NOT faces — no strip page for metal nobody is cutting', () => {
    const out = ops.neonize(faceDoc(), 'face', 20).doc;
    expect(out.runs.length).toBe(2);
    expect(out.runs.find((r) => r.id === 'face')).toBeUndefined();
    for (const r of out.runs) {
      expect('is_channel_letter_face' in r).toBe(false);
      expect('channel_letter_depth_mm' in r).toBe(false);
    }

    // NEGATIVE CONTROL. Those two assertions also pass on a neonize that
    // carries nothing at all, which is what shipped before this change — so on
    // their own they say nothing about whether the decision is expressed in the
    // code or merely absent from it. Run the SAME source through splitRun,
    // which shares the helper and whose answer is the opposite: route neonize
    // through splitRun's field set and the loop above fails; gut the helper to
    // make that pass and this half fails.
    for (const h of ops.splitRun(faceDoc(), 'face', 2).runs) {
      expect(h.is_channel_letter_face).toBe(true);
      expect(h.channel_letter_depth_mm).toBe(90);
    }
  });

  it('raceway_id, group_id and kind survive onto BOTH offsets', () => {
    const out = ops.neonize(faceDoc(), 'face', 20).doc;
    const runs = emitted(out);
    expect(runs.map((r) => r.id).sort()).toEqual(['face-inner', 'face-outer']);
    for (const r of runs) {
      // The tubes terminate at the same raceway the face did, and the box is
      // sized to reach every tagged run whether or not it is a face.
      expect(r.raceway_id).toBe('gl1');
      // The offsets are the same logical letter — and neonize REPLACES the
      // source, so dropping this leaves the group a member down.
      expect(r.group_id).toBe('g1');
      expect(r.kind).toBe('jumper');
    }
  });

  it('the stitched variant inherits the same set', () => {
    // One continuous run instead of two, same inheritance question.
    const out = ops.neonize(faceDoc(), 'face', 20, { stitch: true }).doc;
    const runs = emitted(out);
    expect(runs.map((r) => r.id)).toEqual(['face-stitched']);
    const r = runs[0];
    expect(r.raceway_id).toBe('gl1');
    expect(r.group_id).toBe('g1');
    expect(r.kind).toBe('jumper');
    expect('is_channel_letter_face' in r).toBe(false);
    expect('channel_letter_depth_mm' in r).toBe(false);
  });

  it('an open source neonizes with the same inheritance as a closed one', () => {
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [{
        id: 'face',
        polyline: { points: [[0, 0], [50, 0], [100, 0]] as [number, number][], closed: false },
        is_channel_letter_face: true,
        raceway_id: 'gl1',
        group_id: 'g1',
      }],
    };
    for (const r of emitted(ops.neonize(doc, 'face', 10).doc)) {
      expect(r.raceway_id).toBe('gl1');
      expect(r.group_id).toBe('g1');
      expect('is_channel_letter_face' in r).toBe(false);
    }
  });

  it('direction never carries, even though the memberships do', () => {
    // `direction` means something only on a closed run with two electrodes, and
    // the offsets are not the walk the source described. Asserted alongside a
    // field that DOES carry, so the absence is a decision the code made rather
    // than a carry that never ran.
    const out = ops.neonize(faceDoc({ direction: 'forward' }), 'face', 20).doc;
    for (const r of emitted(out)) {
      expect('direction' in r).toBe(false);
      expect(r.raceway_id).toBe('gl1');
    }
  });

  it('an unclassified source emits exactly the keys it always did', () => {
    // DisallowUnknownFields is unforgiving, and so is the round trip: a key
    // holding `undefined` disappears through JSON.stringify, so the object the
    // editor holds would stop matching the doc the server stores. toStrictEqual
    // is what catches that; toEqual would not.
    const doc: DesignDoc = {
      version: 1,
      view_box_mm: [0, 0, 100, 100],
      runs: [{
        id: 'plain',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 100]] as [number, number][],
          closed: true,
        },
        tube_diameter_mm: 12,
        color: 'classic-red',
        notes: '15kV @ 60mA',
      }],
    };
    for (const r of ops.neonize(doc, 'plain', 20).doc.runs) {
      expect(Object.keys(r).sort())
        .toEqual(['color', 'id', 'notes', 'polyline', 'tube_diameter_mm']);
      expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r);
    }
    // And the stitched shape, which builds its run through the same helper.
    for (const r of ops.neonize(doc, 'plain', 20, { stitch: true }).doc.runs) {
      expect(Object.keys(r).sort())
        .toEqual(['color', 'id', 'notes', 'polyline', 'tube_diameter_mm']);
      expect(JSON.parse(JSON.stringify(r))).toStrictEqual(r);
    }
  });

  it('an empty-string kind stays empty rather than becoming a jumper', () => {
    const out = ops.neonize(faceDoc({ kind: '' }), 'face', 20).doc;
    for (const r of emitted(out)) expect(r.kind ?? '').toBe('');
  });
});

// ---------------------------------------------------------------------------
// Bug #16's neighbour audit — the ops next door that also assume raw points.
//
// Both of these change a run's VERTEX COUNT and left `polyline.segment_types`
// exactly as they found it. The array is then the wrong length, which is not
// a cosmetic drift: internal/designdoc/types.go's UnmarshalJSON enforces
// len(SegmentTypes) == segmentCount at the door, so the next save of that doc
// is a 400 and the operator loses the edit with no idea why. Every arc after
// the touch point also lands on the wrong segment in the meantime.
// ---------------------------------------------------------------------------
describe('segment_types survives vertex-count changes (Bug #16 neighbour audit)', () => {
  describe('simplifyRun', () => {
    // A long straight with redundant collinear vertices, then one arc. RDP
    // measures deviation from the CHORD, so it cannot see an arc's bow at all
    // — it would drop the vertex defining a 50 mm sagitta as "straight".
    function doc(): DesignDoc {
      return {
        version: 1,
        view_box_mm: [0, 0, 400, 400],
        runs: [{
          id: 'a',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [240, 0]],
            closed: false,
            segment_types: ['line', 'line', 'line', 'line', 'arc'],
          },
        }],
      };
    }

    it('leaves a well-formed segment_types array after dropping vertices', () => {
      const out = ops.simplifyRun(doc(), 'a', 1).runs[0];
      // The collinear middles collapse, so something was actually dropped.
      expect(out.polyline.points.length).toBeLessThan(6);
      expectWellFormedRun(out);
    });

    it('keeps the arc: the drawn shape is unchanged where the curve lives', () => {
      const out = ops.simplifyRun(doc(), 'a', 1).runs[0];
      // Both ends of the arc segment survive, and it is still an arc.
      expect(out.polyline.points).toContainEqual([40, 0]);
      expect(out.polyline.points).toContainEqual([240, 0]);
      const last = out.polyline.points.length - 2;
      expect(isArcKind(segmentTypeAt(out, last))).toBe(true);
      // The geometric invariant: the apex of the bow is still 50 mm off the
      // chord. Measured through flatRunPoints, not raw vertices.
      const ys = flatRunPoints(out).map((p) => p[1]);
      expect(Math.max(...ys)).toBeCloseTo(50, 6);
    });

    it('a line-only run simplifies exactly as before', () => {
      const plain: DesignDoc = {
        version: 1,
        view_box_mm: [0, 0, 100, 100],
        runs: [{
          id: 'a',
          polyline: {
            points: [[0, 0], [10, 0], [20, 0], [30, 0], [40, 0], [40, 40]],
            closed: false,
          },
        }],
      };
      const out = ops.simplifyRun(plain, 'a', 1).runs[0];
      expect(out.polyline.points).toEqual([[0, 0], [40, 0], [40, 40]]);
      expect(out.polyline.segment_types).toBeUndefined();
    });
  });

  describe('insertDoubleback', () => {
    function doc(types: ('line' | 'arc' | 'arc_r')[]): DesignDoc {
      return {
        version: 1,
        view_box_mm: [0, 0, 400, 400],
        runs: [{
          id: 'a',
          polyline: {
            points: [[0, 0], [100, 0], [200, 0]],
            closed: false,
            segment_types: types,
          },
          tube_diameter_mm: 10,
        }],
      };
    }

    it('splices four line entries into segment_types for the four new vertices', () => {
      const out = ops.insertDoubleback(doc(['line', 'arc']), 'a', 0, 0.5).runs[0];
      expect(out.polyline.points.length).toBe(7);
      expectWellFormedRun(out);
      // The arc was on segment 1 and must still be, four vertices later.
      expect(out.polyline.segment_types)
        .toEqual(['line', 'line', 'line', 'line', 'line', 'arc']);
    });

    it('refuses to hairpin an ARC segment rather than placing the U on its chord', () => {
      // The hairpin is built by interpolating p1 -> p2 linearly, so on an arc
      // it would land on the chord — up to a quarter of the chord off the
      // glass. Refusing is the honest answer until the placement is arc-aware.
      const before = doc(['arc', 'line']);
      const out = ops.insertDoubleback(before, 'a', 0, 0.5).runs[0];
      expect(out.polyline.points).toEqual(before.runs[0].polyline.points);
      expect(out.polyline.segment_types).toEqual(['arc', 'line']);
    });

    it('a run with no segment_types does not grow one', () => {
      const plain: DesignDoc = {
        version: 1,
        view_box_mm: [0, 0, 400, 400],
        runs: [{
          id: 'a',
          polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
          tube_diameter_mm: 10,
        }],
      };
      const out = ops.insertDoubleback(plain, 'a', 0, 0.5).runs[0];
      expect(out.polyline.points.length).toBe(7);
      expect('segment_types' in out.polyline).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Bug #17 — splitRun dropped segment_types entirely and insertVertex left it
// the wrong LENGTH.
//
// Two defects in CLAUDE.md's recurring bug class 1 (an op that changes a run's
// point count forgetting a sibling field), and they fail differently:
//
//   splitRun straightened every arc on both pieces, so a 2782mm curved run
//   came back as two 1200mm straights and 382mm of glass left the takeoff, the
//   pattern and the DXF in one click — with the validator reporting the
//   shorter number as fact. Silent.
//
//   insertVertex left the array one entry short, which the Go decoder rejects
//   at unmarshal, so every subsequent save of that doc was a 400. Loud, but
//   only at save time and only to the operator.
//
// The shape decision (repo owner, 2026-09-01, recorded in
// specs/done/bug-17-splitrun-drops-arcs.md): a cut INSIDE an arc segment
// straightens ONLY that segment, because there is no bulge value that draws
// the two halves of a fixed-bulge arc. A cut AT a vertex is pure bookkeeping
// and must preserve every arc exactly — that is what these tests pin.
// ---------------------------------------------------------------------------
describe('splitRun and insertVertex carry segment_types (Bug #17)', () => {
  const CHORD = 300;
  // The bow one 300mm chord gains by being drawn as an arc — the glass a
  // straightening loses.
  //
  // MEASURED THE WAY THE CONSUMER MEASURES: runLengthMM sums chords over the
  // FLATTENED curve (that is what the Go validator does, so it is the number
  // that decides whether a run comes back flagged), which lands a shade under
  // the ideal circular arc length that segmentLengthMM computes — 47.6328 vs
  // 47.7357 here, 0.2%. Deriving this constant from the arc formula instead
  // makes every total-length assertion below fail by exactly that sampling
  // difference, which is a real trap rather than a hypothetical one.
  const BOW = ops.runLengthMM({
    id: 'bow',
    polyline: { points: [[0, 0], [CHORD, 0]], closed: false, segment_types: ['arc'] },
  }) - CHORD;

  function docOf(runs: DesignRun[]): DesignDoc {
    return { version: 1, view_box_mm: [0, 0, 2000, 2000], runs };
  }

  // Four segments, deliberately mixed: both sides of bow and one straight, so
  // a helper that only recognises 'arc' cannot make these pass vacuously
  // (CLAUDE.md bug class 7).
  function arcRun(): DesignRun {
    return {
      id: 'r1',
      polyline: {
        points: [[0, 0], [300, 0], [600, 0], [900, 0], [1200, 0]],
        closed: false,
        segment_types: ['arc', 'arc_r', 'line', 'arc'],
      },
      tube_diameter_mm: 12,
      color: 'classic-red',
    };
  }

  describe('splitRun at a vertex', () => {
    it('draws exactly the glass the original drew', () => {
      // The invariant that actually pins this: the two pieces concatenate to
      // the same flattened curve. Field assertions pass while the drawn shape
      // is wrong, which is how this bug survived two previous fixes to the
      // same function.
      const src = arcRun();
      const out = ops.splitRun(docOf([src]), 'r1', 2);
      const [head, tail] = out.runs;
      expectSamePoints(
        [...flatRunPoints(head), ...flatRunPoints(tail).slice(1)],
        flatRunPoints(src),
      );
    });

    it('and the straightened pieces do NOT — the negative control', () => {
      // The same comparison against the pieces the pre-fix code produced.
      // Without this, "the points match" would be a claim about a test that
      // has never been seen to fail.
      const src = arcRun();
      const out = ops.splitRun(docOf([src]), 'r1', 2);
      const straighten = (r: DesignRun): DesignRun => ({
        ...r,
        polyline: { points: r.polyline.points, closed: r.polyline.closed },
      });
      expect(() => expectSamePoints(
        [
          ...flatRunPoints(straighten(out.runs[0])),
          ...flatRunPoints(straighten(out.runs[1])).slice(1),
        ],
        flatRunPoints(src),
      )).toThrow();
    });

    it('hands each piece the segments that belong to it', () => {
      const out = ops.splitRun(docOf([arcRun()]), 'r1', 2);
      expect(out.runs[0].polyline.segment_types).toEqual(['arc', 'arc_r']);
      expect(out.runs[1].polyline.segment_types).toEqual(['line', 'arc']);
      expectWellFormedDoc(out);
    });

    // Tier 3 #111 left this assertion deliberately unwritten because
    // straightening made it false. It is the whole point of the fix.
    it('preserves the total arc-aware length exactly', () => {
      const src = arcRun();
      const before = ops.runLengthMM(src);
      const out = ops.splitRun(docOf([src]), 'r1', 2);
      const after = out.runs.reduce((acc, r) => acc + ops.runLengthMM(r), 0);
      expect(after).toBeCloseTo(before, 9);

      // Stated in glass rather than in ratios: the run is 1200mm of chord
      // carrying three bows, and the pre-fix pieces summed to the chord.
      expect(before).toBeCloseTo(1200 + 3 * BOW, 9);
      expect(ops.chordLengthMM(src.polyline.points, false)).toBeCloseTo(1200, 9);
      expect(after).not.toBeCloseTo(1200, 3);

      // And the flattened measure is the ideal circular arc to within the
      // sampling error the flattener is documented to have — so `BOW` is a
      // measurement of the right curve, not of whatever the sampler drew.
      const idealBow = segmentLengthMM([0, 0], [CHORD, 0], 'arc') - CHORD;
      expect(Math.abs(BOW - idealBow) / idealBow).toBeLessThan(0.003);
    });

    it('drops the closing segment with the closing glass on a closed source', () => {
      const loop: DesignRun = {
        id: 'sq',
        polyline: {
          points: [[0, 0], [300, 0], [300, 300], [0, 300]],
          closed: true,
          segment_types: ['arc', 'line', 'arc_r', 'arc'],
        },
      };
      const out = ops.splitRun(docOf([loop]), 'sq', 2);
      // Both pieces open, and the closing segment's entry ('arc', index 3)
      // leaves with the closing chord rather than landing on other glass.
      expect(out.runs[0].polyline.segment_types).toEqual(['arc', 'line']);
      expect(out.runs[1].polyline.segment_types).toEqual(['arc_r']);
      expectWellFormedDoc(out);
      const drawn = [
        ...flatRunPoints(out.runs[0]),
        ...flatRunPoints(out.runs[1]).slice(1),
      ];
      // The open walk 0 -> 1 -> 2 -> 3 of the original loop, which is the
      // closed flatten minus its closing arc.
      const openSource: DesignRun = { ...loop, polyline: { ...loop.polyline, closed: false } };
      expectSamePoints(drawn, flatRunPoints(openSource));
    });

    it('a run with no segment_types does not grow one', () => {
      const plain: DesignRun = {
        id: 'r1',
        polyline: { points: [[0, 0], [300, 0], [600, 0], [900, 0]], closed: false },
      };
      const out = ops.splitRun(docOf([plain]), 'r1', 2);
      for (const r of out.runs) expect('segment_types' in r.polyline).toBe(false);
      // …and the JSON is byte-identical to what a pre-#78 doc holds.
      expect(JSON.parse(JSON.stringify(out.runs[0].polyline)))
        .toStrictEqual({ points: [[0, 0], [300, 0], [600, 0]], closed: false });
    });

    // The exact runs internal/server/segment_types_integration_test.go hands
    // the validator. The Go side cannot call splitRun, so the two are pinned
    // to each other here — the takeoff number that test asserts is only
    // meaningful if these really are the runs the op emits.
    it('emits the two polylines the API takeoff test posts', () => {
      const bugReport: DesignRun = {
        id: 'r1',
        polyline: {
          points: [[200, 700], [1400, 700], [2600, 700]],
          closed: false,
          segment_types: ['arc', 'arc'],
        },
        tube_diameter_mm: 12,
      };
      const out = ops.splitRun(docOf([bugReport]), 'r1', 1);
      expect(out.runs.map((r) => JSON.stringify(r.polyline))).toEqual([
        '{"points":[[200,700],[1400,700]],"closed":false,"segment_types":["arc"]}',
        '{"points":[[1400,700],[2600,700]],"closed":false,"segment_types":["arc"]}',
      ]);
    });

    it('a malformed source array still yields exact-length pieces', () => {
      // Docs written by the pre-fix insertVertex are already out there. The Go
      // decoder refuses them, so the repair path has to run through an op —
      // and an op that propagated the malformation could not be that path.
      const broken: DesignRun = {
        id: 'r1',
        polyline: {
          points: [[0, 0], [300, 0], [600, 0], [900, 0], [1200, 0]],
          closed: false,
          segment_types: ['arc', 'arc_r'],
        },
      };
      expect(ops.segmentTypesWellFormed(broken)).toBe(false);
      const out = ops.splitRun(docOf([broken]), 'r1', 2);
      expectWellFormedDoc(out);
      expect(out.runs[0].polyline.segment_types).toEqual(['arc', 'arc_r']);
      expect(out.runs[1].polyline.segment_types).toEqual(['line', 'line']);
    });
  });

  describe('insertVertex', () => {
    it('leaves an array the Go decoder will accept', () => {
      const out = ops.insertVertex(docOf([arcRun()]), 'r1', 1, 0.5).runs[0];
      expect(out.polyline.points.length).toBe(6);
      expectWellFormedRun(out);
    });

    it('straightens only the segment the vertex lands in', () => {
      const out = ops.insertVertex(docOf([arcRun()]), 'r1', 1, 0.5).runs[0];
      // Segment 1 was 'arc_r'; its two halves are lines and every other arc
      // keeps both its position and its SIDE.
      expect(out.polyline.segment_types).toEqual(['arc', 'line', 'line', 'line', 'arc']);
    });

    it('loses exactly the bow of that one segment, and nothing else', () => {
      const src = arcRun();
      const before = ops.runLengthMM(src);
      const after = ops.runLengthMM(ops.insertVertex(docOf([src]), 'r1', 1, 0.5).runs[0]);
      // A number, not a tolerance: the 300mm chord that was an arc is now two
      // collinear halves summing to 300.
      expect(before - after).toBeCloseTo(BOW, 9);
      expect(after).toBeCloseTo(1200 + 2 * BOW, 9);
    });

    it('inserting on a LINE segment costs no glass at all', () => {
      const src = arcRun();
      const before = ops.runLengthMM(src);
      const out = ops.insertVertex(docOf([src]), 'r1', 2, 0.5).runs[0];
      expect(ops.runLengthMM(out)).toBeCloseTo(before, 9);
      expect(out.polyline.segment_types).toEqual(['arc', 'arc_r', 'line', 'line', 'arc']);
    });

    it('a run with no segment_types does not grow one', () => {
      const plain: DesignRun = {
        id: 'r1',
        polyline: { points: [[0, 0], [300, 0], [600, 0]], closed: false },
      };
      const out = ops.insertVertex(docOf([plain]), 'r1', 0, 0.5).runs[0];
      expect(out.polyline.points.length).toBe(4);
      expect('segment_types' in out.polyline).toBe(false);
    });

    it('keeps a closed run closing entry at the end of the array', () => {
      const loop: DesignRun = {
        id: 'sq',
        polyline: {
          points: [[0, 0], [300, 0], [300, 300], [0, 300]],
          closed: true,
          segment_types: ['arc', 'line', 'arc_r', 'arc'],
        },
      };
      const out = ops.insertVertex(docOf([loop]), 'sq', 0, 0.5).runs[0];
      expect(out.polyline.segment_types).toEqual(['line', 'line', 'line', 'arc_r', 'arc']);
      expectWellFormedRun(out);
    });

    // The exact bytes internal/server/segment_types_integration_test.go POSTs.
    // The Go side cannot call this function, so the two are pinned to each
    // other here: change the op's output and this fails, pointing at the
    // fixture that has to move with it.
    it('emits the polyline the API round-trip test posts', () => {
      const src: DesignRun = {
        id: 'r1',
        polyline: {
          points: [[0, 0], [300, 0], [600, 0]],
          closed: false,
          segment_types: ['arc', 'line'],
        },
      };
      const out = ops.insertVertex(docOf([src]), 'r1', 0, 0.5).runs[0];
      expect(JSON.stringify(out.polyline)).toBe(
        '{"points":[[0,0],[150,0],[300,0],[600,0]],"closed":false,'
        + '"segment_types":["line","line","line"]}',
      );
    });
  });

  describe('the ops that cut through both of them', () => {
    it('splitTubesAtRaceway keeps the arcs off the cut and stays saveable', () => {
      // A closed loop crossing the guideline at two vertices: the loop is
      // opened at the first crossing (which ROTATES segment_types) and then
      // cut, so this exercises the rotation and the split in one pass.
      const doc: DesignDoc = {
        version: 1,
        view_box_mm: [0, 0, 400, 400],
        guidelines: [{ id: 'rw1', kind: 'raceway', y_mm: 0 }],
        runs: [{
          id: 'sq',
          polyline: {
            points: [[0, 0], [300, 0], [300, 300], [0, 300]],
            closed: true,
            segment_types: ['line', 'arc', 'line', 'arc_r'],
          },
        }],
      };
      const res = ops.splitTubesAtRaceway(doc, 'rw1');
      expect(res.runsSplit).toBe(1);
      expectWellFormedDoc(res.doc);
      // The crossings land on vertices, so nothing is straightened: both
      // curved segments survive, each on its original side.
      const kinds = res.doc.runs.flatMap((r) => r.polyline.segment_types ?? []);
      expect(kinds.filter((k) => k === 'arc').length).toBe(1);
      expect(kinds.filter((k) => k === 'arc_r').length).toBe(1);
    });

    it('an open run cut at a vertex by the raceway keeps its arcs', () => {
      const doc: DesignDoc = {
        version: 1,
        view_box_mm: [0, 0, 400, 400],
        guidelines: [{ id: 'rw1', kind: 'raceway', y_mm: 100 }],
        runs: [{
          id: 'o',
          polyline: {
            points: [[0, 0], [100, 100], [200, 200]],
            closed: false,
            segment_types: ['arc', 'arc_r'],
          },
        }],
      };
      const res = ops.splitTubesAtRaceway(doc, 'rw1');
      expect(res.runsSplit).toBe(1);
      expectWellFormedDoc(res.doc);
      expect(res.doc.runs.map((r) => r.polyline.segment_types))
        .toEqual([['arc'], ['arc_r']]);
      expect(res.doc.runs.every((r) => r.raceway_id === 'rw1')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// The invariant applied BROADLY — one arc-bearing run through every op that
// changes its point count or point order.
//
// The point of a shared helper is that it can be pointed at everything, and
// pointing it at everything is what turns "splitRun forgot segment_types" from
// a bug report into a list. Bug #17 fixed the split path and left three ops
// pinned FAILING here — deleteVertex, breakOpen and moveOpening — so that
// fixing one would make this block go red and say which list to move it to.
// Tier 3 #119 fixed all three, so the KNOWN BROKEN list is now empty and every
// op that changes a run's point count or point order is in `passing` below.
// Keep it that way: a new op belongs in this sweep on the day it lands.
//
// The vacuity guard is the load-bearing part (CLAUDE.md bug class 7). Each
// case hands back the doc BEFORE and AFTER and asserts the geometry actually
// moved, because an op that quietly did nothing satisfies the invariant for
// free — and `expectWellFormedRun` is deliberately silent about a run with no
// array at all, so a case whose op simply dropped segment_types would pass.
// ---------------------------------------------------------------------------
describe('segment_types well-formedness across every point-count op', () => {
  function openArcRun(id = 'a'): DesignRun {
    return {
      id,
      polyline: {
        points: [[0, 0], [100, 0], [200, 0], [300, 0]],
        closed: false,
        segment_types: ['arc', 'line', 'arc_r'],
      },
      tube_diameter_mm: 10,
    };
  }
  function closedArcRun(id = 'a'): DesignRun {
    return {
      id,
      polyline: {
        points: [[0, 0], [100, 0], [100, 100], [0, 100]],
        closed: true,
        segment_types: ['arc', 'line', 'arc_r', 'line'],
      },
      tube_diameter_mm: 10,
    };
  }
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1, view_box_mm: [0, 0, 400, 400], runs,
  });

  // Each case hands back the doc BEFORE and AFTER, because an op that quietly
  // did nothing would satisfy the invariant for free — the exact way a sweep
  // like this goes vacuous (CLAUDE.md bug class 7).
  type Case = [string, () => [DesignDoc, DesignDoc]];
  const before1 = () => docOf([openArcRun()]);
  const beforeClosed = () => docOf([closedArcRun()]);

  const passing: Case[] = [
    ['splitRun', () => { const d = before1(); return [d, ops.splitRun(d, 'a', 2)]; }],
    ['insertVertex on an arc', () => { const d = before1(); return [d, ops.insertVertex(d, 'a', 0, 0.5)]; }],
    ['insertVertex on a line', () => { const d = before1(); return [d, ops.insertVertex(d, 'a', 1, 0.5)]; }],
    ['insertVertex on a closed run', () => { const d = beforeClosed(); return [d, ops.insertVertex(d, 'a', 1, 0.5)]; }],
    ['insertDoubleback', () => { const d = before1(); return [d, ops.insertDoubleback(d, 'a', 1, 0.5)]; }],
    ['simplifyRun', () => {
      const d = docOf([{
        id: 'a',
        polyline: {
          points: [[0, 0], [50, 0], [100, 0], [200, 0], [300, 0]],
          closed: false,
          segment_types: ['line', 'line', 'line', 'arc'],
        },
      }]);
      return [d, ops.simplifyRun(d, 'a', 1)];
    }],
    ['reverseRun', () => { const d = before1(); return [d, ops.reverseRun(d, 'a')]; }],
    ['joinRuns', () => {
      const d = docOf([
        openArcRun(),
        {
          id: 'b',
          polyline: {
            points: [[300, 0], [400, 0], [500, 0]],
            closed: false,
            segment_types: ['arc', 'line'],
          },
        },
      ]);
      return [d, ops.joinRuns(d, 'a', 'tail', 'b', 'head')];
    }],
    // Tier 2 #134 — folds through joinRuns, so it changes point count and
    // point order and belongs in this sweep on its own account.
    ['joinRunsAlongArtwork', () => {
      const d = docOf([
        openArcRun(),
        {
          id: 'b',
          polyline: {
            points: [[300, 0], [400, 0], [500, 0]],
            closed: false,
            segment_types: ['arc', 'line'],
          },
        },
      ]);
      return [d, ops.joinRunsAlongArtwork(d, ['a', 'b']).doc];
    }],
    ['moveVertices', () => {
      const d = before1();
      return [d, ops.moveVertices(d, 'a', [{ pointIndex: 1, x: 150, y: 40 }])];
    }],
    ['autoSplitOverlongTubes', () => {
      const d = before1();
      return [d, ops.autoSplitOverlongTubes(d, 60).doc];
    }],
    ['splitTubesAtRaceway (open)', () => {
      const d: DesignDoc = {
        ...docOf([{
          id: 'a',
          polyline: {
            points: [[0, 0], [100, 100], [200, 0]],
            closed: false,
            segment_types: ['arc', 'arc_r'],
          },
        }]),
        guidelines: [{ id: 'rw1', kind: 'raceway', y_mm: 50 }],
      };
      return [d, ops.splitTubesAtRaceway(d, 'rw1').doc];
    }],
    ['splitTubesAtRaceway (closed)', () => {
      const d: DesignDoc = {
        ...docOf([closedArcRun('sq')]),
        guidelines: [{ id: 'rw1', kind: 'raceway', y_mm: 50 }],
      };
      return [d, ops.splitTubesAtRaceway(d, 'rw1').doc];
    }],
    // Tier 3 #119 — the three that used to be pinned as KNOWN BROKEN below.
    ['deleteVertex (merges two segments)', () => { const d = before1(); return [d, ops.deleteVertex(d, 'a', 1)]; }],
    ['deleteVertex (drops the first segment)', () => { const d = before1(); return [d, ops.deleteVertex(d, 'a', 0)]; }],
    ['deleteVertex on a closed run', () => { const d = beforeClosed(); return [d, ops.deleteVertex(d, 'a', 0)]; }],
    ['breakOpen', () => { const d = beforeClosed(); return [d, ops.breakOpen(d, 'a', 1)]; }],
    ['moveOpening', () => {
      const d = docOf([{ ...openArcRun(), electrodes: [{ point_index: 0 }, { point_index: 3 }] }]);
      return [d, ops.moveOpening(d, 'a', 1)];
    }],
    // Tier 1 #127 — changes the point count (drops the trailing duplicate),
    // so it belongs in this sweep like every other op that does.
    ['closeGeometricLoop', () => {
      const d = docOf([{
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
        tube_diameter_mm: 10,
      }]);
      return [d, ops.closeGeometricLoop(d, 'a')];
    }],
    ['breakOpen on a geometric loop', () => {
      const d = docOf([{
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
        tube_diameter_mm: 10,
      }]);
      return [d, ops.breakOpen(d, 'a', 1)];
    }],
  ];

  // The whole geometry an op could have touched, as a string: run ids, point
  // lists, segment types and closed-ness.
  const shapeOf = (doc: DesignDoc) => JSON.stringify(
    doc.runs.map((r) => [r.id, r.polyline.points, r.polyline.segment_types ?? null, !!r.polyline.closed]),
  );

  for (const [name, runCase] of passing) {
    it(`${name} leaves every run saveable`, () => {
      const [before, after] = runCase();
      expect(shapeOf(after), `${name} was a no-op; the assertion below is vacuous`)
        .not.toBe(shapeOf(before));
      expectWellFormedDoc(after);
    });
  }

  // The list that used to sit here is empty. Anything added to it later is a
  // regression, not a backlog item: every op in this file that changes a run's
  // point count or point order now carries segment_types with it.
  it('the KNOWN BROKEN list is empty — every point-count op is in the sweep', () => {
    const swept = new Set(passing.map(([name]) => name.replace(/ .*/, '')));
    for (const op of [
      'splitRun', 'insertVertex', 'insertDoubleback', 'simplifyRun', 'reverseRun',
      'joinRuns', 'joinRunsAlongArtwork', 'moveVertices', 'autoSplitOverlongTubes',
      'splitTubesAtRaceway',
      'deleteVertex', 'breakOpen', 'moveOpening', 'closeGeometricLoop',
    ]) {
      expect(swept.has(op), `${op} is not covered by the well-formedness sweep`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Tier 3 #119 — segment_types through deleteVertex, breakOpen and moveOpening.
//
// The fifth, sixth and seventh instances of CLAUDE.md bug class 1, all with
// the same shape as Bug #17: `{ ...run.polyline, points }` replaces the points
// and leaves the sibling array behind. Only the FIRST of them produces an
// error — deleteVertex leaves the array one entry too long and the Go decoder
// 400s the next save. The other two keep the array the right LENGTH (breakOpen
// emits n+1 points, so a closed run's n segments become n open segments) and
// get the ORDER wrong, which no length check can see and which the operator
// discovers as a curve that moved to a different part of the tube.
//
// So the assertions here are geometric, per CLAUDE.md: `drawnSegments` is the
// whole of what a run puts on the glass — every segment's two endpoints AND
// its bow side — and comparing that list before and after says "the same
// glass, re-indexed" in a way a field assertion cannot.
// ---------------------------------------------------------------------------
describe('Tier 3 #119 — segment_types through the last three point-count ops', () => {
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1, view_box_mm: [0, 0, 400, 400], runs,
  });

  // Every segment a run draws, as a comparable string: the two endpoints and
  // the bow. Two runs whose lists are rotations of each other draw the same
  // shape starting in different places, which is exactly what breakOpen and
  // moveOpening claim to do.
  const drawnSegments = (run: DesignRun): string[] => {
    const pts = run.polyline.points;
    const n = pts.length;
    const out: string[] = [];
    for (let i = 0; i < segmentCount(run); i++) {
      out.push(JSON.stringify([pts[i], pts[(i + 1) % n], segmentTypeAt(run, i)]));
    }
    return out;
  };
  const rotate = <T,>(xs: T[], k: number): T[] => xs.slice(k).concat(xs.slice(0, k));

  // glassMM measures ONE segment the way the Go validator measures it: flatten
  // first, then sum chords. Do NOT reach for segmentLengthMM here — that is
  // the ideal circular arc, and the two differ by ~0.2% (115.8776 vs 115.9104
  // on a 100mm chord), which is enough to fail every total-length assertion
  // below by exactly that sampling difference. Bug #17 hit this; the spec for
  // this task calls it out; this helper is where it stays fixed.
  const glassMM = (a: [number, number], b: [number, number], t: SegmentKind): number =>
    ops.runLengthMM({ id: 'probe', polyline: { points: [a, b], closed: false, segment_types: [t] } });

  // The glass an 'arc' over a 100mm chord draws beyond its chord. Measured,
  // not derived.
  const BOW_100 = glassMM([0, 0], [100, 0], 'arc') - 100;

  describe('deleteVertex', () => {
    // Collinear on purpose. Dropping a vertex between two straights shortens a
    // run whenever the three points are NOT collinear, and that has nothing to
    // do with segment_types — it is the operator asking for a straighter path.
    // Collinear isolates the ONLY glass this fix is answerable for: the bow of
    // a merged arc.
    const threeInARow = (types: SegmentKind[]): DesignRun => ({
      id: 'a',
      polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false, segment_types: types },
    });

    it('merging two lines loses exactly nothing', () => {
      const src = threeInARow(['line', 'line']);
      const out = ops.deleteVertex(docOf([src]), 'a', 1).runs[0];
      expectWellFormedRun(out);
      expect(out.polyline.segment_types).toEqual(['line']);
      expect(ops.runLengthMM(out)).toBe(ops.runLengthMM(src));
    });

    // Bug #17's decision, not a fresh one: an edit straightens only the glass
    // it touches. Two arcs merged across a dropped vertex are not one arc, and
    // no value of a fixed ARC_BULGE draws the pair, so the merge becomes a
    // line — and the bow it drew is gone. That number is computable, so it is
    // computed rather than tolerated.
    it('merging an arc with a line loses exactly the arc bow', () => {
      for (const types of [['arc', 'line'], ['line', 'arc_r']] as SegmentKind[][]) {
        const src = threeInARow(types);
        const out = ops.deleteVertex(docOf([src]), 'a', 1).runs[0];
        expectWellFormedRun(out);
        expect(out.polyline.segment_types).toEqual(['line']);
        expect(ops.runLengthMM(src) - ops.runLengthMM(out)).toBeCloseTo(BOW_100, 9);
      }
    });

    it('merging two arcs loses exactly both bows', () => {
      const src = threeInARow(['arc', 'arc_r']);
      const out = ops.deleteVertex(docOf([src]), 'a', 1).runs[0];
      expectWellFormedRun(out);
      expect(out.polyline.segment_types).toEqual(['line']);
      expect(ops.runLengthMM(src) - ops.runLengthMM(out)).toBeCloseTo(2 * BOW_100, 9);
    });

    it('deleting an END vertex drops that segment whole and merges nothing', () => {
      const src: DesignRun = {
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [200, 0], [300, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
      };
      // Vertex 0: the leading 'arc' disappears with it; the survivors keep
      // their types AND their sides.
      const head = ops.deleteVertex(docOf([src]), 'a', 0).runs[0];
      expectWellFormedRun(head);
      expect(head.polyline.segment_types).toEqual(['line', 'arc_r']);
      expect(drawnSegments(head)).toEqual(drawnSegments(src).slice(1));
      // Vertex 3, same from the other end.
      const tail = ops.deleteVertex(docOf([src]), 'a', 3).runs[0];
      expectWellFormedRun(tail);
      expect(tail.polyline.segment_types).toEqual(['arc', 'line']);
      expect(drawnSegments(tail)).toEqual(drawnSegments(src).slice(0, 2));
    });

    it('leaves every arc the delete did not touch exactly where it was', () => {
      const src: DesignRun = {
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [200, 0], [300, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
      };
      // Deleting vertex 2 merges segments 1 ('line') and 2 ('arc_r'); segment
      // 0's arc is untouched, on the same two points, bowed the same way.
      const out = ops.deleteVertex(docOf([src]), 'a', 2).runs[0];
      expectWellFormedRun(out);
      expect(out.polyline.segment_types).toEqual(['arc', 'line']);
      expect(drawnSegments(out)[0]).toBe(drawnSegments(src)[0]);
      expect(ops.runLengthMM(src) - ops.runLengthMM(out)).toBeCloseTo(BOW_100, 9);
    });

    it('a closed run keeps one entry per segment, closing chord included', () => {
      const sq: DesignRun = {
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 100]],
          closed: true,
          segment_types: ['arc', 'line', 'arc_r', 'line'],
        },
      };
      // Deleting vertex 0 merges the CLOSING segment with segment 0, and the
      // merged entry has to land at the END of the array where the new closing
      // segment lives — the case an "array.splice(i, 2, 'line')" would get
      // wrong.
      const at0 = ops.deleteVertex(docOf([sq]), 'a', 0).runs[0];
      expectWellFormedRun(at0);
      expect(at0.polyline.points).toEqual([[100, 0], [100, 100], [0, 100]]);
      expect(at0.polyline.segment_types).toEqual(['line', 'arc_r', 'line']);
      // Deleting an interior vertex merges in place.
      const at2 = ops.deleteVertex(docOf([sq]), 'a', 2).runs[0];
      expectWellFormedRun(at2);
      expect(at2.polyline.segment_types).toEqual(['arc', 'line', 'line']);
      expect(drawnSegments(at2)[0]).toBe(drawnSegments(sq)[0]);
    });

    it('does not grow a segment_types array on a pre-#78 run', () => {
      const plain: DesignRun = {
        id: 'a',
        polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
      };
      const out = ops.deleteVertex(docOf([plain]), 'a', 1).runs[0];
      expect('segment_types' in out.polyline).toBe(false);
    });

    it('leaves the run alone when the index is out of range', () => {
      const src = threeInARow(['arc', 'line']);
      const out = ops.deleteVertex(docOf([src]), 'a', 9).runs[0];
      expect(out).toBe(src);
    });

    // NEGATIVE CONTROL. `expectWellFormedRun` only means something if it has
    // been seen to fail, so build the pre-fix output — points replaced, array
    // left behind — and assert the decoder's twin refuses it. Without this,
    // "the array is well-formed" is a claim about a check that has never said
    // no (CLAUDE.md bug class 7).
    it('NEGATIVE CONTROL: the pre-fix spread leaves the run unsaveable', () => {
      const src = threeInARow(['arc', 'line']);
      const preFix: DesignRun = {
        ...src,
        polyline: { ...src.polyline, points: src.polyline.points.filter((_, i) => i !== 1) },
      };
      expect(ops.segmentTypesWellFormed(preFix)).toBe(false);
      expect(preFix.polyline.segment_types).toHaveLength(2);
      expect(segmentCount(preFix)).toBe(1);
    });

    // The exact bytes internal/server/segment_types_integration_test.go POSTs.
    // The Go side cannot call this function, so the two are pinned to each
    // other here: change the op's output and this fails, pointing at the
    // fixture that has to move with it.
    it('emits the polyline the API round-trip test posts', () => {
      const src: DesignRun = {
        id: 'r1',
        polyline: {
          points: [[0, 0], [300, 0], [600, 0], [900, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
      };
      const out = ops.deleteVertex(docOf([src]), 'r1', 1).runs[0];
      expect(JSON.stringify(out.polyline)).toBe(
        '{"points":[[0,0],[600,0],[900,0]],"closed":false,'
        + '"segment_types":["line","arc_r"]}',
      );
    });
  });

  describe('breakOpen', () => {
    const closedSq = (): DesignRun => ({
      id: 'a',
      polyline: {
        points: [[0, 0], [100, 0], [100, 100], [0, 100]],
        closed: true,
        segment_types: ['arc', 'line', 'arc_r', 'line'],
      },
    });

    // THE invariant. Breaking a loop open is pure bookkeeping: the same loop,
    // walked from a different vertex. No glass is lost and no arc changes
    // kind, so the drawn-segment list must come back as an exact rotation —
    // from EVERY break vertex, because a fix that only works for one is a
    // coincidence.
    it('draws the same glass from every break vertex — the loop, re-indexed', () => {
      const src = closedSq();
      const before = drawnSegments(src);
      for (let k = 0; k < src.polyline.points.length; k++) {
        const out = ops.breakOpen(docOf([src]), 'a', k).runs[0];
        expectWellFormedRun(out);
        expect(out.polyline.closed).toBe(false);
        expect(drawnSegments(out), `break at ${k}`).toEqual(rotate(before, k));
        expect(ops.runLengthMM(out), `break at ${k}`)
          .toBeCloseTo(ops.runLengthMM(src), 9);
      }
    });

    // The same statement one level lower, against the points the validator,
    // the pattern and the DXF are all derived from: the flattened curve is the
    // same curve, entered at the break vertex.
    it('flattens to the same curve, walked from the break vertex', () => {
      const src = closedSq();
      const pts = src.polyline.points;
      const n = pts.length;
      for (let k = 0; k < n; k++) {
        const out = ops.breakOpen(docOf([src]), 'a', k).runs[0];
        const expected: [number, number][] = [pts[k]];
        for (let j = 0; j < n; j++) {
          expected.push(...flattenSegment(
            pts[(k + j) % n], pts[(k + j + 1) % n], segmentTypeAt(src, (k + j) % n),
          ));
        }
        expect(flatRunPoints(out), `break at ${k}`).toEqual(expected);
      }
    });

    // NEGATIVE CONTROL, and a demonstration of why the invariant above has to
    // be per-segment. The pre-fix run — points rotated, array left behind — is
    // accepted by the decoder's twin AND measures the same total glass, on
    // this fixture to within float noise. Every cheap check passes. Only
    // comparing what each segment draws finds the two arcs sitting on the
    // straight sides of the square.
    it('NEGATIVE CONTROL: an unrotated array passes every check except shape', () => {
      const src = closedSq();
      const out = ops.breakOpen(docOf([src]), 'a', 1).runs[0];
      const preFix: DesignRun = {
        ...out,
        polyline: { ...out.polyline, segment_types: src.polyline.segment_types },
      };
      expect(ops.segmentTypesWellFormed(preFix)).toBe(true);
      expect(ops.runLengthMM(preFix)).toBeCloseTo(ops.runLengthMM(src), 9);
      // …and draws a different tube.
      expect(drawnSegments(preFix)).not.toEqual(drawnSegments(out));
      expect(flatRunPoints(preFix)).not.toEqual(flatRunPoints(out));
    });

    it('does not grow a segment_types array on a pre-#78 run', () => {
      const plain: DesignRun = {
        id: 'a',
        polyline: { points: [[0, 0], [100, 0], [100, 100]], closed: true },
      };
      const out = ops.breakOpen(docOf([plain]), 'a', 1).runs[0];
      expect('segment_types' in out.polyline).toBe(false);
    });
  });

  describe('moveOpening', () => {
    const openArcRun = (): DesignRun => ({
      id: 'a',
      polyline: {
        points: [[0, 0], [100, 0], [200, 0], [300, 0]],
        closed: false,
        segment_types: ['arc', 'line', 'arc_r'],
      },
      electrodes: [{ point_index: 0 }, { point_index: 3 }],
    });

    it('rotates the array with the walk from every vertex on it', () => {
      const src = openArcRun();
      const pts = src.polyline.points;
      const n = pts.length;
      for (let k = 0; k < n; k++) {
        const out = ops.moveOpening(docOf([src]), 'a', k).runs[0];
        expectWellFormedRun(out);
        // New segment j is old segment (k+j) % n. Old index n-1 is not a
        // segment — it is the opening — so it enters as a line.
        const want: SegmentKind[] = [];
        for (let j = 0; j < n - 1; j++) {
          const from = (k + j) % n;
          want.push(from === n - 1 ? 'line' : segmentTypeAt(src, from));
        }
        expect(out.polyline.segment_types, `opening at ${k}`).toEqual(want);
      }
    });

    // The length statement, computed rather than tolerated. Rotating the
    // opening trades exactly one segment for exactly one other: old segment
    // k-1 becomes the new gap, and the old gap (last vertex -> first) becomes
    // drawn glass, as a straight line because the operator drew no curve
    // across the opening.
    it('trades exactly one segment of glass for exactly one other', () => {
      const src = openArcRun();
      const pts = src.polyline.points;
      const n = pts.length;
      const srcLen = ops.runLengthMM(src);
      for (let k = 1; k < n; k++) {
        const out = ops.moveOpening(docOf([src]), 'a', k).runs[0];
        const lost = glassMM(pts[k - 1], pts[k], segmentTypeAt(src, k - 1));
        const gained = glassMM(pts[n - 1], pts[0], 'line');
        expect(ops.runLengthMM(out), `opening at ${k}`)
          .toBeCloseTo(srcLen - lost + gained, 9);
        // Every segment that SURVIVED the rotation is byte-identical: same
        // endpoints, same bow, same side.
        const survivors = drawnSegments(out).filter((s) => drawnSegments(src).includes(s));
        expect(survivors, `opening at ${k}`).toHaveLength(n - 2);
      }
    });

    it('does not grow a segment_types array on a pre-#78 run', () => {
      const plain: DesignRun = {
        id: 'a',
        polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
        electrodes: [{ point_index: 0 }, { point_index: 2 }],
      };
      const out = ops.moveOpening(docOf([plain]), 'a', 1).runs[0];
      expect('segment_types' in out.polyline).toBe(false);
    });

    // SPEC CORRECTION, pinned so it is not re-litigated from prose.
    //
    // Tier 3 #119's spec asks for the same geometric invariant on moveOpening
    // that breakOpen satisfies — "the result must draw the same glass as the
    // source, it is the same loop re-indexed". It is not, and the reason is in
    // the POINTS, not in segment_types: moveOpening treats an open polyline as
    // a cycle whose missing segment IS the opening, so rotating it necessarily
    // trades one segment of glass for another (asserted exactly, above). That
    // is the op's documented behaviour and its existing tests assert it.
    //
    // Feeding it a breakOpen output — the case its own doc comment names as
    // the common one — is where that reading gets expensive: breakOpen ends
    // the walk on a DUPLICATE of the start vertex (zero-width opening, full
    // perimeter), so moveOpening drops a real segment of glass and leaves the
    // duplicate stranded mid-polyline as a zero-length segment. Measured here
    // rather than described. Reconciling the two ops is a shape decision for
    // the repo owner and a change to the point handling, which #119 explicitly
    // scopes out — this test exists so the next person finds the numbers.
    it('KNOWN LIMIT: on a breakOpen output it drops a segment and strands the duplicate', () => {
      const loop: DesignRun = {
        id: 'a',
        polyline: {
          points: [[0, 0], [100, 0], [100, 100], [0, 100]],
          closed: true,
          segment_types: ['arc', 'line', 'arc_r', 'line'],
        },
      };
      const opened = ops.breakOpen(docOf([loop]), 'a', 0);
      // breakOpen itself is exact: the full perimeter, ending on a duplicate.
      expect(ops.runLengthMM(opened.runs[0])).toBeCloseTo(ops.runLengthMM(loop), 9);
      expect(opened.runs[0].polyline.points[0])
        .toEqual(opened.runs[0].polyline.points[4]);

      const moved = ops.moveOpening(opened, 'a', 2).runs[0];
      expectWellFormedRun(moved);
      // The duplicate is now stranded in the middle as a zero-length segment…
      expect(moved.polyline.points[2]).toEqual(moved.polyline.points[3]);
      // …and old segment 1 (the 100mm straight) is gone from the takeoff.
      expect(ops.runLengthMM(opened.runs[0]) - ops.runLengthMM(moved))
        .toBeCloseTo(100, 9);
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 2 #135 — block-outs from the validator's crossing findings.
//
// The two tuning facts the op is built around were both learned by rendering
// the wrong version first, and both are things a later change would "clean
// up" back into the bug. They are pinned here, not just commented:
//
//   (a) the filter is the RULE ID `crossing_needs_blockout`, never severity —
//       `min_spacing` fires on every near-parallel pair and painting those
//       swallowed whole strokes;
//   (b) the painted span is ~2 TUBE DIAMETERS, derived from the run's
//       diameter (falling back to the project spec), never a hard-coded 30.
//
// The load-bearing geometric test is the CLOSED run with two electrodes.
// On an open run the live walk is the whole polyline, so live and raw index
// space coincide and a raw-index implementation passes everything else in
// this block while painting the wrong part of a loop.
// ---------------------------------------------------------------------------
describe('Tier 2 #135 — placeBlockoutsFromCrossings', () => {
  const CROSSING = 'crossing_needs_blockout';

  // A 200mm straight run with a vertex every millimetre, so a live index IS
  // a millimetre and the span assertions can be exact.
  function straightRun(id = 'r1', diameterMM?: number): DesignRun {
    const points: [number, number][] = [];
    for (let i = 0; i <= 200; i++) points.push([i, 0]);
    return {
      id,
      polyline: { points, closed: false },
      ...(diameterMM === undefined ? {} : { tube_diameter_mm: diameterMM }),
    };
  }

  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 400, 400],
    runs,
  });

  // paintedPolyline resolves a blockout back to the glass it paints: live
  // indices -> raw vertices -> the FLATTENED curve between them. Every
  // assertion below measures against this rather than against the indices, so
  // "the paint covers the crossing" is a millimetre statement.
  function paintedPolyline(
    run: DesignRun,
    b: { start_live_index: number; end_live_index: number },
  ): [number, number][] {
    const { live } = runArcs(run);
    const pts = run.polyline.points;
    const out: [number, number][] = [pts[live[b.start_live_index]]];
    for (let k = b.start_live_index; k < b.end_live_index; k++) {
      const a = live[k];
      const c = live[k + 1];
      const hit = segmentIndexBetween(a, c, pts.length, !!run.polyline.closed);
      if (!hit) {
        out.push(pts[c]);
        continue;
      }
      const p0 = pts[hit.seg];
      const p1 = pts[(hit.seg + 1) % pts.length];
      const flat: [number, number][] = [p0, ...flattenSegment(p0, p1, segmentTypeAt(run, hit.seg))];
      const seq = hit.reversed ? flat.slice().reverse() : flat;
      out.push(...seq.slice(1));
    }
    return out;
  }

  function distToPolylineMM(pts: [number, number][], target: [number, number]): number {
    let best = Infinity;
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const abx = bx - ax;
      const aby = by - ay;
      const len2 = abx * abx + aby * aby;
      let t = len2 > 0 ? ((target[0] - ax) * abx + (target[1] - ay) * aby) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(target[0] - (ax + t * abx), target[1] - (ay + t * aby));
      if (d < best) best = d;
    }
    if (pts.length === 1) return Math.hypot(target[0] - pts[0][0], target[1] - pts[0][1]);
    return best;
  }

  const onlyBlockout = (run: DesignRun) => {
    expect(run.blockouts).toHaveLength(1);
    return run.blockouts![0];
  };

  // -- (a) the rule-id filter --------------------------------------------
  describe('filters on the rule id, not on severity', () => {
    it('paints crossings and ignores min_spacing findings at the same spot', () => {
      const doc = docOf([straightRun('r1', 12)]);
      const findings = [
        { rule: 'min_spacing', x_mm: 50, y_mm: 0 },
        { rule: 'min_spacing', x_mm: 100, y_mm: 0 },
        { rule: 'min_spacing', x_mm: 150, y_mm: 0 },
        { rule: CROSSING, x_mm: 100, y_mm: 0 },
      ];
      // Vacuity guard: the fixture MUST contain min_spacing findings, or the
      // assertion below passes for the wrong reason.
      expect(findings.filter((f) => f.rule === 'min_spacing')).toHaveLength(3);

      const res = ops.placeBlockoutsFromCrossings(doc, findings, { projectDiameterMM: 12 });
      expect(res.crossings).toBe(1);
      expect(res.placed).toBe(1);
      const b = onlyBlockout(res.doc.runs[0]);
      // 24mm of paint centred on x=100 — the two min_spacing spots are
      // outside it, which is the whole point of the rule-id filter.
      expect(b.start_live_index).toBe(88);
      expect(b.end_live_index).toBe(112);
      expect(distToPolylineMM(paintedPolyline(res.doc.runs[0], b), [50, 0])).toBeGreaterThan(30);
      expect(distToPolylineMM(paintedPolyline(res.doc.runs[0], b), [150, 0])).toBeGreaterThan(30);
    });

    it('a report of only min_spacing errors paints nothing and returns the same doc', () => {
      const doc = docOf([straightRun('r1', 12)]);
      const res = ops.placeBlockoutsFromCrossings(doc, [
        { rule: 'min_spacing', x_mm: 40, y_mm: 0 },
        { rule: 'min_spacing', x_mm: 120, y_mm: 0 },
      ]);
      expect(res.crossings).toBe(0);
      expect(res.placed).toBe(0);
      expect(res.doc).toBe(doc);
      expect(res.doc.runs[0].blockouts ?? []).toHaveLength(0);
    });

    it('CROSSING_BLOCKOUT_RULE is the validator rule id', () => {
      // internal/validate/types.go:19. If the Go constant is ever renamed the
      // op silently stops finding anything, so pin the string.
      expect(ops.CROSSING_BLOCKOUT_RULE).toBe('crossing_needs_blockout');
    });
  });

  // -- (b) the span --------------------------------------------------------
  describe('painted span is ~2 tube diameters, derived not hard-coded', () => {
    const paintedMM = (run: DesignRun) =>
      ops.chordLengthMM(paintedPolyline(run, onlyBlockout(run)));

    it('defaults to 2 x the run diameter', () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 12)]),
        [{ rule: CROSSING, x_mm: 100, y_mm: 0 }],
      );
      expect(ops.crossingBlockoutSpanMM(res.doc.runs[0])).toBe(24);
      expect(paintedMM(res.doc.runs[0])).toBeCloseTo(24, 6);
    });

    it('falls back to the project tube spec when the run has no override', () => {
      const run = straightRun('r1');
      expect(run.tube_diameter_mm).toBeUndefined();
      const res = ops.placeBlockoutsFromCrossings(
        docOf([run]),
        [{ rule: CROSSING, x_mm: 100, y_mm: 0 }],
        { projectDiameterMM: 8 },
      );
      expect(paintedMM(res.doc.runs[0])).toBeCloseTo(16, 6);
    });

    it("the run's own diameter wins over the project spec", () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 15)]),
        [{ rule: CROSSING, x_mm: 100, y_mm: 0 }],
        { projectDiameterMM: 8 },
      );
      expect(ops.crossingBlockoutSpanMM(res.doc.runs[0], 8)).toBe(30);
      expect(paintedMM(res.doc.runs[0])).toBeCloseTo(30, 6);
    });

    it('nothing hard-codes 30: an 8mm tube paints 16mm, a 15mm tube 30mm', () => {
      const eight = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 8)]),
        [{ rule: CROSSING, x_mm: 100, y_mm: 0 }],
      );
      expect(paintedMM(eight.doc.runs[0])).toBeCloseTo(16, 6);
      expect(ops.BLOCKOUT_SPAN_DIAMETERS).toBe(2);
    });

    it('an operator override beats the derived default', () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 12)]),
        [{ rule: CROSSING, x_mm: 100, y_mm: 0 }],
        { spanMM: 60 },
      );
      expect(paintedMM(res.doc.runs[0])).toBeCloseTo(60, 6);
    });
  });

  // -- the index problem ---------------------------------------------------
  describe('closed run with two electrodes — live indices, not raw ones', () => {
    // 24-gon, r=50 about (100,100). Electrodes at raw 6 (top) and raw 18
    // (bottom): forward walks 6..18, the LEFT half. The crossing sits on raw
    // vertex 12 — live index 6. The two index spaces differ by exactly the
    // electrode offset, which is what makes this fixture able to fail.
    const N = 24;
    function ring(direction: 'forward' | 'backward'): DesignRun {
      const points: [number, number][] = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * Math.PI * 2;
        points.push([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]);
      }
      return {
        id: 'loop',
        polyline: { points, closed: true },
        tube_diameter_mm: 12,
        electrodes: [{ point_index: 6 }, { point_index: 18 }],
        direction,
      };
    }
    const CHORD_MM = 2 * 50 * Math.sin(Math.PI / N);

    it('places the block-out so it covers the crossing point in millimetres', () => {
      const run = ring('forward');
      const crossing: [number, number] = run.polyline.points[12]; // (50, 100)
      const { live } = runArcs(run);
      // The fixture is only meaningful while the two index spaces disagree.
      expect(live[6]).toBe(12);
      expect(live.length).toBe(13);

      const res = ops.placeBlockoutsFromCrossings(docOf([run]), [
        { rule: CROSSING, x_mm: crossing[0], y_mm: crossing[1] },
      ]);
      expect(res.placed).toBe(1);
      const b = onlyBlockout(res.doc.runs[0]);

      // Brackets the crossing's LIVE index (6), not its RAW index (12).
      expect(b.start_live_index).toBeLessThan(6);
      expect(b.end_live_index).toBeGreaterThan(6);
      expect(distToPolylineMM(paintedPolyline(res.doc.runs[0], b), crossing)).toBeLessThan(0.5);

      // At least the requested 24mm of glass, and no more than one chord of
      // slop at each end (indices round OUTWARD so the span is covered).
      const mm = ops.chordLengthMM(paintedPolyline(res.doc.runs[0], b));
      expect(mm).toBeGreaterThanOrEqual(24 - 1e-9);
      expect(mm).toBeLessThanOrEqual(24 + 2 * CHORD_MM);

      // NEGATIVE CONTROL — the same numbers read as RAW vertex indices, i.e.
      // what a naive implementation writes. That glass is on the far side of
      // the loop, ~60mm from the crossing: this is the failure the fixture
      // exists to catch.
      const rawRead = run.polyline.points.slice(b.start_live_index, b.end_live_index + 1);
      expect(distToPolylineMM(rawRead, crossing)).toBeGreaterThan(20);
    });

    it('honours direction: a crossing on the dead arc is not painted', () => {
      // (150,100) is raw vertex 0 — on the loop, but on the INACTIVE half
      // when direction is forward. Painting the nearest live glass there
      // would put paint 70mm from the crossing.
      const forwardDoc = docOf([ring('forward')]);
      const dead = ops.placeBlockoutsFromCrossings(forwardDoc, [
        { rule: CROSSING, x_mm: 150, y_mm: 100 },
      ]);
      expect(dead.placed).toBe(0);
      expect(dead.unresolved).toBe(1);
      expect(dead.doc).toBe(forwardDoc);

      // Flip the direction and the same point is live glass, so it paints.
      const live = ops.placeBlockoutsFromCrossings(docOf([ring('backward')]), [
        { rule: CROSSING, x_mm: 150, y_mm: 100 },
      ]);
      expect(live.placed).toBe(1);
      const b = onlyBlockout(live.doc.runs[0]);
      expect(distToPolylineMM(paintedPolyline(live.doc.runs[0], b), [150, 100])).toBeLessThan(0.5);
    });
  });

  // -- idempotence and merging --------------------------------------------
  describe('idempotence and merging', () => {
    it('a second pass adds nothing and hands back the same doc reference', () => {
      const doc = docOf([straightRun('r1', 12)]);
      const findings = [
        { rule: CROSSING, x_mm: 60, y_mm: 0 },
        { rule: CROSSING, x_mm: 160, y_mm: 0 },
      ];
      const first = ops.placeBlockoutsFromCrossings(doc, findings);
      expect(first.placed).toBe(2);
      expect(first.doc.runs[0].blockouts).toHaveLength(2);

      const second = ops.placeBlockoutsFromCrossings(first.doc, findings);
      expect(second.placed).toBe(0);
      expect(second.skipped).toBe(2);
      // Same reference: editDoc's identity guard then skips the undo push.
      expect(second.doc).toBe(first.doc);
    });

    it('overlapping spans on one run merge instead of stacking', () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 12)]),
        [
          { rule: CROSSING, x_mm: 100, y_mm: 0 },
          { rule: CROSSING, x_mm: 110, y_mm: 0 },
        ],
      );
      // Two crossings acted on…
      expect(res.placed).toBe(2);
      // …one continuous painted span, 88..122, not two stacked ones.
      const b = onlyBlockout(res.doc.runs[0]);
      expect(b).toEqual({ start_live_index: 88, end_live_index: 122 });
    });

    it('a block-out the operator painted by hand counts as a skip', () => {
      const run = straightRun('r1', 12);
      run.blockouts = [{ start_live_index: 80, end_live_index: 120 }];
      const doc = docOf([run]);
      const res = ops.placeBlockoutsFromCrossings(doc, [{ rule: CROSSING, x_mm: 100, y_mm: 0 }]);
      expect(res.placed).toBe(0);
      expect(res.skipped).toBe(1);
      expect(res.doc).toBe(doc);
    });
  });

  // -- clamping ------------------------------------------------------------
  describe('clamping at the ends of a run', () => {
    it('a crossing at the first vertex paints a span inside the run', () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 12)]),
        [{ rule: CROSSING, x_mm: 0, y_mm: 0 }],
      );
      const b = onlyBlockout(res.doc.runs[0]);
      expect(b.start_live_index).toBe(0);
      expect(b.end_live_index).toBe(12);
      expect(distToPolylineMM(paintedPolyline(res.doc.runs[0], b), [0, 0])).toBeLessThan(1e-9);
    });

    it('a crossing at the last vertex stays in range', () => {
      const res = ops.placeBlockoutsFromCrossings(
        docOf([straightRun('r1', 12)]),
        [{ rule: CROSSING, x_mm: 200, y_mm: 0 }],
      );
      const b = onlyBlockout(res.doc.runs[0]);
      expect(b.start_live_index).toBe(188);
      expect(b.end_live_index).toBe(200);
      expect(b.end_live_index).toBeLessThan(res.doc.runs[0].polyline.points.length);
    });

    it('a run shorter than the span paints the whole run, not a negative index', () => {
      const stub: DesignRun = {
        id: 'stub',
        polyline: { points: [[0, 0], [4, 0]], closed: false },
        tube_diameter_mm: 12,
      };
      const res = ops.placeBlockoutsFromCrossings(docOf([stub]), [
        { rule: CROSSING, x_mm: 2, y_mm: 0 },
      ]);
      const b = onlyBlockout(res.doc.runs[0]);
      expect(b.start_live_index).toBe(0);
      expect(b.end_live_index).toBe(1);
    });
  });

  // -- run choice ----------------------------------------------------------
  describe('which of the two crossing tubes gets painted', () => {
    function crossPair(): DesignDoc {
      const h: [number, number][] = [];
      for (let i = 0; i <= 200; i++) h.push([i, 100]);
      const v: [number, number][] = [];
      for (let i = 0; i <= 200; i++) v.push([100, i]);
      return docOf([
        { id: 'horizontal', polyline: { points: h, closed: false }, tube_diameter_mm: 12 },
        { id: 'vertical', polyline: { points: v, closed: false }, tube_diameter_mm: 12 },
      ]);
    }

    it('paints ONE tube per crossing, not both', () => {
      // Painting both doubles the dark glass at every crossing, which is the
      // failure mode the 2-diameter span exists to avoid.
      const res = ops.placeBlockoutsFromCrossings(crossPair(), [
        { rule: CROSSING, x_mm: 100, y_mm: 100 },
      ]);
      expect(res.placed).toBe(1);
      const painted = res.doc.runs.filter((r) => (r.blockouts?.length ?? 0) > 0);
      expect(painted.map((r) => r.id)).toEqual(['horizontal']); // tie -> doc order
    });

    it('picks the run whose glass is nearest the finding', () => {
      // Nudge the finding 3mm along the vertical tube: it is still exactly on
      // the vertical run's centreline and 3mm off the horizontal one.
      const res = ops.placeBlockoutsFromCrossings(crossPair(), [
        { rule: CROSSING, x_mm: 100, y_mm: 103 },
      ]);
      const painted = res.doc.runs.filter((r) => (r.blockouts?.length ?? 0) > 0);
      expect(painted.map((r) => r.id)).toEqual(['vertical']);
    });

    it('a finding nowhere near any run is reported, not painted onto the nearest thing', () => {
      const doc = crossPair();
      const res = ops.placeBlockoutsFromCrossings(doc, [
        { rule: CROSSING, x_mm: 5000, y_mm: 5000 },
      ]);
      expect(res.unresolved).toBe(1);
      expect(res.placed).toBe(0);
      expect(res.doc).toBe(doc);
    });

    it('a finding with no coordinates is reported, not guessed at', () => {
      const doc = crossPair();
      const res = ops.placeBlockoutsFromCrossings(doc, [{ rule: CROSSING }]);
      expect(res.crossings).toBe(1);
      expect(res.unresolved).toBe(1);
      expect(res.doc).toBe(doc);
    });
  });

  // -- arcs ----------------------------------------------------------------
  describe('arc runs are measured on the curve, not the chord', () => {
    function arcRun(): DesignRun {
      return {
        id: 'bow',
        polyline: {
          points: [[0, 0], [100, 0]],
          closed: false,
          segment_types: ['arc'],
        },
        // 4mm tube => a 20mm snap tolerance (the 20mm floor), comfortably
        // less than the 25mm the bow stands off its chord.
        tube_diameter_mm: 4,
      };
    }

    it('a crossing on the bow is found even though it is 25mm off the chord', () => {
      const run = arcRun();
      const flat = flatRunPoints(run);
      let apex = flat[0];
      for (const p of flat) if (Math.abs(p[1]) > Math.abs(apex[1])) apex = p;
      // Vacuity guard: the fixture is only a test while the bow is far enough
      // off the chord that a chord-based measurement would MISS it.
      expect(distToPolylineMM([[0, 0], [100, 0]], apex)).toBeGreaterThan(20);

      const res = ops.placeBlockoutsFromCrossings(docOf([run]), [
        { rule: CROSSING, x_mm: apex[0], y_mm: apex[1] },
      ]);
      expect(res.placed).toBe(1);
      const b = onlyBlockout(res.doc.runs[0]);
      expect(distToPolylineMM(paintedPolyline(res.doc.runs[0], b), apex)).toBeLessThan(0.5);
    });

    it('leaves geometry and segment_types untouched on every run it paints', () => {
      const run: DesignRun = {
        id: 'mixed',
        polyline: {
          points: [[0, 0], [100, 0], [200, 0], [300, 0]],
          closed: false,
          segment_types: ['arc', 'line', 'arc_r'],
        },
        tube_diameter_mm: 12,
      };
      const doc = docOf([run]);
      const res = ops.placeBlockoutsFromCrossings(doc, [
        { rule: CROSSING, x_mm: 250, y_mm: 0 },
      ]);
      expect(res.placed).toBe(1);
      const after = res.doc.runs[0];
      // Not a point-count op: the vertex list and the arc list are identical.
      expect(after.polyline.points).toEqual(run.polyline.points);
      expect(after.polyline.segment_types).toEqual(['arc', 'line', 'arc_r']);
      expectWellFormedDoc(res.doc);
    });
  });
});

// ---------------------------------------------------------------------------
// Tier 2 #136 — circuits
// ---------------------------------------------------------------------------
describe('circuits', () => {
  function circuitDoc(): DesignDoc {
    const mk = (id: string, y: number): DesignRun => ({
      id,
      polyline: { points: [[0, y], [100, y]], closed: false },
      electrodes: [{ point_index: 0 }, { point_index: 1 }],
    });
    return {
      version: 1,
      view_box_mm: [0, 0, 200, 100],
      runs: [mk('r1', 0), mk('r2', 10), mk('r3', 20), mk('r4', 30)],
    };
  }

  it('allocates c1, c2, … and skips ids already taken', () => {
    const doc = circuitDoc();
    expect(ops.nextCircuitId(doc)).toBe('c1');
    const withOne = { ...doc, circuits: [{ id: 'c1' }, { id: 'c3' }, { id: 'left-bank' }] };
    // Non-matching ids do not eat integer slots.
    expect(ops.nextCircuitId(withOne)).toBe('c2');
  });

  it('wires four runs into one circuit without touching their electrodes', () => {
    const doc = circuitDoc();
    const { doc: next, circuitId } = ops.createCircuit(
      doc,
      ['r1', 'r2', 'r3', 'r4'],
      'Script',
    );
    expect(circuitId).toBe('c1');
    expect(next.circuits).toEqual([{ id: 'c1', name: 'Script' }]);
    expect(next.runs.map((r) => r.circuit_id)).toEqual(['c1', 'c1', 'c1', 'c1']);
    // The whole point: the derivation is what collapses, not the drawing.
    for (const r of next.runs) expect(r.electrodes).toHaveLength(2);
    // And the geometry is untouched.
    expect(next.runs.map((r) => r.polyline.points)).toEqual(
      doc.runs.map((r) => r.polyline.points),
    );
  });

  it('omits the name key for an unnamed circuit (matches Go omitempty)', () => {
    const { doc } = ops.createCircuit(circuitDoc(), ['r1'], '   ');
    expect(doc.circuits).toEqual([{ id: 'c1' }]);
    expect(JSON.stringify(doc.circuits)).not.toContain('name');
  });

  it('re-assigning replaces membership rather than adding a second one', () => {
    let doc = ops.createCircuit(circuitDoc(), ['r1', 'r2'], 'A').doc;
    doc = ops.createCircuit(doc, ['r2', 'r3'], 'B').doc;
    expect(doc.circuits?.map((c) => c.id)).toEqual(['c1', 'c2']);
    const byId = Object.fromEntries(doc.runs.map((r) => [r.id, r.circuit_id]));
    expect(byId).toEqual({ r1: 'c1', r2: 'c2', r3: 'c2', r4: undefined });
  });

  it('deletes the circuit_id key rather than blanking it', () => {
    const doc = ops.createCircuit(circuitDoc(), ['r1'], 'A').doc;
    const cleared = ops.assignRunsToCircuit(doc, ['r1'], '');
    expect('circuit_id' in cleared.runs[0]).toBe(false);
    expect(JSON.stringify(cleared)).not.toContain('circuit_id');
  });

  it('refuses to assign to a circuit that does not exist', () => {
    const doc = circuitDoc();
    // A dangling FK is a 400 from the Go decoder, so the op must not create
    // one. Same object back = editDoc pushes no undo entry.
    expect(ops.assignRunsToCircuit(doc, ['r1'], 'c9')).toBe(doc);
  });

  it('dissolve clears every member FK as well as the entry', () => {
    const doc = ops.createCircuit(circuitDoc(), ['r1', 'r2', 'r3'], 'A').doc;
    const after = ops.dissolveCircuit(doc, 'c1');
    expect(after.circuits).toEqual([]);
    // Leaving one behind would 400 the next save — this is the Tier 3 #140
    // failure mode, not tidiness.
    expect(JSON.stringify(after)).not.toContain('circuit_id');
    // Negative control: a doc that still has the entry is NOT clean.
    expect(JSON.stringify(doc)).toContain('circuit_id');
  });

  it('dissolve and rename are no-ops for an unknown id', () => {
    const doc = ops.createCircuit(circuitDoc(), ['r1'], 'A').doc;
    expect(ops.dissolveCircuit(doc, 'c9')).toBe(doc);
    expect(ops.renameCircuit(doc, 'c9', 'x')).toBe(doc);
    expect(ops.renameCircuit(doc, 'c1', 'A')).toBe(doc);
  });

  it('rename to an empty string drops the key', () => {
    const doc = ops.createCircuit(circuitDoc(), ['r1'], 'A').doc;
    const after = ops.renameCircuit(doc, 'c1', '  ');
    expect(after.circuits).toEqual([{ id: 'c1' }]);
  });

  it('circuitMemberIds lists members in doc order', () => {
    const doc = ops.createCircuit(circuitDoc(), ['r3', 'r1'], 'A').doc;
    expect(ops.circuitMemberIds(doc, 'c1')).toEqual(['r1', 'r3']);
    expect(ops.circuitMemberIds(doc, 'c9')).toEqual([]);
  });

  it('a circuit is orthogonal to groups and raceways', () => {
    // The same run can legitimately be in all three: a selection group, a
    // box, and a wiring circuit. Collapsing any two makes one answer wrong.
    let doc = circuitDoc();
    doc = ops.groupRuns(doc, ['r1', 'r2'], 'Trim').doc;
    doc = { ...doc, runs: doc.runs.map((r) => ({ ...r, raceway_id: 'rw1' })) };
    doc = ops.createCircuit(doc, ['r1', 'r2', 'r3'], 'Wire').doc;
    const r1 = doc.runs[0];
    expect(r1.group_id).toBe('g1');
    expect(r1.raceway_id).toBe('rw1');
    expect(r1.circuit_id).toBe('c1');
    // Dissolving the circuit leaves the other two alone.
    const after = ops.dissolveCircuit(doc, 'c1');
    expect(after.runs[0].group_id).toBe('g1');
    expect(after.runs[0].raceway_id).toBe('rw1');
  });
});
