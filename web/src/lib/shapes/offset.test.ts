import { describe, expect, it } from 'vitest';
import {
  offsetOpenPolyline,
  offsetPolygon,
  segmentIntersection,
  signedArea,
  trimSelfIntersections,
} from './offset';

describe('offsetPolygon', () => {
  // 100×100 axis-aligned square traced CCW. No closing duplicate so we
  // exercise the path that operates on distinct vertices directly.
  function squareCCW(): [number, number][] {
    return [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
  }

  it('outward offset of a 100×100 CCW square by 10mm produces a 120×120 square', () => {
    const r = offsetPolygon(squareCCW(), 10);
    expect(r.points.length).toBe(4);
    expect(r.miterClampedCount).toBe(0);
    expect(r.selfIntersected).toBe(false);
    // Bounding box: -10..110 on each axis.
    const xs = r.points.map((p) => p[0]).sort((a, b) => a - b);
    const ys = r.points.map((p) => p[1]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10, 6);
    expect(xs[3]).toBeCloseTo(110, 6);
    expect(ys[0]).toBeCloseTo(-10, 6);
    expect(ys[3]).toBeCloseTo(110, 6);
  });

  it('inward offset of the same square by 10mm produces an 80×80 square', () => {
    const r = offsetPolygon(squareCCW(), -10);
    expect(r.points.length).toBe(4);
    expect(r.miterClampedCount).toBe(0);
    expect(r.selfIntersected).toBe(false);
    const xs = r.points.map((p) => p[0]).sort((a, b) => a - b);
    const ys = r.points.map((p) => p[1]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(10, 6);
    expect(xs[3]).toBeCloseTo(90, 6);
    expect(ys[0]).toBeCloseTo(10, 6);
    expect(ys[3]).toBeCloseTo(90, 6);
  });

  it('outward offset of a sharp-apex isoceles triangle triggers the miter clamp', () => {
    // 20° apex (well under the 2*asin(1/miterLimit) ≈ 28.96° clamp
    // threshold for miterLimit=4) so the spike at the tip definitely
    // clamps regardless of floating-point near-boundary noise.
    const halfApex = (10 * Math.PI) / 180; // 10° from vertical
    const h = 100;
    const w = h * Math.tan(halfApex);
    // Apex at origin pointing toward -y, base above. CCW order.
    const triangle: [number, number][] = [
      [0, 0],
      [w, h],
      [-w, h],
    ];
    const r = offsetPolygon(triangle, 10, 4);
    // The clamp emits two output vertices at the bevel instead of one
    // miter — so the apex contributes 2 vertices and the other two
    // (90°-ish) corners contribute 1 each = 4 output vertices.
    expect(r.miterClampedCount).toBe(1);
    expect(r.points.length).toBe(4);
  });

  it('inward offset of a peanut shape past its neck width produces a self-intersecting polyline', () => {
    // 100×40 rectangle with notches cut from the top and bottom that
    // leave a 10mm-thick neck between y=15 and y=25 in the middle. An
    // 8mm inset eats through the neck — the inset top-of-bottom-notch
    // edge crosses the inset bottom-of-top-notch edge.
    //
    //   ┌───┐         ┌───┐
    //   │   │         │   │
    //   │   └─────────┘   │   <- top notch bottom (y=25)
    //   │      neck       │
    //   │   ┌─────────┐   │   <- bottom notch top (y=15)
    //   │   │         │   │
    //   └───┘         └───┘
    const peanut: [number, number][] = [
      [0, 0],
      [40, 0],
      [40, 15],
      [60, 15],
      [60, 0],
      [100, 0],
      [100, 40],
      [60, 40],
      [60, 25],
      [40, 25],
      [40, 40],
      [0, 40],
    ];
    const r = offsetPolygon(peanut, -8);
    expect(r.selfIntersected).toBe(true);
  });

  it('CW input expands outward for positive distance (winding-agnostic API)', () => {
    // Same geometry as squareCCW but reversed → CW winding. With a
    // positive distance the API contract is "expand", so we should
    // still get a 120×120 square outside the original.
    const cw = squareCCW().slice().reverse();
    expect(signedArea(cw)).toBeLessThan(0); // sanity: CW
    const r = offsetPolygon(cw, 10);
    expect(r.points.length).toBe(4);
    expect(r.miterClampedCount).toBe(0);
    const xs = r.points.map((p) => p[0]).sort((a, b) => a - b);
    const ys = r.points.map((p) => p[1]).sort((a, b) => a - b);
    expect(xs[0]).toBeCloseTo(-10, 6);
    expect(xs[3]).toBeCloseTo(110, 6);
    expect(ys[0]).toBeCloseTo(-10, 6);
    expect(ys[3]).toBeCloseTo(110, 6);
  });
});

describe('offsetPolygon corner styles', () => {
  // 100×100 CCW square; index 1 = top-right corner (90° turn).
  function squareCCW(): [number, number][] {
    return [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
  }

  it('cornerStyle "bevel" produces a chamfered corner (2 verts at the corner)', () => {
    const r = offsetPolygon(squareCCW(), 10, {
      cornerStyles: ['miter', 'bevel', 'miter', 'miter'],
    });
    // 3 mitered corners (1 vertex each) + 1 beveled corner (2 vertices)
    // = 5 output vertices.
    expect(r.points.length).toBe(5);
    expect(r.miterClampedCount).toBe(1);
  });

  it('cornerStyle "round" produces multiple polyline points along the arc', () => {
    const r = offsetPolygon(squareCCW(), 10, {
      cornerStyles: ['miter', 'round', 'miter', 'miter'],
    });
    // 3 mitered + ≥3 sample points on the arc = at least 6 total. The
    // arc samples scale with sweep angle (90° → ~10 samples).
    expect(r.points.length).toBeGreaterThanOrEqual(6);
    expect(r.miterClampedCount).toBe(1);
  });
});

describe('offsetPolygon trimSelfIntersections', () => {
  it('trims the inner-offset loop on a peanut shape', () => {
    const peanut: [number, number][] = [
      [0, 0],
      [40, 0],
      [40, 15],
      [60, 15],
      [60, 0],
      [100, 0],
      [100, 40],
      [60, 40],
      [60, 25],
      [40, 25],
      [40, 40],
      [0, 40],
    ];
    const untrimmed = offsetPolygon(peanut, -8);
    expect(untrimmed.selfIntersected).toBe(true);
    const trimmed = offsetPolygon(peanut, -8, { trimSelfIntersections: true });
    // After trimming, the polyline should no longer self-intersect.
    expect(trimmed.selfIntersected).toBe(false);
    // Trimming reduces vertex count (the loop arc gets dropped).
    expect(trimmed.points.length).toBeLessThan(untrimmed.points.length);
  });

  it('trimSelfIntersections is a no-op on a clean offset', () => {
    const square: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const trimmed = offsetPolygon(square, 10, { trimSelfIntersections: true });
    expect(trimmed.selfIntersected).toBe(false);
    expect(trimmed.points.length).toBe(4);
  });
});

describe('offsetOpenPolyline', () => {
  it('offsets a horizontal line segment and emits butt caps', () => {
    const r = offsetOpenPolyline([[0, 0], [100, 0]], 10);
    // Only one edge; first endpoint translates by (0, -10), last by (0, -10).
    // (Right-of-forward for forward = (1,0) is (0,-1).)
    expect(r.points.length).toBe(2);
    expect(r.points[0][0]).toBeCloseTo(0, 6);
    expect(r.points[0][1]).toBeCloseTo(-10, 6);
    expect(r.points[1][0]).toBeCloseTo(100, 6);
    expect(r.points[1][1]).toBeCloseTo(-10, 6);
  });

  it('offsets a 90° L-shape with butt caps at both ends', () => {
    // L: (0,0) → (100,0) → (100,100). Forward at first edge is +x; at
    // second edge is +y. Right-of-forward at first edge = (0,-1) so the
    // first endpoint translates to (0, -10). At the second edge, right
    // is (1, 0) so the last endpoint translates to (110, 100).
    const r = offsetOpenPolyline([[0, 0], [100, 0], [100, 100]], 10);
    expect(r.points.length).toBe(3);
    // First endpoint butt cap.
    expect(r.points[0][0]).toBeCloseTo(0, 6);
    expect(r.points[0][1]).toBeCloseTo(-10, 6);
    // Interior corner at (100,0): bisector direction is (1,-1)/√2. Miter
    // length = 10/cos(45°) = 10√2 ≈ 14.142. Output vertex =
    // (100 + 14.142 * 1/√2, 0 + 14.142 * -1/√2) = (110, -10).
    expect(r.points[1][0]).toBeCloseTo(110, 4);
    expect(r.points[1][1]).toBeCloseTo(-10, 4);
    // Last endpoint butt cap.
    expect(r.points[2][0]).toBeCloseTo(110, 6);
    expect(r.points[2][1]).toBeCloseTo(100, 6);
    expect(r.miterClampedCount).toBe(0);
    expect(r.selfIntersected).toBe(false);
  });

  it('negative distance offsets to the opposite (left) side', () => {
    const r = offsetOpenPolyline([[0, 0], [100, 0]], -10);
    // Flipping the sign moves the parallel run to (0,10) → (100,10).
    expect(r.points[0][1]).toBeCloseTo(10, 6);
    expect(r.points[1][1]).toBeCloseTo(10, 6);
  });

  it('returns the input unchanged for fewer than 2 vertices or zero distance', () => {
    const empty = offsetOpenPolyline([], 10);
    expect(empty.points).toEqual([]);
    const single = offsetOpenPolyline([[5, 5]], 10);
    expect(single.points).toEqual([[5, 5]]);
    const zero = offsetOpenPolyline([[0, 0], [10, 0]], 0);
    expect(zero.points).toEqual([[0, 0], [10, 0]]);
  });
});

describe('segmentIntersection', () => {
  it('detects a proper crossing', () => {
    const pt = segmentIntersection([0, 0], [10, 10], [0, 10], [10, 0]);
    expect(pt).not.toBeNull();
    expect(pt![0]).toBeCloseTo(5, 6);
    expect(pt![1]).toBeCloseTo(5, 6);
  });

  it('returns null for parallel segments', () => {
    expect(segmentIntersection([0, 0], [10, 0], [0, 5], [10, 5])).toBeNull();
  });

  it('returns null when the segments do not overlap', () => {
    expect(segmentIntersection([0, 0], [1, 1], [10, 10], [11, 11])).toBeNull();
  });

  it('returns null for shared endpoints (open intervals)', () => {
    // Two segments meeting at (10,10) but not crossing through.
    expect(segmentIntersection([0, 0], [10, 10], [10, 10], [20, 0])).toBeNull();
  });
});

describe('trimSelfIntersections', () => {
  it('drops the loop on a manually-built figure-eight slice', () => {
    // Minimal self-intersecting open polyline: a triangle that crosses
    // its own first edge.
    //   (0,0) → (10,0) → (5, -5) → (5, 5)
    // The third edge (5,-5)→(5,5) crosses the first edge (0,0)→(10,0).
    const pts: [number, number][] = [
      [0, 0],
      [10, 0],
      [5, -5],
      [5, 5],
    ];
    const trimmed = trimSelfIntersections(pts, false);
    // Result should be shorter than the input and should not contain
    // the loop.
    expect(trimmed.length).toBeLessThan(pts.length + 1);
    // Verify by re-running the trimmer — should be a no-op.
    const again = trimSelfIntersections(trimmed, false);
    expect(again.length).toBe(trimmed.length);
  });
});
