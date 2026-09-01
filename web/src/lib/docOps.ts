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
  Guideline,
  DesignDoc,
  DesignRun,
  Dimension,
  Group,
  Label,
  Raceway,
  SegmentKind,
} from '../api';
import {
  RACEWAY_DEFAULT_DEPTH_MM,
  RACEWAY_DEFAULT_HEIGHT_MM,
  RACEWAY_END_MARGIN_MM,
  RACEWAY_SPLICE_MM,
} from '../api';
import { selectionBBoxMM, type BBoxMM } from './arrange';
import { computeBends, type BendPoint } from './bends';
import {
  HOUSING_LIBRARY,
  type ElectrodeWithHousing,
  type HousingType,
} from './housingLibrary';
import { groupByBaseline, type GroupOptions } from './raceway';
import { defaultDirection, runArcs } from './runArcs';
import {
  flatRunPoints,
  flattenSegment,
  flipArcKind,
  isArcKind,
  runHasArcs,
  segmentCount,
  segmentTypeAt,
} from './arcGeom';
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

/**
 * Drop `tube_diameter_mm` from every run still carrying `oldDiameterMM`, so
 * those runs inherit the project's tube spec instead of pinning the old value.
 *
 * Called when the project's tube spec changes. Runs are *seeded* with the
 * project diameter at vectorize time (designdoc/convert.go), so most values
 * are inherited defaults rather than deliberate overrides — and the field is
 * not cosmetic: it feeds bend clustering (designdoc/bends.go), the takeoff's
 * glass grouping (takeoff/takeoff.go) and the ø printed on the pattern
 * (printpdf/render.go). Left stale, a 12mm→8mm switch keeps ordering 12mm
 * stock and keeps telling the bender 12mm.
 *
 * Clearing rather than rewriting means the run reads through to whatever the
 * project spec currently is, so the next spec change needs no migration at all.
 * A run deliberately overridden to exactly the old spec's diameter is cleared
 * too — indistinguishable in the data model, and harmless, since it then
 * inherits that same number until the spec changes again.
 *
 * Returns the input unchanged when nothing matches, so callers can use identity
 * to decide whether the document actually changed.
 */
