import type { DesignRun } from '../api';

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

export function indicesToD(indices: number[], points: [number, number][], closed: boolean): string {
  if (indices.length === 0) return '';
  const parts: string[] = [];
  for (let i = 0; i < indices.length; i++) {
    const cmd = i === 0 ? 'M' : 'L';
    const [x, y] = points[indices[i]];
    parts.push(`${cmd}${x} ${y}`);
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
  return out;
}

function clamp(i: number, n: number): number {
  if (n === 0) return 0;
  if (i < 0) return 0;
  if (i >= n) return n - 1;
  return i;
}
