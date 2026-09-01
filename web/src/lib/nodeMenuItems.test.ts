import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { availableActionsForVertex, type NodeMenuActionId } from './nodeMenuItems';

const docOf = (runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 1000, 1000],
  runs,
});

// A 5-vertex open line: indices 0..4 along +X.
const openRun = (over: Partial<DesignRun> = {}): DesignRun => ({
  id: 'r1',
  polyline: {
    points: [[0, 0], [100, 0], [200, 0], [300, 0], [400, 0]],
    closed: false,
  },
  ...over,
});

// A 4-vertex closed square.
const closedRun = (over: Partial<DesignRun> = {}): DesignRun => ({
  id: 'r1',
  polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
  ...over,
});

const idsAt = (doc: DesignDoc, vi: number): NodeMenuActionId[] =>
  availableActionsForVertex(doc, 'r1', vi).map((i) => i.id);

describe('availableActionsForVertex', () => {
  it('offers the full mid-polyline set on an open run', () => {
    const ids = idsAt(docOf([openRun()]), 2);
    expect(ids).toEqual([
      'insert-vertex',
      'insert-doubleback',
      'convert-to-arc',
      'split-run',
      'place-electrode',
      'blockout-from-here',
      'mark-jump',
      'mark-support',
      'mark-doubleback',
      'mark-drop-bend',
      'mark-special-bend',
      'delete-vertex',
    ]);
  });

  it('returns nothing for an unknown run or an out-of-range vertex', () => {
    const doc = docOf([openRun()]);
    expect(availableActionsForVertex(doc, 'nope', 0)).toEqual([]);
    expect(idsAt(doc, -1)).toEqual([]);
    expect(idsAt(doc, 5)).toEqual([]);
  });

  // insertVertex / insertDoubleback address the segment AFTER the vertex,
  // and the last vertex has none.
  it('drops the forward-segment actions on the last vertex', () => {
    const ids = idsAt(docOf([openRun()]), 4);
    expect(ids).not.toContain('insert-vertex');
    expect(ids).not.toContain('insert-doubleback');
  });

  it('drops insert-doubleback on a zero-length forward segment', () => {
    const run = openRun();
    run.polyline.points[3] = [200, 0]; // duplicate of vertex 2
    const ids = idsAt(docOf([run]), 2);
    expect(ids).toContain('insert-vertex');
    expect(ids).not.toContain('insert-doubleback');
  });

  // splitRun requires 0 < i < n-1 so each piece keeps two points.
  it('offers split-run only strictly inside an open run', () => {
    const doc = docOf([openRun()]);
    expect(idsAt(doc, 0)).not.toContain('split-run');
    expect(idsAt(doc, 4)).not.toContain('split-run');
    expect(idsAt(doc, 1)).toContain('split-run');
    expect(idsAt(doc, 3)).toContain('split-run');
  });

  // Splitting a closed run drops its closing segment, so the correct route
  // is to break the loop open first. The menu offers that instead.
  it('offers break-loop-open, never split-run, on a closed run', () => {
    const ids = idsAt(docOf([closedRun()]), 2);
    expect(ids).toContain('break-loop-open');
    expect(ids).not.toContain('split-run');
  });

  it('withholds break-loop-open from a closed run too small to open', () => {
    const run = closedRun();
    run.polyline.points = [[0, 0], [100, 0]];
    expect(idsAt(docOf([run]), 1)).not.toContain('break-loop-open');
  });

  it('offers move-opening only on an open run with exactly two electrodes', () => {
    const two = openRun({ electrodes: [{ point_index: 0 }, { point_index: 4 }] });
    expect(idsAt(docOf([two]), 2)).toContain('move-opening');

    const one = openRun({ electrodes: [{ point_index: 0 }] });
    expect(idsAt(docOf([one]), 2)).not.toContain('move-opening');

    expect(idsAt(docOf([openRun()]), 2)).not.toContain('move-opening');
  });

  // Rotating the polyline to start where it already starts changes nothing.
  it('withholds move-opening at vertex 0, where it would be a no-op', () => {
    const two = openRun({ electrodes: [{ point_index: 0 }, { point_index: 4 }] });
    expect(idsAt(docOf([two]), 0)).not.toContain('move-opening');
  });

  it('swaps place-electrode for the housing pair on an electrode vertex', () => {
    const run = openRun({ electrodes: [{ point_index: 0 }, { point_index: 4 }] });
    const ids = idsAt(docOf([run]), 0);
    expect(ids).not.toContain('place-electrode');
    expect(ids).toContain('add-housing');
    expect(ids).toContain('delete-electrode');
  });

  // placeElectrode relocates the nearer of two rather than refusing, so the
  // label has to stop promising a third electrode.
  it('relabels place-electrode once two electrodes exist', () => {
    const bare = availableActionsForVertex(docOf([openRun()]), 'r1', 2);
    expect(bare.find((i) => i.id === 'place-electrode')?.label).toBe('Place electrode here');

    const run = openRun({ electrodes: [{ point_index: 0 }, { point_index: 4 }] });
    const full = availableActionsForVertex(docOf([run]), 'r1', 2);
    expect(full.find((i) => i.id === 'place-electrode')?.label).toBe(
      'Move nearest electrode here',
    );
  });

  // Annotations and bends anchor by LIVE index. On a closed loop with two
  // electrodes the dead arc has no live index, so nothing can anchor there.
  it('withholds every mark on a closed loop’s dead arc', () => {
    // Octagon so the two arcs are unambiguous; electrodes at 0 and 4 make
    // 1..3 one arc and 5..7 the other.
    const pts: [number, number][] = [];
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      pts.push([100 + 50 * Math.cos(a), 100 + 50 * Math.sin(a)]);
    }
    const run: DesignRun = {
      id: 'r1',
      polyline: { points: pts, closed: true },
      electrodes: [{ point_index: 0 }, { point_index: 4 }],
      direction: 'forward',
    };
    const doc = docOf([run]);
    // Forward walk is 0,1,2,3,4 — so 2 is live and 6 is not.
    expect(idsAt(doc, 2)).toContain('mark-jump');
    expect(idsAt(doc, 2)).toContain('blockout-from-here');
    expect(idsAt(doc, 6)).not.toContain('mark-jump');
    expect(idsAt(doc, 6)).not.toContain('blockout-from-here');
    expect(idsAt(doc, 6)).not.toContain('mark-special-bend');
  });

  // deleteVertex refuses below the minimum, so the menu must not offer it.
  it('withholds delete-vertex at the minimum vertex count', () => {
    const twoPt: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0]], closed: false },
    };
    expect(idsAt(docOf([twoPt]), 0)).not.toContain('delete-vertex');

    const triangle: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [100, 0], [50, 100]], closed: true },
    };
    expect(idsAt(docOf([triangle]), 1)).not.toContain('delete-vertex');

    expect(idsAt(docOf([closedRun()]), 1)).toContain('delete-vertex');
  });

  it('never returns a duplicate action', () => {
    const cases: DesignRun[] = [
      openRun(),
      openRun({ electrodes: [{ point_index: 0 }, { point_index: 4 }] }),
      closedRun(),
      closedRun({ electrodes: [{ point_index: 0 }, { point_index: 2 }] }),
    ];
    for (const run of cases) {
      for (let vi = 0; vi < run.polyline.points.length; vi++) {
        const ids = idsAt(docOf([run]), vi);
        expect(new Set(ids).size).toBe(ids.length);
      }
    }
  });

  it('always offers at least one action on a well-formed vertex', () => {
    const doc = docOf([openRun()]);
    for (let vi = 0; vi < 5; vi++) expect(idsAt(doc, vi).length).toBeGreaterThan(0);
  });
});

