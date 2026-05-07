import { describe, expect, it } from 'vitest';
import { circleToPoints } from './circle';

describe('circleToPoints', () => {
  it('emits segments+1 points (closing duplicate) by default', () => {
    const pts = circleToPoints(0, 0, 100);
    expect(pts.length).toBe(65);
    expect(pts[0]).toEqual(pts[64]);
  });

  it('every point lies within 1.5mm of the target radius (chord error)', () => {
    const pts = circleToPoints(50, 50, 100, 64);
    for (const [x, y] of pts) {
      const d = Math.hypot(x - 50, y - 50);
      expect(Math.abs(d - 100)).toBeLessThan(1.5);
    }
  });

  it('respects a custom segment count', () => {
    const pts = circleToPoints(0, 0, 50, 32);
    expect(pts.length).toBe(33);
  });

  it('clamps below 3 segments', () => {
    const pts = circleToPoints(0, 0, 10, 1);
    // Even when asked for 1, we keep 3 segments + closing dup so the polyline is renderable.
    expect(pts.length).toBeGreaterThanOrEqual(4);
  });
});
