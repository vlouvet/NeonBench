import { describe, expect, it } from 'vitest';
import {
  ANGLE_SNAP_STEP_DEG,
  composeSnap,
  findGeometrySnap,
  findGuideSnap,
  snapRadiusMM,
  snapToAngle,
  snapToGrid,
  type SnapGuideLike,
  type SnapRunLike,
} from './snap';

const runs = (...polys: [number, number][][]): SnapRunLike[] =>
  polys.map((points) => ({ polyline: { points } }));

describe('snapToAngle', () => {
  it('preserves length while snapping the direction', () => {
    // Cursor at (10, 0.5) — almost horizontal — snaps to 0°.
    const out = snapToAngle([0, 0], [10, 0.5]);
    const len = Math.hypot(out[0], out[1]);
    expect(len).toBeCloseTo(Math.hypot(10, 0.5), 6);
    expect(Math.abs(out[1])).toBeLessThan(1e-6);
    expect(out[0]).toBeCloseTo(Math.hypot(10, 0.5), 6);
  });

  it('snaps to 45° when the cursor is near 45°', () => {
    const out = snapToAngle([0, 0], [10, 9]);
    const len = Math.hypot(out[0], out[1]);
    const expectedLen = Math.hypot(10, 9);
    expect(len).toBeCloseTo(expectedLen, 6);
    expect(out[0]).toBeCloseTo(expectedLen * Math.cos(Math.PI / 4), 6);
    expect(out[1]).toBeCloseTo(expectedLen * Math.sin(Math.PI / 4), 6);
  });

  it('snaps to 15° when cursor is near 15°', () => {
    // 15° is the smallest non-zero increment.
    const ang = (16 * Math.PI) / 180;
    const r = 20;
    const out = snapToAngle([5, 5], [5 + r * Math.cos(ang), 5 + r * Math.sin(ang)]);
    const dx = out[0] - 5;
    const dy = out[1] - 5;
    const outAngDeg = (Math.atan2(dy, dx) * 180) / Math.PI;
    expect(outAngDeg).toBeCloseTo(15, 6);
  });

  it('returns the input when from === to', () => {
    expect(snapToAngle([3, 4], [3, 4])).toEqual([3, 4]);
  });

  it('respects a custom step', () => {
    // 30° step — cursor at 35° snaps to 30°.
    const ang = (35 * Math.PI) / 180;
    const out = snapToAngle([0, 0], [10 * Math.cos(ang), 10 * Math.sin(ang)], 30);
    const outDeg = (Math.atan2(out[1], out[0]) * 180) / Math.PI;
    expect(outDeg).toBeCloseTo(30, 6);
  });
});

describe('snapToGrid', () => {
  it('quantizes to the grid when enabled', () => {
    expect(snapToGrid([3.4, 7.8], true, 5)).toEqual([5, 10]);
  });

  it('passes through when disabled', () => {
    expect(snapToGrid([3.4, 7.8], false, 5)).toEqual([3.4, 7.8]);
  });

  it('passes through when snapMM is zero or negative', () => {
    expect(snapToGrid([3.4, 7.8], true, 0)).toEqual([3.4, 7.8]);
    expect(snapToGrid([3.4, 7.8], true, -5)).toEqual([3.4, 7.8]);
  });
});

describe('snapRadiusMM', () => {
  it('uses the pixel floor when grid snap is off', () => {
    expect(snapRadiusMM(1, false, 5)).toBeCloseTo(8, 6);
    expect(snapRadiusMM(2, false, 5)).toBeCloseTo(4, 6);
  });

  it('uses snapMM/2 when larger than the pixel floor', () => {
    // At k=1, pixelMM=8; snapMM=20 → snapMM/2=10 wins.
    expect(snapRadiusMM(1, true, 20)).toBeCloseTo(10, 6);
  });

  it('uses pixel floor when snapMM/2 is smaller', () => {
    // snapMM=4 → snapMM/2=2; pixelMM=8; pixel wins.
    expect(snapRadiusMM(1, true, 4)).toBeCloseTo(8, 6);
  });
});

