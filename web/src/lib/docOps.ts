// Pure functions that drive the editor's doc mutations. Extracting them
// here from EditorPage lets unit tests exercise each transformation
// without spinning up React or the canvas, and lets EditorPage stay
// focused on UI plumbing.
//
// Every op takes a DesignDoc and returns a NEW DesignDoc — the existing
// editDoc() wrapper in EditorPage handles undo-stack push and dirty flag.

import type {
  Annotation,
  Bend,
  Blockout,
  DesignDoc,
  DesignRun,
  Dimension,
  Label,
} from '../api';
import { computeBends, type BendPoint } from './bends';
import { defaultDirection } from './runArcs';

type Electrode = { point_index: number };

function mapRun(doc: DesignDoc, runId: string, fn: (run: DesignRun) => DesignRun): DesignDoc {
  return { ...doc, runs: doc.runs.map((r) => (r.id === runId ? fn(r) : r)) };
}

export function placeElectrode(doc: DesignDoc, runId: string, pointIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const existing = run.electrodes ?? [];
    let next: Electrode[];
    if (existing.length >= 2) {
      const dist = (idx: number) => Math.abs(idx - pointIndex);
      const replaceIdx = dist(existing[0].point_index) < dist(existing[1].point_index) ? 0 : 1;
      next = existing.slice();
      next[replaceIdx] = { point_index: pointIndex };
    } else {
      next = [...existing, { point_index: pointIndex }];
    }
    const updated: DesignRun = { ...run, electrodes: next };
    if (run.polyline.closed && next.length === 2 && !run.direction) {
      updated.direction = defaultDirection(updated);
    }
    return updated;
  });
}

export function deleteElectrode(doc: DesignDoc, runId: string, electrodeIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    electrodes: (run.electrodes ?? []).filter((_, i) => i !== electrodeIndex),
  }));
}

export function clearElectrodes(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => ({ ...run, electrodes: [] }));
}

export function flipDirection(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const cur = run.direction ?? defaultDirection(run);
    const next: 'forward' | 'backward' = cur === 'forward' ? 'backward' : 'forward';
    return { ...run, direction: next };
  });
}

export function placeBlockout(
  doc: DesignDoc,
  runId: string,
  startLiveIndex: number,
  endLiveIndex: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const s = Math.min(startLiveIndex, endLiveIndex);
    const e = Math.max(startLiveIndex, endLiveIndex);
    const blockouts: Blockout[] = [...(run.blockouts ?? []), { start_live_index: s, end_live_index: e }];
    return { ...run, blockouts };
  });
}

export function deleteBlockout(doc: DesignDoc, runId: string, blockoutIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    blockouts: (run.blockouts ?? []).filter((_, i) => i !== blockoutIndex),
  }));
}

export function placeAnnotation(
  doc: DesignDoc,
  runId: string,
  kind: Annotation['kind'],
  liveIndex: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    annotations: [...(run.annotations ?? []), { kind, live_index: liveIndex }],
  }));
}

export function deleteAnnotation(doc: DesignDoc, runId: string, annotationIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => ({
    ...run,
    annotations: (run.annotations ?? []).filter((_, i) => i !== annotationIndex),
  }));
}

export function placeBend(
  doc: DesignDoc,
  runId: string,
  liveIndex: number,
  projectDiameterMM: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const seed: Bend[] = run.bends && run.bends.length > 0
      ? run.bends
      : computeBends(run, projectDiameterMM).map((b: BendPoint) => ({ live_index: b.liveIndex }));
    if (seed.some((b) => Math.abs(b.live_index - liveIndex) < 2)) {
      return { ...run, bends: seed };
    }
    const bends = [...seed, { live_index: liveIndex }].sort((a, b) => a.live_index - b.live_index);
    return { ...run, bends };
  });
}

export function deleteBend(
  doc: DesignDoc,
  runId: string,
  bendIndex: number,
  projectDiameterMM: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const seed: Bend[] = run.bends && run.bends.length > 0
      ? run.bends
      : computeBends(run, projectDiameterMM).map((b: BendPoint) => ({ live_index: b.liveIndex }));
    return { ...run, bends: seed.filter((_, i) => i !== bendIndex) };
  });
}

export function resetBends(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const { bends: _drop, ...rest } = run;
    return rest;
  });
}

export function setRunColor(doc: DesignDoc, runId: string, color: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (color === '') {
      const { color: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, color };
  });
}

export function setRunDiameter(doc: DesignDoc, runId: string, diameterMM: number | null): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (diameterMM == null || Number.isNaN(diameterMM) || diameterMM <= 0) {
      const { tube_diameter_mm: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, tube_diameter_mm: diameterMM };
  });
}

export function setRunNotes(doc: DesignDoc, runId: string, notes: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (notes.trim() === '') {
      const { notes: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, notes };
  });
}

