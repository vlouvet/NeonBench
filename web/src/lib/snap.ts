// Drawing-tool snap helpers (Tier 3 #34).
//
// Three snap modes compose during the in-progress drawing of pen / rect
// / circle / arc shapes:
//
//   geometry > angle > grid
//
//   1. Geometry — when the cursor is within `snapRadiusMM` of an existing
//      run's vertex (or segment midpoint) the working point jumps to that
//      exact location. A real geometric point should beat a 5 mm grid
//      intersection nearby — operators expect "click on that vertex" to
//      land on the vertex, not the nearest grid cell.
//   2. Angle — Shift-held while dragging the working segment. The angle
//      from the previous anchor to the cursor snaps to the nearest 15°
//      increment (same magnitude, snapped direction).
//   3. Grid — the existing `snapEnabled + snapMM` quantize-to-grid that
//      EditorCanvas's `snapPoint` already implements; applied last so a
//      free-cursor click still rounds to the user-set grid.
//
// The functions here are pure and side-effect free so they unit-test
// without an RTL canvas mount. EditorCanvas wires them into its
// `clientToWorldSnapped` path and the per-tool drawing branches.

export type Point = [number, number];

// Default angle-snap increment in degrees. 15° matches every 2D drafting
// tool the trade uses (CAD, Illustrator, NeonWizard) and divides 90° /
// 180° / 360° cleanly so 0/45/90/135/etc are all on the wheel.
export const ANGLE_SNAP_STEP_DEG = 15;

// "Snap radius" for vertex / midpoint detection. The MAX of "8 device
// pixels at the current zoom" and "half the user's snap-grid setting"
// — the first keeps the target visually generous regardless of zoom,
// the second ties grabbing radius to the drawing precision the user
// has already chosen. Mirrors the shape used by the node-edit alt-
// hover (`nodeSnapRadiusMM` in EditorCanvas) so the two snap modes
// feel calibrated the same way.
export function snapRadiusMM(
  scale: number,
  snapEnabled: boolean,
  snapMM: number,
): number {
  const pixelMM = 8 / scale;
  if (snapEnabled && snapMM > 0) return Math.max(pixelMM, snapMM / 2);
  return pixelMM;
}

// Constrain the segment from `from` to `to` to the nearest `stepDeg`-
// degree increment, preserving the cursor's distance from the anchor.
// Pure trig — atan2 → round to step → re-emit at the original radius.
//
// The default `stepDeg` of 15 is exposed via `ANGLE_SNAP_STEP_DEG` so a
// future "configurable angle increment" task can swap it in without
// touching the call sites.
export function snapToAngle(
  from: Point,
  to: Point,
  stepDeg: number = ANGLE_SNAP_STEP_DEG,
): Point {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return [to[0], to[1]];
  const stepRad = (stepDeg * Math.PI) / 180;
  const ang = Math.atan2(dy, dx);
  const angSnapped = Math.round(ang / stepRad) * stepRad;
  return [from[0] + len * Math.cos(angSnapped), from[1] + len * Math.sin(angSnapped)];
}

// Quantize to a uniform mm grid. Disabled returns the input unchanged.
// Negative or zero `snapMM` is treated as "no grid" so a configuration
// glitch can't accidentally collapse every point to the origin.
export function snapToGrid(
  p: Point,
  snapEnabled: boolean,
  snapMM: number,
): Point {
  if (!snapEnabled || !(snapMM > 0)) return p;
  return [Math.round(p[0] / snapMM) * snapMM, Math.round(p[1] / snapMM) * snapMM];
}

// Result of a geometry-snap probe. `null` means no candidate within
// range — the caller should fall back to angle/grid as appropriate.
export type GeometrySnap = {
  point: Point;
  kind: 'vertex' | 'midpoint';
};

// Polyline-shaped run input. Kept structural (rather than importing
// DesignRun from api.ts) so this module has no React/api dependency
// and stays vitest-ergonomic.
export type SnapRunLike = {
  polyline: { points: Point[] };
};

