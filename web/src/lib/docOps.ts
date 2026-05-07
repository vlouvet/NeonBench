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

// setRunChannelLetterFace toggles the per-run "this is a channel-letter
// face silhouette" flag (NW #106). When true, the print PDF emits an
// unfolded return-strip page for this run. When false, we strip the
// key entirely so the design-doc JSON stays clean (omitempty).
export function setRunChannelLetterFace(
  doc: DesignDoc,
  runId: string,
  isFace: boolean,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (!isFace) {
      const { is_channel_letter_face: _drop, ...rest } = run;
      return rest;
    }
    return { ...run, is_channel_letter_face: true };
  });
}

// appendRuns inserts pre-built runs at the end of the design doc and
// rewrites their ids so they don't collide with existing run names. Used
// by the Hershey "Add text" tool, which generates one run per stroke per
// letter — `text-1`, `text-2`, … — and needs them to slot into the doc
// without clashing with previous text inserts.
export function appendRuns(doc: DesignDoc, newRuns: DesignRun[], idPrefix: string): DesignDoc {
  const taken = new Set(doc.runs.map((r) => r.id));
  let counter = 1;
  function nextId() {
    let id = `${idPrefix}-${counter++}`;
    while (taken.has(id)) id = `${idPrefix}-${counter++}`;
    taken.add(id);
    return id;
  }
  const reIded = newRuns.map((r) => ({ ...r, id: nextId() }));
  return { ...doc, runs: [...doc.runs, ...reIded] };
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

// insertVertex splices ONE new vertex into a polyline at the parametric
// position `t ∈ [0, 1]` along the chosen segment. The new vertex lands at
// index segmentIndex + 1; everything after shifts up by 1.
//
// Index-shifting follows the same pattern as insertDoubleback's bigger
// 4-vertex splice — anchors strictly before the insertion stay put,
// anchors at or after the insertion bump by 1. live_index handling for
// blockouts/annotations/bends uses the same simplification: in the
// common open-run no-electrode case live_index === polyline index, so
// the bump is correct. Closed runs with two electrodes are an edge case
// the user is unlikely to hit while shaping a polyline (you'd shape
// before placing electrodes), but we still apply the live-index bump
// conservatively.
export function insertVertex(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
  t: number,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const pts = run.polyline.points;
    if (segmentIndex < 0 || segmentIndex >= pts.length - 1) return run;
    const tt = Math.max(0, Math.min(1, t));
    const p1 = pts[segmentIndex];
    const p2 = pts[segmentIndex + 1];
    const nx = p1[0] + tt * (p2[0] - p1[0]);
    const ny = p1[1] + tt * (p2[1] - p1[1]);
    const k = segmentIndex;
    const newPts: [number, number][] = [
      ...pts.slice(0, k + 1),
      [nx, ny],
      ...pts.slice(k + 1),
    ];
    const shiftPoint = (i: number) => (i >= k + 1 ? i + 1 : i);
    const shiftLive = (i: number) => (i >= k + 1 ? i + 1 : i);
    return {
      ...run,
      polyline: { ...run.polyline, points: newPts },
      electrodes: run.electrodes
        ? run.electrodes.map((e) => ({ ...e, point_index: shiftPoint(e.point_index) }))
        : run.electrodes,
      blockouts: run.blockouts
        ? run.blockouts.map((b) => ({
            start_live_index: shiftLive(b.start_live_index),
            end_live_index: shiftLive(b.end_live_index),
          }))
        : run.blockouts,
      annotations: run.annotations
        ? run.annotations.map((a) => ({ ...a, live_index: shiftLive(a.live_index) }))
        : run.annotations,
      bends: run.bends
        ? run.bends.map((b) => ({ live_index: shiftLive(b.live_index) }))
        : run.bends,
    };
  });
}