export function placeLabel(doc: DesignDoc, x: number, y: number, text: string): DesignDoc {
  const label: Label = { x, y, text };
  return { ...doc, labels: [...(doc.labels ?? []), label] };
}

export function deleteLabel(doc: DesignDoc, index: number): DesignDoc {
  return { ...doc, labels: (doc.labels ?? []).filter((_, i) => i !== index) };
}

export function placeDimension(
  doc: DesignDoc,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  note?: string,
): DesignDoc {
  const dim: Dimension = note ? { x1, y1, x2, y2, note } : { x1, y1, x2, y2 };
  return { ...doc, dimensions: [...(doc.dimensions ?? []), dim] };
}

export function deleteDimension(doc: DesignDoc, index: number): DesignDoc {
  return { ...doc, dimensions: (doc.dimensions ?? []).filter((_, i) => i !== index) };
}

export function moveVertex(
  doc: DesignDoc,
  runId: string,
  pointIndex: number,
  x: number,
  y: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (pointIndex < 0 || pointIndex >= run.polyline.points.length) return run;
    if (run.polyline.points[pointIndex][0] === x && run.polyline.points[pointIndex][1] === y) return run;
    const points = run.polyline.points.slice();
    points[pointIndex] = [x, y];
    return { ...run, polyline: { ...run.polyline, points } };
  });
}

// simplifyRun runs a Ramer-Douglas-Peucker pass on the polyline and trims
// vertices whose perpendicular distance to the line through their
// neighbors falls below epsilonMM. Adjusts electrode and live-arc-indexed
// references so blockouts/annotations/bends keep pointing at the same
// physical part of the tube. No-op if epsilon is non-positive.
export function simplifyRun(doc: DesignDoc, runId: string, epsilonMM: number): DesignDoc {
  if (!(epsilonMM > 0)) return doc;
  return mapRun(doc, runId, (run) => {
    const pts = run.polyline.points;
    if (pts.length < 4) return run;
    const keep = rdpKeep(pts, run.polyline.closed, epsilonMM);
    // Always keep both endpoints of an open polyline. (RDP already does
    // for the recursive case but the closed-loop branch can drop them.)
    if (!run.polyline.closed) {
      keep[0] = true;
      keep[pts.length - 1] = true;
    }
    // Always keep any electrode anchor so existing electrodes don't
    // suddenly point at a deleted vertex.
    for (const e of run.electrodes ?? []) {
      if (e.point_index >= 0 && e.point_index < keep.length) keep[e.point_index] = true;
    }
    if (keep.every((b) => b)) return run;
    // Build the index remap and the new point list in one pass.
    const remap = new Array<number>(pts.length).fill(-1);
    const newPts: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      if (keep[i]) {
        remap[i] = newPts.length;
        newPts.push(pts[i]);
      }
    }
    if (newPts.length < (run.polyline.closed ? 3 : 2)) return run;
    const electrodes = (run.electrodes ?? []).map((e) => ({
      ...e,
      point_index: remap[e.point_index] >= 0 ? remap[e.point_index] : 0,
    }));
    // Live-arc indices for blockouts/annotations/bends are positions
    // within the live arc, not raw polyline indices, so they don't need
    // remapping when we keep all electrodes — the live arc just becomes
    // shorter. Clamp them to the new length.
    const newLiveLen = run.polyline.closed && (run.electrodes?.length ?? 0) === 2
      ? estimateLiveArcLen(newPts.length, true)
      : newPts.length;
    const clamp = (i: number) => Math.max(0, Math.min(newLiveLen - 1, i));
    return {
      ...run,
      polyline: { ...run.polyline, points: newPts },
      electrodes,
      blockouts: (run.blockouts ?? []).map((b) => ({
        start_live_index: clamp(Math.round((b.start_live_index / Math.max(1, pts.length - 1)) * (newPts.length - 1))),
        end_live_index: clamp(Math.round((b.end_live_index / Math.max(1, pts.length - 1)) * (newPts.length - 1))),
      })),
      annotations: (run.annotations ?? []).map((a) => ({
        ...a,
        live_index: clamp(Math.round((a.live_index / Math.max(1, pts.length - 1)) * (newPts.length - 1))),
      })),
      bends: (run.bends ?? []).map((b) => ({
        live_index: clamp(Math.round((b.live_index / Math.max(1, pts.length - 1)) * (newPts.length - 1))),
      })),
    };
  });
}

function estimateLiveArcLen(_n: number, _closed: boolean): number {
  // After simplify, we don't know the exact live-arc length without
  // re-running runArcs. The clamp below uses newPts.length as an
  // upper bound, which is correct for the common no-electrode case.
  return _n;
}

