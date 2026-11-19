// Raceway boxes for the 3D preview, resolved to three.js world space.
//
// Pure: no React, no WebGL. `Scene.tsx` meshes what `racewayBoxes` returns
// (Tier 3 #138), and `bboxOfDoc` in `cameraPresets.ts` frames the camera and
// sizes the wall around the same boxes (Tier 3 #183). It lives in its own
// module rather than in `Scene.tsx` so `cameraPresets.ts` can use the one
// placement rule without an import cycle through the React scene.

import type { DesignDoc, DesignRun } from '../api';
import {
  racewayEffectiveDepthMM,
  racewayEffectiveHeightMM,
} from '../lib/docOps';

// How far behind the design (in -Z, mm) the wall plane sits. 50 mm
// is far enough to dodge z-fighting with the tube surfaces (which
// extrude along Z) and to read as a "backing" rather than co-planar,
// but close enough that the bloom from the emissive tubes still
// catches the wall surface. If a future spec adds tube-back geometry
// that pokes into negative Z, revisit.
export const WALL_Z_OFFSET_MM = 50;

// Tier 3 #138 — where a raceway's FRONT face sits, in mm behind the design
// plane (−Z). The Z ordering, front to back, is:
//
//   glass         Z ∈ [−r, +r + lift]   tubes are centred on Z = 0; jumps
//                                       and Bug #09 crossings lift toward +Z
//   raceway front Z = −20               ← RACEWAY_FRONT_GAP_MM
//   wall plane    Z = −50               ← WALL_Z_OFFSET_MM (not moved)
//   raceway back  Z = −20 − depth_mm    behind the wall for any real box
//
// 20 mm clears the back of a 25 mm tube (r = 12.5) by 7.5 mm, so glass never
// pierces the box, and stays 30 mm in front of the wall, so the front face is
// never co-planar with it.
//
// The box is drawn at the doc's full depth, and a real raceway (shop default
// 203.2 mm) is far deeper than the 50 mm the wall plane leaves. So with the
// wall on, the wall plane cuts THROUGH the box and only the front 30 mm shows
// — the box reads as mounted on the wall. That cut is a perpendicular
// intersection, not two co-planar faces, so it does not z-fight. The one
// co-planar case (a box exactly 30 mm deep) is handled by
// RACEWAY_WALL_CLEARANCE_MM below.
export const RACEWAY_FRONT_GAP_MM = 20;

// If a box's back face would land within this distance of the wall plane it
// is pushed 2× this distance BEHIND the wall instead — co-planar faces are
// exactly the z-fight that shows on some GPUs and not others. The extra depth
// is behind the wall, so with the wall on it is invisible; with the wall off
// it is at most 1.5 mm on a box no shop builds (30 mm deep).
export const RACEWAY_WALL_CLEARANCE_MM = 0.5;

/** One raceway box, resolved to three.js world space (Y up, mm). */
export interface RacewayBox {
  id: string;
  /** Box centre. */
  position: [number, number, number];
  /** Full extents along X (length), Y (height) and Z (depth). */
  size: [number, number, number];
}

/**
 * Pure helper — resolve `doc.raceways` into boxes ready to mesh.
 *
 * Geometry mirrors the editor's raceway rect (EditorCanvas): the matching
 * `kind: 'raceway'` guideline supplies the TOP edge (`y_mm`, doc Y down), the
 * record supplies left edge, length, height and depth, and 0 / absent height
 * or depth means the shop default (`racewayEffective*MM`). Doc Y is flipped
 * to three's Y-up the same way the tubes are (`y_three = −y_doc`).
 *
 * Skipped, as the editor skips them: a raceway with no matching raceway
 * guideline, or a non-positive / non-finite length.
 *
 * Group focus (Tier 3 #63): a raceway has no group of its own, so when a
 * group is focused only raceways with at least one member run among
 * `visibleRuns` are drawn. With no focus, every raceway is drawn — the box
 * is hardware whether or not its letters are currently shown.
 *
 * A doc with no raceways returns `[]`, and Scene then adds nothing to the
 * scene graph — which is what keeps a no-raceway render identical.
 */
export function racewayBoxes(
  doc: DesignDoc | null | undefined,
  visibleRuns: DesignRun[] = doc?.runs ?? [],
  focusedGroupId: string | null = null,
): RacewayBox[] {
  const raceways = doc?.raceways ?? [];
  if (raceways.length === 0) return [];
  const guides = doc?.guidelines ?? [];
  const memberIds = focusedGroupId
    ? new Set(visibleRuns.map((r) => r.raceway_id).filter(Boolean))
    : null;
  const out: RacewayBox[] = [];
  for (const rw of raceways) {
    const guide = guides.find((g) => g.id === rw.id && g.kind === 'raceway');
    if (!guide) continue;
    if (!Number.isFinite(rw.length_mm) || rw.length_mm <= 0) continue;
    if (!Number.isFinite(rw.x_mm) || !Number.isFinite(guide.y_mm)) continue;
    if (memberIds && !memberIds.has(rw.id)) continue;
    const height = racewayEffectiveHeightMM(rw);
    const front = -RACEWAY_FRONT_GAP_MM;
    let back = front - racewayEffectiveDepthMM(rw);
    if (Math.abs(back + WALL_Z_OFFSET_MM) < RACEWAY_WALL_CLEARANCE_MM) {
      back = -WALL_Z_OFFSET_MM - 2 * RACEWAY_WALL_CLEARANCE_MM;
    }
    out.push({
      id: rw.id,
      position: [
        rw.x_mm + rw.length_mm / 2,
        -(guide.y_mm + height / 2),
        (front + back) / 2,
      ],
      size: [rw.length_mm, height, front - back],
    });
  }
  return out;
}