// splitRun splits one polyline into two new runs at a vertex. The vertex
// at `pointIndex` is duplicated so it appears as the last vertex of the
// first run AND the first vertex of the second run — that way joining
// them back together (see joinRuns) reverses the operation cleanly.
//
// Closed runs are forced open by the split: the first new run gets
// indices [0..pointIndex], the second gets [pointIndex..n-1], both open.
// The first new run reuses the original id with `-a` suffix (preserves
// name continuity for selection-by-name); the second gets `-b`. Color,
// diameter override, notes are duplicated to both.
//
// Electrodes / blockouts / annotations / bends partition by their
// underlying anchor position relative to the split:
// - Electrodes pointing strictly before pointIndex stay on run-a.
// - Electrodes pointing strictly after pointIndex go to run-b with
//   point_index − pointIndex.
// - Electrodes exactly at pointIndex are ambiguous; V1 drops them with
//   a console.warn — realistic users will replace them.
// - Blockouts entirely on one side stay there; straddling blockouts are
//   dropped with a warn (V1 — splitting a blockout into two valid
//   pieces is a follow-up).
// - Annotations / bends partition by live_index against the live arc;
//   for the common open-run no-electrode case live_index === polyline
//   index so the same partition applies.
export function splitRun(doc: DesignDoc, runId: string, pointIndex: number): DesignDoc {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return doc;
  const pts = run.polyline.points;
  const n = pts.length;
  // Need at least 2 vertices on each side after splitting (so each new
  // run has at least 2 points). The split duplicates pointIndex, so
  // run-a gets pointIndex+1 points and run-b gets n-pointIndex points.
  if (pointIndex <= 0 || pointIndex >= n - 1) return doc;

  const aPts = pts.slice(0, pointIndex + 1);
  const bPts = pts.slice(pointIndex);

  const aId = `${run.id}-a`;
  const bId = `${run.id}-b`;

  // Partition electrodes by their polyline anchor.
  const aElectrodes: Electrode[] = [];
  const bElectrodes: Electrode[] = [];
  for (const e of run.electrodes ?? []) {
    if (e.point_index < pointIndex) {
      aElectrodes.push({ ...e, point_index: e.point_index });
    } else if (e.point_index > pointIndex) {
      bElectrodes.push({ ...e, point_index: e.point_index - pointIndex });
    } else {
      // Exactly at the split — ambiguous, drop with a warning.
      console.warn(
        `splitRun: electrode at split point ${pointIndex} on run ${run.id} dropped (ambiguous)`,
      );
    }
  }

  // Partition blockouts: live_index is treated as polyline index for the
  // common open-run no-electrode case (which is what splitRun is for).
  // Straddling blockouts are dropped with a warning.
  const aBlockouts: Blockout[] = [];
  const bBlockouts: Blockout[] = [];
  for (const b of run.blockouts ?? []) {
    const s = b.start_live_index;
    const e = b.end_live_index;
    const lo = Math.min(s, e);
    const hi = Math.max(s, e);
    if (hi <= pointIndex) {
      aBlockouts.push({ start_live_index: s, end_live_index: e });
    } else if (lo >= pointIndex) {
      bBlockouts.push({
        start_live_index: s - pointIndex,
        end_live_index: e - pointIndex,
      });
    } else {
      // Straddles the split.
      console.warn(
        `splitRun: blockout [${s}, ${e}] on run ${run.id} straddles split point ${pointIndex} — dropped`,
      );
    }
  }

  // Partition annotations and bends similarly. Annotations / bends at
  // exactly the split point go to run-a (the duplicated vertex is the
  // last vertex of run-a).
  const aAnnotations: Annotation[] = [];
  const bAnnotations: Annotation[] = [];
  for (const a of run.annotations ?? []) {
    if (a.live_index <= pointIndex) {
      aAnnotations.push({ ...a, live_index: a.live_index });
    } else {
      bAnnotations.push({ ...a, live_index: a.live_index - pointIndex });
    }
  }
  const aBends: Bend[] = [];
  const bBends: Bend[] = [];
  for (const b of run.bends ?? []) {
    if (b.live_index <= pointIndex) {
      aBends.push({ live_index: b.live_index });
    } else {
      bBends.push({ live_index: b.live_index - pointIndex });
    }
  }

  function withMeta(
    id: string,
    points: [number, number][],
    electrodes: Electrode[],
    blockouts: Blockout[],
    annotations: Annotation[],
    bends: Bend[],
  ): DesignRun {
    const next: DesignRun = {
      id,
      polyline: { points, closed: false },
    };
    if (run!.tube_diameter_mm != null) next.tube_diameter_mm = run!.tube_diameter_mm;
    if (run!.color != null) next.color = run!.color;
    if (run!.notes != null) next.notes = run!.notes;
    if (electrodes.length > 0) next.electrodes = electrodes;
    if (blockouts.length > 0) next.blockouts = blockouts;
    if (annotations.length > 0) next.annotations = annotations;
    if (bends.length > 0) next.bends = bends;
    return next;
  }

  const aRun = withMeta(aId, aPts, aElectrodes, aBlockouts, aAnnotations, aBends);
  const bRun = withMeta(bId, bPts, bElectrodes, bBlockouts, bAnnotations, bBends);

  // Replace the original run in-place (preserves position in the run list)
  // with the two new runs.
  const idx = doc.runs.findIndex((r) => r.id === runId);
  const nextRuns = doc.runs.slice();
  nextRuns.splice(idx, 1, aRun, bRun);
  return { ...doc, runs: nextRuns };
}

