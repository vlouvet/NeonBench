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
    const a = g.arcFor(p0, p1, false)!;
    expect(a.radiusMM).toBeCloseTo(62.5, 9);          // 0.625 x chord
    expect(g.ARC_INCLUDED_ANGLE).toBeCloseTo(4 * Math.atan(0.5), 12);
    expect(a.lengthMM).toBeCloseTo(62.5 * 4 * Math.atan(0.5), 9);
    expect(a.lengthMM / 100).toBeCloseTo(1.15911, 4); // ~15.9% longer
  });

  it('puts both endpoints exactly on the circle', () => {
    const a = g.arcFor(p0, p1, false)!;
    for (const p of [p0, p1]) {
      expect(Math.hypot(p[0] - a.cx, p[1] - a.cy)).toBeCloseTo(a.radiusMM, 9);
    }
  });

  it('bows out by a quarter of the chord, on the (-dy, dx) side', () => {
    const pts = g.flattenSegment(p0, p1, 'arc');
    const apex = pts.reduce((b, p) => (Math.abs(p[1]) > Math.abs(b[1]) ? p : b), pts[0]);
    expect(Math.abs(apex[1])).toBeCloseTo(25, 1);
    expect(apex[1]).toBeGreaterThan(0);
    expect(pts[pts.length - 1]).toEqual(p1);
  });

  it('keeps every flattened sample on the circle', () => {
    const a = g.arcFor([10, 20], [90, 75], false)!;
    for (const p of g.flattenSegment([10, 20], [90, 75], 'arc')) {
      expect(Math.hypot(p[0] - a.cx, p[1] - a.cy)).toBeCloseTo(a.radiusMM, 6);
    }
  });

  it('treats a degenerate chord as a line rather than emitting NaN', () => {
    expect(g.arcFor([5, 5], [5, 5], false)).toBeNull();
    expect(g.arcFor([5, 5], [5, 5], true)).toBeNull();
    expect(g.segmentLengthMM([5, 5], [5, 5], 'arc')).toBe(0);
    expect(g.segmentLengthMM([5, 5], [5, 5], 'arc_r')).toBe(0);
    expect(g.flattenSegment([5, 5], [5, 5], 'arc')).toHaveLength(1);
    expect(g.arcCubics([5, 5], [5, 5], 'arc', false)).toEqual([]);
  });

  it('approximates the arc closely with its two cubics', () => {
    const a = g.arcFor(p0, p1, false)!;
    const cubics = g.arcCubics(p0, p1, 'arc', false);
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
    expect(g.arcCubics(p0, p1, 'arc', true).at(-1)).toMatchObject({ x: p0[0], y: p0[1] });
  });

  it('splits a segment leaving and rejoining at half the included angle', () => {
    const half = 2 * Math.atan(g.ARC_BULGE);
    const line = g.segmentTangents(p0, p1, 'line');
    expect(line.leaving).toEqual(line.arriving);
    const arc = g.segmentTangents(p0, p1, 'arc');
    expect(Math.atan2(arc.leaving[1], arc.leaving[0])).toBeCloseTo(half, 12);
    expect(Math.atan2(arc.arriving[1], arc.arriving[0])).toBeCloseTo(-half, 12);
  });
});