// Tier 3 #78 — the conversion items #76 deliberately deferred until arcs
// existed. Only one of the pair ever shows: offering "convert to line" on a
// segment that is already straight is a row that does nothing.
describe('availableActionsForVertex — arc conversion', () => {
  const docOf = (runs: DesignRun[]): DesignDoc => ({
    version: 1,
    view_box_mm: [0, 0, 400, 400],
    runs,
  });
  const straight = (): DesignRun => ({
    id: 'r1',
    polyline: { points: [[0, 0], [100, 0], [200, 0]], closed: false },
  });

  it('offers convert-to-arc on a straight segment', () => {
    const ids = availableActionsForVertex(docOf([straight()]), 'r1', 0).map((i) => i.id);
    expect(ids).toContain('convert-to-arc');
    expect(ids).not.toContain('convert-to-line');
  });

  it('offers convert-to-line once the segment is curved', () => {
    const run = straight();
    run.polyline.segment_types = ['arc', 'line'];
    const ids = availableActionsForVertex(docOf([run]), 'r1', 0).map((i) => i.id);
    expect(ids).toContain('convert-to-line');
    expect(ids).not.toContain('convert-to-arc');
  });

  // Both act on the segment LEAVING the vertex, so the last vertex of an open
  // run has nothing to convert.
  it('offers neither on the last vertex of an open run', () => {
    const ids = availableActionsForVertex(docOf([straight()]), 'r1', 2).map((i) => i.id);
    expect(ids).not.toContain('convert-to-arc');
    expect(ids).not.toContain('convert-to-line');
  });

  it('offers neither across a zero-length segment', () => {
    const run: DesignRun = {
      id: 'r1',
      polyline: { points: [[0, 0], [0, 0], [100, 0]], closed: false },
    };
    const ids = availableActionsForVertex(docOf([run]), 'r1', 0).map((i) => i.id);
    expect(ids).not.toContain('convert-to-arc');
  });

  it('reads the type per segment, not per run', () => {
    const run = straight();
    run.polyline.segment_types = ['arc', 'line'];
    expect(availableActionsForVertex(docOf([run]), 'r1', 0).map((i) => i.id))
      .toContain('convert-to-line');
    expect(availableActionsForVertex(docOf([run]), 'r1', 1).map((i) => i.id))
      .toContain('convert-to-arc');
  });
});
