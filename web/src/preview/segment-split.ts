// Per-segment split for the Phase 3 tube preview.
//
// Phase 3 #6 introduces two pieces of fidelity over #2 / #3:
//   1. Tubes are no longer rendered as one geometry per run; runs whose
//      `Run.Blockouts` mark a sub-arc as painted-over are split into
//      live + blockout sub-segments, each with its own material.
//   2. Electrode caps draw at the polyline points named by
//      `Run.Electrodes` (handled by `Electrode.tsx`).
//
// `splitRunBySegments` is the pure helper for (1). It returns a flat
// list of segments whose `points` field is the 2D polyline slice the
// caller hands directly to `polylineToCurve`. The Y-flip is the
// caller's responsibility — same convention as #2.
//
// Indices subtlety: `Run.Blockouts` use *live-arc* indices (positions
// within the visible tube between the run's two electrodes), NOT raw
// polyline indices. The translation is done by
// `lib/runArcs.blockoutSegments`, which we delegate to. For runs
// without two electrodes, the live arc IS the whole polyline, so the
// behavior reduces to "operate on point indices" and matches the
// spec's worked example exactly.
//
// Seam-point sharing: each blockout segment shares its first/last
// polyline point with the adjacent live segment, so the rendered
// tube is continuous across the seam. `blockoutSegments` already
// emits the seam point in both segments; we preserve that contract.

import type { DesignRun } from '../api';
import { blockoutSegments, runArcs } from '../lib/runArcs';
import { flattenSegment, isArcKind, segmentIndexBetween, segmentTypeAt } from '../lib/arcGeom';

export interface RunSegment {
  // Polyline point pairs ([x, y] in mm, doc-Y convention). Hand
  // straight to `polylineToCurve` from `tube-geom.ts`.
  points: [number, number][];
  // True for sub-arcs covered by black-out paint; the renderer
  // applies the dark sleeve material instead of the emissive one.
  isBlockout: boolean;
  // The sub-segment is closed only when the entire run is closed
  // AND the segment spans the full live arc with no blockouts (i.e.
  // a closed loop with no painted-over portion). Otherwise the
  // segment renders as an open tube.
  closed: boolean;
  // Indices INTO `points` (segment-local) for each `kind: 'jump'`
  // annotation that falls inside this segment's slice. Tier 3 #68 —
  // the renderer feeds these to `liftPointsAtJumps` to raise the
  // tube out of plane at jump locations. Empty array (the common
  // case) means the segment renders flat at Z=0.
  jumpPolylineIndices: number[];
  // Indices INTO `points` (segment-local) for each `kind: 'drop_bend'`
  // annotation that falls inside this segment's slice. Tier 3 #77 —
  // distinct from `jumpPolylineIndices` because drop-bends use a
  // different lift kernel (0.5× diameter instead of 2.5×) and are
  // explicitly not clustered with jumps. Empty array (the common
  // case) means no drop-bend dips on this segment.
  dropBendPolylineIndices: number[];
}

/**
 * Split a run's polyline into alternating live / blockout segments
 * suitable for individual `<tubeGeometry>` calls.
 *
 * Empty / single-point runs produce no segments — the renderer
 * filters them out anyway, so returning `[]` is the cleanest API.
 *
 * Runs with no blockouts produce a single segment carrying the
 * whole polyline; the caller doesn't need to special-case the
 * common path.
 */
