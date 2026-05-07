import { describe, expect, it } from 'vitest';
import { rectToPoints } from './rect';

describe('rectToPoints', () => {
  it('emits 5 points (4 corners + closing duplicate) for a 100x50 rectangle', () => {
    const pts = rectToPoints(0, 0, 100, 50);
    expect(pts.length).toBe(5);
    // First === last so the polyline reads as closed under the
    // "first === last" convention.
    expect(pts[0]).toEqual(pts[4]);
  });

  it('reports a 100x50 bounding box for a 100x50 rectangle', () => {
    const pts = rectToPoints(0, 0, 100, 50);
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(0);
    expect(Math.max(...xs)).toBe(100);
    expect(Math.min(...ys)).toBe(0);
    expect(Math.max(...ys)).toBe(50);
  });

  it('produces 4 distinct corner points', () => {
    const pts = rectToPoints(10, 10, 30, 25);
    const corners = pts.slice(0, 4);
    const unique = new Set(corners.map((p) => `${p[0]},${p[1]}`));
    expect(unique.size).toBe(4);
  });

  it('normalizes corners regardless of click order', () => {
    const a = rectToPoints(50, 40, 10, 20);
    const b = rectToPoints(10, 20, 50, 40);
    expect(a).toEqual(b);
  });
});
