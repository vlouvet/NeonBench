// Pure geometry helpers for the Phase 3 tube preview. Kept free of
// React and JSX so they can be unit-tested without spinning up a
// `<Canvas>` (jsdom has no WebGL context). The Tube component in
// `./Tube.tsx` consumes these to drive `<tubeGeometry>`.
//
// Coordinate conventions:
//   - Input points are 2D `[x, y]` tuples in millimeters, matching
//     `DesignDoc.runs[i].polyline.points` from `web/src/api.ts`.
//   - The design doc uses screen-Y (down-positive), the same
//     convention as the editor canvas. three.js uses Y-up, so we
//     flip Y on the way to `Vector3` (`y_three = -y_doc`). Without
//     this flip, neon designs would render upside-down in the
//     preview.

import * as THREE from 'three';

// Lower / upper clamps for the tube's path-direction segment count.
// Floor of 16 keeps a tiny electrode pin from looking facetted. Ceiling
// of 256 keeps a 10k-point polyline from blowing out the GPU. A typical
// 1000 mm letter run lands at 200 (one segment per 5 mm of arc length),
// which reads as smooth at typical preview zoom levels.
export const TUBE_SEGMENTS_MIN = 16;
export const TUBE_SEGMENTS_MAX = 256;

// Target arc length per path segment, in millimeters. ~5 mm matches
// roughly the visual smoothing of glass tube at conversational viewing
// distance; tighter than that and the bundle pays for polys you can't
// see.
export const TUBE_SEGMENT_TARGET_MM = 5;

// Radial segments around the cross-section. 8 sides reads as round at
// typical preview zooms; 6 looks visibly hexagonal, 12+ wastes polys.
// Re-exported for the Tube component so the magic number lives in one
// place.
export const TUBE_RADIAL_SEGMENTS = 8;

// Default tube diameter in millimeters. Used when neither the run nor
// the project supplies one — defensive only; a valid design doc always
// resolves to a real diameter via the project's tube spec.
export const DEFAULT_TUBE_DIAMETER_MM = 12;

/**
 * Convert a 2D polyline (millimeter `[x, y]` tuples) into a
 * `THREE.CatmullRomCurve3` lying flat on the XY plane (Z = 0).
 *
 * Y is flipped on the way out: design-doc Y points down (screen
 * convention), three.js Y points up. Catmull-Rom smooths between
 * control points so a polyline with sharp angles renders as a tube
 * with gentle curves — the right look for glass neon, which can't
 * bend on a dime. If a future spec wants strictly faceted polylines,
 * swap to `LineCurve3` segments composed via `CurvePath`.
 *
 * Returns a degenerate two-point curve (origin → +1 X) when called
 * with fewer than two points; the caller filters runs that wouldn't
 * extrude meaningfully, this helper just refuses to crash.
 */
export function polylineToCurve(
  points: ReadonlyArray<readonly [number, number]>,
  closed: boolean,
): THREE.CatmullRomCurve3 {
  if (points.length < 2) {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ]);
  }
  const v3 = points.map(
    ([x, y]) => new THREE.Vector3(x, -y, 0), // Y-flip: doc +y down → three +y up
  );
  return new THREE.CatmullRomCurve3(v3, closed, 'catmullrom', 0.5);
}

/**
 * Compute the path-direction segment count for a polyline:
 * approximately one segment per 5 mm of total path length, clamped
 * to `[16, 256]`. The clamp makes a one-vertex pin still render
 * (floor) and keeps a 10k-point polyline from blowing the polygon
 * budget (ceiling).
 *
 * Length is summed over straight-line distances between consecutive
 * vertices. The Catmull-Rom curve will smooth through these, so the
 * actual rendered arc is slightly longer — close enough for a
 * heuristic.
 */
export function tubeSegmentCount(
  points: ReadonlyArray<readonly [number, number]>,
): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    len += Math.hypot(x2 - x1, y2 - y1);
  }
  const segs = Math.round(len / TUBE_SEGMENT_TARGET_MM);
  return Math.max(TUBE_SEGMENTS_MIN, Math.min(segs, TUBE_SEGMENTS_MAX));
}
