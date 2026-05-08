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
  Group,
  Label,
} from '../api';
import { computeBends, type BendPoint } from './bends';
import {
  HOUSING_LIBRARY,
  type ElectrodeWithHousing,
  type HousingType,
} from './housingLibrary';
import { groupByBaseline, type GroupOptions } from './raceway';
import { defaultDirection } from './runArcs';
import {
  offsetOpenPolyline,
  offsetPolygon,
  type CornerStyle,
} from './shapes/offset';

type Electrode = { point_index: number };

// OperationError signals an invalid op input that the caller should
// surface to the user (e.g. "custom housing requires a positive bore").
// Throw rather than silently no-op so the editor can show a toast and
// the test suite can assert on the message.
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OperationError';
  }
}

// HousingInput is the shape the housing-picker modal builds when the
// user clicks Save. setElectrodeHousing normalizes it before writing
// onto the doc: stock shells have their bore stripped (the library is
// authoritative), custom housings require a positive bore.
export type HousingInput = {
  housing_type: HousingType;
  bore_diameter_mm?: number;
  elevation_mm?: number;
};

const VALID_HOUSING_TYPES: ReadonlySet<string> = new Set([
  '',
  'shell-15',
  'shell-19',
  'custom',
]);

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

// setElectrodeHousing writes housing metadata onto one electrode in a run
// (Tier 3 #62 — Common + Custom electrode housings). The op is purely
// additive at the schema level: the three optional fields on Electrode
// (`housing_type`, `bore_diameter_mm`, `elevation_mm`) deserialize as
// zero values for old design-doc blobs, so no migration is needed.
//
// Behavior:
//   - housing_type === ''       → clears all three housing fields
//                                 (the doc reverts to "no housing").
//   - housing_type === stock    → sets type + elevation; bore is
//                                 dropped from the doc because the
//                                 frontend's HOUSING_LIBRARY is
//                                 authoritative (avoids the doc and
//                                 the library drifting apart on a
//                                 future stock-shell dimension change).
//   - housing_type === 'custom' → requires a positive bore_diameter_mm;
//                                 throws OperationError otherwise.
//
// `electrodeIndex` is the index INTO `run.electrodes`, not the
// electrode's polyline anchor (the doc's electrodes array is the same
// shape the picker UI iterates with `electrodes.map((e, i) => …)`).
export function setElectrodeHousing(
  doc: DesignDoc,
  runId: string,
  electrodeIndex: number,
  housing: HousingInput,
): DesignDoc {
  if (!VALID_HOUSING_TYPES.has(housing.housing_type)) {
    throw new OperationError(
      `setElectrodeHousing: invalid housing_type "${housing.housing_type}"`,
    );
  }
  if (housing.housing_type === 'custom') {
    if (
      housing.bore_diameter_mm == null ||
      !Number.isFinite(housing.bore_diameter_mm) ||
      housing.bore_diameter_mm <= 0
    ) {
      throw new OperationError(
        'setElectrodeHousing: custom housing requires bore_diameter_mm > 0',
      );
    }
  }
  return mapRun(doc, runId, (run) => {
    const electrodes = run.electrodes ?? [];
    if (electrodeIndex < 0 || electrodeIndex >= electrodes.length) {
      return run;
    }
    const next = electrodes.slice();
    const cur = next[electrodeIndex] as ElectrodeWithHousing;
    const updated: ElectrodeWithHousing = { point_index: cur.point_index };
    if (housing.housing_type === '') {
      // Clearing — strip every housing field so the JSON stays clean.
    } else if (housing.housing_type === 'shell-15' || housing.housing_type === 'shell-19') {
      updated.housing_type = housing.housing_type;
      // Bore is intentionally NOT persisted for stock shells: the
      // library is authoritative, so writing it would only invite
      // drift if the dimensions table changes later. The library
      // reference here is a sanity guard — if the key isn't in the
      // library the type system would have caught it; the lookup
      // also throws if someone hand-edits a doc with a bogus key.
      if (!HOUSING_LIBRARY[housing.housing_type]) {
        throw new OperationError(
          `setElectrodeHousing: stock housing "${housing.housing_type}" missing from library`,
        );
      }
      if (housing.elevation_mm != null && housing.elevation_mm > 0) {
        updated.elevation_mm = housing.elevation_mm;
      }
    } else {
      // 'custom' — already validated above.
      updated.housing_type = 'custom';
      updated.bore_diameter_mm = housing.bore_diameter_mm;
      if (housing.elevation_mm != null && housing.elevation_mm > 0) {
        updated.elevation_mm = housing.elevation_mm;
      }
    }
    next[electrodeIndex] = updated as unknown as Electrode;
    return { ...run, electrodes: next };
  });
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
    const next = { ...run };
    delete next.bends;
    return next;
  });
}

