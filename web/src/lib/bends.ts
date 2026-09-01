import type { DesignRun } from '../api';
import { runArcs } from './runArcs';
import { vertexArcRadiusMM, vertexTurnDeg, walkSegmentLengthMM } from './arcGeom';

export type BendPoint = {
  liveIndex: number;       // index into the live arc (matches blockout/annotation index space)
  pointIndex: number;      // index into run.polyline.points
  x: number;               // mm
  y: number;               // mm
  arcLengthMM: number;     // arc length from the start of the live arc
  radiusMM: number;        // approximate local bend radius (circumradius around the apex)
  angleDeg: number;        // approximate cumulative turn angle through the bend
};

const DEFAULT_DIAMETER_MM = 10;
const TURN_MIN_DEG = 20;     // a "bend" must turn the tube at least this much
const CLUSTER_FACTOR = 2;    // bends within CLUSTER_FACTOR × diameter merge into one

// effectiveBends returns the run's authored bend list when present and
// non-empty, otherwise the auto-detected list. Manual bends still get
// their angle/radius computed from the polyline neighborhood.
export function effectiveBends(run: DesignRun, projectDiameterMM = DEFAULT_DIAMETER_MM): BendPoint[] {
  if (!run.bends || run.bends.length === 0) {
    return computeBends(run, projectDiameterMM);
  }
  const arcs = runArcs(run);
  const liveIdx = arcs.live;
  if (liveIdx.length < 3) return [];
  const pts = liveIdx.map((i) => run.polyline.points[i]);
  const n = pts.length;
  // Tier 3 #78 — an arc is ~15.9% longer than its chord, so chord-summing
  // would place every downstream callout short along the glass. Mirrors
  // designdoc.EffectiveBends; the editor's list and the printed page have to
  // agree or the operator is reading two different documents.
  const arcLen = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    arcLen[i] = arcLen[i - 1] + walkSegmentLengthMM(run, liveIdx[i - 1], liveIdx[i]);
  }
  return run.bends
    .filter((b) => b.live_index >= 0 && b.live_index < n)
    .map((b) => {
      const li = b.live_index;
      const lo = Math.max(0, li - 1);
      const hi = Math.min(n - 1, li + 1);
      const a = pts[lo];
      const c = pts[hi];
      // Magnitude: an arc leaves and rejoins its chord at half the included
      // angle, and this field has always reported an unsigned angle.
      const turn =
        (Math.abs(vertexTurnDeg(run, liveIdx[lo], liveIdx[li], liveIdx[hi])) * Math.PI) / 180;
      // When an arc meets the vertex, its radius is the one the bender forms.
      const arcR = vertexArcRadiusMM(run, liveIdx[lo], liveIdx[li], liveIdx[hi]);
      const r = arcR > 0 ? arcR : circumradius3(a, pts[li], c);
      return {
        liveIndex: li,
        pointIndex: liveIdx[li],
        x: pts[li][0],
        y: pts[li][1],
        arcLengthMM: arcLen[li],
        radiusMM: Number.isFinite(r) ? r : 0,
        angleDeg: (turn * 180) / Math.PI,
      };
    });
}

// computeBends scans a run's live arc and returns the points where the tube
// physically bends — auto-suggested apex locations a fabricator would heat
// and form. The detection is intentionally simple: per-vertex turn angles
// summed over a 3-vertex window, peaks grouped into contiguous bend regions
// with one apex per region.
export function computeBends(run: DesignRun, projectDiameterMM = DEFAULT_DIAMETER_MM): BendPoint[] {
  const arcs = runArcs(run);
  const liveIdx = arcs.live;
  if (liveIdx.length < 3) return [];
  const pts = liveIdx.map((i) => run.polyline.points[i]);
  const n = pts.length;

  // Tier 3 #78 — arc-aware, same reasoning as effectiveBends above.
  const arcLen = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    arcLen[i] = arcLen[i - 1] + walkSegmentLengthMM(run, liveIdx[i - 1], liveIdx[i]);
  }

  const turn = new Array<number>(n).fill(0);
  // Magnitude, not signed: detection below thresholds on size, so a signed
  // value would make every right-hand bend fall under it and disappear. The Go
  // side shipped exactly that bug once.
  for (let i = 1; i < n - 1; i++) {
    turn[i] =
      (Math.abs(vertexTurnDeg(run, liveIdx[i - 1], liveIdx[i], liveIdx[i + 1])) * Math.PI) / 180;
  }

  // 3-vertex window sum smooths out single-vertex jitter from polyline
  // flattening without erasing real local maxima.
  const smoothed = new Array<number>(n).fill(0);
  for (let i = 1; i < n - 1; i++) {
    const a = i > 1 ? turn[i - 1] : 0;
    const b = turn[i];
    const c = i < n - 2 ? turn[i + 1] : 0;
    smoothed[i] = a + b + c;
  }

  const turnMinRad = (TURN_MIN_DEG * Math.PI) / 180;

  // Walk smoothed[]; collect contiguous regions ≥ threshold; emit the apex.
  const raw: BendPoint[] = [];
  let inBend = false;
  let bestI = -1;
  let bestVal = 0;
  function flush() {
    if (!inBend || bestI < 0) return;
    const lo = Math.max(0, bestI - 1);
    const hi = Math.min(n - 1, bestI + 1);
    const a = pts[lo];
    const b = pts[bestI];
    const c = pts[hi];
    const arcR = vertexArcRadiusMM(run, liveIdx[lo], liveIdx[bestI], liveIdx[hi]);
    const r = arcR > 0 ? arcR : circumradius3(a, b, c);
    raw.push({
      liveIndex: bestI,
      pointIndex: liveIdx[bestI],
      x: pts[bestI][0],
      y: pts[bestI][1],
      arcLengthMM: arcLen[bestI],
      radiusMM: Number.isFinite(r) ? r : 0,
      angleDeg: (bestVal * 180) / Math.PI,
    });
    inBend = false;
    bestI = -1;
    bestVal = 0;
  }
  for (let i = 0; i < n; i++) {
    if (smoothed[i] >= turnMinRad) {
      if (!inBend || smoothed[i] > bestVal) {
        bestI = i;
        bestVal = smoothed[i];
      }
      inBend = true;
    } else if (inBend) {
      flush();
    }
  }
  flush();

  // Merge bends whose apexes fall within CLUSTER_FACTOR × diameter of each
  // other along the arc — in practice the heuristic sometimes splits one
  // physical bend into two when the polyline samples land just right.
  const D = run.tube_diameter_mm && run.tube_diameter_mm > 0 ? run.tube_diameter_mm : projectDiameterMM;
  const clusterMM = D * CLUSTER_FACTOR;
  const merged: BendPoint[] = [];
  for (const b of raw) {
    const last = merged[merged.length - 1];
    if (last && b.arcLengthMM - last.arcLengthMM < clusterMM) {
      if (b.angleDeg > last.angleDeg) merged[merged.length - 1] = b;
    } else {
      merged.push(b);
    }
  }
  return merged;
}

function distance(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

function circumradius3(a: [number, number], b: [number, number], c: [number, number]): number {
  const ab = distance(a, b);
  const bc = distance(b, c);
  const ca = distance(c, a);
  const s = (ab + bc + ca) / 2;
  const areaSq = s * (s - ab) * (s - bc) * (s - ca);
  if (areaSq <= 0) return Infinity;
  const area = Math.sqrt(areaSq);
  if (area < 1e-9) return Infinity;
  return (ab * bc * ca) / (4 * area);
}
