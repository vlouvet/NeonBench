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

  // Translate `kind: 'jump'` annotations from live-arc index to
  // polyline index once. A jump's `live_index` is a position in the
  // live arc; the polyline index it maps to is `liveIndices[live_index]`.
  // Out-of-range live indices (from edits that orphaned an annotation)
  // are silently skipped — `liftPointsAtJumps` already handles
  // out-of-range polyline indices, but filtering here keeps the
  // per-segment `jumpPolylineIndices` lists honest.
  const jumpPolylineIdxs: number[] = [];
  const annotations = run.annotations ?? [];
  for (const a of annotations) {
    if (a.kind !== 'jump') continue;
    if (a.live_index < 0 || a.live_index >= liveIndices.length) continue;
    jumpPolylineIdxs.push(liveIndices[a.live_index]);
  }

  return segs
    .filter((s) => s.liveIndices.length >= 2)
    .map((s) => {
      // Per-segment: include only jumps whose polyline index falls
      // inside this segment's slice. Translate to a segment-local
      // (zero-based) index so the renderer can hand it straight to
      // `liftPointsAtJumps` without further translation.
      const segLocalJumps: number[] = [];
      for (const ji of jumpPolylineIdxs) {
        const localIdx = s.liveIndices.indexOf(ji);
        if (localIdx >= 0) segLocalJumps.push(localIdx);
      }
      return {
        points: s.liveIndices.map((idx) => points[idx]),
        isBlockout: s.isBlockout,
        // Only a single, unbroken, live, closed loop renders as a
        // closed tube. Any blockout breaks the loop into open arcs.
        closed: wholeRunIsLive,
        jumpPolylineIndices: segLocalJumps,
      };
    });
}