describe('findGeometrySnap', () => {
  it('returns null when no candidate is in range', () => {
    const r = runs([
      [0, 0],
      [10, 0],
    ]);
    expect(findGeometrySnap(r, [50, 50], 1)).toBeNull();
  });

  it('snaps to a vertex within range', () => {
    const r = runs([
      [0, 0],
      [10, 0],
      [10, 10],
    ]);
    const hit = findGeometrySnap(r, [10.4, 0.3], 1);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('vertex');
    expect(hit!.point).toEqual([10, 0]);
  });

  it('snaps to a segment midpoint when no vertex is closer', () => {
    const r = runs([
      [0, 0],
      [10, 0],
    ]);
    // Midpoint of the segment is at (5, 0). Cursor at (5.1, 0.2).
    const hit = findGeometrySnap(r, [5.1, 0.2], 1);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('midpoint');
    expect(hit!.point[0]).toBeCloseTo(5, 6);
    expect(hit!.point[1]).toBeCloseTo(0, 6);
  });

  it('prefers a vertex over a midpoint at equal distance', () => {
    // Two vertices at (0,0) and (10,0) — midpoint (5,0) and vertex
    // (10,0) are both 5 units from a cursor at (5,5+something) chosen
    // s.t. both candidates are equidistant. Easiest: vertex sits ON
    // the midpoint via a single-vertex polyline plus a separate run.
    const r = runs(
      // First run has a vertex at (5, 0)
      [[5, 0]],
      // Second run is a segment whose midpoint is also at (5, 0)
      [
        [0, 0],
        [10, 0],
      ],
    );
    const hit = findGeometrySnap(r, [5.05, 0.0], 1);
    expect(hit).not.toBeNull();
    expect(hit!.kind).toBe('vertex');
  });

  it('respects the radius cutoff', () => {
    const r = runs([
      [0, 0],
      [10, 0],
    ]);
    // Cursor at (5, 2) — midpoint (5,0) is 2 mm away. Radius 1 → miss.
    expect(findGeometrySnap(r, [5, 2], 1)).toBeNull();
    // Radius 3 → hit.
    expect(findGeometrySnap(r, [5, 2], 3)).not.toBeNull();
  });
});