// rdpKeep returns a boolean per polyline vertex: true = retained, false =
// dropped. For closed polylines, picks the two extremal points as the
// initial split before running RDP on each half.
function rdpKeep(pts: [number, number][], closed: boolean, eps: number): boolean[] {
  const n = pts.length;
  const keep = new Array<boolean>(n).fill(false);
  if (n === 0) return keep;
  if (n <= 2) {
    keep.fill(true);
    return keep;
  }
  if (!closed) {
    keep[0] = true;
    keep[n - 1] = true;
    rdpRecurse(pts, 0, n - 1, eps, keep);
    return keep;
  }
  // Closed: find the two points farthest apart, split the loop there,
  // then RDP each half.
  let bestI = 0;
  let bestJ = 1;
  let bestD = -Infinity;
  // Sample ~32 points to find an approximate diameter; full O(n²) is too slow on dense polylines.
  const stride = Math.max(1, Math.floor(n / 32));
  for (let i = 0; i < n; i += stride) {
    for (let j = i + 1; j < n; j += stride) {
      const dx = pts[j][0] - pts[i][0];
      const dy = pts[j][1] - pts[i][1];
      const d = dx * dx + dy * dy;
      if (d > bestD) {
        bestD = d;
        bestI = i;
        bestJ = j;
      }
    }
  }
  keep[bestI] = true;
  keep[bestJ] = true;
  rdpRecurse(pts, bestI, bestJ, eps, keep);
  // Second arc wraps; reindex by walking j → n-1 → 0 → i.
  rdpRecurseClosed(pts, bestJ, bestI, n, eps, keep);
  return keep;
}

function rdpRecurse(pts: [number, number][], i: number, j: number, eps: number, keep: boolean[]): void {
  if (j - i < 2) return;
  let maxD = 0;
  let maxK = -1;
  for (let k = i + 1; k < j; k++) {
    const d = perpDist(pts[k], pts[i], pts[j]);
    if (d > maxD) {
      maxD = d;
      maxK = k;
    }
  }
  if (maxK >= 0 && maxD > eps) {
    keep[maxK] = true;
    rdpRecurse(pts, i, maxK, eps, keep);
    rdpRecurse(pts, maxK, j, eps, keep);
  }
}

function rdpRecurseClosed(pts: [number, number][], from: number, to: number, n: number, eps: number, keep: boolean[]): void {
  // Walk from `from` forward (wrapping) until we hit `to`, applying RDP
  // along the way. Handled by mapping to a flat index array.
  const path: number[] = [];
  let i = from;
  for (;;) {
    path.push(i);
    if (i === to) break;
    i = (i + 1) % n;
    if (path.length > n) return; // safety
  }
  rdpRecurseFlat(pts, path, 0, path.length - 1, eps, keep);
}

function rdpRecurseFlat(pts: [number, number][], path: number[], i: number, j: number, eps: number, keep: boolean[]): void {
  if (j - i < 2) return;
  let maxD = 0;
  let maxK = -1;
  const a = pts[path[i]];
  const b = pts[path[j]];
  for (let k = i + 1; k < j; k++) {
    const d = perpDist(pts[path[k]], a, b);
    if (d > maxD) {
      maxD = d;
      maxK = k;
    }
  }
  if (maxK >= 0 && maxD > eps) {
    keep[path[maxK]] = true;
    rdpRecurseFlat(pts, path, i, maxK, eps, keep);
    rdpRecurseFlat(pts, path, maxK, j, eps, keep);
  }
}

function perpDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs((dy * p[0] - dx * p[1]) + b[0] * a[1] - b[1] * a[0]) / len;
}

// reverseRun flips the polyline order and rewrites every index that
// referenced a polyline vertex (electrodes) so they keep pointing at
// the same physical point. Live-arc indices stay numerically valid:
// their length doesn't change, just the walk direction. Useful when
// the user wants to swap which end of an open run is "start" — affects
// electrode-to-electrode order and the bend-list numbering.
export function reverseRun(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const pts = run.polyline.points;
    const n = pts.length;
    if (n < 2) return run;
    const reversed = pts.slice().reverse();
    const flip = (i: number) => n - 1 - i;
    return {
      ...run,
      polyline: { ...run.polyline, points: reversed },
      electrodes: (run.electrodes ?? []).map((e) => ({ ...e, point_index: flip(e.point_index) })),
    };
  });
}

export function deleteVertex(doc: DesignDoc, runId: string, pointIndex: number): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const minPts = run.polyline.closed ? 3 : 2;
    if (run.polyline.points.length <= minPts) return run;
    const points = run.polyline.points.filter((_, i) => i !== pointIndex);
    const shift = (i: number) => (i > pointIndex ? i - 1 : i);
    const electrodes = (run.electrodes ?? [])
      .filter((e) => e.point_index !== pointIndex)
      .map((e) => ({ ...e, point_index: shift(e.point_index) }));
    return {
      ...run,
      polyline: { ...run.polyline, points },
      electrodes,
    };
  });
}