export function splitRunBySegments(run: DesignRun): RunSegment[] {
  const points = run.polyline.points;
  if (!points || points.length < 2) return [];

  const arcs = runArcs(run);
  const liveIndices = arcs.live;
  if (liveIndices.length < 2) return [];

  const segs = blockoutSegments(liveIndices, run.blockouts, arcs.liveClosed);
  if (segs.length === 0) return [];

  const wholeRunIsLive =
    segs.length === 1 && !segs[0].isBlockout && arcs.liveClosed;

  // Translate `kind: 'jump'` and `kind: 'drop_bend'` annotations from
  // live-arc index to polyline index once. Each annotation's
  // `live_index` is a position in the live arc; the polyline index it
  // maps to is `liveIndices[live_index]`. Out-of-range live indices
  // (from edits that orphaned an annotation) are silently skipped —
  // `liftPointsAtJumps` already handles out-of-range polyline indices,
  // but filtering here keeps the per-segment index lists honest.
  //
  // Tier 3 #77 — jumps and drop-bends live in separate arrays
  // because they map to different lift kernels and intentionally
  // do not cluster together.
  const jumpPolylineIdxs: number[] = [];
  const dropBendPolylineIdxs: number[] = [];
  const annotations = run.annotations ?? [];
  for (const a of annotations) {
    if (a.live_index < 0 || a.live_index >= liveIndices.length) continue;
    if (a.kind === 'jump') {
      jumpPolylineIdxs.push(liveIndices[a.live_index]);
    } else if (a.kind === 'drop_bend') {
      dropBendPolylineIdxs.push(liveIndices[a.live_index]);
    }
  }

  return segs
    .filter((s) => s.liveIndices.length >= 2)
    .map((s) => {
      // Per-segment: include only jumps / drop-bends whose polyline
      // index falls inside this segment's slice. Translate to a
      // segment-local (zero-based) index so the renderer can hand it
      // straight to `liftPointsAtJumps` without further translation.
      // Tier 3 #78 — expand arc segments into their sampled curve so the
      // preview shows the tube bending. Without this a curved segment is two
      // vertices, and CatmullRom through two points is a straight line: the 2D
      // canvas and the printed pattern would show a curve while the 3D preview
      // showed a chord.
      //
      // `localOf[k]` is where walk position k landed in the expanded array,
      // which is what the jump / drop-bend indices below are remapped through.
      const expanded: [number, number][] = [];
      const localOf: number[] = [];
      for (let k = 0; k < s.liveIndices.length; k++) {
        const idx = s.liveIndices[k];
        if (k === 0) {
          localOf.push(expanded.length);
          expanded.push(points[idx]);
          continue;
        }
        const prev = s.liveIndices[k - 1];
        const hit = segmentIndexBetween(prev, idx, points.length, !!run.polyline.closed);
        const segType = hit ? segmentTypeAt(run, hit.seg) : 'line';
        if (isArcKind(segType) && hit) {
          const a = points[hit.seg];
          const b = points[(hit.seg + 1) % points.length];
          // A backwards walk traces the SAME circle, so it must flatten the
          // forward segment and walk those samples in reverse. Flattening
          // b -> a instead asks arcFor for the arc that bows left of b -> a,
          // which is the mirror of this one; and the samples then came out
          // ordered from the far end, so the tube zigzagged across the chord.
          // Probed before the fix on a=(0,0) b=(100,0): the walk began at
          // (3.3, -4.1) — mirrored bow, wrong end — and should begin at
          // (96.7, +4.1).
          const fwd = flattenSegment(a, b, segType);
          const samples = hit.reversed
            ? [...fwd.slice(0, -1).reverse(), a]
            : fwd;
          for (const pt of samples) expanded.push(pt);
          localOf.push(expanded.length - 1);
          continue;
        }
        localOf.push(expanded.length);
        expanded.push(points[idx]);
      }

      const segLocalJumps: number[] = [];
      for (const ji of jumpPolylineIdxs) {
        const walkIdx = s.liveIndices.indexOf(ji);
        if (walkIdx >= 0) segLocalJumps.push(localOf[walkIdx]);
      }
      const segLocalDropBends: number[] = [];
      for (const di of dropBendPolylineIdxs) {
        const walkIdx = s.liveIndices.indexOf(di);
        if (walkIdx >= 0) segLocalDropBends.push(localOf[walkIdx]);
      }
      return {
        points: expanded,
        isBlockout: s.isBlockout,
        // Only a single, unbroken, live, closed loop renders as a
        // closed tube. Any blockout breaks the loop into open arcs.
        closed: wholeRunIsLive,
        jumpPolylineIndices: segLocalJumps,
        dropBendPolylineIndices: segLocalDropBends,
      };
    });
}
