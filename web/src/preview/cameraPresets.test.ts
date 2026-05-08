import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { DesignDoc, DesignRun } from '../api';
import {
  bboxOfDoc,
  cameraPositionForPreset,
  PRESET_DISTANCE_FACTOR,
} from './cameraPresets';

// `THREE.Vector3` is pure JS — no WebGL required — so these tests
// run cleanly under jsdom without a `<Canvas>`. We assert
// component-wise with `toBeCloseTo` because the iso preset's
// `distance / √3` computation accumulates a sliver of floating-point
// error that strict equality would flag spuriously.

function expectVec3(v: THREE.Vector3, x: number, y: number, z: number) {
  expect(v.x).toBeCloseTo(x);
  expect(v.y).toBeCloseTo(y);
  expect(v.z).toBeCloseTo(z);
}

function makeRun(points: [number, number][]): DesignRun {
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    polyline: { points, closed: false },
  };
}

function makeDoc(runs: DesignRun[]): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 1000, 500],
    runs,
  };
}

describe('bboxOfDoc', () => {
  it('returns Y-flipped bbox of a 1000×500 mm two-run sign', () => {
    // Run A: a 1000-mm horizontal stroke at y=0.
    // Run B: a 500-mm vertical stroke from y=0 down to y=500 (doc-down).
    // After Y-flip, doc y=0..500 → three y=0..-500. Together they cover
    // X ∈ [0, 1000] and three-Y ∈ [-500, 0].
    const doc = makeDoc([
      makeRun([
        [0, 0],
        [1000, 0],
      ]),
      makeRun([
        [0, 0],
        [0, 500],
      ]),
    ]);
    const bb = bboxOfDoc(doc);
    expectVec3(bb.min, 0, -500, -0.5);
    expectVec3(bb.max, 1000, 0, 0.5);
    expectVec3(bb.size, 1000, 500, 1);
    expectVec3(bb.center, 500, -250, 0);
  });

  it('flips Y so a doc with positive screen-Y points sits in negative three-Y', () => {
    const doc = makeDoc([
      makeRun([
        [10, 100],
        [20, 200],
      ]),
    ]);
    const bb = bboxOfDoc(doc);
    // doc y ∈ [100, 200] → three y ∈ [-200, -100]
    expectVec3(bb.min, 10, -200, -0.5);
    expectVec3(bb.max, 20, -100, 0.5);
  });

  it('handles negative-coordinate fixtures', () => {
    // A run that lives in negative X/Y in the doc's coord system.
    const doc = makeDoc([
      makeRun([
        [-100, -50],
        [-50, -25],
      ]),
    ]);
    const bb = bboxOfDoc(doc);
    // doc Y ∈ [-50, -25] → three Y ∈ [25, 50]
    expectVec3(bb.min, -100, 25, -0.5);
    expectVec3(bb.max, -50, 50, 0.5);
    expectVec3(bb.size, 50, 25, 1);
    expectVec3(bb.center, -75, 37.5, 0);
  });

  it('returns a non-NaN fallback bbox for an empty doc', () => {
    const bb = bboxOfDoc(makeDoc([]));
    expect(Number.isFinite(bb.min.x)).toBe(true);
    expect(Number.isFinite(bb.max.x)).toBe(true);
    expect(bb.size.x).toBeGreaterThan(0);
    expect(bb.size.y).toBeGreaterThan(0);
    expect(bb.size.z).toBeGreaterThan(0);
    // Center should be at origin for the symmetric fallback.
    expectVec3(bb.center, 0, 0, 0);
  });

  it('returns a non-NaN fallback bbox for a null doc', () => {
    const bb = bboxOfDoc(null);
    expect(Number.isFinite(bb.min.x)).toBe(true);
    expect(bb.size.length()).toBeGreaterThan(0);
  });

  it('returns a non-NaN fallback bbox when all runs are empty', () => {
    const doc = makeDoc([makeRun([])]);
    const bb = bboxOfDoc(doc);
    expect(Number.isFinite(bb.min.x)).toBe(true);
    expect(bb.size.length()).toBeGreaterThan(0);
  });

  it('aggregates across multiple runs', () => {
    const doc = makeDoc([
      makeRun([
        [0, 0],
        [10, 0],
      ]),
      makeRun([
        [100, -50],
        [200, -50],
      ]),
    ]);
    const bb = bboxOfDoc(doc);
    // doc Y ∈ [-50, 0] → three Y ∈ [0, 50]
    expectVec3(bb.min, 0, 0, -0.5);
    expectVec3(bb.max, 200, 50, 0.5);
  });

  // Tier 3 #63 — `selectedGroupId` filter restricts the bbox to runs
  // whose `group_id` matches. A camera-fit / wall-plane that keys off
  // the filtered bbox then reframes to just the focused group.
  describe('selectedGroupId filter', () => {
    function makeGroupedRun(
      groupId: string,
      points: [number, number][],
    ): DesignRun {
      return {
        id: `run-${groupId}-${Math.random().toString(36).slice(2, 8)}`,
        polyline: { points, closed: false },
        group_id: groupId,
      };
    }

    it('restricts bbox to runs whose group_id matches', () => {
      const doc = makeDoc([
        makeGroupedRun('A', [
          [0, 0],
          [100, 0],
        ]),
        makeGroupedRun('B', [
          [500, 500],
          [1000, 1000],
        ]),
      ]);
      // Group A only: doc Y 0 → three Y 0.
      const bbA = bboxOfDoc(doc, 'A');
      expectVec3(bbA.min, 0, 0, -0.5);
      expectVec3(bbA.max, 100, 0, 0.5);
      // Group B only: doc Y ∈ [500, 1000] → three Y ∈ [-1000, -500].
      const bbB = bboxOfDoc(doc, 'B');
      expectVec3(bbB.min, 500, -1000, -0.5);
      expectVec3(bbB.max, 1000, -500, 0.5);
    });

    it('treats null / undefined / empty string as "no filter"', () => {
      const doc = makeDoc([
        makeGroupedRun('A', [
          [0, 0],
          [100, 0],
        ]),
        makeGroupedRun('B', [
          [500, 500],
          [1000, 1000],
        ]),
      ]);
      const expectedMin = { x: 0, y: -1000, z: -0.5 };
      const expectedMax = { x: 1000, y: 0, z: 0.5 };
      for (const filter of [undefined, null, ''] as const) {
        const bb = bboxOfDoc(doc, filter);
        expectVec3(bb.min, expectedMin.x, expectedMin.y, expectedMin.z);
        expectVec3(bb.max, expectedMax.x, expectedMax.y, expectedMax.z);
      }
    });

    it('falls back to empty-doc bbox when no run matches the filter', () => {
      const doc = makeDoc([
        makeGroupedRun('A', [
          [0, 0],
          [100, 0],
        ]),
      ]);
      const bb = bboxOfDoc(doc, 'nonexistent');
      // Empty-set bbox: same fallback as a zero-run doc — symmetric
      // 200 mm cube centered at origin so the camera math stays sane.
      expect(Number.isFinite(bb.min.x)).toBe(true);
      expect(bb.size.length()).toBeGreaterThan(0);
      expectVec3(bb.center, 0, 0, 0);
    });

    it('excludes runs without a group_id when a filter is active', () => {
      const ungrouped = makeRun([
        [0, 0],
        [50, 0],
      ]);
      const doc = makeDoc([
        ungrouped,
        makeGroupedRun('A', [
          [200, 200],
          [300, 200],
        ]),
      ]);
      const bb = bboxOfDoc(doc, 'A');
      expectVec3(bb.min, 200, -200, -0.5);
      expectVec3(bb.max, 300, -200, 0.5);
    });
  });
});