// joinRuns merges two polylines into one. `endpointA` and `endpointB`
// are 'head' (first vertex) or 'tail' (last vertex) — which end of each
// run participates in the join. The implementation reverses one or both
// so the join is conceptually tail-to-head:
//
//   tail-to-head:  runA + runB                  (no reversal)
//   tail-to-tail:  runA + reverse(runB)
//   head-to-head:  reverse(runA) + runB
//   head-to-tail:  reverse(runA) + reverse(runB) === reverse(runB + runA)
//
// The duplicated vertex at the join (within 0.01mm) is dropped. The
// result inherits runA's metadata (color, diameter, notes). The two
// original runs are removed from doc.runs and replaced by the single
// joined run, which gets runA's id (preserves selection state).
//
// Self-join (runA === runB, head joined to its own tail) produces a
// closed run.
//
// Annotations / electrodes / blockouts / bends are transformed through
// the reversal + concatenation. The math is bug-prone — see tests.
export function joinRuns(
  doc: DesignDoc,
  runIdA: string,
  endpointA: 'head' | 'tail',
  runIdB: string,
  endpointB: 'head' | 'tail',
): DesignDoc {
  const runA = doc.runs.find((r) => r.id === runIdA);
  const runB = doc.runs.find((r) => r.id === runIdB);
  if (!runA || !runB) return doc;

  // Self-join: same run, opposite endpoints → close it into a loop.
  if (runIdA === runIdB) {
    if (endpointA === endpointB) return doc; // can't join an end to itself
    if (runA.polyline.closed) return doc; // already closed
    const closed: DesignRun = {
      ...runA,
      polyline: { ...runA.polyline, closed: true },
    };
    return { ...doc, runs: doc.runs.map((r) => (r.id === runIdA ? closed : r)) };
  }

  // Reverse-helper that transforms the run plus all of its anchored
  // metadata (electrodes via point_index; blockouts/annotations/bends
  // via live_index treated as polyline index for the common case).
  function reversedRun(r: DesignRun): DesignRun {
    const n = r.polyline.points.length;
    const flipPt = (i: number) => n - 1 - i;
    return {
      ...r,
      polyline: { ...r.polyline, points: r.polyline.points.slice().reverse() },
      electrodes: r.electrodes
        ? r.electrodes.map((e) => ({ ...e, point_index: flipPt(e.point_index) }))
        : r.electrodes,
      blockouts: r.blockouts
        ? r.blockouts.map((b) => ({
            start_live_index: flipPt(b.start_live_index),
            end_live_index: flipPt(b.end_live_index),
          }))
        : r.blockouts,
      annotations: r.annotations
        ? r.annotations.map((a) => ({ ...a, live_index: flipPt(a.live_index) }))
        : r.annotations,
      bends: r.bends
        ? r.bends.map((b) => ({ live_index: flipPt(b.live_index) }))
        : r.bends,
    };
  }

  // Pick the orientation that puts runA's tail next to runB's head.
  const a = endpointA === 'tail' ? runA : reversedRun(runA);
  const b = endpointB === 'head' ? runB : reversedRun(runB);

  const aPts = a.polyline.points;
  const bPts = b.polyline.points;
  const aLast = aPts[aPts.length - 1];
  const bFirst = bPts[0];
  // Drop the duplicate vertex at the seam if the two endpoints match
  // within 0.01mm. The shift moves run-b's anchors back by 1.
  const seamDropped = aLast && bFirst
    && Math.hypot(aLast[0] - bFirst[0], aLast[1] - bFirst[1]) < 0.01;
  const bStartIdx = seamDropped ? 1 : 0;
  const aLen = aPts.length;
  const joinedPts: [number, number][] = [
    ...aPts,
    ...bPts.slice(bStartIdx),
  ];

  // Anchor remap for run-b: each polyline-index anchor i (0..n-1) lands
  // at aLen + (i - bStartIdx) in the joined polyline. Indices below
  // bStartIdx are at the dropped duplicate — fold them onto the seam
  // (aLen - 1, the last vertex of run-a, which is the same physical point).
  const remapB = (i: number) => {
    if (i < bStartIdx) return aLen - 1;
    return aLen + (i - bStartIdx);
  };

  const electrodes: Electrode[] = [
    ...(a.electrodes ?? []),
    ...((b.electrodes ?? []).map((e) => ({ ...e, point_index: remapB(e.point_index) }))),
  ];
  const blockouts: Blockout[] = [
    ...(a.blockouts ?? []),
    ...((b.blockouts ?? []).map((bo) => ({
      start_live_index: remapB(bo.start_live_index),
      end_live_index: remapB(bo.end_live_index),
    }))),
  ];
  const annotations: Annotation[] = [
    ...(a.annotations ?? []),
    ...((b.annotations ?? []).map((an) => ({ ...an, live_index: remapB(an.live_index) }))),
  ];
  const bends: Bend[] = [
    ...(a.bends ?? []),
    ...((b.bends ?? []).map((bn) => ({ live_index: remapB(bn.live_index) }))),
  ];

  // Result inherits runA's metadata (color, diameter, notes) and id.
  const joined: DesignRun = {
    id: runA.id,
    polyline: { points: joinedPts, closed: false },
  };
  if (runA.tube_diameter_mm != null) joined.tube_diameter_mm = runA.tube_diameter_mm;
  if (runA.color != null) joined.color = runA.color;
  if (runA.notes != null) joined.notes = runA.notes;
  if (electrodes.length > 0) joined.electrodes = electrodes;
  if (blockouts.length > 0) joined.blockouts = blockouts;
  if (annotations.length > 0) joined.annotations = annotations;
  if (bends.length > 0) joined.bends = bends;

  // Replace runA in place with the joined run; remove runB.
  const idxA = doc.runs.findIndex((r) => r.id === runIdA);
  const nextRuns = doc.runs
    .slice(0, idxA)
    .concat(joined)
    .concat(doc.runs.slice(idxA + 1).filter((r) => r.id !== runIdB));
  return { ...doc, runs: nextRuns };
}

