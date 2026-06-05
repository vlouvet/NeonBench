import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import {
  DROP_BEND_LIFT_HEIGHT_MULT,
  DROP_BEND_LIFT_SPAN_MULT,
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
    // Place jumps far enough apart that they DON'T cluster (gap >
    // JUMP_LIFT_CLUSTER_GAP_MULT × diameter) AND their half-spans
    // don't reach each other.
    const span = JUMP_LIFT_SPAN_MULT * D;
    const between = Math.ceil(span * 1.5); // > clusterGap, > 2× halfSpan
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

  it('clusters two close jumps into one tabletop plateau (no M-shape)', () => {
    // Jumps within JUMP_LIFT_CLUSTER_GAP_MULT × diameter — should
    // merge into one plateau at HEIGHT, not produce two peaks with a
    // valley between. This is the user-facing case from project 21232:
    // marking both ends of a crossing (entry + exit) must produce
    // one continuous bridge.
    const pts = linePoints(60);
    const j1 = 20;
    const j2 = 30; // 10 mm apart, well below clusterGap (= 48 mm)
    const lifted = liftPointsAtJumps(pts, [j1, j2], D);
    expect(lifted[j1][2]).toBeCloseTo(HEIGHT, 6);
    expect(lifted[j2][2]).toBeCloseTo(HEIGHT, 6);
    // Every point BETWEEN the two jumps lifts to full HEIGHT (plateau),
    // not a dipped valley.
    for (let i = j1; i <= j2; i++) {
      expect(lifted[i][2]).toBeCloseTo(HEIGHT, 6);
    }
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

// Tier 3 #77 — drop-bend annotations lift the tube subtly out of
// plane (0.5× diameter vs 2.5× for jumps), with the same raised-
// cosine kernel but a different HEIGHT_MULT. Drop-bends do not
// cluster with jumps; composition is max() per point.
describe('liftPointsAtJumps — drop-bend kernel (Tier 3 #77)', () => {
  const D = 12;
  const DROP_HEIGHT = DROP_BEND_LIFT_HEIGHT_MULT * D; // 6 mm on a 12-mm tube
  const JUMP_HEIGHT = JUMP_LIFT_HEIGHT_MULT * D; // 30 mm
  const DROP_HALF_SPAN = (DROP_BEND_LIFT_SPAN_MULT * D) / 2; // 24 mm

  const linePoints = (count: number): [number, number][] => {
    const out: [number, number][] = [];
    for (let i = 0; i < count; i++) out.push([i, 0]);
    return out;
  };

  it('lifts a drop-bend point to 0.5× diameter (not the jump height)', () => {
    const pts = linePoints(60);
    const dropIdx = 30;
    const lifted = liftPointsAtJumps(pts, [], D, [dropIdx]);
    expect(lifted[dropIdx][2]).toBeCloseTo(DROP_HEIGHT, 6);
    // Sanity: the lift must NOT equal the jump height. Drop bends
    // are subtle dips, not horseshoes.
    expect(lifted[dropIdx][2]).toBeLessThan(JUMP_HEIGHT);
  });

  it('falls smoothly to zero at half-span', () => {
    const pts = linePoints(60);
    const dropIdx = 30;
    const lifted = liftPointsAtJumps(pts, [], D, [dropIdx]);
    // Mid-falloff: non-zero, below peak.
    const halfwayIdx = dropIdx + Math.floor(DROP_HALF_SPAN / 2);
    expect(lifted[halfwayIdx][2]).toBeGreaterThan(0);
    expect(lifted[halfwayIdx][2]).toBeLessThan(DROP_HEIGHT);
    // Beyond the half-span: identically zero.
    const farIdx = dropIdx + Math.ceil(DROP_HALF_SPAN);
    if (farIdx < pts.length) {
      expect(lifted[farIdx][2]).toBe(0);
    }
  });

  it('does NOT cluster with jumps even when adjacent', () => {
    // Place a jump and a drop within the jump-cluster gap (cluster
    // gap = 48 mm). If drop-bends clustered with jumps as a SAME-KIND
    // pair, every point in the interval [jumpIdx, dropIdx] would
    // lift to FULL jump HEIGHT (plateau at 30 mm). Spec is the
    // opposite: drop-bends are a separate semantic, so the kernel
    // between them follows the jump-cosine FALLOFF (decreasing away
    // from jumpIdx) rather than holding at full jump height. The
    // jump's lift dominates here because its tail (cosine over a
    // 24 mm half-span) is taller than the drop's own peak (6 mm),
    // but the falloff shape proves the two kinds didn't merge.
    const pts = linePoints(60);
    const jumpIdx = 20;
    const dropIdx = 30; // 10 mm away, would have clustered if same-kind
    const lifted = liftPointsAtJumps(pts, [jumpIdx], D, [dropIdx]);
    expect(lifted[jumpIdx][2]).toBeCloseTo(JUMP_HEIGHT, 6);
    // No plateau: the value at dropIdx is the jump cosine at d=10mm
    // (a fraction of JUMP_HEIGHT), STRICTLY less than JUMP_HEIGHT.
    // If the kinds had merged into a same-kind cluster, dropIdx
    // would equal JUMP_HEIGHT.
    expect(lifted[dropIdx][2]).toBeLessThan(JUMP_HEIGHT);
    // It's also at least DROP_HEIGHT (the drop's own peak is part
    // of the max composition).
    expect(lifted[dropIdx][2]).toBeGreaterThanOrEqual(DROP_HEIGHT);
    // Midpoint between jump and drop: same cosine-falloff regime,
    // strictly below JUMP_HEIGHT (no plateau).
    const midIdx = 25;
    expect(lifted[midIdx][2]).toBeLessThan(JUMP_HEIGHT);
    expect(lifted[midIdx][2]).toBeGreaterThan(0);
  });

  it('isolated drop-bend reaches its full DROP_HEIGHT (no jump interference)', () => {
    // The "does NOT cluster" test verifies the geometric semantic
    // when both kinds are present; this companion test confirms
    // that a drop-bend's peak does hit DROP_HEIGHT when no jump is
    // overshadowing it. Together the two assertions prove the
    // drop-bend kernel is a real, independent contribution to the
    // max composition (not a no-op).
    const pts = linePoints(40);
    const dropIdx = 20;
    const lifted = liftPointsAtJumps(pts, [], D, [dropIdx]);
    expect(lifted[dropIdx][2]).toBeCloseTo(DROP_HEIGHT, 6);
  });

  it('composes via max() at a coincident jump + drop vertex (jump wins)', () => {
    // When both annotations land on the same vertex, the final lift
    // is the JUMP height (taller), not the sum. Operator-friendly:
    // a jump-with-an-incidental-drop reads as a clear horseshoe.
    const pts = linePoints(40);
    const sharedIdx = 20;
    const lifted = liftPointsAtJumps(pts, [sharedIdx], D, [sharedIdx]);
    expect(lifted[sharedIdx][2]).toBeCloseTo(JUMP_HEIGHT, 6);
    // Not 2.5× + 0.5× = 3× diameter.
    expect(lifted[sharedIdx][2]).toBeLessThan(JUMP_HEIGHT + DROP_HEIGHT - 0.1);
  });

  it('returns Z=0 everywhere when both index arrays are empty', () => {
    const lifted = liftPointsAtJumps(linePoints(10), [], D, []);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('returns Z=0 everywhere when diameter is zero', () => {
    const lifted = liftPointsAtJumps(linePoints(10), [], 0, [5]);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('silently skips out-of-range drop-bend indices', () => {
    const pts = linePoints(10);
    const lifted = liftPointsAtJumps(pts, [], D, [-1, 999]);
    for (const [, , z] of lifted) expect(z).toBe(0);
  });

  it('produces independent dips for two drop-bends far apart', () => {
    const pts = linePoints(120);
    const d1 = 30;
    const d2 = 90; // > 2 × half-span apart
    const lifted = liftPointsAtJumps(pts, [], D, [d1, d2]);
    expect(lifted[d1][2]).toBeCloseTo(DROP_HEIGHT, 6);
    expect(lifted[d2][2]).toBeCloseTo(DROP_HEIGHT, 6);
    // Halfway between: outside both half-spans, identically zero.
    expect(lifted[60][2]).toBe(0);
  });
});
