import { describe, expect, it } from 'vitest';
import type { DesignRun } from '../api';
import * as g from './arcGeom';

// These are the SAME numbers internal/designdoc/arc_test.go pins. The editor
// draws from arcGeom.ts while the printed pattern, the DXF and the validator
// derive from arc.go — if the two drift, an operator sees one curve on screen
// and gets a different one on the bench. Changing either side alone fails here.
describe('arcGeom matches the Go implementation', () => {
  const p0: [number, number] = [0, 0];
  const p1: [number, number] = [100, 0];

  it('derives radius, angle and length from the bulge alone', () => {
    expect(g.ARC_BULGE).toBe(0.5);
    const a = g.arcFor(p0, p1)!;
    expect(a.radiusMM).toBeCloseTo(62.5, 9);          // 0.625 x chord
    expect(g.ARC_INCLUDED_ANGLE).toBeCloseTo(4 * Math.atan(0.5), 12);
    expect(a.lengthMM).toBeCloseTo(62.5 * 4 * Math.atan(0.5), 9);
    expect(a.lengthMM / 100).toBeCloseTo(1.15911, 4); // ~15.9% longer
  });

  it('puts both endpoints exactly on the circle', () => {
    const a = g.arcFor(p0, p1)!;
    for (const p of [p0, p1]) {
      expect(Math.hypot(p[0] - a.cx, p[1] - a.cy)).toBeCloseTo(a.radiusMM, 9);
    }
  });

  it('bows out by a quarter of the chord, on the (-dy, dx) side', () => {
    const pts = g.flattenSegment(p0, p1, true);
    const apex = pts.reduce((b, p) => (Math.abs(p[1]) > Math.abs(b[1]) ? p : b), pts[0]);
    expect(Math.abs(apex[1])).toBeCloseTo(25, 1);
    expect(apex[1]).toBeGreaterThan(0);
    expect(pts[pts.length - 1]).toEqual(p1);
  });

  it('keeps every flattened sample on the circle', () => {
    const a = g.arcFor([10, 20], [90, 75])!;
    for (const p of g.flattenSegment([10, 20], [90, 75], true)) {
      expect(Math.hypot(p[0] - a.cx, p[1] - a.cy)).toBeCloseTo(a.radiusMM, 6);
    }
  });

  it('treats a degenerate chord as a line rather than emitting NaN', () => {
    expect(g.arcFor([5, 5], [5, 5])).toBeNull();
    expect(g.segmentLengthMM([5, 5], [5, 5], true)).toBe(0);
    expect(g.flattenSegment([5, 5], [5, 5], true)).toHaveLength(1);
    expect(g.arcCubics([5, 5], [5, 5], false)).toEqual([]);
  });

  it('approximates the arc closely with its two cubics', () => {
    const a = g.arcFor(p0, p1)!;
    const cubics = g.arcCubics(p0, p1, false);
    expect(cubics).toHaveLength(2);
    // Sample both cubics and check every point sits on the circle.
    let cur = p0;
    for (const c of cubics) {
      for (let t = 0; t <= 1; t += 0.05) {
        const mt = 1 - t;
        const x = mt ** 3 * cur[0] + 3 * mt ** 2 * t * c.c1x + 3 * mt * t ** 2 * c.c2x + t ** 3 * c.x;
        const y = mt ** 3 * cur[1] + 3 * mt ** 2 * t * c.c1y + 3 * mt * t ** 2 * c.c2y + t ** 3 * c.y;
        expect(Math.abs(Math.hypot(x - a.cx, y - a.cy) - a.radiusMM)).toBeLessThan(0.01);
      }
      cur = [c.x, c.y];
    }
    expect(cur).toEqual(p1);
  });

  it('reverses the cubics to end where the forward pair started', () => {
    expect(g.arcCubics(p0, p1, true).at(-1)).toMatchObject({ x: p0[0], y: p0[1] });
  });

  it('splits a segment leaving and rejoining at half the included angle', () => {
    const half = 2 * Math.atan(g.ARC_BULGE);
    const line = g.segmentTangents(p0, p1, false);
    expect(line.leaving).toEqual(line.arriving);
    const arc = g.segmentTangents(p0, p1, true);
    expect(Math.atan2(arc.leaving[1], arc.leaving[0])).toBeCloseTo(half, 12);
    expect(Math.atan2(arc.arriving[1], arc.arriving[0])).toBeCloseTo(-half, 12);
  });
});