// Find the nearest existing vertex / segment-midpoint within
// `radius` mm of `target`. Vertex strictly beats midpoint at equal
// distance — the loop visits all vertices first, then midpoints, and
// only replaces the running best on STRICTLY smaller distance, so a
// vertex co-located with a midpoint wins.
//
// Performance: O(N) over total vertices. For the typical neon design
// (≤ ~2k vertices), this runs well under a millisecond on every
// pointermove. A spatial index (R-tree / quadtree) would buy us
// scaling beyond ~10k vertices, but adding one before we hit that
// bar would just be code we'd later have to delete.
export function findGeometrySnap(
  runs: ReadonlyArray<SnapRunLike>,
  target: Point,
  radius: number,
): GeometrySnap | null {
  const r2 = radius * radius;
  let best: GeometrySnap | null = null;
  let bestD = r2;
  // Vertex pass — first so it strictly beats a midpoint at the same dist.
  for (const run of runs) {
    const pts = run.polyline.points;
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      const dx = p[0] - target[0];
      const dy = p[1] - target[1];
      const d = dx * dx + dy * dy;
      if (d <= bestD) {
        bestD = d;
        best = { point: [p[0], p[1]], kind: 'vertex' };
      }
    }
  }
  // Midpoint pass — only replace if STRICTLY closer than the best
  // vertex, so a vertex sitting on a midpoint stays the winner.
  for (const run of runs) {
    const pts = run.polyline.points;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      const dx = mx - target[0];
      const dy = my - target[1];
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = { point: [mx, my], kind: 'midpoint' };
      }
    }
  }
  return best;
}

// Compose all three snap modes for a working point. Returns the snapped
// world-space point AND the geometry-snap result (for visual cue render
// at the call site — the EditorCanvas paints a hover ring on it).
//
// Composition rules (in order):
//   1. If geometry snap fires, return that exact point. Skip angle
//      and grid — a "lock to vertex" intent should not be re-quantized.
//   2. Else if `anchor` is given AND `shiftHeld`, lock to nearest
//      `stepDeg`-degree direction from `anchor`. Skip grid — the user
//      explicitly chose a precise angle.
//   3. Else apply grid snap (no-op when grid snap is off).
//
// `anchor` is the fixed point the angle snap pivots around — for the
// pen tool it's the last committed vertex; for rect/circle/arc it's
// the first corner / center / first-click depending on the tool.
export type ComposedSnap = {
  point: Point;
  geometry: GeometrySnap | null;
  angleLocked: boolean;
};

export function composeSnap(args: {
  cursor: Point;
  anchor: Point | null;
  shiftHeld: boolean;
  runs: ReadonlyArray<SnapRunLike>;
  scale: number;
  snapEnabled: boolean;
  snapMM: number;
  stepDeg?: number;
}): ComposedSnap {
  const {
    cursor,
    anchor,
    shiftHeld,
    runs,
    scale,
    snapEnabled,
    snapMM,
    stepDeg = ANGLE_SNAP_STEP_DEG,
  } = args;
  // Geometry first — this is the "click here, get this exact point"
  // hard lock. Always probed (not gated on snapEnabled) since the user
  // expects existing geometry to attract the cursor regardless of the
  // grid-snap toggle. The radius itself adapts to the toggle though
  // (see `snapRadiusMM`).
  const geometry = findGeometrySnap(runs, cursor, snapRadiusMM(scale, snapEnabled, snapMM));
  if (geometry) {
    return { point: geometry.point, geometry, angleLocked: false };
  }
  // Angle next — only when an anchor is available AND shift is held.
  if (anchor && shiftHeld) {
    return { point: snapToAngle(anchor, cursor, stepDeg), geometry: null, angleLocked: true };
  }
  // Grid as the fallback. Non-cursor sites (label drop, vertex drag)
  // can call `snapToGrid` directly; this composed path is for the
  // drawing tools that want geometry > angle > grid in lockstep.
  return { point: snapToGrid(cursor, snapEnabled, snapMM), geometry: null, angleLocked: false };
}
