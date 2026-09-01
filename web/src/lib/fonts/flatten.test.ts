import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHORD_TOLERANCE_MM,
  cubicAt,
  distanceToPolyline,
  flattenCubic,
  flattenQuadratic,
  quadraticAt,
  type Pt,
} from './flatten';

// The assertion that matters is not "how many points came out" — that is
// an implementation detail and a test of it would break on any tuning.
// It is: NO POINT OF THE TRUE CURVE IS FURTHER FROM THE EMITTED POLYLINE
// THAN THE TOLERANCE. We sample the real bezier densely and measure to
// the polyline's SEGMENTS (not its vertices — a vertex-only measure calls
// a two-point chord across a half-circle a perfect approximation).

const SAMPLES = 2001;

function maxDeviationQuad(p0: Pt, c: Pt, p1: Pt, tol: number): number {
  const poly: Pt[] = [p0, ...flattenQuadratic(p0, c, p1, tol)];
  let worst = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const d = distanceToPolyline(quadraticAt(p0, c, p1, i / (SAMPLES - 1)), poly);
    if (d > worst) worst = d;
  }
  return worst;
}

function maxDeviationCubic(p0: Pt, c1: Pt, c2: Pt, p1: Pt, tol: number): number {
  const poly: Pt[] = [p0, ...flattenCubic(p0, c1, c2, p1, tol)];
  let worst = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const d = distanceToPolyline(cubicAt(p0, c1, c2, p1, i / (SAMPLES - 1)), poly);
    if (d > worst) worst = d;
  }
  return worst;
}

describe('flattenQuadratic', () => {
  it('emits the endpoint but not the start point', () => {
    const out = flattenQuadratic([0, 0], [50, 100], [100, 0]);
    expect(out[out.length - 1]).toEqual([100, 0]);
    expect(out[0]).not.toEqual([0, 0]);
  });

  it('keeps every curve point within the chord tolerance', () => {
    for (const tol of [2, 1, DEFAULT_CHORD_TOLERANCE_MM, 0.05]) {
      expect(maxDeviationQuad([0, 0], [50, 120], [100, 0], tol)).toBeLessThanOrEqual(tol);
      // An asymmetric arch, the shape a real 'n' shoulder makes.
      expect(maxDeviationQuad([0, 0], [10, 90], [100, 20], tol)).toBeLessThanOrEqual(tol);
    }
  });

  it('spends more vertices as the tolerance tightens', () => {
    const coarse = flattenQuadratic([0, 0], [50, 120], [100, 0], 2).length;
    const fine = flattenQuadratic([0, 0], [50, 120], [100, 0], 0.05).length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it('emits a single segment for a curve that is already straight', () => {
    // Control point on the chord: the "curve" is a line.
    expect(flattenQuadratic([0, 0], [50, 0], [100, 0], 0.25)).toEqual([[100, 0]]);
  });

  it('treats a non-positive tolerance as the default rather than looping', () => {
    const a = flattenQuadratic([0, 0], [50, 120], [100, 0], 0);
    const b = flattenQuadratic([0, 0], [50, 120], [100, 0], -5);
    const d = flattenQuadratic([0, 0], [50, 120], [100, 0]);
    expect(a).toEqual(d);
    expect(b).toEqual(d);
  });

  it('terminates on a degenerate curve whose endpoints coincide', () => {
    const out = flattenQuadratic([0, 0], [0, 100], [0, 0], 0.25);
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThan(10000);
    expect(out[out.length - 1]).toEqual([0, 0]);
  });
});

describe('flattenCubic', () => {
  it('emits the endpoint but not the start point', () => {
    const out = flattenCubic([0, 0], [0, 60], [100, 60], [100, 0]);
    expect(out[out.length - 1]).toEqual([100, 0]);
    expect(out[0]).not.toEqual([0, 0]);
  });

  it('keeps every curve point within the chord tolerance', () => {
    for (const tol of [2, 1, DEFAULT_CHORD_TOLERANCE_MM, 0.05]) {
      expect(
        maxDeviationCubic([0, 0], [0, 80], [100, 80], [100, 0], tol),
      ).toBeLessThanOrEqual(tol);
      // An S-curve: the control points sit on opposite sides of the
      // chord, so a "max of the two hull distances" bound has to hold
      // for both lobes at once.
      expect(
        maxDeviationCubic([0, 0], [0, 90], [100, -90], [100, 0], tol),
      ).toBeLessThanOrEqual(tol);
    }
  });

  it('terminates on a cusp', () => {
    // Control points that cross over, so the curve doubles back on
    // itself — the shape the recursion cap exists for. A very tight
    // tolerance on top of it: the output must still be bounded.
    const out = flattenCubic([0, 0], [100, 100], [0, 100], [100, 0], 0.001);
    expect(out.length).toBeGreaterThan(1);
    expect(out.length).toBeLessThan(20000);
  });

  it('collapses a cubic whose control points lie on its own chord', () => {
    // Degenerate but legal: the curve wiggles ALONG the chord and never
    // leaves it, so a single segment really is within tolerance.
    expect(flattenCubic([0, 0], [100, 0], [0, 0], [100, 0], 0.01)).toEqual([[100, 0]]);
  });
});