export function setRunColor(doc: DesignDoc, runId: string, color: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (color === '') {
      const next = { ...run };
      delete next.color;
      return next;
    }
    return { ...run, color };
  });
}

export function setRunDiameter(doc: DesignDoc, runId: string, diameterMM: number | null): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (diameterMM == null || Number.isNaN(diameterMM) || diameterMM <= 0) {
      const next = { ...run };
      delete next.tube_diameter_mm;
      return next;
    }
    return { ...run, tube_diameter_mm: diameterMM };
  });
}

export function setRunNotes(doc: DesignDoc, runId: string, notes: string): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (notes.trim() === '') {
      const next = { ...run };
      delete next.notes;
      return next;
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
      // Clearing the face flag also clears the per-run depth and
      // raceway metadata that only makes sense in face context.
      // Keeps the doc JSON tidy and prevents stale overrides
      // re-appearing if the user re-enables the flag later.
      const next = { ...run };
      delete next.is_channel_letter_face;
      delete next.channel_letter_depth_mm;
      delete next.raceway_id;
      return next;
    }
    return { ...run, is_channel_letter_face: true };
  });
}

// setRunChannelLetterDepth sets a per-run depth override (mm) for the
// run's return strip (Tier 3 #26). null / NaN / non-positive values
// clear the override so the print PDF falls back to the project
// default. Only meaningful when is_channel_letter_face is true.
export function setRunChannelLetterDepth(
  doc: DesignDoc,
  runId: string,
  depthMM: number | null,
): DesignDoc {
  return mapRun(doc, runId, (run) => {
    if (depthMM == null || Number.isNaN(depthMM) || depthMM <= 0) {
      const next = { ...run };
      delete next.channel_letter_depth_mm;
      return next;
    }
    return { ...run, channel_letter_depth_mm: depthMM };
  });
}

// autoAssignRaceways runs the baseline + horizontal-proximity clustering
// in lib/raceway.ts and writes the assigned raceway IDs back onto every
// face-flagged run in the doc. Tier 3 #46.
//
// Default behaviour overwrites existing manual raceway_id values so the
// auto-pass produces a fully consistent result. Pass
// `{ preserveExisting: true }` to skip runs that already have a non-empty
// raceway_id — useful for incremental tagging when the operator has
// already labelled a few letters by hand.
//
// Runs without `is_channel_letter_face` are untouched. The returned doc
// is structurally new (same identity rules as every other docOp) so the
// editor's editDoc() wrapper can push it onto the undo stack.
export function autoAssignRaceways(doc: DesignDoc, opts: GroupOptions = {}): DesignDoc {
  const assignments = groupByBaseline(doc.runs, opts);
  if (assignments.size === 0 && !opts.preserveExisting) {
    // No face-flagged runs at all — return a structurally new doc only
    // if we'd otherwise overwrite values; otherwise skip the no-op
    // allocation. We fall through to the rebuild path so the caller
    // always gets a fresh doc identity (predictable for editDoc).
  }
  const nextRuns = doc.runs.map((run) => {
    if (!run.is_channel_letter_face) return run;
    const id = assignments.get(run.id);
    if (id === undefined) {
      // No assignment for this face run. With preserveExisting=true this
      // is the path for runs that already had a manual raceway_id; leave
      // them alone. With preserveExisting=false it means the run had an
      // empty polyline and the clusterer skipped it; leave it alone too.
      return run;
    }
    if (run.raceway_id === id) return run;
    return { ...run, raceway_id: id };
  });
  return { ...doc, runs: nextRuns };
}