// Tier 3 #87 — the flipped side. Same chord, same circle size, other side.
describe('arcGeom signed arc side', () => {
  const p0: [number, number] = [0, 0];
  const p1: [number, number] = [100, 0];

  it('classifies the three segment kinds', () => {
    expect(g.isArcKind('line')).toBe(false);
    expect(g.isArcKind('arc')).toBe(true);
    expect(g.isArcKind('arc_r')).toBe(true);
    expect(g.arcKindFlipped('arc')).toBe(false);
    expect(g.arcKindFlipped('arc_r')).toBe(true);
    expect(g.flipArcKind('arc')).toBe('arc_r');
    expect(g.flipArcKind('arc_r')).toBe('arc');
    expect(g.flipArcKind('line')).toBe('line');
  });

  it("puts the flipped apex at the unflipped one's mirror in the chord", () => {
    const apexOf = (t: g.SegmentKind) => {
      const pts = g.flattenSegment(p0, p1, t);
      return pts.reduce((b, p) => (Math.abs(p[1]) > Math.abs(b[1]) ? p : b), pts[0]);
    };
    const left = apexOf('arc');
    const right = apexOf('arc_r');
    expect(left[1]).toBeGreaterThan(0);
    expect(right[1]).toBeLessThan(0);
    expect(right[0]).toBeCloseTo(left[0], 9);
    expect(right[1]).toBeCloseTo(-left[1], 9);
  });

  it('mirrors every flattened sample about the chord', () => {
    const a: [number, number] = [10, 20];
    const b: [number, number] = [90, 75];
    // Mirror about the chord ab, so the assertion holds on a chord that is not
    // axis-aligned: reflect across the infinite line through a and b.
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    const reflect = ([x, y]: [number, number]): [number, number] => {
      const t = ((x - a[0]) * dx + (y - a[1]) * dy) / len2;
      const fx = a[0] + t * dx;
      const fy = a[1] + t * dy;
      return [2 * fx - x, 2 * fy - y];
    };
    const left = g.flattenSegment(a, b, 'arc');
    const right = g.flattenSegment(a, b, 'arc_r');
    expect(right).toHaveLength(left.length);
    for (let i = 0; i < left.length; i++) {
      const [ex, ey] = reflect(left[i]);
      expect(right[i][0]).toBeCloseTo(ex, 6);
      expect(right[i][1]).toBeCloseTo(ey, 6);
    }
  });

  it('measures the two sides identically — a flip moves glass, it does not add any', () => {
    expect(g.segmentLengthMM(p0, p1, 'arc_r')).toBeCloseTo(g.segmentLengthMM(p0, p1, 'arc'), 12);
    expect(g.arcFor(p0, p1, true)!.radiusMM).toBeCloseTo(g.arcFor(p0, p1, false)!.radiusMM, 12);
    expect(g.arcFor(p0, p1, true)!.lengthMM).toBeCloseTo(g.arcFor(p0, p1, false)!.lengthMM, 12);
  });

  // The Go twin carries a SweepCCW flag; the TS Arc does not, so pin the same
  // fact the way this side can see it — the centre moves to the other side of
  // the chord, which is what makes the sweep run the other way and what the
  // DXF bulge SIGN encodes (asserted for real in internal/printdxf/arc_test.go
  // and against a live export in the PR).
  it('puts the centre on the opposite side of the chord', () => {
    const left = g.arcFor(p0, p1, false)!;
    const right = g.arcFor(p0, p1, true)!;
    expect(left.cy).toBeLessThan(0);
    expect(right.cy).toBeGreaterThan(0);
    expect(right.cy).toBeCloseTo(-left.cy, 9);
    expect(right.cx).toBeCloseTo(left.cx, 9);
  });

  it('swaps the sign of both tangent rotations', () => {
    const half = 2 * Math.atan(g.ARC_BULGE);
    const arc = g.segmentTangents(p0, p1, 'arc_r');
    expect(Math.atan2(arc.leaving[1], arc.leaving[0])).toBeCloseTo(-half, 12);
    expect(Math.atan2(arc.arriving[1], arc.arriving[0])).toBeCloseTo(half, 12);
  });

  it('draws the flipped cubics on the flipped side too', () => {
    const left = g.arcCubics(p0, p1, 'arc', false);
    const right = g.arcCubics(p0, p1, 'arc_r', false);
    expect(right).toHaveLength(left.length);
    for (let i = 0; i < left.length; i++) {
      expect(right[i].c1y).toBeCloseTo(-left[i].c1y, 9);
      expect(right[i].c2y).toBeCloseTo(-left[i].c2y, 9);
      expect(right[i].x).toBeCloseTo(left[i].x, 9);
    }
    expect(g.arcCubics(p0, p1, 'line', false)).toEqual([]);
  });
});

