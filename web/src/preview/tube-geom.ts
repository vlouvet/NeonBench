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

// Jump-annotation lift constants (Tier 3 #68). A `kind: 'jump'`
// annotation is the trade convention for "the tube physically arcs
// out of plane here so it can pass over another tube." We model that
// as a localized Z-lift centered on the jump's polyline point, sized
// relative to the run's tube diameter so a 12 mm tube and a 22 mm
// tube each get a proportional horseshoe.
//
//   HEIGHT = 1.0 × diameter (≈ 12 mm of lift on a 12 mm spec). One
//     diameter is the trade-typical "small u-bend over" on a hand-
//     drawn pattern — enough clearance to read as 'over' without
//     turning every jump into a billboard.
//   SPAN   = 4.0 × diameter (≈ 48 mm of lifted polyline on a 12 mm
//     spec). Wide enough that two crossing tubes read as one passing
//     over the other; narrow enough that a multi-letter sign with
//     several jumps doesn't end up looking like a wave.
//
// Tunable per-project is a follow-up.
export const JUMP_LIFT_HEIGHT_MULT = 1.0;
export const JUMP_LIFT_SPAN_MULT = 4.0;

/**
 * Pure helper for the Tier 3 #68 jump-lift feature. Returns 3D points
 * with Z lifted by a raised-cosine kernel centered on each jump in
 * the segment.
 *
 * Distance is **arc length** along the polyline (sum of segment
 * lengths from the point to the jump's polyline point), NOT
 * Euclidean — so the lift follows the tube's path even around tight
 * corners. Points outside any jump's span keep Z = 0; points inside
 * multiple overlapping spans take the max (not sum) so two close
 * jumps don't double up.
 *
 * Empty `jumpIndicesInSegment`, zero diameter, or single-point
 * polylines all short-circuit to the unlifted (Z=0) form.
 */
export function liftPointsAtJumps(
  points: ReadonlyArray<readonly [number, number]>,
  jumpIndicesInSegment: ReadonlyArray<number>,
  diameterMM: number,
): [number, number, number][] {
  if (
    points.length === 0 ||
    jumpIndicesInSegment.length === 0 ||
    diameterMM <= 0
  ) {
    return points.map(([x, y]) => [x, y, 0]);
  }
  const span = JUMP_LIFT_SPAN_MULT * diameterMM;
  const halfSpan = span / 2;
  const height = JUMP_LIFT_HEIGHT_MULT * diameterMM;

  // Cumulative arc length from index 0 to index i.
  const arcAt: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    arcAt.push(arcAt[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }

  // Filter jumps to in-range and pre-resolve their arc positions.
  const jumpArcs: number[] = [];
  for (const j of jumpIndicesInSegment) {
    if (j >= 0 && j < points.length) jumpArcs.push(arcAt[j]);
  }
  if (jumpArcs.length === 0) {
    return points.map(([x, y]) => [x, y, 0]);
  }

  return points.map(([x, y], i) => {
    let z = 0;
    for (const ja of jumpArcs) {
      const d = Math.abs(arcAt[i] - ja);
      if (d >= halfSpan) continue;
      const k = (d / halfSpan) * (Math.PI / 2);
      const c = Math.cos(k);
      const lift = height * c * c;
      if (lift > z) z = lift;
    }
    return [x, y, z];
  });
}

/**
 * Convert a polyline (millimeter tuples) into a `THREE.CatmullRomCurve3`.
 * Accepts either 2D `[x, y]` tuples (Z defaults to 0, classic flat
 * tubes) or 3D `[x, y, z]` tuples (Tier 3 #68 jump lifts; Z carries
 * the out-of-plane offset).
 *
 * Y is flipped on the way out: design-doc Y points down (screen
 * convention), three.js Y points up. Z is NOT flipped — the lift
 * helper produces Z+ values that mean "toward the viewer," which
 * matches three.js's Z+ convention.
 *
 * Catmull-Rom smooths between control points so a polyline with sharp
 * angles renders as a tube with gentle curves — the right look for
 * glass neon, which can't bend on a dime.
 *
 * Returns a degenerate two-point curve (origin → +1 X) when called
 * with fewer than two points; the caller filters runs that wouldn't
 * extrude meaningfully, this helper just refuses to crash.
 */
export function polylineToCurve(
  points: ReadonlyArray<readonly [number, number] | readonly [number, number, number]>,
  closed: boolean,
): THREE.CatmullRomCurve3 {
  if (points.length < 2) {
    return new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(1, 0, 0),
    ]);
  }
  const v3 = points.map((p) => {
    const x = p[0];
    const y = p[1];
    const z = p.length >= 3 ? (p as readonly [number, number, number])[2] : 0;
    return new THREE.Vector3(x, -y, z); // Y-flip: doc +y down → three +y up
  });
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