// setRunRacewayID labels a run with a raceway grouping id (Tier 3 #26).
// Empty / whitespace-only strings clear the label so the run reverts
// to an individual return strip page. Trimming on save keeps the doc
// JSON tidy and prevents whitespace-only strings from inadvertently
// grouping runs together.
export function setRunRacewayID(
  doc: DesignDoc,
  runId: string,
  racewayID: string,
): DesignDoc {
  const trimmed = racewayID.trim();
  return mapRun(doc, runId, (run) => {
    if (trimmed === '') {
      const next = { ...run };
      delete next.raceway_id;
      return next;
    }
    return { ...run, raceway_id: trimmed };
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
      ? estimateLiveArcLen(newPts.length)
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

function estimateLiveArcLen(n: number): number {
  // After simplify, we don't know the exact live-arc length without
  // re-running runArcs. The clamp below uses newPts.length as an
  // upper bound, which is correct for the common no-electrode case.
  return n;
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

// breakOpen converts a closed polyline into an open one with the gap
// (i.e. the opening between the two electrodes) at the chosen vertex
// (Tier 3 #61 / NW #130 — Move Opening / Break Tube Open).
//
// Geometry: the closed loop is rewritten so that the polyline's vertex
// list starts at `vertexIndex`, walks the full perimeter, and ends with
// a duplicate of `vertexIndex` — that way the new OPEN polyline traces
// the same physical shape as the closed loop did. The two electrodes
// land on the duplicated vertices: index 0 (the original `vertexIndex`)
// and index n (the duplicate at the end of the new list).
//
// Live-arc indices for blockouts / annotations / bends carry over
// untouched. Live indices are walk-relative (a step count along the
// active arc), and the new open polyline traces exactly the same arc
// the original closed loop did from the chosen vertex — just walked
// from a different starting point. So a blockout that was 3 steps
// "into" the live walk before is still 3 steps in after the break.
//
// Throws if the run is already open (no closed loop to break) or if
// the vertex index is out of range.
export function breakOpen(doc: DesignDoc, runId: string, vertexIndex: number): DesignDoc {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return doc;
  if (!run.polyline.closed) {
    throw new OperationError('breakOpen: run is already open');
  }
  const pts = run.polyline.points;
  const n = pts.length;
  if (n < 3) {
    throw new OperationError('breakOpen: closed polyline needs at least 3 vertices');
  }
  if (vertexIndex < 0 || vertexIndex >= n) {
    throw new OperationError(`breakOpen: vertexIndex ${vertexIndex} out of range [0, ${n})`);
  }
  const newPts: [number, number][] = [
    ...pts.slice(vertexIndex),
    ...pts.slice(0, vertexIndex),
    pts[vertexIndex],
  ];
  return mapRun(doc, runId, (r) => {
    const next: DesignRun = {
      ...r,
      polyline: { ...r.polyline, points: newPts, closed: false },
      electrodes: [{ point_index: 0 }, { point_index: newPts.length - 1 }],
    };
    // Direction is meaningless once the run is open (runArcs walks the
    // full polyline) — drop it so a stale value can't surface later.
    delete next.direction;
    return next;
  });
}

// moveOpening rotates an OPEN run's polyline so the live arc starts at
// a chosen vertex while preserving the underlying physical shape
// (Tier 3 #61 / NW #130). Used to re-position the electrode opening
// when the as-drawn opening lands somewhere awkward (over a logo,
// behind a column, in a corner the bender can't reach).
//
// The run must have exactly two electrodes; we walk the live arc from
// `electrodes[0].point_index` to `electrodes[1].point_index` in the
// current direction (defaultDirection picks the shorter arc when not
// set), then rotate the walk so it starts at `newStartVertexIndex`.
// The rotated walk becomes the new polyline; electrodes land at
// `[0, walked.length - 1]`. Live-arc indices for blockouts /
// annotations / bends carry over unchanged because they're already
// walk-relative — rotating the start vertex doesn't change which
// vertex is "k hops in".
//
// Throws if the run is closed, the run lacks exactly two electrodes,
// or the chosen vertex isn't on the existing live walk.
export function moveOpening(
  doc: DesignDoc,
  runId: string,
  newStartVertexIndex: number,
): DesignDoc {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return doc;
  if (run.polyline.closed) {
    throw new OperationError('moveOpening: run is closed (use breakOpen first)');
  }
  const electrodes = run.electrodes ?? [];
  if (electrodes.length !== 2) {
    throw new OperationError(
      `moveOpening: run has ${electrodes.length} electrode(s); need exactly 2`,
    );
  }
  const pts = run.polyline.points;
  const n = pts.length;
  if (n < 2) {
    throw new OperationError('moveOpening: open polyline needs at least 2 vertices');
  }
  // For an OPEN run, runArcs walks the full polyline regardless of
  // electrode positions — direction is meaningful only for closed
  // loops where the live arc is the shorter of the two ways around.
  // The spec frames the walk as electrode[0] → electrode[1] but in
  // the open-run-from-breakOpen common case those are exactly [0, n-1],
  // making the walk identical to the full polyline. We mirror that
  // behaviour here. (If the operator hand-placed electrodes mid-
  // polyline on an open run before invoking moveOpening, they probably
  // meant for the rotation to align the polyline endpoints with the
  // new opening rather than the electrode pair — same end result.)
  const walked: number[] = [];
  for (let i = 0; i < n; i++) walked.push(i);
  const targetWalkPos = walked.indexOf(newStartVertexIndex);
  if (targetWalkPos < 0) {
    throw new OperationError(
      `moveOpening: vertex ${newStartVertexIndex} not on live walk`,
    );
  }
  // Rotate the walk so it starts at the user-clicked vertex. The
  // rotated walk becomes the new polyline order — last index is the
  // walk's prior end (where the second electrode used to be), now
  // bumped by one walk-step to the new opening's other side.
  const rotated = walked.slice(targetWalkPos).concat(walked.slice(0, targetWalkPos));
  const newPts: [number, number][] = rotated.map((i) => pts[i]);
  return mapRun(doc, runId, (r) => ({
    ...r,
    polyline: { ...r.polyline, points: newPts },
    electrodes: [{ point_index: 0 }, { point_index: newPts.length - 1 }],
  }));
}

// connectTubes creates a new "jumper" run that splices two existing
// primary runs together at chosen electrode positions (Tier 3 #60 /
// NW #125). In neon trade language a jumper is a short glass tube
// — Strattman Fig.11.3 (10–11 mm OD with a flared end) or Miller
// p.204–205 (16 mm OD glass-sleeved twisted lead-wire) — that
// carries the electrical path between two adjacent primary tubes
// whose physical ends sit close together.
//
// The new run is a 2-vertex polyline whose endpoints copy the world
// position of the source-run electrode anchors at the moment of
// connection. We deliberately copy world coords (rather than store
// "from-run electrode 0 → to-run electrode 1") so future shape edits
// to the source runs (reverseRun, simplifyRun, splitRun, electrode
// re-indexing) can't silently dangle the jumper endpoints. The price
// is that moving an electrode after the fact does NOT drag the
// jumper along — the operator deletes the jumper and re-issues
// connectTubes, same as on a paper drawing.
//
// V1 simplifications:
//   - 2-vertex jumpers only (multi-vertex routed jumpers deferred).
//   - No new electrodes on the jumper itself — it's wired, not open
//     glass between two electrodes of its own.
//   - kind = "jumper" so 2D / 3D / print pipelines branch on it.
//   - Inherits raceway_id when both source runs share one (Strattman
//     raceway grouping); otherwise empty (no spurious cross-grouping).
//   - Inherits no diameter override — the project tube spec applies.
//     `opts.diameter_mm_override` exists for future per-jumper UI;
//     when set, it lands on the new run's tube_diameter_mm.
//
// Throws OperationError when:
//   - fromRunId === toRunId (would self-jumper one run).
//   - either run id is unknown.
//   - the electrode index is out of bounds on its run.
export function connectTubes(
  doc: DesignDoc,
  fromRunId: string,
  fromElectrodeIdx: number,
  toRunId: string,
  toElectrodeIdx: number,
  opts?: { diameter_mm_override?: number },
): DesignDoc {
  if (fromRunId === toRunId) {
    throw new OperationError(
      'connectTubes: cannot create a jumper from a run to itself',
    );
  }
  const fromRun = doc.runs.find((r) => r.id === fromRunId);
  if (!fromRun) {
    throw new OperationError(`connectTubes: unknown fromRunId "${fromRunId}"`);
  }
  const toRun = doc.runs.find((r) => r.id === toRunId);
  if (!toRun) {
    throw new OperationError(`connectTubes: unknown toRunId "${toRunId}"`);
  }
  const fromElectrodes = fromRun.electrodes ?? [];
  if (fromElectrodeIdx < 0 || fromElectrodeIdx >= fromElectrodes.length) {
    throw new OperationError(
      `connectTubes: fromElectrodeIdx ${fromElectrodeIdx} out of range on run ${fromRunId}`,
    );
  }
  const toElectrodes = toRun.electrodes ?? [];
  if (toElectrodeIdx < 0 || toElectrodeIdx >= toElectrodes.length) {
    throw new OperationError(
      `connectTubes: toElectrodeIdx ${toElectrodeIdx} out of range on run ${toRunId}`,
    );
  }
  const fromAnchor = fromElectrodes[fromElectrodeIdx].point_index;
  const toAnchor = toElectrodes[toElectrodeIdx].point_index;
  const fromPts = fromRun.polyline.points;
  const toPts = toRun.polyline.points;
  if (fromAnchor < 0 || fromAnchor >= fromPts.length) {
    throw new OperationError(
      `connectTubes: from-electrode point_index ${fromAnchor} out of range on run ${fromRunId}`,
    );
  }
  if (toAnchor < 0 || toAnchor >= toPts.length) {
    throw new OperationError(
      `connectTubes: to-electrode point_index ${toAnchor} out of range on run ${toRunId}`,
    );
  }
  const fromPoint = fromPts[fromAnchor];
  const toPoint = toPts[toAnchor];
  const inheritsRaceway =
    !!fromRun.raceway_id &&
    fromRun.raceway_id !== '' &&
    fromRun.raceway_id === toRun.raceway_id;
  const newRun: DesignRun = {
    id: nextRunId(doc, 'j'),
    polyline: {
      points: [
        [fromPoint[0], fromPoint[1]],
        [toPoint[0], toPoint[1]],
      ],
      closed: false,
    },
    kind: 'jumper',
  };
  if (inheritsRaceway) newRun.raceway_id = fromRun.raceway_id;
  if (
    opts?.diameter_mm_override != null &&
    Number.isFinite(opts.diameter_mm_override) &&
    opts.diameter_mm_override > 0
  ) {
    newRun.tube_diameter_mm = opts.diameter_mm_override;
  }
  return { ...doc, runs: [...doc.runs, newRun] };
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

// nextRunId returns the lowest unused id of the form `${prefix}${n}` (n
// starting at 1) on the doc. Defaults to prefix "r" so the first
// allocated id is "r1", the next "r2", and so on. Independent of any
// existing runs that don't follow this scheme — non-matching ids
// (e.g. "text-1", "circle-2") are simply ignored when scanning for
// collisions, so this helper neither renames them nor lets them eat
// an integer slot.
//
// Used by splitRun (Tier 3 #25) to replace the old `<id>-a` / `<id>-b`
// suffix scheme. The flat numeric form prevents nesting on repeated
// splits (`<id>-a-a`, `<id>-a-b`, …) and keeps run ids legible.
export function nextRunId(doc: DesignDoc, prefix: string = 'r'): string {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  const taken = new Set<number>();
  for (const r of doc.runs) {
    const m = re.exec(r.id);
    if (m) taken.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${prefix}${n}`;
}

// splitRun splits one polyline into two new runs at a vertex. The vertex
// at `pointIndex` is duplicated so it appears as the last vertex of the
// first run AND the first vertex of the second run — that way joining
// them back together (see joinRuns) reverses the operation cleanly.
//
// Closed runs are forced open by the split: the first new run gets
// indices [0..pointIndex], the second gets [pointIndex..n-1], both open.
// Both new runs receive freshly allocated numeric ids from `nextRunId`
// (Tier 3 #25): the editor-internal convention "r1, r2, …", continuing
// from the lowest unused integer. The original id is dropped — repeated
// splits stay flat (no `<id>-a-a` / `<id>-a-b` nesting). Color,
// diameter override, notes are duplicated to both.
//
// Electrodes / blockouts / annotations / bends partition by their
// underlying anchor position relative to the split:
// - Electrodes pointing strictly before pointIndex stay on run-a.
// - Electrodes pointing strictly after pointIndex go to run-b with
//   point_index − pointIndex.
// - Electrodes exactly at pointIndex are ambiguous; V1 drops them with
//   a console.warn — realistic users will replace them.
// - Blockouts entirely on one side stay there; straddling blockouts
//   (Tier 3 #25) are split into two pieces, one on each new run, so
//   the user's intent survives. The split point itself is excluded
//   from both pieces — run-a's piece ends at `pointIndex - 1`, run-b's
//   starts at 0 (so the duplicated vertex isn't double-blocked-out).
//   A piece that collapses to length 0 is dropped on its own; the
//   surviving piece still posts.
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

  // Allocate two fresh numeric ids. We compute both at once so the
  // second id doesn't collide with the first.
  const aId = nextRunId(doc);
  const bId = nextRunId({ ...doc, runs: [...doc.runs, { ...run, id: aId }] });

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
  // Straddling blockouts are split into two pieces (Tier 3 #25) — one
  // on each new run — so the user's blockout intent survives the split.
  // The duplicated vertex at the split is excluded from both pieces:
  // run-a's piece ends at `pointIndex - 1` and run-b's piece starts at 0,
  // so the seam vertex isn't double-counted as blocked-out.
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
      // Straddles the split. Cut at the split point: run-a keeps
      // [lo, pointIndex - 1] and run-b gets [0, hi - pointIndex].
      // Either piece may collapse to a single index (length 1) which
      // is still a valid blockout; only an inverted pair is empty,
      // which can't happen given lo < pointIndex < hi.
      const aEnd = pointIndex - 1;
      const bEnd = hi - pointIndex;
      if (aEnd >= lo) {
        aBlockouts.push({ start_live_index: lo, end_live_index: aEnd });
      }
      if (bEnd >= 0) {
        bBlockouts.push({ start_live_index: 0, end_live_index: bEnd });
      }
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

// neonize turns a single run (closed or open) into a pair of parallel-
// offset runs — the "double-stroke" / "Auto Tube Layout" / "Parallel
// Tube Layout" primitive that channel-letter shops use to fabricate a
// thick stroke out of two parallel tubes (NW #123, #131, #141 parity).
//
// The source run is replaced by two new runs `<id>-outer` and
// `<id>-inner`, each offset by ±spacingMM/2 from the original outline
// using the angle-bisector miter construction in offset.ts. Color,
// diameter override, and notes are inherited; electrodes / blockouts /
// annotations / bends are NOT carried over (they refer to indices on
// the original polyline, which doesn't survive the geometry rewrite —
// the user re-places them on the offset runs as needed).
//
// Tier 3 #27 added optional behavior:
//   - opts.stitch (default false) — produce ONE continuous run named
//     `<id>-stitched` that walks the outer offset, U-bends at the
//     endpoints, and returns along the (reversed) inner offset. Useful
//     for fabrications that prefer a single tube run with electrodes
//     at the seam over two separate runs.
//   - opts.cornerStyles — per-vertex 'miter' | 'round' | 'bevel'. Length
//     should equal the source polyline's vertex count; missing entries
//     default to 'miter'. For closed inputs, the array indexes the
//     "distinct vertices" view (closing duplicate stripped).
//   - Open polylines are now supported; the offset uses butt caps at
//     each endpoint.
//   - Self-intersection in the inner offset is auto-trimmed (heuristic;
//     figure-8 cases still need manual cleanup).
//
// Failure modes:
//   - <3 vertices on a closed run (or <2 on open) → returns the doc
//     unchanged.
//   - Run not found → returns the doc unchanged.
//   - Self-intersection that survives the trim → emits the run(s)
//     anyway and surfaces a warning so the user can clean up with the
//     node editor.
//   - Acute corners that triggered the miter clamp → counted in the
//     warning if the count is high enough to be worth flagging.
//
// Architectural choice: the original run is destroyed, not preserved as
// a guide layer. Adding a "this run is a guide" flag would touch the
// design-doc schema, the canvas renderer, and the print/DXF emitters —
// out of scope for V1.
export type NeonizeOptions = {
  stitch?: boolean;
  cornerStyles?: CornerStyle[];
  hairpinDepthMM?: number;
  hairpinGapMM?: number;
};

export function neonize(
  doc: DesignDoc,
  runId: string,
  spacingMM: number,
  options: NeonizeOptions = {},
): { doc: DesignDoc; warning?: string } {
  const idx = doc.runs.findIndex((r) => r.id === runId);
  if (idx < 0) return { doc };
  const src = doc.runs[idx];

  if (!(spacingMM > 0) || !Number.isFinite(spacingMM)) {
    return { doc, warning: 'Neonize spacing must be a positive number.' };
  }
  const minPts = src.polyline.closed ? 3 : 2;
  if (src.polyline.points.length < minPts) {
    return { doc, warning: 'Polyline is degenerate.' };
  }

  const half = spacingMM / 2;
  const cornerStyles = options.cornerStyles;
  const stitch = options.stitch ?? false;

  const offsetOpts = {
    cornerStyles,
    trimSelfIntersections: true,
  };

  let outer: ReturnType<typeof offsetPolygon>;
  let inner: ReturnType<typeof offsetPolygon>;
  if (src.polyline.closed) {
    outer = offsetPolygon(src.polyline.points, +half, offsetOpts);
    inner = offsetPolygon(src.polyline.points, -half, offsetOpts);
  } else {
    outer = offsetOpenPolyline(src.polyline.points, +half, offsetOpts);
    inner = offsetOpenPolyline(src.polyline.points, -half, offsetOpts);
  }

  // Build the replacement run(s). Inheritance: only carry forward the
  // run-level properties that aren't index-bound.
  function withMeta(id: string, points: [number, number][], closed: boolean): DesignRun {
    const r: DesignRun = { id, polyline: { points, closed } };
    if (src.tube_diameter_mm != null) r.tube_diameter_mm = src.tube_diameter_mm;
    if (src.color != null) r.color = src.color;
    if (src.notes != null) r.notes = src.notes;
    return r;
  }

  const nextRuns = doc.runs.slice();

  if (stitch) {
    // Stitch the two offsets into one continuous run with hairpin U-bends
    // at the joins. For a closed source we still treat the result as an
    // open path: outer goes around, hairpin at the "seam" connects to
    // reversed-inner, hairpin back to outer's start. Electrodes presumably
    // land at that seam. Hairpin defaults reuse PR #18's convention:
    // depth = 1.5 × tube ø, gap = spacing.
    const tubeDiam = src.tube_diameter_mm ?? 10;
    const depth = options.hairpinDepthMM ?? 1.5 * tubeDiam;
    const gap = options.hairpinGapMM ?? spacingMM;

    const stitched = stitchOffsets(
      outer.points,
      inner.points,
      src.polyline.closed,
      depth,
      gap,
    );
    const stitchedRun = withMeta(`${src.id}-stitched`, stitched, false);
    nextRuns.splice(idx, 1, stitchedRun);
  } else {
    const outerRun = withMeta(
      `${src.id}-outer`,
      outer.points,
      src.polyline.closed,
    );
    const innerRun = withMeta(
      `${src.id}-inner`,
      inner.points,
      src.polyline.closed,
    );
    nextRuns.splice(idx, 1, outerRun, innerRun);
  }

  // Stitch any non-empty warnings into a single user-facing string.
  const warnings: string[] = [];
  if (outer.selfIntersected) {
    warnings.push('Outer offset self-intersects — clean up with the node editor.');
  }
  if (inner.selfIntersected) {
    warnings.push('Inner offset self-intersects — clean up with the node editor.');
  }
  const totalClamps = outer.miterClampedCount + inner.miterClampedCount;
  if (totalClamps >= 3) {
    warnings.push(`${totalClamps} acute corners were beveled — visually verify.`);
  }

  return {
    doc: { ...doc, runs: nextRuns },
    warning: warnings.length > 0 ? warnings.join(' ') : undefined,
  };
}

// stitchOffsets — concatenate the outer offset, a hairpin U-bend at one
// end, the reversed inner offset, and a closing hairpin if the source
// was closed. The resulting polyline is one continuous open path.
//
// Geometry of the hairpin (matches PR #18 insertDoubleback's straight-
// drop combination bend, rotated to bridge two parallel paths):
//
//   outer-tail --A         D-- inner-head (reversed)
//                |         |
//                B---------C
//
// where AD is the gap-wide "mouth" between outer-tail and inner-head,
// and AB / DC drop perpendicular by `depth`. For a 180° bridge across a
// gap of `spacing`, the natural mouth width IS `spacing` and the drop
// is `depth` outward from the path. The implementation places the
// hairpin so it bows away from the source polyline's tangent at the
// seam — i.e. perpendicular to the seam line.
function stitchOffsets(
  outer: [number, number][],
  inner: [number, number][],
  closed: boolean,
  depth: number,
  gap: number,
): [number, number][] {
  const reversedInner = inner.slice().reverse();
  if (outer.length < 1 || reversedInner.length < 1) {
    return [...outer, ...reversedInner];
  }

  // For a CLOSED source the outer and inner both wrap; we need to build
  // a single open run by walking outer, hairpinning to the reversed-
  // inner's first point, walking the reversed inner, and hairpinning
  // back to outer[0]. Both hairpins go on the "outside" of the seam
  // (away from the path's interior).
  //
  // For an OPEN source the outer and inner share endpoint X-coordinates
  // (both offset perpendicular to the source's first/last segments).
  // The hairpin spans the spacing gap at each open endpoint.
  if (closed) {
    // Pick a seam: outer.last -> inner.last (reversed).first = inner.last.
    // Build a hairpin at outer's last point and another at outer's first
    // point (closing the loop into one continuous open run).
    const oFirst = outer[0];
    const oLast = outer[outer.length - 1];
    const iFirst = reversedInner[0]; // == inner[inner.length - 1]
    const iLast = reversedInner[reversedInner.length - 1]; // == inner[0]
    const hairpin1 = buildHairpin(oLast, iFirst, depth, gap);
    const hairpin2 = buildHairpin(iLast, oFirst, depth, gap);
    return [...outer, ...hairpin1, ...reversedInner, ...hairpin2];
  }

  // Open: hairpins at both endpoints. Outer.last connects to
  // reversedInner.first; outer.first connects to reversedInner.last
  // (which is the path's other endpoint).
  const oFirst = outer[0];
  const oLast = outer[outer.length - 1];
  const iFirst = reversedInner[0];
  const iLast = reversedInner[reversedInner.length - 1];
  const hairpin1 = buildHairpin(oLast, iFirst, depth, gap);
  const hairpin2 = buildHairpin(iLast, oFirst, depth, gap);
  return [
    ...outer,
    ...hairpin1,
    ...reversedInner,
    ...hairpin2,
    // Close the path back to outer[0] so the stitched run truly walks the
    // full perimeter and returns to its start. Drop the duplicate.
    oFirst,
  ];
}

// buildHairpin — emits the 4 internal vertices A, B, C, D of a U-bend
// that bridges from `start` to `end`. Mouth width = |end - start|; depth
// is perpendicular to the seam, on the side opposite the half-way
// midpoint. Returns the 4 vertices (caller appends both `start` and
// `end` from outer/inner).
function buildHairpin(
  start: [number, number],
  end: [number, number],
  depth: number,
  gap: number,
): [number, number][] {
  // Direction along the seam (start -> end) and perpendicular drop.
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Degenerate seam — emit a tiny perpendicular bump so the path
    // still connects without zero-length edges.
    return [
      [start[0], start[1] + depth],
      [start[0] + gap, start[1] + depth],
    ];
  }
  const fx = dx / len;
  const fy = dy / len;
  // Perpendicular: 90° CCW from forward.
  const px = -fy;
  const py = fx;
  // A is at start, dropped depth perpendicular.
  const ax = start[0] + px * depth;
  const ay = start[1] + py * depth;
  // B is at end, dropped depth perpendicular.
  const bx = end[0] + px * depth;
  const by = end[1] + py * depth;
  return [
    [ax, ay],
    [bx, by],
  ];
}

// nextGroupId returns the lowest unused id of the form `${prefix}${n}`
// (n starting at 1) on the doc. Defaults to prefix "g" so the first
// allocated id is "g1", the next "g2", and so on. Mirrors `nextRunId`
// (Tier 3 #25): non-matching ids are ignored, so a future hand-edited
// doc with custom group ids ("trim-front", "letters-1") doesn't eat
// integer slots and stays addressable. Tier 3 #33b.
export function nextGroupId(doc: DesignDoc, prefix: string = 'g'): string {
  const re = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\d+)$`);
  const taken = new Set<number>();
  for (const g of doc.groups ?? []) {
    const m = re.exec(g.id);
    if (m) taken.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `${prefix}${n}`;
}

// groupRuns binds the named runs into a fresh group (Tier 3 #33b /
// NW #139). Returns the new doc plus the freshly-allocated group id
// so the caller can wire follow-up UI (rename inline, scroll a
// sidebar entry into view) without re-deriving it from the doc.
//
// Semantic decisions baked in here:
//   - Re-grouping already-grouped runs REPLACES the prior `group_id`
//     (a run can only be in one group). The old group entry is left
//     in place — its membership shrinks to whatever runs weren't
//     reassigned. This matches the spec's `[r1,r2]→A, [r2,r3]→B` test
//     case: after the second call, A still exists with just r1, and
//     r2 belongs to B.
//   - `runIds` not present in the doc are silently dropped (no
//     throw), so a stale selection from a deleted run can't strand
//     the editor. The freshly-allocated group still appears in
//     `Doc.Groups` even if every requested id was bogus — the caller
//     is responsible for guarding the empty-selection case at the UI
//     layer (the sidebar's "Group selected" button is disabled when
//     selectedRunIds.length < 2).
//   - Allocation flows through nextGroupId so concurrent calls
//     within one editDoc reducer never collide; ids stay legible
//     ("g1", "g2", …) rather than UUIDs.
export function groupRuns(
  doc: DesignDoc,
  runIds: string[],
  name: string,
): { doc: DesignDoc; groupId: string } {
  const groupId = nextGroupId(doc);
  const targetIds = new Set(runIds);
  const groups: Group[] = [...(doc.groups ?? []), { id: groupId, name }];
  const runs = doc.runs.map((r) =>
    targetIds.has(r.id) ? { ...r, group_id: groupId } : r,
  );
  return { doc: { ...doc, runs, groups }, groupId };
}

// dissolveGroup clears every member's `group_id` and removes the
// matching entry from `Doc.Groups` (Tier 3 #33b). No-op when the
// groupId doesn't exist — keeps the editor's "Dissolve" button safe
// to double-click without throwing.
//
// Implementation note: we strip the `group_id` field entirely (rather
// than setting it to "") so the encoded JSON stays clean. omitempty
// on the Go side already drops empty strings, but the frontend's
// JSON.stringify doesn't, so we delete the property to match.
export function dissolveGroup(doc: DesignDoc, groupId: string): DesignDoc {
  if (!groupId) return doc;
  const existing = doc.groups ?? [];
  const hasEntry = existing.some((g) => g.id === groupId);
  const hasMember = doc.runs.some((r) => r.group_id === groupId);
  // No-op: nothing to dissolve. Returning the same reference keeps
  // `editDoc`'s identity-equality short-circuit happy (no spurious
  // undo entry) and lets the test suite assert exact-reference
  // stability for the missing-groupId branch.
  if (!hasEntry && !hasMember) return doc;
  const groups = existing.filter((g) => g.id !== groupId);
  const runs = doc.runs.map((r) => {
    if (r.group_id !== groupId) return r;
    const next: DesignRun = { ...r };
    delete next.group_id;
    return next;
  });
  return { ...doc, runs, groups };
}

// renameGroup updates one Group's display name. No-op when the
// groupId doesn't exist — same defensive shape as dissolveGroup so
// the sidebar's inline rename can safely fire even if the group was
// dissolved on another tab. The runs slice is untouched (FKs are
// IDs, not names).
export function renameGroup(
  doc: DesignDoc,
  groupId: string,
  newName: string,
): DesignDoc {
  if (!groupId) return doc;
  const groups = doc.groups ?? [];
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx < 0) return doc;
  if (groups[idx].name === newName) return doc;
  const next = groups.slice();
  next[idx] = { ...next[idx], name: newName };
  return { ...doc, groups: next };
}