describe('arcGeom run helpers', () => {
  const run = (
    points: [number, number][],
    segment_types?: g.SegmentKind[],
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

  // Tier 3 #87 — curve-aware hit testing. The tolerance below stands in for
  // the canvas's hit stroke: what matters is that a click on the GLASS is
  // inside it and a click on empty air is not.
  describe('runPathDistanceMM', () => {
    // A 400 mm chord bows to a 100 mm sagitta at bulge 0.5, so its apex sits
    // at (200, +100) and a 25 mm tolerance cleanly separates "on the glass"
    // from "on the chord".
    const TOL_MM = 25;
    const chord: [number, number][] = [[0, 0], [400, 0]];
    // 20 mm inside the bow, measured down from the apex.
    const nearApex: [number, number] = [200, 80];

    it('measures to the segment, not to the nearest vertex', () => {
      const straight = run(chord);
      // Halfway along: 200 mm from either end, 1 mm from the tube. The old
      // vertex-distance test answered 200 and missed by any tolerance.
      expect(g.runPathDistanceMM(straight, [200, 1])).toBeCloseTo(1, 9);
    });

    it('selects a click 20 mm from a bowed apex, and misses the unbowed chord', () => {
      const curved = run(chord, ['arc']);
      const straight = run(chord);
      expect(g.runPathDistanceMM(curved, nearApex)).toBeLessThan(TOL_MM);
      expect(g.runPathDistanceMM(curved, nearApex)).toBeCloseTo(20, 0);
      // Same click, no bow: 80 mm of empty air away. Measuring to the chord
      // would have answered 80 for the curved run too — a miss on exactly the
      // segments that are most obviously curved.
      expect(g.runPathDistanceMM(straight, nearApex)).toBeCloseTo(80, 9);
      expect(g.runPathDistanceMM(straight, nearApex)).toBeGreaterThan(TOL_MM);
    });

    it('follows the flip: the same click misses once the bow moves', () => {
      const flipped = run(chord, ['arc_r']);
      expect(g.runPathDistanceMM(flipped, nearApex)).toBeGreaterThan(TOL_MM);
      expect(g.runPathDistanceMM(flipped, [200, -80])).toBeLessThan(TOL_MM);
    });

    it('closes the loop on a closed run, with and without arcs', () => {
      const square = run([[0, 0], [100, 0], [100, 100], [0, 100]], undefined, true);
      // Midpoint of the CLOSING segment (from [0,100] back to [0,0]).
      expect(g.runPathDistanceMM(square, [3, 50])).toBeCloseTo(3, 9);
      const curvedSquare = run(
        [[0, 0], [100, 0], [100, 100], [0, 100]],
        ['line', 'line', 'line', 'arc'],
        true,
      );
      // The closing segment runs [0,100] -> [0,0], i.e. direction (0,-1), so
      // its left-hand normal is (+1, 0): the bow reaches x = +25 at midpoint.
      expect(g.runPathDistanceMM(curvedSquare, [25, 50])).toBeLessThan(0.5);
    });

    it('answers Infinity for an empty run rather than NaN', () => {
      expect(g.runPathDistanceMM(run([]), [0, 0])).toBe(Infinity);
      expect(g.runPathDistanceMM(run([[3, 4]]), [0, 0])).toBeCloseTo(5, 9);
    });

    // The case that made EditorCanvas's nearestRunId pick the WRONG run. It is
    // what click-to-select on a validation marker uses, and it used to compare
    // distances to VERTICES. Here that inverts the answer.
    it('ranks runs by their glass, not by their vertices', () => {
      const marker: [number, number] = [200, -98];
      const a = run(chord, ['arc_r']);            // apex at (200, -100)
      const b = run([[150, -150], [250, -150]]);  // a short bar beyond the bow

      const nearestVertex = (r: typeof a) =>
        Math.min(...r.polyline.points.map((p) => Math.hypot(p[0] - marker[0], p[1] - marker[1])));

      // Old behaviour, reconstructed: B wins on vertex distance (72 vs 223),
      // so a marker sitting 2 mm off run A's glass selected run B.
      expect(nearestVertex(b)).toBeLessThan(nearestVertex(a));
      // New behaviour: A wins on path distance, by a factor of 25.
      expect(g.runPathDistanceMM(a, marker)).toBeLessThan(3);
      expect(g.runPathDistanceMM(b, marker)).toBeGreaterThan(50);
    });
  });
});
