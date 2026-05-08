import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import {
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
