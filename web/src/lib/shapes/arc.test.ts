import { describe, expect, it } from 'vitest';
import { threePointArcToPoints } from './arc';

describe('threePointArcToPoints', () => {
  it('endpoints are exactly p1 and p3', () => {
    const pts = threePointArcToPoints([0, 0], [50, 50], [100, 0]);
    expect(pts[0]).toEqual([0, 0]);
    expect(pts[pts.length - 1]).toEqual([100, 0]);
  });

  it('sample points lie on the circumscribed circle', () => {
    const p1: [number, number] = [0, 0];
    const p2: [number, number] = [50, 50];
    const p3: [number, number] = [100, 0];
    const pts = threePointArcToPoints(p1, p2, p3);
    // For these three points the circumscribed circle is centered at (50, 0)
    // with radius 50. Every emitted sample should satisfy that within 0.5mm.
    for (const [x, y] of pts) {
      const d = Math.hypot(x - 50, y - 0);
      expect(Math.abs(d - 50)).toBeLessThan(0.5);
    }
  });

  it('falls back to a straight 2-point line when the three points are collinear', () => {
    const pts = threePointArcToPoints([0, 0], [50, 0], [100, 0]);
    expect(pts).toEqual([
      [0, 0],
      [100, 0],
    ]);
  });

  it('returns at least 9 points (8 segments) for a tight arc', () => {
    const pts = threePointArcToPoints([0, 0], [1, 1], [2, 0]);
    expect(pts.length).toBeGreaterThanOrEqual(9);
  });

  it('polyline midpoint sits on the arc within 0.5mm of the geometric center', () => {
    // Three points (0,0), (50,50), (100,0) → circumscribed circle centered
    // at (50, 0), radius 50. The polyline's middle sample should be on that
    // circle — i.e. distance to center is 50mm within tight tolerance.
    const pts = threePointArcToPoints([0, 0], [50, 50], [100, 0]);
    const mid = pts[Math.floor(pts.length / 2)];
    const d = Math.hypot(mid[0] - 50, mid[1] - 0);
    expect(Math.abs(d - 50)).toBeLessThan(0.5);
  });
});
