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

  return segs
    .filter((s) => s.liveIndices.length >= 2)
    .map((s) => ({
      points: s.liveIndices.map((idx) => points[idx]),
      isBlockout: s.isBlockout,
      // Only a single, unbroken, live, closed loop renders as a
      // closed tube. Any blockout breaks the loop into open arcs.
      closed: wholeRunIsLive,
    }));
}
