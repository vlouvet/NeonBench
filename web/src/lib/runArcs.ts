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
