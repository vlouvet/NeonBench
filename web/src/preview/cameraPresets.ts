// Pure helpers for the Phase 3 #5 camera-preset feature. No React, no
// JSX — `THREE.Vector3` is a thin pure-JS struct (no WebGL context
// required) so these can be unit-tested under jsdom without spinning
// up a `<Canvas>`.
//
// Two responsibilities:
//   1. `bboxOfDoc` walks the design doc's runs and returns the axis-
//      aligned bounding box of the (Y-flipped) tube paths in three.js
//      world space. The Y-flip matches Phase 3 #2's convention (doc Y
//      points down, three Y points up) so the bbox lives in the same
//      coordinate system as the rendered tubes.
//   2. `cameraPositionForPreset` turns a (preset, bbox) pair into a
//      `{ position, target }` for the orbit camera. The preset
//      framings are computed from the bbox so a tiny 100 mm sign and
//      a 6 m sign both fill the viewport with comfortable margin.

import * as THREE from 'three';
import type { DesignDoc } from '../api';

/** Axis-aligned bounding box for the design's tubes in three.js world space. */
export interface Bbox {
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
  center: THREE.Vector3;
}

/** The four preset views shipped with Phase 3 #5. */
export type CameraPreset = 'front' | 'iso' | 'top' | 'side';

/** Camera framing: where the camera sits, and what it's looking at. */
export interface CameraFraming {
  position: THREE.Vector3;
  target: THREE.Vector3;
}

// Multiplier on the bbox diagonal that decides how far the camera
// stands back. 1.5× the diagonal is a comfortable margin for a 50°
// FOV — the sign fills the frame without crowding the edges. Tighter
// (1.2×) starts clipping at the corners; looser (2×) leaves a sea of
// dead space. Tweakable per-preset if a future iteration wants the
// iso view tighter than the orthographic-ish front view.
export const PRESET_DISTANCE_FACTOR = 1.5;

// Fallback half-extent in millimeters when the doc is empty (no runs,
// or all runs are degenerate). Picked to match a small-letter sign so
// the camera distance lands in a "looks like something is here" range
// rather than 0 (which would NaN the lerp) or 10 km (which would
// trigger the OrbitControls' maxDistance clamp).
const EMPTY_DOC_HALF_EXTENT_MM = 100;

// We extrude tubes flat on Z = 0 (Phase 3 #2). To prevent a zero-Z
// bbox from collapsing the diagonal computation onto the XY plane —
// which would make the iso preset coplanar with the design — we pad
// Z by ±0.5 mm so `size.z` is always 1 mm. The padding is invisible
// on render and irrelevant to the framing, but keeps `size.length()`
// honest as a "how big is this thing in 3D?" estimator.
const Z_PADDING_MM = 0.5;

/**
 * Compute the axis-aligned bounding box of every tube path in the
 * design, in three.js world space (Y-flipped to match the renderer).
 *
 * Returns a sensible fallback bbox for empty / degenerate docs so the
 * camera-presets math doesn't NaN out. The fallback is a 200 mm cube
 * centered at the origin — small enough that the initial camera
 * lands close to where a user would expect, large enough that the
 * `minDistance` clamp on OrbitControls doesn't immediately fight us.
 */
export function bboxOfDoc(doc: DesignDoc | null | undefined): Bbox {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);

  if (doc) {
    for (const run of doc.runs) {
      for (const [x, y] of run.polyline.points) {
        // Y-flip: doc +Y down → three +Y up. This must match
        // `polylineToCurve` in tube-geom.ts or the bbox sits in a
        // different coordinate system than the rendered tubes.
        const tx = x;
        const ty = -y;
        if (tx < min.x) min.x = tx;
        if (ty < min.y) min.y = ty;
        if (tx > max.x) max.x = tx;
        if (ty > max.y) max.y = ty;
      }
    }
  }

  if (!Number.isFinite(min.x)) {
    // Empty doc fallback — don't NaN out the camera math.
    min.set(-EMPTY_DOC_HALF_EXTENT_MM, -EMPTY_DOC_HALF_EXTENT_MM, -Z_PADDING_MM);
    max.set(EMPTY_DOC_HALF_EXTENT_MM, EMPTY_DOC_HALF_EXTENT_MM, Z_PADDING_MM);
  } else {
    // Z is always 0 in V1 (flat tubes). Pad ±0.5 mm so size.z > 0
    // and the diagonal length is meaningful for iso framing.
    min.z = -Z_PADDING_MM;
    max.z = Z_PADDING_MM;
  }

  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(max, min).multiplyScalar(0.5);
  return { min, max, size, center };
}

/**
 * Compute the camera position + look-at target for a given preset
 * and design bbox. The framing distance scales with the bbox
 * diagonal so small and large designs both fill the viewport.
 *
 * - **front** — directly in front of the design (along +Z), at
 *   diagonal × 1.5 distance. The "as the customer sees it" view and
 *   the default initial framing.
 * - **iso** — three-quarter view from the +X +Y +Z octant. Classic
 *   marketing-render angle; useful for showing depth once Phase 3 #6
 *   adds return strips and electrodes.
 * - **top** — bird's-eye from +Y. Good for layout review (run
 *   spacing, footprint).
 * - **side** — profile from +X. Useful for confirming tube depth
 *   and (future) channel-letter return-strip geometry.
 */
export function cameraPositionForPreset(
  preset: CameraPreset,
  bbox: Bbox,
): CameraFraming {
  const { center, size } = bbox;
  // Bbox diagonal × margin factor. `size.length()` returns the 3D
  // diagonal so e.g. a wide sign and a tall sign with the same
  // longest-side length still get a slightly different framing —
  // matches what the eye expects.
  const distance = size.length() * PRESET_DISTANCE_FACTOR;
  const target = center.clone();

  switch (preset) {
    case 'front':
      return {
        position: new THREE.Vector3(center.x, center.y, center.z + distance),
        target,
      };
    case 'iso': {
      // Equal offsets on all three axes give the classic 45/45/45
      // iso angle. Magnitude per-axis is `distance / √3` so the
      // resulting world-space distance from center matches the
      // other presets — without this normalization the iso view
      // would sit √3× further back and look "zoomed out" relative
      // to front/top/side.
      const d = distance / Math.sqrt(3);
      return {
        position: new THREE.Vector3(center.x + d, center.y + d, center.z + d),
        target,
      };
    }
    case 'top':
      return {
        position: new THREE.Vector3(center.x, center.y + distance, center.z),
        target,
      };
    case 'side':
      return {
        position: new THREE.Vector3(center.x + distance, center.y, center.z),
        target,
      };
  }
}