export function clearRunDiametersMatching(doc: DesignDoc, oldDiameterMM: number): DesignDoc {
  if (!Number.isFinite(oldDiameterMM) || oldDiameterMM <= 0) return doc;
  let changed = false;
  const runs = doc.runs.map((run) => {
    if (run.tube_diameter_mm !== oldDiameterMM) return run;
    changed = true;
    const next = { ...run };
    delete next.tube_diameter_mm;
    return next;
  });
  return changed ? { ...doc, runs } : doc;
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

// insertChannelLetterRuns appends the output of `channelLetterFromText`
// (Tier 2 #71 — the "Channel letter wizard" dialog) onto the design doc
// as one undo-able edit. Each emitted run is re-id'd via the standard
// `idPrefix-N` convention so it doesn't collide with prior inserts; the
// per-run `is_channel_letter_face` flag and optional `raceway_id`
// already baked in by the wizard pass through untouched. When the
// caller supplies a non-empty `racewayId`, every emitted run is tagged
// with that id (overriding whatever the wizard wrote) — this is how the
// EditorPage UI promotes the wizard's placeholder raceway label to the
// user's chosen name in one step.
export function insertChannelLetterRuns(
  doc: DesignDoc,
  runs: DesignRun[],
  racewayId?: string,
): DesignDoc {
  const tagged = racewayId
    ? runs.map((r) => ({ ...r, raceway_id: racewayId }))
    : runs;
  return appendRuns(doc, tagged, 'letter');
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

// moveVertices applies one set of (pointIndex → new XY) writes to a run
// in a single op (Tier 3 #48 — multi-vertex select + drag). Used by the
// node-edit canvas when the operator drags a vertex while two or more
// vertices on the same run are selected: every selected vertex
// translates by the same delta. Driving this through one op keeps the
// undo stack intact (one entry per drag, not per vertex) and avoids
// per-vertex revalidation churn.
//
// Out-of-range or no-op writes are silently dropped; if every write
// dropped, the run is returned unchanged so editDoc's structural-equal
// guard short-circuits the dirty-flag bump.
export function moveVertices(
  doc: DesignDoc,
  runId: string,
  writes: { pointIndex: number; x: number; y: number }[],
): DesignDoc {
  if (writes.length === 0) return doc;
  const idx = doc.runs.findIndex((r) => r.id === runId);
  if (idx < 0) return doc;
  const run = doc.runs[idx];
  const pts = run.polyline.points;
  let nextPts: [number, number][] | null = null;
  for (const w of writes) {
    if (w.pointIndex < 0 || w.pointIndex >= pts.length) continue;
    const cur = pts[w.pointIndex];
    if (cur[0] === w.x && cur[1] === w.y) continue;
    if (!nextPts) nextPts = pts.slice();
    nextPts[w.pointIndex] = [w.x, w.y];
  }
  if (!nextPts) return doc;
  const updated: DesignRun = { ...run, polyline: { ...run.polyline, points: nextPts } };
  const nextRuns = doc.runs.slice();
  nextRuns[idx] = updated;
  return { ...doc, runs: nextRuns };
}

// mergeVertices collapses two vertices on the same run into one
// (Tier 3 #48 — vertex-merge on drop). The inverse of splitRun in
// spirit: where splitRun duplicates a vertex into two distinct runs,
// mergeVertices folds two distinct vertices on ONE run back into a
// single vertex. Useful after import where vectorize over-segmented a
// corner into two near-coincident points.
//
// Behaviour:
//   - `indexA` is the kept vertex (its XY survives as the merge anchor);
//     `indexB` is dropped.
//   - All anchor references to `indexB` are rewritten to `indexA`
//     (including run.electrodes' `point_index` and live-arc-indexed
//     metadata for the open-run no-electrode common case).
//   - References strictly above `indexB` shift down by 1 to account
//     for the dropped polyline slot.
//   - Adjacent merges (|indexA - indexB| == 1) collapse cleanly: the
//     remaining vertex preserves the kept index's XY.
//   - A non-adjacent merge leaves the polyline disconnected at the
//     "gap" that used to be filled by the path through indexB. We
//     do NOT auto-bridge — the caller is expected to drag the merge
//     candidates close together first, so the topology change is
//     invisible. (Operationally: the canvas only fires this when the
//     drop lands inside the snap-to-vertex radius.)
//   - Closed runs collapsing below 3 distinct points, or open runs
//     below 2, are silently no-op'd to keep the doc valid.
//   - indexA == indexB is a no-op.
//
// Like splitRun this produces a NEW DesignRun; the caller's editDoc
// wraps it for the dirty/undo bookkeeping.
export function mergeVertices(
  doc: DesignDoc,
  runId: string,
  indexA: number,
  indexB: number,
): DesignDoc {
  if (indexA === indexB) return doc;
  return mapRun(doc, runId, (run) => {
    const pts = run.polyline.points;
    const n = pts.length;
    if (indexA < 0 || indexA >= n) return run;
    if (indexB < 0 || indexB >= n) return run;
    const minPts = run.polyline.closed ? 3 : 2;
    if (n - 1 < minPts) return run;

    const drop = indexB;
    const keep = indexA;
    // Remap any anchor pointing at `drop` to `keep`; anchors strictly
    // above `drop` shift down by 1.
    const remap = (i: number): number => {
      if (i === drop) return keep > drop ? keep - 1 : keep;
      if (i > drop) return i - 1;
      return i;
    };

    const points = pts.filter((_, i) => i !== drop);

    // Electrodes: rewrite point_index, then dedup if the merge collapsed
    // two electrodes onto the same vertex (rare but possible if both
    // ends of an electrode pair sat on the merge candidates).
    const seenElec = new Set<number>();
    const electrodes: Electrode[] = [];
    for (const e of run.electrodes ?? []) {
      const next = remap(e.point_index);
      if (seenElec.has(next)) continue;
      seenElec.add(next);
      electrodes.push({ ...e, point_index: next });
    }

    // Live-arc-indexed metadata: open-run no-electrode common case
    // treats live_index as polyline index. We mirror the splitRun /
    // insertVertex / deleteVertex partition convention here. For the
    // closed-run / electrode-bearing edge case the operator can clean
    // up afterwards — vertex-merge is post-import polish, not deep
    // editing of an already-instrumented run.
    const blockouts: Blockout[] = [];
    for (const b of run.blockouts ?? []) {
      blockouts.push({
        start_live_index: remap(b.start_live_index),
        end_live_index: remap(b.end_live_index),
      });
    }
    const annotations: Annotation[] = [];
    for (const a of run.annotations ?? []) {
      annotations.push({ ...a, live_index: remap(a.live_index) });
    }
    const bends: Bend[] = [];
    for (const bn of run.bends ?? []) {
      bends.push({ live_index: remap(bn.live_index) });
    }

    const next: DesignRun = {
      ...run,
      polyline: { ...run.polyline, points },
    };
    if (electrodes.length > 0) next.electrodes = electrodes;
    else if (run.electrodes) delete next.electrodes;
    if (blockouts.length > 0) next.blockouts = blockouts;
    else if (run.blockouts) delete next.blockouts;
    if (annotations.length > 0) next.annotations = annotations;
    else if (run.annotations) delete next.annotations;
    if (bends.length > 0) next.bends = bends;
    else if (run.bends) delete next.bends;
    return next;
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
    // Pin both ends of every ARC segment. RDP measures perpendicular distance
    // to the CHORD, so it is blind to an arc's bow by construction — it will
    // cheerfully drop the vertex that defines a 50 mm sagitta as "within
    // epsilon of a straight line", and the arc then re-forms across whatever
    // longer span replaced it. Pinning the endpoints keeps the drawn curve
    // exactly where it was and has a second payoff: every span RDP is still
    // allowed to collapse is made only of straights, so the merged segment is
    // unambiguously a 'line' below.
    for (let i = 0; i < segmentCount(run); i++) {
      if (!isArcKind(segmentTypeAt(run, i))) continue;
      keep[i] = true;
      keep[(i + 1) % pts.length] = true;
    }
    if (keep.every((b) => b)) return run;
    // Build the index remap and the new point list in one pass.
    const remap = new Array<number>(pts.length).fill(-1);
    const origOf: number[] = [];
    const newPts: [number, number][] = [];
    for (let i = 0; i < pts.length; i++) {
      if (keep[i]) {
        remap[i] = newPts.length;
        origOf.push(i);
        newPts.push(pts[i]);
      }
    }
    if (newPts.length < (run.polyline.closed ? 3 : 2)) return run;
    // Rebuild segment_types over the surviving vertices. Dropping a vertex
    // MERGES the two segments either side of it, so leaving the old array in
    // place left it too long — and the Go decoder (internal/designdoc/
    // types.go UnmarshalJSON) rejects any array that isn't exactly
    // segmentCount entries, turning the next save of the doc into a 400.
    // Build it only when one existed, so a pre-#78 run still round-trips
    // without growing the key.
    const polyline = { ...run.polyline, points: newPts };
    if (run.polyline.segment_types) {
      const m = newPts.length;
      const segs = run.polyline.closed ? m : m - 1;
      const nextTypes: SegmentKind[] = [];
      for (let j = 0; j < segs; j++) {
        const from = origOf[j];
        const to = origOf[(j + 1) % m];
        // A new segment that still spans exactly one old segment keeps its
        // type; anything wider is a collapsed run of straights.
        const single = run.polyline.closed
          ? (from + 1) % pts.length === to
          : from + 1 === to;
        nextTypes.push(single ? segmentTypeAt(run, from) : 'line');
      }
      polyline.segment_types = nextTypes;
    }
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
      polyline,
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

// reverseRun flips the run's direction of travel: the polyline order is
// reversed and every index that referenced a polyline vertex or a live-arc
// position is rewritten so it keeps pointing at the same physical place.
// Useful when the user wants to swap which end of an open run is "start" —
// it drives electrode-to-electrode order and the bend-list numbering.
//
// Arc segments (Tier 3 #78) make this more than an array reverse.
// `segment_types[i]` describes the segment LEAVING vertex i, so after the
// reversal index i joins a different pair of vertices than it did before and
// the flags have to travel with the chords they describe: for an open
// n-point run new j = old (n-2-j), for a closed run new j = old (n-2-j) mod
// n. Leaving them alone is what Bug #11 reported — curvature jumping onto
// whichever chords happened to inherit the old indices.
//
// ARC HANDEDNESS — Tier 3 #87. `arcFor` bows toward (-dy, dx), i.e. to the
// LEFT of travel, so reversing a chord moves the bow to the other side. A
// boolean "is an arc" therefore could not survive a reversal at all, which is
// what Bug #11 reported and what PR #149's index remap could not fix.
//
// `segment_types` now stores the side ('arc' vs 'arc_r'), so the fix is to
// flip each carried value as it moves: the two flips — the one the reversal
// forces on the geometry, and the one applied to the stored side — cancel,
// and the drawn curve does not move at all. Reversing an arc run is now
// shape-preserving, which is what "reverse" has always claimed.
//
// The invariant that pins it is geometric, not a field assertion:
// flatRunPoints(reversed) equals flatRunPoints(original) reversed.
//
// Do NOT add this flip to `mirrorRuns` in arrange.ts. A mirror is
// reflect-then-reverse: the reflection already flips handedness once, the
// reversal flips it back, and the stored side must stay put. Flipping there
// too is a double-flip that inverts every mirrored curve.
export function reverseRun(doc: DesignDoc, runId: string): DesignDoc {
  return mapRun(doc, runId, reversedRun);
}

// reversedRun is the run-level half of reverseRun, factored out so joinRuns
// can share it. joinRuns reverses an input before concatenating and used to
// carry a private copy of this logic; the copy never learned about
// segment_types and flipped blockout range endpoints without swapping them,
// which is Bug #14. One implementation with two callers is the point — the
// duplicate is what drifted.
function reversedRun(run: DesignRun): DesignRun {
  const pts = run.polyline.points;
  const n = pts.length;
  if (n < 2) return run;
  const closed = !!run.polyline.closed;
  const flip = (i: number) => n - 1 - i;

  const polyline = { ...run.polyline, points: pts.slice().reverse() };
  // Only rebuild the array when one exists: a pre-#78 run has no
  // segment_types and must round-trip without growing one, and the Go
  // decoder rejects an array that isn't exactly segmentCount long.
  if (run.polyline.segment_types) {
    const count = segmentCount(run);
    const moved: SegmentKind[] = [];
    for (let j = 0; j < count; j++) {
      const src = closed ? (((n - 2 - j) % n) + n) % n : n - 2 - j;
      // Index remap AND side flip. The remap alone was Bug #11's fix and
      // still left every bow mirrored; the flip is what makes the reversal
      // shape-preserving.
      moved.push(flipArcKind(segmentTypeAt(run, src)));
    }
    polyline.segment_types = moved;
  }

  const next: DesignRun = { ...run, polyline };
  if (run.electrodes) {
    next.electrodes = run.electrodes.map((e) => ({ ...e, point_index: flip(e.point_index) }));
  }
  // Walking a closed loop the other way swaps which half of it is lit, so
  // an explicit direction has to flip to keep the same arc live. An unset
  // direction needs no help: defaultDirection measures the two halves and
  // its answer survives the reversal on its own.
  if (closed && run.direction && (run.electrodes?.length ?? 0) === 2) {
    next.direction = run.direction === 'forward' ? 'backward' : 'forward';
  }

  // Blockouts, annotations and bends are anchored to positions along the
  // LIVE walk, not to raw polyline indices — the convention splitRun and
  // insertDoubleback already follow. That walk does NOT always turn around
  // with the point list: an open run's walk is the polyline itself so it
  // reverses, but a closed two-electrode run's walk still starts at
  // electrodes[0] — which keeps its identity here — and, with `direction`
  // flipped above, covers the same half in the same order, so its positions
  // do not move at all. Resolving each position through the polyline vertex
  // it names is exact for both cases; assuming L-1-k is not.
  const oldLive = runArcs(run).live;
  const newLive = runArcs(next).live;
  const posOfVertex = new Map<number, number>();
  for (let i = newLive.length - 1; i >= 0; i--) posOfVertex.set(newLive[i], i);
  const livePos = (k: number) => {
    const clamped = Math.min(Math.max(k, 0), oldLive.length - 1);
    return posOfVertex.get(flip(oldLive[clamped])) ?? clamped;
  };
  const walkReversed = oldLive.length > 1 && livePos(0) > livePos(oldLive.length - 1);

  if (run.blockouts) {
    next.blockouts = run.blockouts.map((b) => {
      const s = livePos(b.start_live_index);
      const e = livePos(b.end_live_index);
      // A blockout spans start -> end walking FORWARD, wrapping past the
      // end of a closed live arc. When the walk turns around, its two ends
      // trade places — one formula that is right for wrapping and
      // non-wrapping spans alike, and an identity when applied twice.
      return walkReversed
        ? { start_live_index: e, end_live_index: s }
        : { start_live_index: s, end_live_index: e };
    });
  }
  if (run.annotations) {
    next.annotations = run.annotations.map((a) => ({ ...a, live_index: livePos(a.live_index) }));
  }
  if (run.bends) {
    next.bends = run.bends.map((b) => ({ live_index: livePos(b.live_index) }));
  }
  return next;
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

// renameLegacyRunIds rewrites every run id matching the pre-Tier-3-#25
// `<base>-a` / `<base>-b` (and deeper-nested `<base>-a-a` etc.) suffix
// scheme to the flat numeric `r<n>` form (Tier 3 #48 — opt-in
// migration of legacy split-run docs). Non-matching ids (e.g. plain
// `r1`, `text-1`, `circle-2`) are left alone so the migration is
// strictly additive — the caller can re-run it without further effect.
//
// Detection heuristic: an id ending in `-a` / `-b` (case-sensitive,
// only those two letters — chosen to match exactly what splitRun
// historically emitted, not arbitrary user-named runs that happen to
// end in "-a"). Repeated splits could nest as `-a-a` / `-a-b`; those
// also match (the suffix is checked, not the full id). The trade-off:
// we MIGHT rename a deliberately-`-a`-suffixed run a user crafted by
// hand, but the design-doc spec doesn't sanction custom run ids and
// the run-row UI just reads `run.id` — the migration's worst case is
// "the operator sees a different id label after the rename". We surface
// this in the button tooltip so it's not a surprise.
//
// Returns the same doc instance when no rename was needed (so React
// state doesn't churn for an already-migrated doc), otherwise returns
// a NEW doc with the rewritten runs array. Idempotent: a second call
// on the rewritten doc returns the same reference.
//
// References in the design doc that depend on run ids:
//   - Run.group_id refers to Group.id (NOT a run id) — untouched.
//   - Annotations / blockouts / bends index INTO their parent run by
//     live/point index — they don't carry the run id at all.
//   - Connect-tubes jumpers carry world-space coords (not run id refs).
// So the rewrite is run-id-only; no cross-field ripple.
const LEGACY_RUN_ID_RE = /-(a|b)(?:-(a|b))*$/;

export function renameLegacyRunIds(doc: DesignDoc): DesignDoc {
  // Cheap pre-scan: if no run id matches the legacy pattern, return the
  // same reference so callers can safely call this on every doc-load
  // without invalidating React memo / dirty-flag bookkeeping.
  let needsRename = false;
  for (const r of doc.runs) {
    if (LEGACY_RUN_ID_RE.test(r.id)) {
      needsRename = true;
      break;
    }
  }
  if (!needsRename) return doc;

  // Reserve all already-numeric `r<n>` slots so the rename can't
  // collide. We allocate fresh ids one-at-a-time, growing the reserved
  // set as we go so two legacy runs don't both claim the same number.
  const re = /^r(\d+)$/;
  const taken = new Set<number>();
  for (const r of doc.runs) {
    const m = re.exec(r.id);
    if (m) taken.add(parseInt(m[1], 10));
  }
  function takeNext(): string {
    let n = 1;
    while (taken.has(n)) n++;
    taken.add(n);
    return `r${n}`;
  }

  const nextRuns = doc.runs.map((r) => {
    if (!LEGACY_RUN_ID_RE.test(r.id)) return r;
    return { ...r, id: takeNext() };
  });
  return { ...doc, runs: nextRuns };
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

// RunClassificationField enumerates the fields that say WHAT a run is — as
// opposed to where its glass goes.
//
// Every op that derives a run from another has to answer for each of them, and
// "carry it" is NOT always the right answer (Tier 3 #110): splitRun and
// joinRuns produce a run of the same nature as their input, neonize produces a
// different kind of object from its input. So the answers live in a Record per
// op rather than in an allow-list per call site. The Record is what makes this
// non-negotiable — add a sixth field to the union and TypeScript refuses to
// compile until every op has answered for it, which is exactly the drift that
// produced bug class 1 four times over.
type RunClassificationField =
  | 'is_channel_letter_face'
  | 'channel_letter_depth_mm'
  | 'raceway_id'
  | 'group_id'
  | 'kind';

type RunClassificationCarry = Readonly<Record<RunClassificationField, boolean>>;

// CARRY_SAME_NATURE — ops whose output is the same kind of object as their
// input. splitRun cuts one tube into two, joinRuns welds two into one; neither
// changes what the glass IS, so everything carries. This is the behaviour
// PR #140 (splitRun) and Bug #15 (joinRuns) each had to restore by hand.
const CARRY_SAME_NATURE: RunClassificationCarry = {
  is_channel_letter_face: true,
  channel_letter_depth_mm: true,
  raceway_id: true,
  group_id: true,
  kind: true,
};

// CARRY_NEONIZED — Tier 3 #110. neonize is the op where "carry everything" is
// the WRONG fix: it consumes a face OUTLINE and emits the tube paths that light
// it. Per-field calls, each a trade decision rather than a preference:
const CARRY_NEONIZED: RunClassificationCarry = {
  // NO. The emitted runs are glass, not sheet metal. BOTH return-strip paths in
  // internal/printpdf/render.go gate on IsChannelLetterFace — the per-run loop
  // directly, the shared-raceway one through groupByRaceway — so carrying this
  // would put a fabrication drawing for a part that does not exist into the
  // operator's printed stack. This is the one field where carrying actively
  // breaks output rather than merely being untidy.
  is_channel_letter_face: false,
  // NO. It describes how far the FACE projects; a tube has no return to fold.
  // Only runDepthMM reads it and only for face runs, so carrying it would be
  // inert today and quietly wrong the day something else does.
  channel_letter_depth_mm: false,
  // YES. Those tubes really do terminate at that raceway, and the box is sized
  // to reach every tagged run whether or not it is a face — see
  // RacewayMemberExtentMM (internal/designdoc/raceway.go) and racewayMembers
  // (internal/printpdf/racewaypage.go), whose non-face fallback exists for
  // exactly this shape of design. Safe because the strip pages need the face
  // flag as well, and that one does not carry.
  raceway_id: true,
  // YES. The offsets belong to the same logical letter as their source, and
  // neonize REPLACES that source: drop this and the group loses a member
  // instead of gaining two, silently ejecting the geometry the operator just
  // generated from the thing they are working on.
  group_id: true,
  // YES, on least-surprise. Neonizing a jumper is unusual, but if someone does
  // it, the result staying a jumper is more predictable than glass-sleeved lead
  // wire silently becoming live tube.
  kind: true,
};

// carryRunClassification stamps those fields onto a run derived from one or two
// existing runs, honouring the caller's `carry` Record. It mutates and returns
// `to`, which every caller has just built fresh.
//
// It exists because forgetting one of these by omission is now the fifth
// instance of CLAUDE.md's recurring bug class 1: splitRun (PR #140),
// reverseRun (Bug #11 / PR #149), joinRuns' private reversedRun copy (Bug #14
// / PR #152), joinRuns itself (Bug #15), and neonize (Tier 3 #110). Two of the
// five were in joinRuns. A longhand allow-list at each call site is what keeps
// failing — worse, both splitRun's and joinRuns' were written under a comment
// claiming to be complete — so the list lives here once and ops go through it.
//
// The fifth one is why `carry` exists rather than the list simply being
// unconditional. neonize's answer is a strict subset, and getting there by
// writing a sixth longhand allow-list next door is how this recurs a sixth
// time; see CARRY_NEONIZED above for which fields it declines and why.
//
// `b` is the second input of a MERGE (joinRuns). Its disagreement rules are
// trade decisions, not preferences:
//
//   is_channel_letter_face — true if EITHER side is true. A face joined to a
//     non-face is still face glass, and the expensive error is silent:
//     groupByRaceway (internal/printpdf/raceway.go) buckets only runs that
//     have IsChannelLetterFace AND a RacewayID, so a face that loses its flag
//     stops appearing on the combined return-strip page with no error at all —
//     the fabricator just never gets the pattern for the metal.
//   channel_letter_depth_mm — a's if set, else b's. When both are set and
//     disagree we take a's and warn: the operator picked two different metal
//     depths and needs to know one was dropped, not to discover it at the
//     brake.
//   raceway_id, group_id — a's if set, else b's. Inheriting a membership beats
//     ejecting the merged run from a raceway or a layer it was already in.
//   kind — a jumper joined to anything that is NOT a jumper produces a LIVE
//     TUBE. This is the one field where "inherit a" is actively wrong: a
//     jumper is glass-sleeved lead wire, so joining it to live glass makes the
//     union live, and calling the result a jumper would drop lit tube out of
//     the 3D render and the printed legend. Only jumper + jumper stays dark.
//
// `direction` is deliberately absent: it means something only on a closed run
// with two electrodes, and every run these ops mint is open (joinRuns' own
// self-join branch closes a run by spreading the original, not through here).
function carryRunClassification(
  to: DesignRun,
  a: DesignRun,
  b?: DesignRun,
  carry: RunClassificationCarry = CARRY_SAME_NATURE,
): DesignRun {
  if (carry.is_channel_letter_face && (a.is_channel_letter_face || b?.is_channel_letter_face)) {
    to.is_channel_letter_face = true;
  }
  if (carry.channel_letter_depth_mm) {
    const depth = a.channel_letter_depth_mm ?? b?.channel_letter_depth_mm;
    if (depth != null) to.channel_letter_depth_mm = depth;
    if (
      b
      && a.channel_letter_depth_mm != null
      && b.channel_letter_depth_mm != null
      && a.channel_letter_depth_mm !== b.channel_letter_depth_mm
    ) {
      console.warn(
        `joinRuns: channel_letter_depth_mm disagrees (${a.channel_letter_depth_mm} vs `
        + `${b.channel_letter_depth_mm}) — keeping ${a.channel_letter_depth_mm}`,
      );
    }
  }
  if (carry.raceway_id) {
    const raceway = a.raceway_id ?? b?.raceway_id;
    if (raceway != null) to.raceway_id = raceway;
  }
  if (carry.group_id) {
    const group = a.group_id ?? b?.group_id;
    if (group != null) to.group_id = group;
  }
  if (carry.kind) {
    const bothJumpers = b ? a.kind === 'jumper' && b.kind === 'jumper' : a.kind === 'jumper';
    if (bothJumpers) to.kind = 'jumper';
    else if (a.kind != null && a.kind !== 'jumper' && b == null) to.kind = a.kind;
  }
  return to;
}

// carryNeonizedClassification — the single-source variant neonize uses. Named
// rather than passing CARRY_NEONIZED inline at the call site so that "what does
// neonizing inherit" and "what does splitting inherit" are one grep apart, and
// so neither can be edited without the reader meeting the other.
function carryNeonizedClassification(to: DesignRun, src: DesignRun): DesignRun {
  return carryRunClassification(to, src, undefined, CARRY_NEONIZED);
}

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
    // Classification carries onto BOTH pieces. Cutting a tube changes where
    // the glass ends, not what it is: a channel-letter face split at the
    // raceway is still face glass, a jumper is still a jumper, and both halves
    // stay in the layer and on the raceway they were already on. PR #140 fixed
    // this by hand; the list now lives in carryRunClassification so joinRuns
    // and this share one copy of it (and of the reasoning).
    carryRunClassification(next, run!);
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
//
// ARC HANDEDNESS — was a known limitation, resolved by Tier 3 #87. Any
// endpoint combination other than tail-to-head reverses an input, and `arcFor`
// bows to the LEFT of travel, so a reversal used to draw every arc mirrored
// about its (unchanged) chord. The reversal here is the shared `reversedRun`,
// which now flips each segment's stored side ('arc' <-> 'arc_r') as it remaps
// it, so the drawn curve stays put for ALL FOUR endpoint combinations. A
// tail-to-head join still reverses nothing at all.
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
    const polyline = { ...runA.polyline, closed: true };
    // Closing the loop ADDS a segment — segmentCount goes n-1 to n — and the
    // Go decoder rejects a segment_types array that isn't exactly that long,
    // so leaving it unextended turns every later save of this doc into a 400.
    // The new closing chord is glass nobody has curved yet, hence 'line'.
    if (runA.polyline.segment_types) {
      polyline.segment_types = [...runA.polyline.segment_types, 'line'];
    }
    const closed: DesignRun = { ...runA, polyline };
    return { ...doc, runs: doc.runs.map((r) => (r.id === runIdA ? closed : r)) };
  }

  // Pick the orientation that puts runA's tail next to runB's head. The
  // reversal is the shared `reversedRun` above — this used to be a private
  // copy that predated arc segments, and it had drifted into Bug #14: it
  // never moved segment_types, and it flipped blockout range endpoints
  // without swapping them, so a reversed range came back running end->start.
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

  // segment_types for the merged run. Index i describes the segment LEAVING
  // vertex i, so the array reads: a's segments, the seam, then b's. Without
  // this the merged run had no array at all and every arc on BOTH inputs —
  // reversed or not — decayed to a straight chord. Build it only when one of
  // the inputs actually had one, so a pre-#78 pair still round-trips without
  // growing the key.
  let joinedTypes: SegmentKind[] | undefined;
  if (a.polyline.segment_types || b.polyline.segment_types) {
    joinedTypes = [];
    for (let j = 0; j < joinedPts.length - 1; j++) {
      if (j < aLen - 1) {
        joinedTypes.push(segmentTypeAt(a, j));
      } else if (!seamDropped && j === aLen - 1) {
        // The endpoints didn't coincide, so this segment is a brand-new
        // bridging chord between them — nobody has curved it.
        joinedTypes.push('line');
      } else {
        joinedTypes.push(segmentTypeAt(b, j - aLen + bStartIdx));
      }
    }
  }

  // Anchor remap for run-b: each polyline-index anchor i (0..n-1) lands
  // at aLen + (i - bStartIdx) in the joined polyline. Indices below
  // bStartIdx are at the dropped duplicate — fold them onto the seam
  // (aLen - 1, the last vertex of run-a, which is the same physical point).
  const remapB = (i: number) => {
    if (i < bStartIdx) return aLen - 1;
    return aLen + (i - bStartIdx);
  };

  // Blockouts, annotations and bends are positions along the LIVE walk, not
  // raw vertices. The merged run is always open, so ITS live walk is its
  // polyline and a live position there is a vertex index — but an input's
  // walk need not be, so resolve each position through the vertex it names
  // before remapping. On the open runs the join tool offers, both maps are
  // the identity; they stop being one as soon as a closed two-electrode run
  // reaches here, which is where treating the two spaces as interchangeable
  // silently went wrong.
  const aLive = runArcs(a).live;
  const bLive = runArcs(b).live;
  const at = (walk: number[], k: number) =>
    walk[Math.min(Math.max(k, 0), walk.length - 1)] ?? 0;
  const liveA = (k: number) => at(aLive, k);
  const liveB = (k: number) => remapB(at(bLive, k));

  const electrodes: Electrode[] = [
    ...(a.electrodes ?? []),
    ...((b.electrodes ?? []).map((e) => ({ ...e, point_index: remapB(e.point_index) }))),
  ];
  const blockouts: Blockout[] = [
    ...((a.blockouts ?? []).map((bo) => ({
      start_live_index: liveA(bo.start_live_index),
      end_live_index: liveA(bo.end_live_index),
    }))),
    ...((b.blockouts ?? []).map((bo) => ({
      start_live_index: liveB(bo.start_live_index),
      end_live_index: liveB(bo.end_live_index),
    }))),
  ];
  const annotations: Annotation[] = [
    ...((a.annotations ?? []).map((an) => ({ ...an, live_index: liveA(an.live_index) }))),
    ...((b.annotations ?? []).map((an) => ({ ...an, live_index: liveB(an.live_index) }))),
  ];
  const bends: Bend[] = [
    ...((a.bends ?? []).map((bn) => ({ live_index: liveA(bn.live_index) }))),
    ...((b.bends ?? []).map((bn) => ({ live_index: liveB(bn.live_index) }))),
  ];

  // Presentation (color, diameter, notes) inherits runA's, along with its id.
  const joined: DesignRun = {
    id: runA.id,
    polyline: { points: joinedPts, closed: false },
  };
  if (joinedTypes) joined.polyline.segment_types = joinedTypes;
  if (runA.tube_diameter_mm != null) joined.tube_diameter_mm = runA.tube_diameter_mm;
  if (runA.color != null) joined.color = runA.color;
  if (runA.notes != null) joined.notes = runA.notes;
  // Classification is a MERGE, not an inheritance, and it used to be missing
  // entirely (Bug #15) — the five fields it covers are what make a merged
  // channel-letter face keep its return-strip page, its raceway and its layer.
  // The A-vs-B rules, including the counter-intuitive jumper one, are stated
  // once at carryRunClassification. Feed it the ORIENTED runs `a`/`b` rather
  // than runA/runB: reversedRun spreads the whole run so the fields are on
  // both, and using the oriented pair keeps "A" meaning the same run the rest
  // of this function calls A.
  carryRunClassification(joined, a, b);
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
    // An ARC segment is refused rather than served wrong. Every coordinate
    // below is a linear interpolation of p1 -> p2, i.e. of the CHORD, so on a
    // bowed segment the U-bend would be planted up to a quarter of the chord
    // off the actual glass — a hairpin the bender cannot make. Placing it on
    // the flattened curve needs the hairpin to know its own arc-length
    // position; that is a real change, filed rather than guessed at here.
    if (isArcKind(segmentTypeAt(run, segmentIndex))) return run;
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

    // segment_types shifts with the points. Segment k becomes the five
    // straights p1-A-B-C-D-p2, and everything after it slides up by 4. Left
    // unshifted the array was both the wrong length — which the Go decoder
    // rejects outright, turning the next save into a 400 — and mis-indexed,
    // moving every later arc four segments off the glass it describes. Only
    // rebuilt when an array already exists, so a pre-#78 run doesn't grow one.
    const polyline = { ...run.polyline, points: newPts };
    if (run.polyline.segment_types) {
      const before = run.polyline.segment_types.slice(0, k);
      const after = run.polyline.segment_types.slice(k + 1);
      polyline.segment_types = [
        ...before,
        'line', 'line', 'line', 'line', 'line',
        ...after,
      ];
    }

    return {
      ...run,
      polyline,
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

// hasHairpinNearEndpoint — idempotency probe for autoDoublebackAllTerminations
// (Tier 2 #72). Detects the 4-vertex U-bend signature that insertDoubleback
// emits within ~tubeDiameter of a chosen polyline endpoint.
//
// The signature insertDoubleback produces (for a hairpin at segment 0,
// t≈0, the head case):
//   endpoint -- A         D -- ...
//                |         |
//                B---------C
// where:
//   - A is just past `endpoint` along the segment forward dir, distance ~= 0.5*gap
//   - B is `depth` perpendicular off A
//   - C is `gap` forward from B (parallel to AD)
//   - D is `depth` back toward the segment line, on the same side as the
//     original forward path.
//
// We probe by checking, on the interior side of the endpoint, whether
// the four vertices nearest the endpoint look like the U. The
// tolerance band is generous (matches the spec's "~tubeDiameter") so the
// detector trips on user-placed hairpins of slightly different
// proportions too — we err toward "skip" rather than "stack a second
// U-bend onto an existing one".
//
// `side` selects which end we're probing:
//   - 'head'  → endpoint is at point_index 0; vertices 1..4 carry the U.
//   - 'tail'  → endpoint is at the last vertex; vertices n-2..n-5 carry the U.
//
// Returns true if a hairpin-shaped neighborhood exists within
// `~2*tubeDiameter` of the endpoint. False if the path doesn't bend
// back close to the endpoint within that range.
function hasHairpinNearEndpoint(
  pts: readonly [number, number][],
  side: 'head' | 'tail',
  tubeDiameter: number,
): boolean {
  const n = pts.length;
  // Need at least 6 vertices total to host a 4-vertex hairpin inset from
  // the endpoint (endpoint + 4 hairpin + 1 continuation).
  if (n < 6) return false;
  // Walk the 4 candidate U vertices from the endpoint inward.
  const u: [number, number][] = side === 'head'
    ? [pts[1], pts[2], pts[3], pts[4]]
    : [pts[n - 2], pts[n - 3], pts[n - 4], pts[n - 5]];
  // After insertDoubleback at t close to the endpoint: the U has its
  // mouth on the segment line (A and D close to the line), with B and C
  // perpendicular. We detect this geometrically: |A-B| ≈ depth ≈
  // |D-C|, |A-D| ≈ gap, and BC parallel to AD.
  const [A, B, C, D] = u;
  const AB = Math.hypot(B[0] - A[0], B[1] - A[1]);
  const DC = Math.hypot(C[0] - D[0], C[1] - D[1]);
  const AD = Math.hypot(D[0] - A[0], D[1] - A[1]);
  const BC = Math.hypot(C[0] - B[0], C[1] - B[1]);
  // Sanity guards: every leg must be non-degenerate.
  if (AB < 1e-6 || DC < 1e-6 || AD < 1e-6 || BC < 1e-6) return false;
  // Generous shape tolerance (~tube diameter as a slack band). The
  // canonical defaults are depth=1.5*ø and gap=1.0*ø, but operators may
  // have hand-tuned either, so we accept a wide window: depth in
  // [0.5*ø, 4*ø] and gap in [0.25*ø, 4*ø].
  const minDepth = 0.5 * tubeDiameter;
  const maxDepth = 4.0 * tubeDiameter;
  const minGap = 0.25 * tubeDiameter;
  const maxGap = 4.0 * tubeDiameter;
  if (AB < minDepth || AB > maxDepth) return false;
  if (DC < minDepth || DC > maxDepth) return false;
  if (AD < minGap || AD > maxGap) return false;
  if (BC < minGap || BC > maxGap) return false;
  // The mouth (AD) and the floor (BC) should be roughly parallel and
  // similar in length — the U should be roughly rectangular.
  if (Math.abs(AD - BC) > tubeDiameter) return false;
  // AB and DC (the two legs) should be roughly parallel and equal-ish.
  if (Math.abs(AB - DC) > tubeDiameter) return false;
  // The whole U should sit within ~2*tubeDiameter of the endpoint along
  // the path — guard against false-positives where a U-bend exists deep
  // inside the run far from the chosen termination.
  const endpoint = side === 'head' ? pts[0] : pts[n - 1];
  for (const p of u) {
    const d = Math.hypot(p[0] - endpoint[0], p[1] - endpoint[1]);
    if (d > 4 * tubeDiameter) return false;
  }
  return true;
}

// autoDoublebackAllTerminations — bulk-applies insertDoubleback to every
// open-run electrode termination on the doc (Tier 2 #72). For a 12-letter
// channel-letter sign with 24 electrodes, this is one click instead of
// 24. The wrapped op (insertDoubleback) is unchanged; this just sweeps
// over every applicable target and accumulates the result into a single
// returned Doc so editDoc() collapses the whole batch into one undo
// step (no per-iteration setDoc / setDirty churn).
//
// "Termination" = an electrode anchored at a polyline endpoint of an
// OPEN run. Closed runs (no endpoints; the "live arc" is the chosen
// half of the loop and the electrodes sit mid-walk) are skipped; users
// can still doubleback closed-run electrodes via the per-electrode
// tool. Electrodes placed mid-polyline on an open run (rare; usually
// only if the operator hand-placed them) are also skipped because
// "termination" implies "endpoint of the open arc."
//
// Idempotency: for each candidate termination, hasHairpinNearEndpoint
// probes the nearby 4 vertices for the U-bend signature; if one
// already exists within ~tubeDiameter of the endpoint, the termination
// is skipped. Re-running the op on an already-doublebacked doc is a
// no-op (returns the same Doc reference so editDoc's structural-equal
// guard prevents a spurious undo entry).
//
// Index discipline: insertDoubleback grows the polyline by 4 vertices
// and shifts every anchor at or after the insertion. We always process
// the tail termination BEFORE the head when both apply, so the head
// insertion (at segment 0) doesn't shift the tail's segment index out
// from under us. Within a single run we re-derive segment indices off
// the working run between insertions.
//
// Returns the new Doc plus a `count` of doublebacks added; the editor
// uses the count to drive its toast / status-line confirmation
// ("Added N doublebacks across M runs"). Callers that only need the
// Doc can ignore the second field.
export type AutoDoublebackOptions = {
  depthMM?: number;
  gapMM?: number;
};

export type AutoDoublebackResult = {
  doc: DesignDoc;
  added: number;
  skipped: number;
};

export function autoDoublebackAllTerminations(
  doc: DesignDoc,
  opts: AutoDoublebackOptions = {},
): AutoDoublebackResult {
  let next = doc;
  let added = 0;
  let skipped = 0;
  // Iterate by run id (not by index) so we can re-read the run off the
  // working doc between insertions — insertDoubleback grows the
  // polyline so any pre-computed segmentIndex would drift.
  for (const original of doc.runs) {
    const runId = original.id;
    // Re-find the run on the working doc (point indices and polyline
    // length may have shifted from a sibling op above).
    let workingRun = next.runs.find((r) => r.id === runId);
    if (!workingRun) continue;
    // Only open runs have terminations; closed runs without endpoints
    // are skipped silently.
    if (workingRun.polyline.closed) continue;
    const electrodes = workingRun.electrodes ?? [];
    if (electrodes.length === 0) continue;
    const tubeDiam = workingRun.tube_diameter_mm ?? 10;
    // Process tail-side terminations BEFORE head-side ones within a
    // single run. Otherwise inserting at the head shifts every
    // downstream index (including the tail's segment index) by 4.
    // Building the work list with tail entries first guarantees the
    // tail's segment index is correct at the moment we apply it.
    type Termination = { side: 'head' | 'tail'; segmentIndex: number; t: number };
    const work: Termination[] = [];
    // Detect head/tail terminations by electrode point_index on the
    // CURRENT working run.
    const headElec = electrodes.some((e) => e.point_index === 0);
    const lastIdx = workingRun.polyline.points.length - 1;
    const tailElec = electrodes.some((e) => e.point_index === lastIdx);
    if (tailElec) {
      // Insert at the last segment, near its tail endpoint.
      work.push({ side: 'tail', segmentIndex: lastIdx - 1, t: 1.0 });
    }
    if (headElec) {
      // Insert at the first segment, near its head endpoint.
      work.push({ side: 'head', segmentIndex: 0, t: 0.0 });
    }
    for (const w of work) {
      // Re-read the working run for the up-to-date polyline.
      workingRun = next.runs.find((r) => r.id === runId);
      if (!workingRun) break;
      const pts = workingRun.polyline.points;
      if (pts.length < 2) continue;
      // Idempotency: probe the 4 vertices nearest this endpoint for an
      // existing hairpin. If found, skip the insertion.
      if (hasHairpinNearEndpoint(pts, w.side, tubeDiam)) {
        skipped++;
        continue;
      }
      // Recompute segment index for the tail case off the latest
      // polyline length (head's segment 0 is stable).
      const seg = w.side === 'tail' ? workingRun.polyline.points.length - 2 : 0;
      const before = next;
      next = insertDoubleback(
        next,
        runId,
        seg,
        w.t,
        opts.depthMM,
        opts.gapMM,
        'left',
      );
      if (next !== before) {
        added++;
      } else {
        skipped++;
      }
    }
  }
  if (added === 0) {
    // No mutation — return the original doc reference so editDoc's
    // structural-equal guard short-circuits the dirty / undo push.
    return { doc, added: 0, skipped };
  }
  return { doc: next, added, skipped };
}

// autoHousingAllElectrodes — bulk-applies setElectrodeHousing to every
// electrode on the doc that doesn't already have a housing (Tier 2 #72).
// For a 12-letter channel-letter sign with 24 electrodes this is one
// click instead of 24 housing-picker modal interactions.
//
// The wrapped op (setElectrodeHousing) is unchanged; this just sweeps
// over every (runId, electrodeIndex) pair on the doc and accumulates
// the result into a single returned Doc so editDoc collapses the whole
// batch into one undo step.
//
// "Already housed" means the electrode's `housing_type` field is set
// to anything other than empty/undefined. We deliberately skip these
// rather than overwrite so the per-letter custom-housing edits the
// operator may have already made stay intact. Operators who want to
// reset everything first can run "Clear electrodes" + "Place electrode"
// or hit the per-pin housing picker and pick "None".
//
// `housing` is the same HousingInput shape the per-electrode modal
// builds; setElectrodeHousing handles validation (stock-shell bore is
// stripped; custom requires positive bore) and throws OperationError
// on invalid input. We let the throw propagate so the editor's toast
// surfaces it as a single error rather than a per-electrode noisy run.
export type AutoHousingResult = {
  doc: DesignDoc;
  applied: number;
  skipped: number;
};

export function autoHousingAllElectrodes(
  doc: DesignDoc,
  housing: HousingInput,
): AutoHousingResult {
  let next = doc;
  let applied = 0;
  let skipped = 0;
  // Iterate by (runId, electrodeIndex). The setElectrodeHousing op
  // returns a new doc on every call; we thread the latest doc through
  // the loop so the final return is the cumulative state.
  for (const original of doc.runs) {
    const runId = original.id;
    const electrodes = (original.electrodes ?? []) as ElectrodeWithHousing[];
    for (let i = 0; i < electrodes.length; i++) {
      // Re-read off the working doc so the skip check sees the most
      // recent housing state (defensive — within one batch nothing
      // else should mutate it, but it costs nothing to be careful).
      const workingRun = next.runs.find((r) => r.id === runId);
      const workingElec = (workingRun?.electrodes ?? [])[i] as
        | ElectrodeWithHousing
        | undefined;
      if (!workingElec) {
        skipped++;
        continue;
      }
      // Skip electrodes that already carry a housing — preserves
      // per-pin operator edits. The truthy check excludes both
      // undefined (no housing field) and the empty-string sentinel
      // (operator explicitly cleared the housing).
      if (workingElec.housing_type) {
        skipped++;
        continue;
      }
      next = setElectrodeHousing(next, runId, i, housing);
      applied++;
    }
  }
  if (applied === 0) {
    return { doc, applied: 0, skipped };
  }
  return { doc: next, applied, skipped };
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
// ARCS (Bug #16): the source is offset through `flatRunPoints`, so the
// generated paths follow the drawn curve rather than its chords. Two
// consequences the operator is owed, and which have nowhere better to live
// until the warning channel stops unmounting the editor (see the note by
// `warnings` below):
//
//   - THE EMITTED RUNS CARRY NO `segment_types`. The offset of a circular arc
//     is a circular arc of a different radius, but `segment_types` can only
//     express the one fixed bulge ARC_BULGE implies for a given chord, so that
//     curve is not representable. The offsets ship as flattened polylines: the
//     operator trades curve fidelity — those segments can no longer be flipped
//     or re-radiused — for a path that actually follows the glass.
//   - DENSITY. `arcGeom` samples at 5°, i.e. 22 points per arc segment. On a
//     200 mm chord (radius 125, offset ring 135) the sampled offset's sagitta
//     error is 0.12 mm, 0.06% of the arc. Vertex count grows linearly at ~22
//     per arc — a curve-heavy glyph gets bigger, not unbounded.
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

// flattenCornerStyles lifts a per-SOURCE-vertex cornerStyles array onto the
// flattened point list `flatRunPoints` produces, so index i still names the
// same physical corner after the arcs have been sampled into straights.
//
// The samples an arc contributes are interior points on a smooth curve — there
// is no corner there to bevel or round — so they take the 'miter' default. The
// walk mirrors flatRunPoints exactly (including the closing segment landing
// back on vertex 0), which is what keeps the two arrays the same length.
function flattenCornerStyles(run: DesignRun, styles: CornerStyle[]): CornerStyle[] {
  if (!runHasArcs(run)) return styles;
  const pts = run.polyline.points;
  const n = pts.length;
  const out: CornerStyle[] = [styles[0] ?? 'miter'];
  const segs = segmentCount(run);
  for (let i = 0; i < segs; i++) {
    const k = flattenSegment(pts[i], pts[(i + 1) % n], segmentTypeAt(run, i)).length;
    for (let j = 0; j < k - 1; j++) out.push('miter');
    out.push(styles[(i + 1) % n] ?? 'miter');
  }
  return out;
}

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
  const stitch = options.stitch ?? false;
  // cornerStyles indexes SOURCE vertices. Flattening inserts vertices between
  // them, so on an arc run the raw array would put every style after the first
  // arc on the wrong corner — remap it alongside the points.
  const cornerStyles = options.cornerStyles
    ? flattenCornerStyles(src, options.cornerStyles)
    : undefined;

  const offsetOpts = {
    cornerStyles,
    trimSelfIntersections: true,
  };

  // Offset the CURVE, not the chords (Bug #16). `polyline.points` is the
  // control skeleton; on a run with arc segments the glass bows a quarter of
  // each chord off it (ARC_BULGE 0.5), so offsetting the raw array produces a
  // clean parallel outline of a shape nobody drew — 50 mm off the tube on a
  // 200 mm arc. This is the other half of the rule in CLAUDE.md → Recurring
  // bug classes → 1: never flatten when you are indexing, ALWAYS flatten when
  // you need the true shape.
  //
  // `flatRunPoints` returns the original array when the run has no arcs, so
  // the line-only path — which three shipped parity rows rest on — is
  // byte-identical to before, not merely close.
  const srcPts = flatRunPoints(src);

  let outer: ReturnType<typeof offsetPolygon>;
  let inner: ReturnType<typeof offsetPolygon>;
  if (src.polyline.closed) {
    outer = offsetPolygon(srcPts, +half, offsetOpts);
    inner = offsetPolygon(srcPts, -half, offsetOpts);
  } else {
    outer = offsetOpenPolyline(srcPts, +half, offsetOpts);
    inner = offsetOpenPolyline(srcPts, -half, offsetOpts);
  }

  // Build the replacement run(s). Inheritance has two halves. The index-bound
  // fields (electrodes, blockouts, annotations, bends, and `direction`, which
  // only means anything on a closed run with two electrodes) do not carry: the
  // emitted path is not the walk the source described, so there is nothing for
  // those indices to point at. The CLASSIFICATION fields carry selectively —
  // see CARRY_NEONIZED for the per-field reasoning. The short version is that
  // neonize is the one derived-run op where "carry everything" is wrong: the
  // face flag must not carry (it would emit return-strip pages for metal nobody
  // is cutting) while the memberships and `kind` must (dropping them ejects the
  // glass the operator just generated from its group and its raceway).
  function withMeta(id: string, points: [number, number][], closed: boolean): DesignRun {
    const r: DesignRun = { id, polyline: { points, closed } };
    if (src.tube_diameter_mm != null) r.tube_diameter_mm = src.tube_diameter_mm;
    if (src.color != null) r.color = src.color;
    if (src.notes != null) r.notes = src.notes;
    carryNeonizedClassification(r, src);
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
  //
  // NOTE — deliberately NOT warning that arcs were flattened, even though the
  // operator is owed that fact. This channel is not a toast: EditorPage's
  // neonizeSelected pipes it into `setError`, and EditorPage early-returns
  // `if (error) return <p className="error">{error}</p>` — the entire editor
  // unmounts, taking the unsaved doc with it. Verified in a browser: adding a
  // warning here replaced the editor with a bare red line of text. The two
  // warnings below already do that, rarely; one that fired on EVERY arc
  // neonize would make it the normal outcome. Filed as a separate bug. Until
  // the channel is a real toast, the fact is stated in the doc-comment above.
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

// setGroupVisible toggles the display-only `visible` flag on one
// group (Tier 3 #33c). No-op for missing groupId so the sidebar's
// eye-toggle can fire safely against a stale UI snapshot. Setting
// the flag to its only-meaningful "false" value writes through;
// setting it to "true" deletes the field entirely (encoded JSON
// stays clean — undefined / nil-pointer is the back-compat
// "visible" semantic). Validation, save, PDF, DXF all ignore this
// field — it's a *display* filter, not a doc filter.
export function setGroupVisible(
  doc: DesignDoc,
  groupId: string,
  visible: boolean,
): DesignDoc {
  if (!groupId) return doc;
  const groups = doc.groups ?? [];
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx < 0) return doc;
  // Normalize: visible=true → undefined (drop the key) so re-marshal
  // matches the back-compat shape; visible=false → explicit false.
  const current = groups[idx].visible;
  const wantFlag = visible ? undefined : false;
  if (current === wantFlag) return doc;
  // Treat undefined === undefined (the same-value short-circuit) so
  // toggling visible=true on an unset flag is a no-op (no spurious
  // undo entry).
  if (current === undefined && wantFlag === undefined) return doc;
  const next = groups.slice();
  const replacement: Group = { ...next[idx] };
  if (wantFlag === undefined) {
    delete replacement.visible;
  } else {
    replacement.visible = wantFlag;
  }
  next[idx] = replacement;
  return { ...doc, groups: next };
}

// setGroupLocked toggles the click-protect `locked` flag on one
// group (Tier 3 #33c). No-op for missing groupId. Locked is a
// plain bool (no "default-true" pointer trick — false is the
// natural default for a fresh group), so we just write the value
// through and drop the key when it's the zero value to keep
// re-marshal clean.
export function setGroupLocked(
  doc: DesignDoc,
  groupId: string,
  locked: boolean,
): DesignDoc {
  if (!groupId) return doc;
  const groups = doc.groups ?? [];
  const idx = groups.findIndex((g) => g.id === groupId);
  if (idx < 0) return doc;
  const current = !!groups[idx].locked;
  if (current === locked) return doc;
  const next = groups.slice();
  const replacement: Group = { ...next[idx] };
  if (locked) {
    replacement.locked = true;
  } else {
    delete replacement.locked;
  }
  next[idx] = replacement;
  return { ...doc, groups: next };
}

// scalePoints scales a list of points about an anchor: p' = anchor + (p -
// anchor) * s. Used by the editor's drag-to-resize handles (feat-editor-scale-
// handles). Pure and stateless so the canvas can scale from a drag snapshot.
export function scalePoints(
  points: [number, number][],
  sx: number,
  sy: number,
  anchorX: number,
  anchorY: number,
): [number, number][] {
  return points.map(([x, y]) => [
    anchorX + (x - anchorX) * sx,
    anchorY + (y - anchorY) * sy,
  ]);
}

// setRunsPoints replaces the polyline points of one or more runs in a single
// new doc — used by the resize-handle drag, which scales every selected run
// about a shared anchor and commits them together (one undo step via the
// editDoc coalescing). Electrodes / bends / blockouts reference point indices,
// not coordinates, so they follow the moved points without extra work. Runs
// not in `updates`, and unknown run ids, are left untouched.
export function setRunsPoints(
  doc: DesignDoc,
  updates: { runId: string; points: [number, number][] }[],
): DesignDoc {
  if (updates.length === 0) return doc;
  const byId = new Map(updates.map((u) => [u.runId, u.points]));
  let changed = false;
  const nextRuns = doc.runs.map((r) => {
    const pts = byId.get(r.id);
    if (!pts) return r;
    changed = true;
    return { ...r, polyline: { ...r.polyline, points: pts } };
  });
  if (!changed) return doc;
  return { ...doc, runs: nextRuns };
}

// ---------------------------------------------------------------------------
// Tier 2 #75 — auto-split overlong tubes
// ---------------------------------------------------------------------------

// segLenMM is `sqrt(dx*dx + dy*dy)`, NOT Math.hypot. hypot is the more
// accurate primitive — it rescales to avoid overflow — but the Go
// validator's `dist()` uses the naive form, and the two can disagree by
// an ulp. The validator is what decides whether a run is flagged, so the
// auto-split has to measure the way the validator measures, not the way
// that is independently more correct. Sign coordinates are millimetres,
// so hypot's overflow protection buys us nothing here anyway.
function segLenMM(a: [number, number], b: [number, number]): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  return Math.sqrt(dx * dx + dy * dy);
}

// polylineLengthMM returns total arc length. Deliberately mirrors the Go
// validator's `(*Polyline).Length()` (internal/validate/geometry.go),
// closing segment included when `closed` — if the two disagree, a run
// the auto-split believes it fixed can still come back flagged.
export function polylineLengthMM(points: [number, number][], closed = false): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += segLenMM(points[i], points[i - 1]);
  }
  if (closed && points.length > 1) {
    total += segLenMM(points[points.length - 1], points[0]);
  }
  return total;
}

// splitRunAtArcLength cuts one OPEN run at `targetMM` measured along its
// polyline from the first vertex, and returns the two new run ids (head
// = the piece containing vertex 0). Returns null when the target isn't
// strictly interior to the run, which is the caller's cue to stop.
//
// The cut lands mid-segment in the general case, so we insertVertex
// first and then splitRun at the vertex we just created. When the target
// falls on an existing vertex (within EPS) we split there directly
// rather than inserting a coincident duplicate — a zero-length segment
// would survive into the bend list as a phantom 0mm run.
function splitRunAtArcLength(
  doc: DesignDoc,
  runId: string,
  targetMM: number,
): { doc: DesignDoc; headId: string; tailId: string } | null {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run || run.polyline.closed) return null;
  const pts = run.polyline.points;
  const n = pts.length;
  if (n < 2) return null;

  const EPS = 1e-9;
  if (targetMM <= EPS) return null;

  // Walk segments, accumulating arc length, until the target lands
  // inside one. `k` ends as the segment index and `t` the parameter
  // along it.
  let acc = 0;
  let k = -1;
  let t = 0;
  for (let i = 0; i < n - 1; i++) {
    const segLen = segLenMM(pts[i + 1], pts[i]);
    if (acc + segLen >= targetMM - EPS) {
      k = i;
      t = segLen === 0 ? 0 : (targetMM - acc) / segLen;
      break;
    }
    acc += segLen;
  }
  if (k < 0) return null; // target past the end of the run

  return splitRunAtSegmentT(doc, runId, k, t);
}

// splitRunAtSegmentT cuts an open run at parameter `t` along segment `k`,
// inserting the vertex first when the cut lands mid-segment, and returns the
// two new run ids (head = the piece containing vertex 0). Shared by the
// arc-length splitter (Tier 2 #75) and the raceway splitter (Tier 2 #74) —
// the insert-then-split dance and its off-by-one are worth having in exactly
// one place.
//
// When the cut coincides with an existing vertex we split there rather than
// inserting a duplicate on top of it: a zero-length segment would survive
// into the bend list as a phantom 0mm run.
function splitRunAtSegmentT(
  doc: DesignDoc,
  runId: string,
  k: number,
  t: number,
): { doc: DesignDoc; headId: string; tailId: string } | null {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return null;
  const n = run.polyline.points.length;
  if (k < 0 || k >= n - 1) return null;
  const EPS = 1e-9;

  // splitRun needs 0 < pointIndex < n-1 so each piece keeps >= 2 points.
  const canSplitAt = (idx: number) => idx > 0 && idx < n - 1;

  let nextDoc: DesignDoc;
  let splitIndex: number;
  if (t <= EPS && canSplitAt(k)) {
    nextDoc = doc;
    splitIndex = k;
  } else if (t >= 1 - EPS && canSplitAt(k + 1)) {
    nextDoc = doc;
    splitIndex = k + 1;
  } else if (t <= EPS || t >= 1 - EPS) {
    // The cut is on an endpoint, where there is nothing to split off.
    return null;
  } else {
    nextDoc = insertVertex(doc, runId, k, t);
    splitIndex = k + 1; // the vertex insertVertex just placed
  }

  const before = new Set(nextDoc.runs.map((r) => r.id));
  const after = splitRun(nextDoc, runId, splitIndex);
  if (after === nextDoc) return null;
  // splitRun replaces the source run in place with [head, tail], so the
  // two fresh ids are the ones that weren't on the doc a moment ago and
  // they are still adjacent in run order.
  const fresh = after.runs.filter((r) => !before.has(r.id));
  if (fresh.length !== 2) return null;
  return { doc: after, headId: fresh[0].id, tailId: fresh[1].id };
}

export type AutoSplitResult = {
  doc: DesignDoc;
  // Source runs that were over the limit and got cut.
  runsSplit: number;
  // Total pieces those runs became (always > runsSplit when runsSplit > 0).
  piecesCreated: number;
  // Closed runs carrying electrodes, which we decline to touch — see below.
  skippedClosedWithElectrodes: number;
};

// autoSplitOverlongTubes cuts every run longer than `maxLengthMM` into
// the fewest equal-arc-length pieces that all fit under the limit
// (Tier 2 #75). One-click counterpart to the `max_segment_length`
// validator issue, which today only tells the operator to go split by
// hand.
//
// Even spacing, not "split at a natural point". Snapping to the nearest
// vertex or electrode would produce prettier cuts on some docs and wildly
// uneven ones on others (a serpentine's vertices cluster at the turns);
// even spacing is predictable and matches the NW behavior operators
// already expect. A "snap to nearest vertex" mode is a follow-up.
//
// Piece count is `ceil(L / limit)`, then re-checked against the geometry
// the split actually produced. The edge case is an L that is an exact
// multiple of the limit: n pieces then have to measure exactly `limit`
// each, and splitting a segment can only ever add length (the two halves
// sum to >= the whole once rounded), so at least one piece lands a
// fraction of a picometre over. The validator's test is a strict `>`, so
// that run comes back flagged and the button looks broken. There is no
// way to place n cuts that avoids this — the only fix is one more cut —
// so if any piece is still over we retry with n+1.
//
// Cost: an exactly-divisible tube gets one more piece than it strictly
// needs. That case does not arise from drawing — it needs L to be an
// exact float multiple of a round limit — but it is trivial to hit from
// a script, and a visibly-broken fix button is worse than one extra cut.
// The postcondition is therefore real rather than nominal: no run on the
// returned doc exceeds `maxLengthMM`.
//
// Closed runs: an electrodeless decorative loop is opened at vertex 0
// (duplicating it as the last vertex, which preserves every live index)
// and then split, per spec — the operator places electrodes afterwards.
// A closed run that already carries electrodes is skipped and counted:
// its live arc is defined by the walk between those electrodes, and
// there is no non-arbitrary answer to which piece inherits which
// electrode. Better to report it than to silently mangle it; the
// operator can `breakOpen` it and re-run.
//
// Locked and hidden groups are not consulted, matching the other
// doc-wide bulk ops (autoAssignRaceways, autoDoublebackAllTerminations)
// — `locked` is a canvas click-protect flag, not a write barrier.
export function autoSplitOverlongTubes(
  doc: DesignDoc,
  maxLengthMM: number,
): AutoSplitResult {
  const none: AutoSplitResult = {
    doc,
    runsSplit: 0,
    piecesCreated: 0,
    skippedClosedWithElectrodes: 0,
  };
  if (!(maxLengthMM > 0)) return none;

  let out = doc;
  let runsSplit = 0;
  let piecesCreated = 0;
  let skippedClosedWithElectrodes = 0;

  // Snapshot the ids up front: splitting mints new runs, and we don't
  // want to re-examine pieces we just created (they're under the limit
  // by construction, and re-entering would risk a runaway on a doc the
  // arithmetic can't satisfy).
  const sourceIds = doc.runs.map((r) => r.id);

  for (const sourceId of sourceIds) {
    const run = out.runs.find((r) => r.id === sourceId);
    if (!run) continue;
    const closed = !!run.polyline.closed;
    const length = polylineLengthMM(run.polyline.points, closed);
    if (length <= maxLengthMM) continue;

    // Opening a closed loop below is a visible edit in its own right and it
    // happens BEFORE we know the split will succeed. No input reaches that
    // bail-out today — every opened loop of >= 3 vertices cuts cleanly — but
    // if one ever did, the doc would be left holding a loop that is open and
    // uncut, which is strictly worse than the overlong loop we started with:
    // the duplicated seam vertex reads as glass-on-glass to the crossing
    // rule. Snapshot so an abandoned run leaves the doc exactly as found.
    const outAtRunStart = out;

    if (closed) {
      if ((run.electrodes?.length ?? 0) > 0) {
        skippedClosedWithElectrodes++;
        continue;
      }
      if (run.polyline.points.length < 3) continue;
      out = mapRun(out, sourceId, (r) => ({
        ...r,
        polyline: {
          ...r.polyline,
          points: [...r.polyline.points, r.polyline.points[0]],
          closed: false,
        },
      }));
    }

    // `pieces` is the nominal cut count; the retry loop below bumps it
    // when the produced geometry doesn't actually clear the limit.
    const pieces = Math.max(2, Math.ceil(length / maxLengthMM));
    let applied: DesignDoc | null = null;
    let appliedPieces = 0;
    // At most two retries: n, n+1, n+2. Floating-point slop is
    // sub-picometre, so one extra cut always suffices in practice; the
    // bound keeps a pathological doc from spinning.
    for (let attempt = 0; attempt < 3 && applied === null; attempt++) {
      const n = pieces + attempt;
      const candidate = cutIntoEqualPieces(out, sourceId, length, n);
      if (!candidate) break;
      const overlong = candidate.pieceIds.some((id) => {
        const r = candidate.doc.runs.find((x) => x.id === id);
        return r ? polylineLengthMM(r.polyline.points, false) > maxLengthMM : false;
      });
      if (!overlong) {
        applied = candidate.doc;
        appliedPieces = candidate.pieceIds.length;
      }
    }
    if (applied === null) {
      out = outAtRunStart;
      continue;
    }
    out = applied;
    runsSplit++;
    piecesCreated += appliedPieces;
  }

  if (runsSplit === 0 && skippedClosedWithElectrodes === 0) return none;
  return { doc: out, runsSplit, piecesCreated, skippedClosedWithElectrodes };
}

// cutIntoEqualPieces makes `n - 1` cuts at arc-length L/n, 2L/n, … along
// an open run. Each cut is measured from the start of the *remaining
// tail*, not from the original vertex 0 — walking the tail avoids having
// to track how earlier insertions shifted the vertex indices, and the
// distances are the same either way because every piece is L/n long.
function cutIntoEqualPieces(
  doc: DesignDoc,
  runId: string,
  totalLengthMM: number,
  n: number,
): { doc: DesignDoc; pieceIds: string[] } | null {
  if (n < 2) return null;
  const step = totalLengthMM / n;
  let out = doc;
  let tailId = runId;
  const pieceIds: string[] = [];
  for (let i = 0; i < n - 1; i++) {
    const cut = splitRunAtArcLength(out, tailId, step);
    if (!cut) return null;
    out = cut.doc;
    pieceIds.push(cut.headId);
    tailId = cut.tailId;
  }
  pieceIds.push(tailId);
  return { doc: out, pieceIds };
}

// ---------------------------------------------------------------------------
// Tier 2 #74 — raceway guideline as a geometric break point
// ---------------------------------------------------------------------------

// How close a vertex has to sit to the guideline to count as ON it. A
// nanometre: far below any real sign geometry, but comfortably above the
// float noise in an interpolated crossing coordinate (~1e-13 mm at
// millimetre scale). This is what makes re-splitting idempotent — the
// vertices a split creates land exactly on the line, and land inside this
// tolerance on the way back in.
export const RACEWAY_ON_LINE_TOL_MM = 1e-6;

export type RacewayCrossing = {
  // Index of the segment the crossing sits on. For a closed polyline the
  // last segment (n-1 -> 0) is included.
  segmentIndex: number;
  // Parameter along that segment, in [0, 1). Exactly 0 means the crossing
  // IS the segment's first vertex.
  t: number;
};

// racewayCrossings finds every point where a polyline meets the horizontal
// line y = yMM, in order along the polyline.
//
// A vertex sitting exactly on the line is emitted once, as `t: 0` on the
// segment leaving it — never also as `t: 1` on the segment arriving, which
// would split the same place twice. A vertex that merely touches the line and
// turns back still counts: the operator put the raceway there, and "tangent,
// so not really a crossing" is not a distinction the shop floor makes.
//
// For an OPEN polyline the two endpoints are excluded. That is not a special
// case bolted on — it is what makes the whole operation idempotent. Splitting
// leaves every new piece with an endpoint exactly on the line, so a second
// pass finds nothing left to do.
export function racewayCrossings(
  points: [number, number][],
  closed: boolean,
  yMM: number,
  tolMM: number = RACEWAY_ON_LINE_TOL_MM,
): RacewayCrossing[] {
  const n = points.length;
  if (n < 2) return [];
  const out: RacewayCrossing[] = [];
  const lastSegment = closed ? n - 1 : n - 2;
  for (let i = 0; i <= lastSegment; i++) {
    const p1 = points[i];
    const p2 = points[(i + 1) % n];
    const a = p1[1] - yMM;
    const b = p2[1] - yMM;
    if (Math.abs(a) <= tolMM) {
      // Vertex i is on the line. Skip vertex 0 of an open run — it is an
      // endpoint, and there is nothing on the far side of it to split off.
      if (closed || i > 0) out.push({ segmentIndex: i, t: 0 });
      continue;
    }
    // Vertex i+1 on the line is emitted by the NEXT iteration as its own
    // `a`. For the final segment of an open run that iteration never comes,
    // which is exactly right: that vertex is the other endpoint.
    if (Math.abs(b) <= tolMM) continue;
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      out.push({ segmentIndex: i, t: a / (a - b) });
    }
  }
  return out;
}

// nextGuidelineId returns the lowest unused `rw<n>` id on the doc. The `rw`
// prefix keeps guideline ids distinguishable from run ids (`r1`) and group
// ids (`g1`) at a glance in the runs list, where the guideline's id shows up
// again as every split piece's raceway tag.
export function nextGuidelineId(doc: DesignDoc): string {
  const taken = new Set<number>();
  for (const g of doc.guidelines ?? []) {
    const m = /^rw(\d+)$/.exec(g.id);
    if (m) taken.add(parseInt(m[1], 10));
  }
  let n = 1;
  while (taken.has(n)) n++;
  return `rw${n}`;
}

export function addRacewayGuideline(doc: DesignDoc, yMM: number): DesignDoc {
  if (!Number.isFinite(yMM)) return doc;
  const g: Guideline = { id: nextGuidelineId(doc), kind: 'raceway', y_mm: yMM };
  return { ...doc, guidelines: [...(doc.guidelines ?? []), g] };
}

export function moveGuideline(doc: DesignDoc, id: string, yMM: number): DesignDoc {
  if (!Number.isFinite(yMM)) return doc;
  const list = doc.guidelines ?? [];
  const idx = list.findIndex((g) => g.id === id);
  if (idx < 0 || list[idx].y_mm === yMM) return doc;
  const next = list.slice();
  next[idx] = { ...next[idx], y_mm: yMM };
  return { ...doc, guidelines: next };
}

// removeGuideline drops the line. Runs already split at it keep their
// geometry AND their raceway tag: the cut glass does not un-cut itself
// because the construction line went away, and the pieces still share a
// strip. Clearing the tag here would silently regroup the PDF.
//
// The modelled BOX does go (Tier 2 #104), and it has to: a Raceway is the
// hardware hanging off this guideline and shares its id, so leaving one
// behind produces a doc the Go decoder rejects — every subsequent save 400s
// with no visible cause. Runs keeping `raceway_id` while the box goes is not
// an inconsistency; the tag records which strip the glass shares, which is
// still true.
export function removeGuideline(doc: DesignDoc, id: string): DesignDoc {
  const list = doc.guidelines ?? [];
  if (!list.some((g) => g.id === id)) return doc;
  const next = list.filter((g) => g.id !== id);
  const out: DesignDoc = { ...doc, guidelines: next };
  if (next.length === 0) delete out.guidelines;
  return removeRaceway(out, id);
}

// ---------------------------------------------------------------------------
// Tier 2 #104 / NW #133 — the raceway as a modelled hardware object
// ---------------------------------------------------------------------------

// findRaceway looks up the box for a guideline id. Raceways share the
// guideline's id space, so this is also "does this guideline have a box".
export function findRaceway(doc: DesignDoc, id: string): Raceway | undefined {
  return (doc.raceways ?? []).find((r) => r.id === id);
}

// racewayMemberIds lists the runs mounted on a raceway — every run carrying
// the id, which after "Split tubes at raceway" is every piece that was cut at
// the line, plus any face run labelled by hand.
export function racewayMemberIds(doc: DesignDoc, id: string): string[] {
  if (!id) return [];
  return doc.runs.filter((r) => r.raceway_id === id).map((r) => r.id);
}

// racewayFitBBox is the ARC-AWARE extent of a raceway's member runs, via
// selectionBBoxMM. Using it rather than reading polyline.points is the whole
// point: an arc bows outside the hull of its own vertices, so a box fitted to
// raw points stops short of the glass it is supposed to carry.
function racewayFitBBox(doc: DesignDoc, id: string): BBoxMM | null {
  const ids = racewayMemberIds(doc, id);
  if (ids.length === 0) return null;
  return selectionBBoxMM(doc, ids);
}

// writeRaceway upserts one box, preserving declaration order. Returns the
// SAME doc when nothing changed — EditorPage's applyOp and the undo-coalescing
// window both read reference identity to decide whether an edit happened.
function writeRaceway(doc: DesignDoc, next: Raceway): DesignDoc {
  const list = doc.raceways ?? [];
  const idx = list.findIndex((r) => r.id === next.id);
  if (idx >= 0) {
    const cur = list[idx];
    if (
      cur.x_mm === next.x_mm &&
      cur.length_mm === next.length_mm &&
      (cur.height_mm ?? 0) === (next.height_mm ?? 0) &&
      (cur.depth_mm ?? 0) === (next.depth_mm ?? 0)
    ) {
      return doc;
    }
    const copy = list.slice();
    copy[idx] = next;
    return { ...doc, raceways: copy };
  }
  return { ...doc, raceways: [...list, next] };
}

// fitRacewayToRuns sizes the box to the runs mounted on it.
//
// This is the ONE place the flush-vs-overhang assumption is applied. See
// RACEWAY_END_MARGIN_MM: no source says whether the box stops level with the
// outermost letters or runs past them, so V1 is flush and the answer, when a
// shop gives us one, is a one-line change here.
//
// Height and depth are carried through untouched — auto-fit answers "where
// does the box start and how long is it", never "what stock is it made from".
export function fitRacewayToRuns(doc: DesignDoc, id: string): DesignDoc {
  const rw = findRaceway(doc, id);
  if (!rw) return doc;
  const bbox = racewayFitBBox(doc, id);
  if (!bbox) return doc;
  return writeRaceway(doc, {
    ...rw,
    x_mm: bbox.minX - RACEWAY_END_MARGIN_MM,
    length_mm: bbox.maxX - bbox.minX + 2 * RACEWAY_END_MARGIN_MM,
  });
}

// createRaceway adds the box for an existing raceway guideline, auto-fitted
// to its member runs.
//
// A guideline with no members yet gets a box spanning the design's view box
// instead of a zero-length one: the operator asked for a raceway, and a box
// they can see and drag is a better starting point than an invisible one they
// have to discover. Re-running on a guideline that already has a box is a
// no-op — use fitRacewayToRuns to re-fit.
export function createRaceway(doc: DesignDoc, guidelineId: string): DesignDoc {
  const guide = (doc.guidelines ?? []).find(
    (g) => g.id === guidelineId && g.kind === 'raceway',
  );
  // A box whose id names no RACEWAY guideline is rejected by the Go decoder,
  // so refusing here keeps the failure in the editor instead of at save time.
  if (!guide) return doc;
  if (findRaceway(doc, guidelineId)) return doc;
  const bbox = racewayFitBBox(doc, guidelineId);
  const [vx, , vw] = doc.view_box_mm;
  const seeded: Raceway = bbox
    ? {
        id: guidelineId,
        x_mm: bbox.minX - RACEWAY_END_MARGIN_MM,
        length_mm: bbox.maxX - bbox.minX + 2 * RACEWAY_END_MARGIN_MM,
      }
    : { id: guidelineId, x_mm: vx, length_mm: vw };
  return writeRaceway(doc, seeded);
}

// setRacewayGeometry applies a numeric-entry or drag edit. Every field is
// operator-overridable on purpose — the defaults are current commercial
// practice from a weaker source class than the rest of docs/neon-rules/, and
// a shop with a different box must be able to say so.
//
// A non-positive height/depth is stored as `undefined` rather than 0 so it
// keeps meaning "use the shop default" and stays out of the saved JSON.
// Negative lengths are clamped to 0 (a box cannot be inside-out); X is free
// to go anywhere, including negative world coordinates.
export function setRacewayGeometry(
  doc: DesignDoc,
  id: string,
  patch: Partial<Pick<Raceway, 'x_mm' | 'length_mm' | 'height_mm' | 'depth_mm'>>,
): DesignDoc {
  const rw = findRaceway(doc, id);
  if (!rw) return doc;
  const num = (v: number | undefined, fallback: number | undefined) =>
    v != null && Number.isFinite(v) ? v : fallback;
  const next: Raceway = {
    id: rw.id,
    x_mm: num(patch.x_mm, rw.x_mm) ?? rw.x_mm,
    length_mm: Math.max(0, num(patch.length_mm, rw.length_mm) ?? rw.length_mm),
  };
  const h = num(patch.height_mm, rw.height_mm);
  if (h != null && h > 0) next.height_mm = h;
  const d = num(patch.depth_mm, rw.depth_mm);
  if (d != null && d > 0) next.depth_mm = d;
  return writeRaceway(doc, next);
}

// dragRacewayEnd moves one end of the box in world mm, keeping the other end
// pinned. Dragging the left end past the right (or vice versa) collapses to a
// zero-length box rather than flipping it inside out.
export function dragRacewayEnd(
  doc: DesignDoc,
  id: string,
  end: 'left' | 'right',
  xMM: number,
): DesignDoc {
  const rw = findRaceway(doc, id);
  if (!rw || !Number.isFinite(xMM)) return doc;
  if (end === 'left') {
    const right = rw.x_mm + rw.length_mm;
    const left = Math.min(xMM, right);
    return setRacewayGeometry(doc, id, { x_mm: left, length_mm: right - left });
  }
  return setRacewayGeometry(doc, id, {
    length_mm: Math.max(0, xMM - rw.x_mm),
  });
}

// removeRaceway drops the box while leaving the guideline and every
// `raceway_id` alone: un-modelling the hardware does not un-cut the glass.
export function removeRaceway(doc: DesignDoc, id: string): DesignDoc {
  const list = doc.raceways ?? [];
  if (!list.some((r) => r.id === id)) return doc;
  const next = list.filter((r) => r.id !== id);
  const out: DesignDoc = { ...doc, raceways: next };
  if (next.length === 0) delete out.raceways;
  return out;
}

// racewayEffectiveHeightMM / racewayEffectiveDepthMM resolve the "0 means
// shop default" sentinel. Twins of Raceway.EffectiveHeightMM /
// EffectiveDepthMM in internal/designdoc/types.go — the canvas draws from
// these while the PDF draws from those, so they have to agree.
export function racewayEffectiveHeightMM(rw: Raceway): number {
  return rw.height_mm && rw.height_mm > 0 ? rw.height_mm : RACEWAY_DEFAULT_HEIGHT_MM;
}

export function racewayEffectiveDepthMM(rw: Raceway): number {
  return rw.depth_mm && rw.depth_mm > 0 ? rw.depth_mm : RACEWAY_DEFAULT_DEPTH_MM;
}

// racewaySpliceCount is the number of butt splices a box of this length
// needs: sections ship at RACEWAY_SPLICE_MM (10 ft) or shorter, so exactly
// 10 ft needs none and 25 ft arrives in three pieces with two seams. Twin of
// Raceway.SpliceCount in Go.
export function racewaySpliceCount(rw: Raceway): number {
  if (rw.length_mm <= RACEWAY_SPLICE_MM) return 0;
  return Math.max(0, Math.ceil(rw.length_mm / RACEWAY_SPLICE_MM) - 1);
}

export type SplitAtRacewayResult = {
  doc: DesignDoc;
  // Runs that crossed the line and were cut.
  runsSplit: number;
  // Total pieces those runs became.
  piecesCreated: number;
  // Closed runs carrying electrodes, which we decline to touch — see below.
  skippedClosedWithElectrodes: number;
};

// splitTubesAtRaceway cuts every run crossing the guideline at the crossing
// point and stamps each resulting piece with the guideline's id as its
// RacewayID (Tier 2 #74). This is the canonical channel-letter-with-raceway
// construction: all tubes terminate at one horizontal back-channel.
//
// Idempotent by construction, not by bookkeeping. Splitting leaves every
// piece with an endpoint exactly on the line, and racewayCrossings excludes
// the endpoints of an open run, so a second pass finds no crossings and
// returns the input doc unchanged. Nothing has to remember what was already
// cut.
//
// MOVING the guideline and splitting again does NOT undo the previous cut —
// it adds a second one, because the old split is now indistinguishable from
// glass the operator drew that way. Undo is the way back, and it is one step
// (the whole sweep is a single editDoc).
//
// Closed runs (a letter's face outline is one) are opened at their first
// crossing rather than skipped, since a raceway through an "O" is ordinary
// work. A closed run carrying electrodes is skipped and counted: its live arc
// is defined by the walk between them, and opening the loop destroys that
// with no non-arbitrary answer for which piece inherits which electrode. Same
// call as autoSplitOverlongTubes, for the same reason.
export function splitTubesAtRaceway(
  doc: DesignDoc,
  guidelineId: string,
): SplitAtRacewayResult {
  const none: SplitAtRacewayResult = {
    doc,
    runsSplit: 0,
    piecesCreated: 0,
    skippedClosedWithElectrodes: 0,
  };
  const guideline = (doc.guidelines ?? []).find((g) => g.id === guidelineId);
  if (!guideline) return none;
  const yMM = guideline.y_mm;

  let out = doc;
  let runsSplit = 0;
  let piecesCreated = 0;
  let skippedClosedWithElectrodes = 0;

  // Snapshot up front: splitting mints new runs, and the pieces are already
  // cut at the line — re-examining them would find nothing but would let a
  // future change loop.
  const sourceIds = doc.runs.map((r) => r.id);

  for (const sourceId of sourceIds) {
    const run = out.runs.find((r) => r.id === sourceId);
    if (!run) continue;
    const closed = !!run.polyline.closed;
    const crossings = racewayCrossings(run.polyline.points, closed, yMM);
    if (crossings.length === 0) continue;

    // Opening a closed loop is a visible edit that happens before we know the
    // splits will land; snapshot so an abandoned run leaves the doc as found.
    const outAtRunStart = out;

    if (closed) {
      if ((run.electrodes?.length ?? 0) > 0) {
        skippedClosedWithElectrodes++;
        continue;
      }
      const opened = openClosedRunAtCrossing(out, sourceId, crossings[0]);
      if (!opened) continue;
      out = opened;
    }

    // Re-derive crossings against whatever shape we are now holding, and cut
    // the head off one at a time. Walking the remaining tail means never
    // having to track how earlier inserts shifted the vertex indices.
    const pieceIds: string[] = [];
    let tailId = sourceId;
    let guard = 0;
    for (;;) {
      const tail = out.runs.find((r) => r.id === tailId);
      if (!tail) break;
      const rest = racewayCrossings(tail.polyline.points, false, yMM);
      if (rest.length === 0) break;
      const cut = splitRunAtSegmentT(out, tailId, rest[0].segmentIndex, rest[0].t);
      if (!cut) break;
      out = cut.doc;
      pieceIds.push(cut.headId);
      tailId = cut.tailId;
      // A crossing count can only shrink; the bound is paranoia about a
      // pathological polyline, not a known case.
      if (++guard > run.polyline.points.length + 4) break;
    }

    if (pieceIds.length === 0) {
      // Nothing was cut. For an open run that means the crossings were not
      // splittable after all; for a closed one it means we opened the loop
      // for nothing. Either way, put the doc back.
      out = outAtRunStart;
      continue;
    }
    pieceIds.push(tailId);

    // Stamp every piece with the guideline id so the PDF's combined strip
    // page (PR #43) groups them.
    const ids = new Set(pieceIds);
    out = {
      ...out,
      runs: out.runs.map((r) => (ids.has(r.id) ? { ...r, raceway_id: guidelineId } : r)),
    };
    runsSplit++;
    piecesCreated += pieceIds.length;
  }

  if (runsSplit === 0 && skippedClosedWithElectrodes === 0) return none;
  return { doc: out, runsSplit, piecesCreated, skippedClosedWithElectrodes };
}

// openClosedRunAtCrossing rewrites a closed run as an open polyline that
// starts and ends at the given crossing, tracing the same physical loop.
// Unlike breakOpen it places no electrodes — a raceway split is a geometry
// operation, and the spec leaves electrode placement to the operator (or to
// the auto-batch in Tier 2 #72).
//
// Returns null when the loop is too small to open.
function openClosedRunAtCrossing(
  doc: DesignDoc,
  runId: string,
  at: RacewayCrossing,
): DesignDoc | null {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run || !run.polyline.closed) return null;
  const pts = run.polyline.points;
  const n = pts.length;
  if (n < 3) return null;

  // Rotate the loop so it begins at the crossing. When the crossing is mid
  // segment the cut point becomes a new vertex at both ends; when it is
  // already a vertex we rotate to it and duplicate it, exactly as breakOpen
  // does.
  const k = at.segmentIndex;
  let rotated: [number, number][];
  if (at.t <= RACEWAY_ON_LINE_TOL_MM) {
    rotated = [...pts.slice(k), ...pts.slice(0, k), pts[k]];
  } else {
    const p1 = pts[k];
    const p2 = pts[(k + 1) % n];
    const cut: [number, number] = [
      p1[0] + at.t * (p2[0] - p1[0]),
      p1[1] + at.t * (p2[1] - p1[1]),
    ];
    // The cut sits between vertex k and k+1, so the opened walk runs
    // cut -> k+1 -> … -> k -> cut.
    const after = pts.slice(k + 1);
    const before = pts.slice(0, k + 1);
    rotated = [cut, ...after, ...before, cut];
  }

  return mapRun(doc, runId, (r) => {
    const next: DesignRun = {
      ...r,
      polyline: { ...r.polyline, points: rotated, closed: false },
    };
    // Direction is meaningless on an open run (runArcs walks the whole
    // polyline); a stale value would misdirect the live-arc walk later.
    delete next.direction;
    return next;
  });
}

// ---------------------------------------------------------------------------
// Tier 3 #78 — arc / line segment conversion
// ---------------------------------------------------------------------------

// setSegmentType marks one segment of a run as a straight line or a circular
// arc. The vertex list never changes — an arc alters what is drawn BETWEEN two
// vertices, so every electrode, bend, blockout and annotation index survives
// untouched. That is the whole reason the field is per-segment rather than
// per-vertex.
//
// The `segment_types` array is allocated lazily, filled with 'line', the first
// time a segment is curved; setting the last arc back to a line drops the
// array again so the doc round-trips byte-identically to a pre-#78 one. The Go
// decoder validates the array's length at unmarshal, so a wrong-length array
// is a failed save rather than a silent disagreement — which makes keeping it
// exactly `segmentCount` long a correctness requirement, not tidiness.
export function setSegmentType(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
  type: SegmentKind,
): DesignDoc {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return doc;
  const count = segmentCount(run);
  if (segmentIndex < 0 || segmentIndex >= count) return doc;
  if (segmentTypeAt(run, segmentIndex) === type) return doc;

  // An arc needs two distinct endpoints to define a circle. Refusing here
  // keeps a degenerate segment from being marked curved and then silently
  // drawn straight by every consumer. Both sides are equally undefined on a
  // zero-length chord, so the guard asks isArcKind rather than naming 'arc'.
  if (isArcKind(type)) {
    const pts = run.polyline.points;
    const a = pts[segmentIndex];
    const b = pts[(segmentIndex + 1) % pts.length];
    if (a[0] === b[0] && a[1] === b[1]) return doc;
  }

  const next: SegmentKind[] = [];
  for (let i = 0; i < count; i++) {
    next.push(i === segmentIndex ? type : segmentTypeAt(run, i));
  }

  return mapRun(doc, runId, (r) => {
    const polyline = { ...r.polyline };
    if (next.some((t) => isArcKind(t))) {
      polyline.segment_types = next;
    } else {
      delete polyline.segment_types;
    }
    return { ...r, polyline };
  });
}

export function convertSegmentToArc(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
): DesignDoc {
  return setSegmentType(doc, runId, segmentIndex, 'arc');
}

export function convertSegmentToLine(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
): DesignDoc {
  return setSegmentType(doc, runId, segmentIndex, 'line');
}

// flipSegmentArc — Tier 3 #87. Move an arc's bow to the other side of its
// chord. The endpoints, the radius and the arc LENGTH are all unchanged; only
// which side the glass falls on moves, so no takeoff, estimate or validation
// number shifts under a flip.
//
// A no-op on a straight segment: there is no side to flip, and inventing one
// would turn "flip" into a second, differently-named "convert to arc".
export function flipSegmentArc(
  doc: DesignDoc,
  runId: string,
  segmentIndex: number,
): DesignDoc {
  const run = doc.runs.find((r) => r.id === runId);
  if (!run) return doc;
  const current = segmentTypeAt(run, segmentIndex);
  if (!isArcKind(current)) return doc;
  return setSegmentType(doc, runId, segmentIndex, flipArcKind(current));
}
