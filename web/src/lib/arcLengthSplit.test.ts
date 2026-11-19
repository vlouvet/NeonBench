// Tier 3 #178 — one measure of arc length on both sides: r*theta.
//
// The editor's runLengthMM decides what the auto-split cuts and what the
// overlong badge counts; Go's Polyline.LengthMM decides the takeoff, the PDF
// and the DXF. These constants are shared digit for digit with
// internal/designdoc/arclength_test.go and internal/validate/arclength_test.go,
// so drifting either side off r*theta fails a suite.
//
// The validator measures an arc a little UNDER r*theta (it flattens
// designdoc.ToSVG's cubics to 0.05mm), so a piece the auto-split calls short
// enough by r*theta is not flagged overlong. The Go suite pins that property
// and runs the real validator over the exact pieces this file pins.

import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun, SegmentKind } from '../api';
import { flatRunPoints, segmentCount, segmentLengthMM, segmentTypeAt } from './arcGeom';
import * as ops from './docOps';

// Shared with internal/designdoc/arclength_test.go.
const R_THETA_OPEN_ARC_100_MM = 115.91190225020152; // 250*atan(0.5)
const R_THETA_CLOSED_SQUARE_3ARCS_MM = 447.73570675060455;
const R_THETA_OPEN_ARC_900_MM = 1043.2071202518136; // 2250*atan(0.5)

// Shared with internal/validate/arclength_test.go.
const SPLIT_LIMIT_MM = 1043.0;
const SPLIT_LIMIT_TIGHT_MM = 1043.21;
const GO_VALIDATOR_OPEN_ARC_900_MM = 1043.2042;
const SPLIT_AT_LIMIT_PIECES: [number, number][][] = [
  [[0, 0], [621.1124405667608, 198.34212477490672]],
  [[621.1124405667608, 198.34212477490672], [900, 0], [1181.5144307849046, 199.1738888433693]],
  [[1181.5144307849046, 199.1738888433693], [1800, 0]],
];

const run = (
  points: [number, number][],
  segment_types: SegmentKind[],
  closed = false,
): DesignRun => ({ id: 'r1', polyline: { points, closed, segment_types } });

const docOf = (runs: DesignRun[]): DesignDoc => ({ version: 1, view_box_mm: [0, 0, 4000, 4000], runs });

// Two 900mm-chord arcs end to end: 2086.41mm of glass by r*theta.
const twoArcs = (): DesignRun => run([[0, 0], [900, 0], [1800, 0]], ['arc', 'arc']);

// The measure runLengthMM used before #178, kept only as a negative control.
const fiveDegreeMM = (r: DesignRun): number =>
  ops.chordLengthMM(flatRunPoints(r), !!r.polyline.closed);

describe('runLengthMM shared r*theta fixtures (Go twin: designdoc/arclength_test.go)', () => {
  const cases: [string, DesignRun, number][] = [
    ['open arc, 100mm chord', run([[0, 0], [100, 0]], ['arc']), R_THETA_OPEN_ARC_100_MM],
    ['flipped arc, 100mm chord', run([[0, 0], [100, 0]], ['arc_r']), R_THETA_OPEN_ARC_100_MM],
    [
      'closed square, three arcs',
      run([[0, 0], [100, 0], [100, 100], [0, 100]], ['arc', 'arc', 'arc', 'line'], true),
      R_THETA_CLOSED_SQUARE_3ARCS_MM,
    ],
    ['open arc, 900mm chord', run([[0, 0], [900, 0]], ['arc']), R_THETA_OPEN_ARC_900_MM],
  ];

  for (const [name, r, want] of cases) {
    it(`measures ${name} as the fixture`, () => {
      expect(Math.abs(ops.runLengthMM(r) - want)).toBeLessThan(1e-9);
      // The per-segment measure agrees: one definition, not two.
      const pts = r.polyline.points;
      let sum = 0;
      for (let i = 0; i < segmentCount(r); i++) {
        sum += segmentLengthMM(pts[i], pts[(i + 1) % pts.length], segmentTypeAt(r, i));
      }
      expect(Math.abs(sum - want)).toBeLessThan(1e-9);
      // Negative control: the 5° flattening is measurably short of the fixture.
      expect(want - fiveDegreeMM(r)).toBeGreaterThan(0.03);
    });
  }
});

describe('auto-split by r*theta is not flagged overlong (Go twin: validate/arclength_test.go)', () => {
  it('cuts two 900mm arcs into the pinned pieces at the shared limit', () => {
    const res = ops.autoSplitOverlongTubes(docOf([twoArcs()]), SPLIT_LIMIT_MM);
    expect(res.runsSplit).toBe(1);
    expect(res.doc.runs).toHaveLength(SPLIT_AT_LIMIT_PIECES.length);
    res.doc.runs.forEach((r, i) => {
      const want = SPLIT_AT_LIMIT_PIECES[i];
      expect(r.polyline.points).toHaveLength(want.length);
      r.polyline.points.forEach((p, j) => {
        expect(p[0]).toBeCloseTo(want[j][0], 9);
        expect(p[1]).toBeCloseTo(want[j][1], 9);
      });
      expect(ops.runLengthMM(r)).toBeLessThanOrEqual(SPLIT_LIMIT_MM);
    });
  });

  // What the old walk did at the same limit, reconstructed from its measure:
  // each intact arc measured under the limit, so two pieces at the middle
  // vertex looked fixed. The Go twin runs the real validator over those two
  // halves and gets two max_segment_length issues; GO_VALIDATOR_OPEN_ARC_900_MM
  // is the number it measures.
  it('negative control: the old 5° measure called a flagged piece short enough', () => {
    const half = run([[0, 0], [900, 0]], ['arc']);
    expect(fiveDegreeMM(half)).toBeLessThanOrEqual(SPLIT_LIMIT_MM);
    expect(Math.ceil(fiveDegreeMM(twoArcs()) / SPLIT_LIMIT_MM)).toBe(2);
    expect(GO_VALIDATOR_OPEN_ARC_900_MM).toBeGreaterThan(SPLIT_LIMIT_MM);
    // r*theta refuses the same half, so the new walk never emits it.
    expect(ops.runLengthMM(half)).toBeGreaterThan(SPLIT_LIMIT_MM);
    const res = ops.autoSplitOverlongTubes(docOf([twoArcs()]), SPLIT_LIMIT_MM);
    for (const r of res.doc.runs) {
      expect(r.polyline.points.length === 2 && segmentTypeAt(r, 0) === 'arc').toBe(false);
    }
  });

  // Just above r*theta the cut lands on the middle vertex and both arcs
  // survive, each within 0.003mm of the limit. The Go twin validates these two
  // pieces at the same limit and gets no issue.
  it('keeps both arcs intact at the tight limit, each at most the limit', () => {
    const res = ops.autoSplitOverlongTubes(docOf([twoArcs()]), SPLIT_LIMIT_TIGHT_MM);
    expect(res.doc.runs.map((r) => r.polyline.points)).toEqual([
      [[0, 0], [900, 0]],
      [[900, 0], [1800, 0]],
    ]);
    expect(res.doc.runs.map((r) => r.polyline.segment_types)).toEqual([['arc'], ['arc']]);
    for (const r of res.doc.runs) {
      expect(ops.runLengthMM(r)).toBeLessThanOrEqual(SPLIT_LIMIT_TIGHT_MM);
      expect(SPLIT_LIMIT_TIGHT_MM - ops.runLengthMM(r)).toBeLessThan(0.003);
    }
  });
});