describe('composeSnap', () => {
  const baseRuns = runs([
    [0, 0],
    [100, 0],
  ]);

  it('geometry beats both angle and grid', () => {
    const out = composeSnap({
      cursor: [99.7, 0.4],
      anchor: [0, 0],
      shiftHeld: true,
      runs: baseRuns,
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
    });
    expect(out.geometry).not.toBeNull();
    expect(out.geometry!.kind).toBe('vertex');
    expect(out.point).toEqual([100, 0]);
    expect(out.angleLocked).toBe(false);
  });

  it('angle wins over grid when shift is held and no geometry hit', () => {
    // Cursor far from any existing vertex/midpoint. Grid 5mm; cursor
    // at angle ~10° (between 0 and 15) snaps to 15° if shift held.
    // But we need the angle-snap path; pick cursor far enough that
    // 5mm grid would round it to a different point.
    const ang = (10 * Math.PI) / 180;
    const r = 200;
    const cursor: [number, number] = [r * Math.cos(ang) + 0, r * Math.sin(ang) + 0];
    const out = composeSnap({
      cursor,
      anchor: [0, 0],
      shiftHeld: true,
      runs: [], // no existing geometry
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
    });
    expect(out.geometry).toBeNull();
    expect(out.angleLocked).toBe(true);
    // Snapped to 15°; length preserved.
    const len = Math.hypot(out.point[0], out.point[1]);
    expect(len).toBeCloseTo(r, 6);
    const outDeg = (Math.atan2(out.point[1], out.point[0]) * 180) / Math.PI;
    // Round-to-15 of 10° → 15°.
    expect(outDeg).toBeCloseTo(15, 6);
  });

  it('grid is the fallback when neither geometry nor angle fires', () => {
    const out = composeSnap({
      cursor: [3.4, 7.8],
      anchor: [0, 0],
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
    });
    expect(out.geometry).toBeNull();
    expect(out.angleLocked).toBe(false);
    expect(out.point).toEqual([5, 10]);
  });

  it('passes the cursor through when nothing snaps', () => {
    const out = composeSnap({
      cursor: [3.4, 7.8],
      anchor: null,
      shiftHeld: true, // shift but no anchor → can't angle-snap
      runs: [],
      scale: 1,
      snapEnabled: false,
      snapMM: 0,
    });
    expect(out.point).toEqual([3.4, 7.8]);
    expect(out.angleLocked).toBe(false);
    expect(out.geometry).toBeNull();
  });

  it('exports the default 15° step', () => {
    expect(ANGLE_SNAP_STEP_DEG).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Tier 2 #91 — guide snapping
// ---------------------------------------------------------------------------

describe('findGuideSnap', () => {
  const gs: SnapGuideLike[] = [
    { id: 'rw1', axis: 'h', posMM: 50 },
    { id: 'rw2', axis: 'v', posMM: 20 },
    { id: 'rw3', axis: 'h', posMM: 200 },
  ];

  it('probes each axis independently', () => {
    // Cursor near the h-guide only.
    const out = findGuideSnap(gs, [80, 51], 3);
    expect(out.h?.id).toBe('rw1');
    expect(out.v).toBeNull();
  });

  it('reports both axes when the cursor sits near their crossing', () => {
    const out = findGuideSnap(gs, [21, 49], 3);
    expect(out.h?.id).toBe('rw1');
    expect(out.v?.id).toBe('rw2');
  });

  it('returns nothing outside the radius', () => {
    const out = findGuideSnap(gs, [80, 60], 3);
    expect(out.h).toBeNull();
    expect(out.v).toBeNull();
  });

  it('picks the nearer of two same-axis guides', () => {
    const out = findGuideSnap(gs, [0, 190], 20);
    expect(out.h?.id).toBe('rw3');
  });

  it('ignores a guide with a non-finite position', () => {
    const out = findGuideSnap([{ id: 'bad', axis: 'h', posMM: NaN }], [0, 0], 10);
    expect(out.h).toBeNull();
  });
});

describe('composeSnap with guides', () => {
  const baseRuns = runs([
    [0, 0],
    [100, 0],
  ]);
  const guides: SnapGuideLike[] = [
    { id: 'rw1', axis: 'h', posMM: 47 },
    { id: 'rw2', axis: 'v', posMM: 23 },
  ];

  it('loses to geometry', () => {
    // A vertex at (100, 0) is within the snap radius AND an h-guide sits
    // 0.4mm away. Geometry keeps the top slot.
    const out = composeSnap({
      cursor: [99.7, 0.4],
      anchor: null,
      shiftHeld: false,
      runs: baseRuns,
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
      guides: [{ id: 'rw1', axis: 'h', posMM: 0.8 }],
    });
    expect(out.geometry).not.toBeNull();
    expect(out.point).toEqual([100, 0]);
    expect(out.guides.h).toBeNull();
  });

  it('beats angle snap even with shift held', () => {
    const out = composeSnap({
      cursor: [200, 47.4],
      anchor: [0, 0],
      shiftHeld: true,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
      guides,
    });
    expect(out.angleLocked).toBe(false);
    expect(out.guides.h?.id).toBe('rw1');
    expect(out.point[1]).toBe(47);
  });

  it('beats grid snap on its own axis and leaves the other axis gridded', () => {
    // y=47.4 is within 2.5mm of the h-guide at 47; x=3.4 has no v-guide
    // in range, so it still rounds to the 5mm grid.
    const out = composeSnap({
      cursor: [3.4, 47.4],
      anchor: null,
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
      guides,
    });
    expect(out.point).toEqual([5, 47]);
    expect(out.guides.h?.id).toBe('rw1');
    expect(out.guides.v).toBeNull();
  });

  it('leaves the free axis genuinely free when the grid is off', () => {
    const out = composeSnap({
      cursor: [3.4, 47.4],
      anchor: null,
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 0, // snap toggle on, but no grid spacing
      guides,
    });
    expect(out.point).toEqual([3.4, 47]);
  });

  it('yields the intersection when an h- and a v-guide both fire', () => {
    const out = composeSnap({
      cursor: [23.4, 47.4],
      anchor: null,
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
      guides,
    });
    expect(out.point).toEqual([23, 47]);
    expect(out.guides.h?.id).toBe('rw1');
    expect(out.guides.v?.id).toBe('rw2');
  });

  it('is disabled with the snap toggle off', () => {
    const out = composeSnap({
      cursor: [23.4, 47.4],
      anchor: null,
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: false,
      snapMM: 5,
      guides,
    });
    expect(out.point).toEqual([23.4, 47.4]);
    expect(out.guides.h).toBeNull();
    expect(out.guides.v).toBeNull();
  });

  it('is a no-op when no guides are passed at all', () => {
    const out = composeSnap({
      cursor: [3.4, 7.8],
      anchor: null,
      shiftHeld: false,
      runs: [],
      scale: 1,
      snapEnabled: true,
      snapMM: 5,
    });
    expect(out.point).toEqual([5, 10]);
    expect(out.guides).toEqual({ h: null, v: null });
  });
});