describe('cameraPositionForPreset', () => {
  // Reference bbox: the 1000×500 sign from above. Center is
  // (500, -250, 0); diagonal is √(1000² + 500² + 1²) ≈ 1118.034.
  const refBbox = bboxOfDoc(
    makeDoc([
      makeRun([
        [0, 0],
        [1000, 0],
      ]),
      makeRun([
        [0, 0],
        [0, 500],
      ]),
    ]),
  );
  const expectedDistance =
    refBbox.size.length() * PRESET_DISTANCE_FACTOR;

  it('front preset sits along +Z at diagonal × factor distance', () => {
    const f = cameraPositionForPreset('front', refBbox);
    expectVec3(f.target, 500, -250, 0);
    expectVec3(f.position, 500, -250, expectedDistance);
    // World-space distance from target should equal expectedDistance.
    expect(f.position.distanceTo(f.target)).toBeCloseTo(expectedDistance);
  });

  it('iso preset sits in the +X +Y +Z octant at the same world distance', () => {
    const f = cameraPositionForPreset('iso', refBbox);
    expectVec3(f.target, 500, -250, 0);
    // Equal offsets along all three axes, normalized so the world-
    // space distance from center matches the other presets.
    const d = expectedDistance / Math.sqrt(3);
    expectVec3(f.position, 500 + d, -250 + d, d);
    expect(f.position.distanceTo(f.target)).toBeCloseTo(expectedDistance);
  });

  it('top preset sits along +Y', () => {
    const f = cameraPositionForPreset('top', refBbox);
    expectVec3(f.target, 500, -250, 0);
    expectVec3(f.position, 500, -250 + expectedDistance, 0);
    expect(f.position.distanceTo(f.target)).toBeCloseTo(expectedDistance);
  });

  it('side preset sits along +X', () => {
    const f = cameraPositionForPreset('side', refBbox);
    expectVec3(f.target, 500, -250, 0);
    expectVec3(f.position, 500 + expectedDistance, -250, 0);
    expect(f.position.distanceTo(f.target)).toBeCloseTo(expectedDistance);
  });

  it('returns a finite, non-zero camera distance for an empty doc', () => {
    const bb = bboxOfDoc(makeDoc([]));
    const f = cameraPositionForPreset('front', bb);
    expect(Number.isFinite(f.position.x)).toBe(true);
    expect(Number.isFinite(f.position.y)).toBe(true);
    expect(Number.isFinite(f.position.z)).toBe(true);
    expect(f.position.distanceTo(f.target)).toBeGreaterThan(0);
  });

  it('does not mutate the bbox center between calls', () => {
    // The implementation clones `center` for the target — verify we
    // didn't accidentally hand out the same Vector3 instance, which
    // would let the caller mutate the bbox.
    const a = cameraPositionForPreset('front', refBbox);
    const b = cameraPositionForPreset('top', refBbox);
    a.target.set(0, 0, 0);
    expect(b.target.x).toBeCloseTo(500);
    expect(b.target.y).toBeCloseTo(-250);
  });
});