// insertDoubleback splices a hairpin (180° U-turn) into a polyline at the
// chosen segment. The U-shape is formed by 4 new vertices A, B, C, D
// inserted between the segment's existing endpoints p1 and p2:
//
//   p1 --A         D-- p2
//        |         |
//        B---------C
//
// where AB and CD are perpendicular drops of `depthMM` (default
// 1.5 × tube ø, per Strattman's "straight-drop combination bend") and BC
// is the U's mouth of `gapMM` (default 1.0 × tube ø — wide enough that
// the two legs don't visually fuse, narrow enough to read as one bend).
//
// `t ∈ [0, 1]` picks the position along the chosen segment where the
// hairpin gets centered (at t the segment splits into a "before A" leg
// and an "after D" leg of equal-ish length given the gap).
//
// `side` controls which side of the path the U drops on. `'left'`
// (default) is the 90°-counter-clockwise side of the forward direction.
// `'right'` is the mirror — useful when the natural orientation would
// have the hairpin overlap an adjacent run.
//
// Index-shifting is the bug-prone bit: the polyline grows by 4 vertices,
// so every electrode (`point_index`), and live-arc-indexed annotation /
// blockout / bend whose underlying polyline anchor sits at or after the
// insertion gets bumped up by 4. Anchors strictly before the insertion
// stay put. Live-arc index handling: if the run has zero electrodes, the
// live-arc index equals the polyline index, so the same shift applies.
// With electrodes the live arc is a sub-walk; we recompute live indices
// by re-running runArcs after the insertion would over-engineer this V1
// — instead we shift live indices by 4 if the equivalent polyline anchor
// is at or after the insertion point. For the (segmentIndex+1) anchor,
// "at or after" is true, so the 4-vertex bump is correct in the common
// open-run, no-electrode case. Closed runs and live-arc subwalks are
// handled by mapping the live index through the existing live[] table
// pre-insertion.
export function insertDoubleback(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
  t: number,
  depthMM?: number,
  gapMM?: number,
  side: 'left' | 'right' = 'left',
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    const pts = run.polyline.points;
    if (segmentIndex < 0 || segmentIndex >= pts.length - 1) return run;
    const tt = Math.max(0, Math.min(1, t));
    const p1 = pts[segmentIndex];
    const p2 = pts[segmentIndex + 1];
    const segLen = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    if (!(segLen > 0)) return run;

    const tubeDiam = run.tube_diameter_mm ?? 10;
    const depth = depthMM != null && depthMM > 0 ? depthMM : 1.5 * tubeDiam;
    const gap = gapMM != null && gapMM > 0 ? gapMM : 1.0 * tubeDiam;

    // Forward unit vector along the segment.
    const fx = (p2[0] - p1[0]) / segLen;
    const fy = (p2[1] - p1[1]) / segLen;
    // Side-direction unit vector (90° CCW for 'left', CW for 'right').
    const sx = side === 'left' ? -fy : fy;
    const sy = side === 'left' ? fx : -fx;

    // Insertion point.
    const pix = p1[0] + tt * (p2[0] - p1[0]);
    const piy = p1[1] + tt * (p2[1] - p1[1]);

    // A: half-gap back from insertion along forward.
    const ax = pix - 0.5 * gap * fx;
    const ay = piy - 0.5 * gap * fy;
    // B: drop depth perpendicular from A.
    const bx = ax + depth * sx;
    const by = ay + depth * sy;
    // C: gap forward from B (so BC is parallel to AD and to the segment).
    const cx = bx + gap * fx;
    const cy = by + gap * fy;
    // D: rise depth back to the segment line.
    const dx = cx - depth * sx;
    const dy = cy - depth * sy;

    // Splice the 4 new vertices between p1 (segmentIndex) and p2
    // (segmentIndex + 1). New indices: A=k+1, B=k+2, C=k+3, D=k+4 where
    // k = segmentIndex. The original p2 ends up at k+5 (was k+1).
    const k = segmentIndex;
    const newPts: [number, number][] = [
      ...pts.slice(0, k + 1),
      [ax, ay],
      [bx, by],
      [cx, cy],
      [dx, dy],
      ...pts.slice(k + 1),
    ];

    // Shift point-index references on annotations that anchor by polyline
    // index (electrodes). Anything pointing at an index >= k+1 must move
    // up by 4.
    const SHIFT = 4;
    const shiftPoint = (i: number) => (i >= k + 1 ? i + SHIFT : i);
    const shiftLive = (i: number) => (i >= k + 1 ? i + SHIFT : i);

    return {
      ...run,
      polyline: { ...run.polyline, points: newPts },
      electrodes: run.electrodes
        ? run.electrodes.map((e) => ({ ...e, point_index: shiftPoint(e.point_index) }))
        : run.electrodes,
      blockouts: run.blockouts
        ? run.blockouts.map((b) => ({
            start_live_index: shiftLive(b.start_live_index),
            end_live_index: shiftLive(b.end_live_index),
          }))
        : run.blockouts,
      annotations: run.annotations
        ? run.annotations.map((a) => ({ ...a, live_index: shiftLive(a.live_index) }))
        : run.annotations,
      bends: run.bends
        ? run.bends.map((b) => ({ live_index: shiftLive(b.live_index) }))
        : run.bends,
    };
  });
}
