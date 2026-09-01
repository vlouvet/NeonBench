import type { DesignRun } from '../api';
import { arcCubics, runHasArcs, segmentIndexBetween, segmentTypeAt } from './arcGeom';

export type RunArcs = {
  // Indices into run.polyline.points. `live` is always non-empty for valid
  // runs; `inactive` is empty unless the run is a closed loop with two
  // electrodes (the loop's other half).
  live: number[];
  inactive: number[];
  liveClosed: boolean;
};

export function runArcs(run: DesignRun): RunArcs {
  const n = run.polyline.points.length;
  if (n === 0) return { live: [], inactive: [], liveClosed: false };

  const electrodes = run.electrodes ?? [];
  if (!run.polyline.closed || electrodes.length !== 2) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return { live: all, inactive: [], liveClosed: run.polyline.closed };
  }

  const a = electrodes[0].point_index;
  const b = electrodes[1].point_index;
  if (a < 0 || a >= n || b < 0 || b >= n) {
    const all: number[] = [];
    for (let i = 0; i < n; i++) all.push(i);
    return { live: all, inactive: [], liveClosed: true };
  }

  const dir = run.direction ?? defaultDirection(run);
  const fwd = arcForward(a, b, n);
  const bwd = arcBackward(a, b, n);
  if (dir === 'backward') {
    return { live: bwd, inactive: fwd, liveClosed: false };
  }
  return { live: fwd, inactive: bwd, liveClosed: false };
}

export function defaultDirection(run: DesignRun): 'forward' | 'backward' {
  if (!run.polyline.closed || (run.electrodes?.length ?? 0) !== 2) return 'forward';
  const n = run.polyline.points.length;
  const a = run.electrodes![0].point_index;
  const b = run.electrodes![1].point_index;
  const fwd = arcLength(arcForward(a, b, n), run.polyline.points);
  const bwd = arcLength(arcBackward(a, b, n), run.polyline.points);
  return bwd > fwd ? 'backward' : 'forward';
}

function arcForward(a: number, b: number, n: number): number[] {
  const out = [a];
  for (let i = (a + 1) % n; ; i = (i + 1) % n) {
    out.push(i);
    if (i === b) break;
  }
  return out;
}

function arcBackward(a: number, b: number, n: number): number[] {
  const out = [a];
  for (let i = (a - 1 + n) % n; ; i = (i - 1 + n) % n) {
    out.push(i);
    if (i === b) break;
  }
  return out;
}

function arcLength(indices: number[], points: [number, number][]): number {
  let total = 0;
  for (let i = 1; i < indices.length; i++) {
    const dx = points[indices[i]][0] - points[indices[i - 1]][0];
    const dy = points[indices[i]][1] - points[indices[i - 1]][1];
    total += Math.sqrt(dx * dx + dy * dy);
  }
  return total;
}

// Tier 3 #78 — `run` is optional so the many callers that only have a point
// list keep working; pass it and a segment marked as an arc is drawn as the
// same two cubics the Go SVG writer emits, so the on-screen curve and the
// printed pattern are one geometry rather than two that resemble each other.
//
// Cubics rather than an SVG `A`: the validator's path parser approximates
// elliptical arcs as straight lines (see internal/validate/pathd.go), and
// keeping both emitters on the same primitive means they cannot diverge.
export function indicesToD(
  indices: number[],
  points: [number, number][],
  closed: boolean,
  run?: DesignRun,
): string {
  if (indices.length === 0) return '';
  const parts: string[] = [];
  const n = points.length;
  const hasArcs = !!run && runHasArcs(run);
  for (let i = 0; i < indices.length; i++) {
    const [x, y] = points[indices[i]];
    if (i === 0) {
      parts.push(`M${x} ${y}`);
      continue;
    }
    if (hasArcs && run) {
      const hit = segmentIndexBetween(indices[i - 1], indices[i], n, !!run.polyline.closed);
      if (hit && segmentTypeAt(run, hit.seg) === 'arc') {
        const cubics = arcCubics(points[hit.seg], points[(hit.seg + 1) % n], hit.reversed);
        if (cubics.length > 0) {
          for (const c of cubics) {
            parts.push(`C${c.c1x} ${c.c1y} ${c.c2x} ${c.c2y} ${c.x} ${c.y}`);
          }
          continue;
        }
      }
    }
    parts.push(`L${x} ${y}`);
  }
  if (closed) parts.push('Z');
  return parts.join(' ');
}

