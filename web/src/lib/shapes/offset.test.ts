import { describe, expect, it } from 'vitest';
import { offsetPolygon, signedArea } from './offset';

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
