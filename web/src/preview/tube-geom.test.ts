import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import {
  JUMP_LIFT_HEIGHT_MULT,
  JUMP_LIFT_SPAN_MULT,
  liftPointsAtJumps,
  polylineToCurve,
  tubeSegmentCount,
  TUBE_SEGMENTS_MAX,
  TUBE_SEGMENTS_MIN,
} from './tube-geom';

// Helpers in tube-geom are pure — no React, no `<Canvas>`. We can
// poke at the constructed curve's underlying control points to
// confirm the Y-flip and the open/closed flag survive the round
// trip without spinning up a renderer.

// Component-wise scalar compare. Vitest's deep equality on Vector3
// (and `toBe`, which uses Object.is) distinguishes `+0` from `-0`,
// and the Y-flip produces `-0` when y is `0`. `toBeCloseTo` treats
// the two as equal, which is the right semantic for geometry tests
// where the sign of zero is not meaningful.
function expectVec3(v: THREE.Vector3, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x);
  expect(v.y).toBeCloseTo(y);
  expect(v.z).toBeCloseTo(z);
}

describe('polylineToCurve', () => {
  it('preserves a horizontal polyline (Y-flip is a no-op when y=0)', () => {
    const c = polylineToCurve(
      [
        [0, 0],
        [100, 0],
      ],
      false,
    );
    expect(c.points).toHaveLength(2);
    expectVec3(c.points[0], 0, 0, 0);
    expectVec3(c.points[1], 100, 0, 0);
    expect(c.closed).toBe(false);
  });

  it('flips Y from doc-down to three-up', () => {
    const c = polylineToCurve(
      [
        [0, 0],
        [0, 100],
      ],
      false,
    );
    expectVec3(c.points[0], 0, 0, 0);
    expectVec3(c.points[1], 0, -100, 0);
  });

  it('passes through the closed flag', () => {
    const c = polylineToCurve(
      [
        [0, 0],
        [10, 0],
        [10, 10],
        [0, 10],
      ],
      true,
    );
    expect(c.closed).toBe(true);
  });

  it('returns a non-crashing degenerate curve for a 1-point input', () => {
    // A 1-point run shouldn't render as a tube; the Tube component
    // filters these. The helper just refuses to crash on bad input.
    const c = polylineToCurve([[42, 42]], false);
    expect(c.points.length).toBeGreaterThanOrEqual(2);
  });

  it('returns a non-crashing degenerate curve for an empty input', () => {
    const c = polylineToCurve([], false);
    expect(c.points.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tubeSegmentCount', () => {
  it('returns ~1 segment per 5 mm of path length for typical runs', () => {
    expect(
      tubeSegmentCount([
        [0, 0],
        [1000, 0],
      ]),
    ).toBe(200);
  });

  it('clamps short polylines up to the floor', () => {
    expect(
      tubeSegmentCount([
        [0, 0],
        [30, 0],
      ]),
    ).toBe(TUBE_SEGMENTS_MIN);
  });

  it('clamps very long polylines down to the ceiling', () => {
    expect(
      tubeSegmentCount([
        [0, 0],
        [5000, 0],
      ]),
    ).toBe(TUBE_SEGMENTS_MAX);
  });

  it('sums distance across multi-vertex polylines (not just endpoints)', () => {
    // Three 100-mm legs around a U-shape = 300 mm total → 60 segs.
    expect(
      tubeSegmentCount([
        [0, 0],
        [100, 0],
        [100, 100],
        [0, 100],
      ]),
    ).toBe(60);
  });

  it('returns the floor when the polyline is empty or single-point', () => {
    expect(tubeSegmentCount([])).toBe(TUBE_SEGMENTS_MIN);
    expect(tubeSegmentCount([[0, 0]])).toBe(TUBE_SEGMENTS_MIN);
  });
});

// Tier 3 #68 — jump-annotation lifts the tube out of plane in 3D
// preview. The kernel is a raised cosine: peak at the jump point,
// smooth fall to 0 at half-span, identically 0 outside.
describe('liftPointsAtJumps', () => {
  const D = 12; // diameter mm
  const HEIGHT = JUMP_LIFT_HEIGHT_MULT * D;
  const HALF_SPAN = (JUMP_LIFT_SPAN_MULT * D) / 2;

  // 1 mm grid of points along X for predictable arc-distance math.
  const linePoints = (count: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) out.push([i, 0]);
    return out;
  };

  it('returns Z=0 everywhere when no jumps', () => {
    const lifted = liftPointsAtJumps(linePoints(10), [], D);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('returns Z=0 everywhere when diameter is zero', () => {
    const lifted = liftPointsAtJumps(linePoints(10), [5], 0);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('preserves X and (input) Y on the way out', () => {
    const pts: [number, number][] = [
      [0, 0],
      [10, 5],
      [20, -3],
    ];
    const lifted = liftPointsAtJumps(pts, [], D);
    expect(lifted).toEqual([
      [0, 0, 0],
      [10, 5, 0],
      [20, -3, 0],
    ]);
  });

  it('peaks at the jump point and falls to zero at half-span', () => {
    // Polyline long enough to span both directions of the lift kernel.
    const pts = linePoints(Math.ceil(HALF_SPAN) * 2 + 5);
    const jumpIdx = Math.floor(pts.length / 2);
    const lifted = liftPointsAtJumps(pts, [jumpIdx], D);
    // Peak: full HEIGHT at the jump itself.
    expect(lifted[jumpIdx][2]).toBeCloseTo(HEIGHT, 6);
    // Falls smoothly: half-distance is a non-zero fraction of HEIGHT.
    const halfwayIdx = jumpIdx + Math.floor(HALF_SPAN / 2);
    expect(lifted[halfwayIdx][2]).toBeGreaterThan(0);
    expect(lifted[halfwayIdx][2]).toBeLessThan(HEIGHT);
    // At the half-span boundary the lift is identically zero.
    const boundaryIdx = jumpIdx + Math.ceil(HALF_SPAN);
    if (boundaryIdx < pts.length) {
      expect(lifted[boundaryIdx][2]).toBe(0);
    }
    // Beyond half-span: still zero.
    const farIdx = pts.length - 1;
    if (farIdx - jumpIdx > HALF_SPAN) {
      expect(lifted[farIdx][2]).toBe(0);
    }
  });

  it('produces independent peaks for two jumps far apart', () => {
    // Place jumps far enough apart that their half-spans don't touch.
    const span = JUMP_LIFT_SPAN_MULT * D;
    const between = Math.ceil(span * 1.5);
    const pts = linePoints(between * 2 + 1);
    const j1 = Math.floor(between / 2);
    const j2 = j1 + between;
    const lifted = liftPointsAtJumps(pts, [j1, j2], D);
    expect(lifted[j1][2]).toBeCloseTo(HEIGHT, 6);
    expect(lifted[j2][2]).toBeCloseTo(HEIGHT, 6);
    // A point exactly between them lies outside both half-spans.
    const midIdx = Math.floor((j1 + j2) / 2);
    expect(lifted[midIdx][2]).toBe(0);
  });

  it('takes max (not sum) when two jumps overlap', () => {
    // Jumps just two indices apart — both half-spans cover the
    // midpoint. With max semantics, peak ≤ HEIGHT; with sum it would
    // be ~2× HEIGHT. The point at j1 exactly should still equal
    // HEIGHT (its own peak), not HEIGHT plus contribution from j2.
    const pts = linePoints(40);
    const j1 = 18;
    const j2 = 20;
    const lifted = liftPointsAtJumps(pts, [j1, j2], D);
    expect(lifted[j1][2]).toBeLessThanOrEqual(HEIGHT + 1e-6);
    expect(lifted[j2][2]).toBeLessThanOrEqual(HEIGHT + 1e-6);
    // The midpoint between the two should be ≤ HEIGHT (max), not
    // approaching 2 × HEIGHT (sum).
    const mid = 19;
    expect(lifted[mid][2]).toBeLessThanOrEqual(HEIGHT + 1e-6);
  });

  it('silently skips out-of-range jump indices', () => {
    const pts = linePoints(10);
    // Indices below 0 and at/beyond points.length — both ignored.
    const lifted = liftPointsAtJumps(pts, [-1, 999], D);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('uses arc length (not Euclidean) so corners count toward distance', () => {
    // U-shape: 100 mm right, 100 mm up, 100 mm left.
    // Arc distance from (0,0) to (0,100) is 300 mm; Euclidean is 100 mm.
    // With a half-span of 24 mm (= JUMP_LIFT_SPAN_MULT × 12 / 2), a
    // jump at the start corner should NOT lift the end corner because
    // arc distance (300) >> 24, even though they are Euclidean-close.
    const pts: [number, number][] = [
      [0, 0],
      [100, 0],
      [100, 100],
      [0, 100],
    ];
    const lifted = liftPointsAtJumps(pts, [0], D);
    expect(lifted[0][2]).toBeCloseTo(HEIGHT, 6);
    expect(lifted[3][2]).toBe(0); // Euclidean-close to start, but arc-far.
  });

  it('returns an empty array for an empty input polyline', () => {
    expect(liftPointsAtJumps([], [5], D)).toEqual([]);
  });
});
