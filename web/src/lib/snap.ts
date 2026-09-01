// Drawing-tool snap helpers (Tier 3 #34, extended by Tier 2 #91).
//
// Four snap modes compose during the in-progress drawing of pen / rect
// / circle / arc shapes:
//
//   geometry > guides > angle > grid
//
//   1. Geometry — when the cursor is within `snapRadiusMM` of an existing
//      run's vertex (or segment midpoint) the working point jumps to that
//      exact location. A real geometric point should beat a 5 mm grid
//      intersection nearby — operators expect "click on that vertex" to
//      land on the vertex, not the nearest grid cell.
//   2. Guides — construction lines dragged off the canvas rulers (Tier 2
//      #91). Ranked BELOW geometry because "land exactly on this existing
//      vertex" is a harder promise than "land on this construction line",
//      and above angle/grid because the operator drew that line on purpose.
//      A guide locks only its own axis; the free coordinate falls through
//      to grid snap. An h-guide and a v-guide in range at once yield their
//      intersection.
//   3. Angle — Shift-held while dragging the working segment. The angle
//      from the previous anchor to the cursor snaps to the nearest 15°
//      increment (same magnitude, snapped direction).
//   4. Grid — the existing `snapEnabled + snapMM` quantize-to-grid that
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

// Tier 2 #91 — a construction / raceway guide reduced to what snapping
// needs. `axis: 'h'` is a horizontal line at y = posMM; `'v'` is a vertical
// line at x = posMM. Kept structural (no `Guideline` import) so this module
// stays free of api.ts, same as `SnapRunLike`.
export type SnapGuideLike = {
  id: string;
  axis: 'h' | 'v';
  posMM: number;
};

// Which guide, if any, captured each axis. Both null means no guide fired.
// Both non-null is the intersection case — the cursor sat inside the snap
// radius of a horizontal AND a vertical guide, and the working point lands
// exactly where they cross.
export type GuideSnap = {
  h: SnapGuideLike | null;
  v: SnapGuideLike | null;
};

// Nearest horizontal guide (by |y − posMM|) and nearest vertical guide (by
// |x − posMM|) within `radius` mm of `target`, independently. The two axes
// are probed separately on purpose: a guide constrains ONE coordinate, so
// "closest guide overall" would be the wrong question — it would let a
// nearby horizontal guide suppress a vertical one the cursor is also sitting
// on, and the intersection case would never fire.
export function findGuideSnap(
  guides: ReadonlyArray<SnapGuideLike>,
  target: Point,
  radius: number,
): GuideSnap {
  let bestH: SnapGuideLike | null = null;
  let bestHD = radius;
  let bestV: SnapGuideLike | null = null;
  let bestVD = radius;
  for (const g of guides) {
    if (!Number.isFinite(g.posMM)) continue;
    if (g.axis === 'v') {
      const d = Math.abs(target[0] - g.posMM);
      if (d <= bestVD) {
        bestVD = d;
        bestV = g;
      }
    } else {
      const d = Math.abs(target[1] - g.posMM);
      if (d <= bestHD) {
        bestHD = d;
        bestH = g;
      }
    }
  }
  return { h: bestH, v: bestV };
}

// Compose all four snap modes for a working point. Returns the snapped
// world-space point AND the geometry-snap result (for visual cue render
// at the call site — the EditorCanvas paints a hover ring on it).
//
// Composition rules (in order):
//   1. If geometry snap fires, return that exact point. Skip guides,
//      angle and grid — a "lock to vertex" intent should not be
//      re-quantized.
//   2. Else if a construction guide is in range on either axis, lock
//      that axis to the guide. The OTHER axis is not held hostage: it
//      falls through to grid snap (or stays free when grid snap is off),
//      so a horizontal guide constrains y and leaves x alone. Both axes
//      firing at once gives the intersection. Skip angle — the operator
//      drew that line to land on it.
//   3. Else if `anchor` is given AND `shiftHeld`, lock to nearest
//      `stepDeg`-degree direction from `anchor`. Skip grid — the user
//      explicitly chose a precise angle.
//   4. Else apply grid snap (no-op when grid snap is off).
//
// Guide snapping is gated on `snapEnabled`, the same toggle as grid
// snap: "snap off" has to mean the cursor is genuinely free, or the
// toggle stops being trustworthy. Geometry snap keeps its existing
// always-on behavior.
//
// `anchor` is the fixed point the angle snap pivots around — for the
// pen tool it's the last committed vertex; for rect/circle/arc it's
// the first corner / center / first-click depending on the tool.
export type ComposedSnap = {
  point: Point;
  geometry: GeometrySnap | null;
  angleLocked: boolean;
  // Tier 2 #91 — which guide captured each axis, for the highlight the
  // canvas paints on a guide that is actively attracting the cursor.
  guides: GuideSnap;
};

const NO_GUIDE_SNAP: GuideSnap = { h: null, v: null };

export function composeSnap(args: {
  cursor: Point;
  anchor: Point | null;
  shiftHeld: boolean;
  runs: ReadonlyArray<SnapRunLike>;
  scale: number;
  snapEnabled: boolean;
  snapMM: number;
  stepDeg?: number;
  guides?: ReadonlyArray<SnapGuideLike>;
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
    guides,
  } = args;
  const radius = snapRadiusMM(scale, snapEnabled, snapMM);
  // Geometry first — this is the "click here, get this exact point"
  // hard lock. Always probed (not gated on snapEnabled) since the user
  // expects existing geometry to attract the cursor regardless of the
  // grid-snap toggle. The radius itself adapts to the toggle though
  // (see `snapRadiusMM`).
  const geometry = findGeometrySnap(runs, cursor, radius);
  if (geometry) {
    return { point: geometry.point, geometry, angleLocked: false, guides: NO_GUIDE_SNAP };
  }
  // Guides next. Same radius as geometry so the two attractors feel
  // calibrated identically, but only when the snap toggle is on.
  if (snapEnabled && guides && guides.length > 0) {
    const hit = findGuideSnap(guides, cursor, radius);
    if (hit.h || hit.v) {
      // The un-captured axis still gets the grid treatment — a guide
      // constrains one coordinate, not the point.
      const gridded = snapToGrid(cursor, snapEnabled, snapMM);
      return {
        point: [hit.v ? hit.v.posMM : gridded[0], hit.h ? hit.h.posMM : gridded[1]],
        geometry: null,
        angleLocked: false,
        guides: hit,
      };
    }
  }
  // Angle next — only when an anchor is available AND shift is held.
  if (anchor && shiftHeld) {
    return {
      point: snapToAngle(anchor, cursor, stepDeg),
      geometry: null,
      angleLocked: true,
      guides: NO_GUIDE_SNAP,
    };
  }
  // Grid as the fallback. Non-cursor sites (label drop, vertex drag)
  // can call `snapToGrid` directly; this composed path is for the
  // drawing tools that want geometry > guides > angle > grid in lockstep.
  return {
    point: snapToGrid(cursor, snapEnabled, snapMM),
    geometry: null,
    angleLocked: false,
    guides: NO_GUIDE_SNAP,
  };
}