// nearestLiveArcIndex finds the position WITHIN the live arc closest to the
// given world-space point. Blockouts are stored in live-arc index space (not
// raw polyline indices), so this is what the click→mark flow needs.
export function nearestLiveArcIndex(
  liveIndices: number[],
  points: [number, number][],
  target: [number, number],
): number {
  let best = 0;
  let bestD = Infinity;
  for (let li = 0; li < liveIndices.length; li++) {
    const p = points[liveIndices[li]];
    if (!p) continue;
    const dx = p[0] - target[0];
    const dy = p[1] - target[1];
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = li;
    }
  }
  return best;
}

// blockoutSegments mirrors the Go splitByBlockouts logic: walk the live
// indices and emit alternating alive/blockout sub-runs. The renderer uses
// this to overlay dashed segments on the live arc at the marked positions.
export type BlockoutSegment = {
  liveIndices: number[];
  isBlockout: boolean;
};

export function blockoutSegments(
  liveIndices: number[],
  blockouts: { start_live_index: number; end_live_index: number }[] | undefined,
  liveClosed: boolean,
): BlockoutSegment[] {
  const n = liveIndices.length;
  if (n === 0) return [];
  if (!blockouts || blockouts.length === 0) {
    return [{ liveIndices, isBlockout: false }];
  }
  const mask = new Array<boolean>(n).fill(false);
  for (const b of blockouts) {
    const s = clamp(b.start_live_index, n);
    const e = clamp(b.end_live_index, n);
    if (s === e) {
      mask[s] = true;
      continue;
    }
    let i = s;
    for (;;) {
      mask[i] = true;
      if (i === e) break;
      i++;
      if (i >= n) {
        if (!liveClosed) break;
        i = 0;
      }
    }
  }
  const out: BlockoutSegment[] = [];
  let cur: BlockoutSegment = { liveIndices: [], isBlockout: mask[0] };
  for (let j = 0; j < n; j++) {
    if (mask[j] !== cur.isBlockout && cur.liveIndices.length > 0) {
      out.push(cur);
      cur = { liveIndices: [liveIndices[j - 1]], isBlockout: mask[j] };
    }
    cur.liveIndices.push(liveIndices[j]);
  }
  if (cur.liveIndices.length > 0) out.push(cur);

  // Tier 3 #59 — closed-loop seam continuity. When a blockout
  // straddles index 0 of a closed live arc, the loop above emits two
  // separate blockout segments (one starting at index 0, one ending
  // at index n-1) that conceptually represent ONE continuous painted
  // arc through the wrap edge. Merge them so downstream renderers
  // (the 2D editor SVG and the 3D preview's segment-split) draw one
  // continuous dashed/dark sleeve instead of two.
  //
  // Guard: only fire on closed loops AND only when BOTH end segments
  // are blockouts. Open arcs never wrap (short-circuit). Closed loops
  // with mid-loop blockouts (first/last both live) are left unchanged
  // to preserve the identity invariant — those rendered correctly
  // pre-fix because two adjacent live tubes meet visually at the
  // seam-share point even though the wrap edge geometry is technically
  // missing. We don't want to change segment counts for docs that
  // were already rendering correctly.
  //
  // Merge formula: `[...last.liveIndices, ...first.liveIndices]`. The
  // pre-merge `last` ends at polyline index n-1 (no trailing seam-
  // share, j=n-1 was the loop's final iteration) and `first` starts
  // at polyline index 0 (no leading seam-share, j=0 was the loop's
  // first iteration). On a closed loop those two indices are adjacent
  // via the wrap edge n-1 -> 0, so we concatenate WITHOUT dropping a
  // duplicate. The resulting segment walks last (...n-1) -> wrap ->
  // first (0...) in polyline traversal order.
  if (liveClosed && out.length >= 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (first.isBlockout && last.isBlockout) {
      const merged: BlockoutSegment = {
        isBlockout: true,
        liveIndices: [...last.liveIndices, ...first.liveIndices],
      };
      return [merged, ...out.slice(1, -1)];
    }
  }
  return out;
}

function clamp(i: number, n: number): number {
  if (n === 0) return 0;
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}
