import { describe, it, expect } from 'vitest';
import { smoothStrokePoints, type Pt } from './smooth';

// A coarse 8-gon approximating a circle of radius 40 — like a faceted Hershey
// "O" — with ~45° turns at each vertex.
function octagon(r: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    out.push([r * Math.cos(t), r * Math.sin(t)]);
  }
  return out;
}

describe('smoothStrokePoints', () => {
  it('leaves short strokes (< 3 points) untouched', () => {
    const seg: Pt[] = [
      [0, 0],
      [10, 0],
    ];
    expect(smoothStrokePoints(seg)).toEqual(seg);
  });

  it('densifies a gentle curve without overshooting the control polygon', () => {
    const coarse = octagon(40); // ~45° turns — below the corner threshold
    const smooth = smoothStrokePoints(coarse);
    // More points after densifying.
    expect(smooth.length).toBeGreaterThan(coarse.length);
    // Centripetal Catmull-Rom must not overshoot: every smoothed point stays
    // within the control polygon's bounds (a uniform spline would bulge past
    // them, inventing tighter local curvature than the original).
    const xs = coarse.map((p) => p[0]);
    const ys = coarse.map((p) => p[1]);
    const pad = 0.5;
    for (const [x, y] of smooth) {
      expect(x).toBeGreaterThanOrEqual(Math.min(...xs) - pad);
      expect(x).toBeLessThanOrEqual(Math.max(...xs) + pad);
      expect(y).toBeGreaterThanOrEqual(Math.min(...ys) - pad);
      expect(y).toBeLessThanOrEqual(Math.max(...ys) + pad);
    }
  });

  it('preserves a sharp corner (an L is not rounded)', () => {
    const ell: Pt[] = [
      [0, 0],
      [0, 50],
      [50, 50],
    ]; // a single 90° corner at [0,50]
    const out = smoothStrokePoints(ell);
    // The corner vertex survives exactly…
    expect(out).toContainEqual([0, 50]);
    // …and nothing is densified across it (both arms are straight 2-pt runs).
    expect(out).toEqual(ell);
  });

  it('smooths the curved part of a mixed stroke while keeping its corner', () => {
    // Straight down, hard 90° corner, then a gentle 3-point curve.
    const mixed: Pt[] = [
      [0, 0],
      [0, 40], // corner
      [10, 50],
      [25, 55],
      [40, 50],
    ];
    const out = smoothStrokePoints(mixed);
    expect(out).toContainEqual([0, 40]); // corner preserved
    expect(out.length).toBeGreaterThan(mixed.length); // curve densified
  });
});