describe('arcGeom run helpers', () => {
  const run = (
    points: [number, number][],
    segment_types?: ('line' | 'arc')[],
    closed = false,
  ): DesignRun => ({ id: 'r', polyline: { points, closed, ...(segment_types ? { segment_types } : {}) } });

  it('defaults to line everywhere when the array is absent', () => {
    const r = run([[0, 0], [1, 0], [2, 0]]);
    for (const i of [-1, 0, 1, 2, 99]) expect(g.segmentTypeAt(r, i)).toBe('line');
    expect(g.runHasArcs(r)).toBe(false);
    expect(g.flatRunPoints(r)).toBe(r.polyline.points);
  });

  it('counts segments, including the closing one', () => {
    expect(g.segmentCount(run([[0, 0]]))).toBe(0);
    expect(g.segmentCount(run([[0, 0], [1, 0]]))).toBe(1);
    expect(g.segmentCount(run([[0, 0], [1, 0], [2, 0]]))).toBe(2);
    expect(g.segmentCount(run([[0, 0], [1, 0], [2, 0]], undefined, true))).toBe(3);
  });

  it('resolves which segment joins two walk positions, and its direction', () => {
    expect(g.segmentIndexBetween(0, 1, 5, false)).toEqual({ seg: 0, reversed: false });
    expect(g.segmentIndexBetween(1, 0, 5, false)).toEqual({ seg: 0, reversed: true });
    expect(g.segmentIndexBetween(4, 0, 5, true)).toEqual({ seg: 4, reversed: false });
    expect(g.segmentIndexBetween(0, 4, 5, true)).toEqual({ seg: 4, reversed: true });
    expect(g.segmentIndexBetween(0, 3, 5, false)).toBeNull();
  });

  it('measures a walk step across an arc in either direction', () => {
    const r = run([[0, 0], [100, 0], [200, 0]], ['line', 'arc']);
    const wantArc = 62.5 * 4 * Math.atan(0.5);
    expect(g.walkSegmentLengthMM(r, 0, 1)).toBeCloseTo(100, 9);
    expect(g.walkSegmentLengthMM(r, 1, 2)).toBeCloseTo(wantArc, 9);
    expect(g.walkSegmentLengthMM(r, 2, 1)).toBeCloseTo(wantArc, 9);
    expect(g.walkSegmentLengthMM(r, 0, 2)).toBeCloseTo(200, 9); // a jump, not a segment
    expect(g.walkSegmentLengthMM(r, 0, 99)).toBe(0);
  });

  it('turns at an arc junction by half the included angle', () => {
    const halfDeg = (2 * Math.atan(g.ARC_BULGE) * 180) / Math.PI;
    const pts: [number, number][] = [[0, 0], [100, 0], [200, 0]];
    expect(g.vertexTurnDeg(run(pts), 0, 1, 2)).toBeCloseTo(0, 9);
    expect(g.vertexTurnDeg(run(pts, ['arc', 'line']), 0, 1, 2)).toBeCloseTo(halfDeg, 9);
    expect(g.vertexTurnDeg(run(pts, ['line', 'arc']), 0, 1, 2)).toBeCloseTo(halfDeg, 9);
    expect(g.vertexTurnDeg(run(pts, ['arc', 'arc']), 0, 1, 2)).toBeCloseTo(2 * halfDeg, 9);
  });

  it('mirrors the turn when the walk runs backwards', () => {
    const r = run([[0, 0], [100, 0], [200, 0]], ['line', 'arc']);
    expect(g.vertexTurnDeg(r, 0, 1, 2)).toBeCloseTo(-g.vertexTurnDeg(r, 2, 1, 0), 9);
  });

  it('reports the arc radius at a vertex an arc meets', () => {
    const r = run([[0, 0], [100, 0], [100, 100]], ['arc', 'line']);
    expect(g.vertexArcRadiusMM(r, 0, 1, 2)).toBeCloseTo(62.5, 9);
    expect(g.vertexArcRadiusMM(run([[0, 0], [100, 0], [100, 100]]), 0, 1, 2)).toBe(0);
  });

  it('expands arcs when flattening a run, and only then', () => {
    const straight = run([[0, 0], [100, 0]]);
    expect(g.flatRunPoints(straight)).toHaveLength(2);
    const curved = run([[0, 0], [100, 0]], ['arc']);
    const flat = g.flatRunPoints(curved);
    expect(flat.length).toBeGreaterThan(20);
    expect(flat[0]).toEqual([0, 0]);
    expect(flat[flat.length - 1]).toEqual([100, 0]);
  });
});
