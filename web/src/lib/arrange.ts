// Tier 2 #90 — arrangement primitives over a multi-run selection:
// align, distribute, mirror, depth order.
//
// Every function here is a pure `DesignDoc -> DesignDoc` transform. When an
// op has nothing to do it returns the SAME doc object, not a structural
// clone — EditorPage's `applyOp` and the undo-coalescing window both lean on
// reference identity to decide whether an edit happened.
//
// Two invariants worth stating up front, because both have bitten this
// codebase before:
//
//   1. Bounding boxes are ARC-AWARE. A run with an arc segment bows outside
//      the hull of its own vertices, so a box built from `polyline.points` is
//      too small and every align/distribute built on it is quietly wrong.
//      `flatRunPoints` is the only honest source.
//
//   2. Mirroring is NOT a coordinate negation. See `mirrorRun` below.

import type { Annotation, Bend, Blockout, DesignDoc, DesignRun, SegmentKind } from '../api';
import { flatRunPoints, runHasArcs } from './arcGeom';
import { runArcs } from './runArcs';

export type BBoxMM = { minX: number; minY: number; maxX: number; maxY: number };

export type AlignEdge = 'left' | 'hcenter' | 'right' | 'top' | 'vcenter' | 'bottom';
export type Axis = 'h' | 'v';
export type DepthMove = 'front' | 'forward' | 'backward' | 'back';

export const ALIGN_EDGES: AlignEdge[] = [
  'left',
  'hcenter',
  'right',
  'top',
  'vcenter',
  'bottom',
];

// Minimum selection size each family needs to mean anything. Aligning one run
// to itself is a no-op; distributing two runs is a no-op (both are extremes).
export const MIN_RUNS_ALIGN = 2;
export const MIN_RUNS_DISTRIBUTE = 3;
export const MIN_RUNS_MIRROR = 1;
export const MIN_RUNS_REORDER = 1;

// ---------------------------------------------------------------------------
// Bounding boxes
// ---------------------------------------------------------------------------

// runBBoxMM is the run's true extent in millimetres, flattening arc segments
// first. Returns null for a run with no points.
export function runBBoxMM(run: DesignRun): BBoxMM | null {
  const pts = flatRunPoints(run);
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { minX, minY, maxX, maxY };
}

// selectionBBoxMM is the union of the per-run boxes for the named runs.
// Unknown ids are skipped; an empty union answers null.
export function selectionBBoxMM(doc: DesignDoc, runIds: readonly string[]): BBoxMM | null {
  const ids = new Set(runIds);
  let out: BBoxMM | null = null;
  for (const run of doc.runs) {
    if (!ids.has(run.id)) continue;
    const b = runBBoxMM(run);
    if (!b) continue;
    out = out
      ? {
          minX: Math.min(out.minX, b.minX),
          minY: Math.min(out.minY, b.minY),
          maxX: Math.max(out.maxX, b.maxX),
          maxY: Math.max(out.maxY, b.maxY),
        }
      : b;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Selection filtering
// ---------------------------------------------------------------------------

function lockedGroupIds(doc: DesignDoc): Set<string> {
  const out = new Set<string>();
  for (const g of doc.groups ?? []) {
    if (g.locked) out.add(g.id);
  }
  return out;
}

// arrangeableRunIds narrows a raw selection to the runs an arrange op may
// actually move: existing runs, de-duplicated, in DOC order (so results don't
// depend on the order the operator happened to shift-click), minus any run
// whose group carries the Layers-panel `locked` flag.
//
// Hidden runs stay IN — hidden is a display filter, not a delete, and the
// canvas has always let hidden runs take part in doc-level edits.
export function arrangeableRunIds(doc: DesignDoc, runIds: readonly string[]): string[] {
  const wanted = new Set(runIds);
  if (wanted.size === 0) return [];
  const locked = lockedGroupIds(doc);
  const out: string[] = [];
  for (const run of doc.runs) {
    if (!wanted.has(run.id)) continue;
    if (run.group_id && locked.has(run.group_id)) continue;
    out.push(run.id);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plumbing: rewrite a subset of runs, preserving doc identity on a no-op
// ---------------------------------------------------------------------------

function mapRuns(
  doc: DesignDoc,
  ids: Set<string>,
  fn: (run: DesignRun) => DesignRun,
): DesignDoc {
  let changed = false;
  const runs = doc.runs.map((run) => {
    if (!ids.has(run.id)) return run;
    const next = fn(run);
    if (next !== run) changed = true;
    return next;
  });
  return changed ? { ...doc, runs } : doc;
}

function translateRun(run: DesignRun, dx: number, dy: number): DesignRun {
  if (dx === 0 && dy === 0) return run;
  const points = run.polyline.points.map(
    ([x, y]): [number, number] => [x + dx, y + dy],
  );
  return { ...run, polyline: { ...run.polyline, points } };
}

// ---------------------------------------------------------------------------
// Align
// ---------------------------------------------------------------------------

function alignDelta(edge: AlignEdge, run: BBoxMM, sel: BBoxMM): [number, number] {
  switch (edge) {
    case 'left':
      return [sel.minX - run.minX, 0];
    case 'hcenter':
      return [(sel.minX + sel.maxX) / 2 - (run.minX + run.maxX) / 2, 0];
    case 'right':
      return [sel.maxX - run.maxX, 0];
    case 'top':
      return [0, sel.minY - run.minY];
    case 'vcenter':
      return [0, (sel.minY + sel.maxY) / 2 - (run.minY + run.maxY) / 2];
    case 'bottom':
      return [0, sel.maxY - run.maxY];
  }
}

// alignRuns translates each selected run so the named edge of its own
// arc-aware bbox meets that edge of the selection bbox. Fewer than two
// arrangeable runs is a no-op.
//
// The selection bbox is computed over the ARRANGEABLE runs only, so a locked
// neighbour can't drag the target edge somewhere nothing will ever reach.
export function alignRuns(
  doc: DesignDoc,
  runIds: readonly string[],
  edge: AlignEdge,
): DesignDoc {
  const ids = arrangeableRunIds(doc, runIds);
  if (ids.length < MIN_RUNS_ALIGN) return doc;
  const sel = selectionBBoxMM(doc, ids);
  if (!sel) return doc;
  return mapRuns(doc, new Set(ids), (run) => {
    const b = runBBoxMM(run);
    if (!b) return run;
    const [dx, dy] = alignDelta(edge, b, sel);
    return translateRun(run, dx, dy);
  });
}

// ---------------------------------------------------------------------------
// Distribute
// ---------------------------------------------------------------------------

// distributeRuns spaces the selection evenly along one axis by bbox CENTRE.
// The two extremes are pinned (that is what makes the op idempotent and what
// every other drawing program does); the interior centres are placed at even
// fractions between them. Fewer than three arrangeable runs is a no-op.
//
// Centre-based rather than gap-based on purpose: neon runs vary wildly in
// width, and gap-based distribution of a "W" next to an "I" reads as wrong to
// a layout artist even though the arithmetic is defensible.
export function distributeRuns(
  doc: DesignDoc,
  runIds: readonly string[],
  axis: Axis,
): DesignDoc {
  const ids = arrangeableRunIds(doc, runIds);
  if (ids.length < MIN_RUNS_DISTRIBUTE) return doc;

  const idSet = new Set(ids);
  const entries: { id: string; centre: number }[] = [];
  for (const run of doc.runs) {
    if (!idSet.has(run.id)) continue;
    const b = runBBoxMM(run);
    if (!b) continue;
    entries.push({
      id: run.id,
      centre: axis === 'h' ? (b.minX + b.maxX) / 2 : (b.minY + b.maxY) / 2,
    });
  }
  if (entries.length < MIN_RUNS_DISTRIBUTE) return doc;
  entries.sort((a, b) => a.centre - b.centre);

  const first = entries[0].centre;
  const last = entries[entries.length - 1].centre;
  const span = last - first;
  const step = span / (entries.length - 1);

  const deltas = new Map<string, number>();
  for (let i = 1; i < entries.length - 1; i++) {
    const target = first + step * i;
    const d = target - entries[i].centre;
    if (d !== 0) deltas.set(entries[i].id, d);
  }
  if (deltas.size === 0) return doc;

  return mapRuns(doc, new Set(deltas.keys()), (run) => {
    const d = deltas.get(run.id) ?? 0;
    return axis === 'h' ? translateRun(run, d, 0) : translateRun(run, 0, d);
  });
}

// ---------------------------------------------------------------------------
// Mirror — the interesting one
// ---------------------------------------------------------------------------

// mirrorRuns flips the selection about its own bbox centre.
//
// THE TRAP: `arcFor(p0, p1)` in arcGeom.ts bows its arc toward the chord
// normal `(-dy, dx)` — the left-hand side of the chord direction. That side is
// handedness-dependent, and a mirror reverses handedness. So negating x on a
// run that has an arc segment leaves the vertices in the right places while
// every arc between them bows the WRONG WAY: the canvas curve, the printed
// pattern and the DXF bulge all silently invert, and any test that only
// compares `polyline.points` sails straight past it.
//
// The fix is to reverse the run's point order as well. Mirroring the chord
// p0->p1 about x gives direction (-dx, dy); reversing it gives (dx, -dy),
// whose left-hand normal is (dy, dx) — exactly the mirror image of the
// original bulge direction (-dy, dx). Handedness cancels, and the flattened
// curve of the mirrored run is the true mirror of the original's.
//
// Reversal is not free: it renumbers every vertex, so `segment_types` (index i
// is the segment LEAVING vertex i), `electrodes[].point_index`, and the
// live-arc indices behind `blockouts` / `annotations` / `bends` all have to be
// carried across. `reverseRun` in docOps.ts is the nearest prior art but it
// only remaps electrodes — it predates arc segments and leaves `segment_types`
// untouched, which is a latent bug there and the reason this file does the
// remapping itself rather than delegating.
//
// DO NOT ALSO FLIP THE STORED SIDE — Tier 3 #87. `segment_types` can now say
// which side an arc bows to ('arc' vs 'arc_r'), and `reversedRun` in docOps.ts
// flips that value as it reverses, because there a reversal is the ONLY
// handedness flip in play. Here there are two: the reflection flips it once
// and the reversal flips it back. The stored side is therefore already correct
// after the remap, for BOTH values — 'arc_r' reflected reads as left-of-travel,
// and reversing that reads as right-of-travel again. Flipping it here as well
// would be a double flip that silently inverts every mirrored curve while
// leaving the vertices, and any test that compares them, perfectly happy. The
// arbiter is the invariant test in arrange.test.ts: flatRunPoints(mirrored)
// must equal the mirrored flatRunPoints(original), reversed.
//
// Runs with no arc segments are mirrored by coordinate flip alone: there is no
// handedness to preserve, and reversing them for nothing would gratuitously
// swap which end of the tube the operator thinks of as the start.
export function mirrorRuns(
  doc: DesignDoc,
  runIds: readonly string[],
  axis: Axis,
): DesignDoc {
  const ids = arrangeableRunIds(doc, runIds);
  if (ids.length < MIN_RUNS_MIRROR) return doc;
  const sel = selectionBBoxMM(doc, ids);
  if (!sel) return doc;
  const cx = (sel.minX + sel.maxX) / 2;
  const cy = (sel.minY + sel.maxY) / 2;
  return mapRuns(doc, new Set(ids), (run) => mirrorRun(run, axis, cx, cy));
}

// mirrorRun flips one run about the given centre. Exported for tests and for
// callers that already know the axis of symmetry they want.
export function mirrorRun(
  run: DesignRun,
  axis: Axis,
  cx: number,
  cy: number,
): DesignRun {
  const pts = run.polyline.points;
  if (pts.length === 0) return run;
  const flipped = pts.map(([x, y]): [number, number] =>
    axis === 'h' ? [2 * cx - x, y] : [x, 2 * cy - y],
  );
  if (!runHasArcs(run)) {
    return { ...run, polyline: { ...run.polyline, points: flipped } };
  }
  return reverseMirrored(run, flipped);
}

// reverseMirrored takes a run and its already-coordinate-flipped points and
// produces the reversed-order run, carrying every index-referencing child
// across. Split out from mirrorRun so the index bookkeeping reads on its own.
function reverseMirrored(run: DesignRun, flipped: [number, number][]): DesignRun {
  const n = flipped.length;
  const closed = !!run.polyline.closed;
  const points = flipped.slice().reverse();

  // Vertex k becomes vertex n-1-k.
  const flipIdx = (i: number) => n - 1 - i;

  // segment_types: new segment j joins new vertices j and j+1, i.e. old
  // vertices (n-1-j) and (n-2-j) — so it IS old segment (n-2-j), walked
  // backwards. The value carries UNCHANGED, side and all: see the double-flip
  // note on mirrorRuns. Open runs never wrap (j <= n-2 keeps n-2-j >= 0);
  // closed runs wrap the final entry back onto old segment n-1, which is the
  // "reversed and shifted" shape the naive `.reverse()` gets wrong.
  const st = run.polyline.segment_types;
  let segment_types: SegmentKind[] | undefined;
  if (st) {
    segment_types = st.map((_, j) => {
      const oldSeg = (((n - 2 - j) % n) + n) % n;
      return st[oldSeg] ?? 'line';
    });
  }

  const polyline = { ...run.polyline, points, closed };
  if (segment_types) polyline.segment_types = segment_types;

  const next: DesignRun = { ...run, polyline };

  if (run.electrodes) {
    next.electrodes = run.electrodes.map((e) => ({
      ...e,
      point_index: flipIdx(e.point_index),
    }));
  }

  // Direction names which half of a closed two-electrode loop is the live
  // arc, in terms of increasing vs decreasing vertex index. Reversal inverts
  // what "increasing" traverses, so an EXPLICIT direction has to flip to keep
  // the same physical glass live. An absent direction is fine left absent:
  // `defaultDirection` picks the longer half by measured length, and the
  // lengths are mirror-invariant, so it re-derives the same physical arc.
  if (run.direction) {
    next.direction = run.direction === 'forward' ? 'backward' : 'forward';
  }

  // Live indices are positions along the live arc, not polyline indices, so
  // they can only be remapped against the live walk of the FINISHED run —
  // which is why this runs after electrodes and direction are settled.
  const oldLive = runArcs(run).live;
  const newLive = runArcs(next).live;
  const newPos = new Map<number, number>();
  for (let i = 0; i < newLive.length; i++) {
    if (!newPos.has(newLive[i])) newPos.set(newLive[i], i);
  }
  const lastLive = Math.max(0, newLive.length - 1);
  const remapLive = (li: number): number => {
    if (!Number.isFinite(li)) return li;
    const oldIdx = oldLive[li];
    if (oldIdx === undefined) return Math.min(Math.max(li, 0), lastLive);
    const pos = newPos.get(flipIdx(oldIdx));
    // Unreachable for a well-formed run: the reversed live walk visits the
    // mirror of every vertex the original one did. Clamping rather than
    // dropping keeps a hand-edited or half-valid doc from losing marks.
    if (pos === undefined) return Math.min(Math.max(li, 0), lastLive);
    return pos;
  };

  // Does the reversed run walk its live arc in the opposite physical
  // direction? For an open run (live = every vertex) it does. For a closed
  // two-electrode loop it does NOT: flipping `direction` above already put the
  // walk back the way it was, so the live positions come out unchanged. A
  // blockout is a SPAN, so only the first case may swap its endpoints —
  // swapping unconditionally would turn a seam-wrapping span into its
  // complement on closed loops.
  const walkReversed = newLive.length > 1 && remapLive(0) > remapLive(1);

  if (run.blockouts) {
    next.blockouts = run.blockouts.map((b): Blockout => {
      const s = remapLive(b.start_live_index);
      const e = remapLive(b.end_live_index);
      return walkReversed
        ? { ...b, start_live_index: e, end_live_index: s }
        : { ...b, start_live_index: s, end_live_index: e };
    });
  }
  if (run.annotations) {
    next.annotations = run.annotations.map(
      (a): Annotation => ({ ...a, live_index: remapLive(a.live_index) }),
    );
  }
  if (run.bends) {
    next.bends = run.bends
      .map((b): Bend => ({ ...b, live_index: remapLive(b.live_index) }))
      .sort((a, b) => a.live_index - b.live_index);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Depth order
// ---------------------------------------------------------------------------

// reorderRuns permutes `doc.runs`, which IS the draw order — EditorCanvas
// maps the array in order, so later entries paint on top. "Front" therefore
// means the END of the array, not the start.
//
// Both the moved runs and the runs left behind keep their relative order.
// `forward` / `backward` step one position and refuse to jump a sibling that
// is also selected, so a multi-run nudge travels as a block.
export function reorderRuns(
  doc: DesignDoc,
  runIds: readonly string[],
  move: DepthMove,
): DesignDoc {
  const list = arrangeableRunIds(doc, runIds);
  if (list.length < MIN_RUNS_REORDER) return doc;
  const ids = new Set(list);
  const runs = doc.runs;

  let next: DesignRun[];
  if (move === 'front') {
    next = [...runs.filter((r) => !ids.has(r.id)), ...runs.filter((r) => ids.has(r.id))];
  } else if (move === 'back') {
    next = [...runs.filter((r) => ids.has(r.id)), ...runs.filter((r) => !ids.has(r.id))];
  } else if (move === 'forward') {
    next = runs.slice();
    // Walk from the top so a block of selected runs shuffles up intact.
    for (let i = next.length - 2; i >= 0; i--) {
      if (ids.has(next[i].id) && !ids.has(next[i + 1].id)) {
        [next[i], next[i + 1]] = [next[i + 1], next[i]];
      }
    }
  } else {
    next = runs.slice();
    for (let i = 1; i < next.length; i++) {
      if (ids.has(next[i].id) && !ids.has(next[i - 1].id)) {
        [next[i], next[i - 1]] = [next[i - 1], next[i]];
      }
    }
  }

  if (next.every((r, i) => r === runs[i])) return doc;
  return { ...doc, runs: next };
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------

// disabledReason answers why an arrange family is unavailable for the current
// selection, or null when it is available. The panel shows this as the button
// tooltip so "nothing happened" is never the whole story.
export function disabledReason(
  doc: DesignDoc | null,
  runIds: readonly string[],
  family: 'align' | 'distribute' | 'mirror' | 'reorder',
): string | null {
  if (!doc) return 'No design loaded.';
  const raw = runIds.length;
  const usable = arrangeableRunIds(doc, runIds).length;
  if (usable < raw) {
    const skipped = raw - usable;
    if (usable === 0) {
      return `All ${raw} selected run${raw === 1 ? '' : 's'} are in a locked layer.`;
    }
    const need =
      family === 'distribute'
        ? MIN_RUNS_DISTRIBUTE
        : family === 'align'
          ? MIN_RUNS_ALIGN
          : MIN_RUNS_MIRROR;
    if (usable < need) {
      return `${skipped} selected run${skipped === 1 ? ' is' : 's are'} in a locked layer, leaving ${usable}. Needs ${need}.`;
    }
    return null;
  }
  switch (family) {
    case 'align':
      return usable < MIN_RUNS_ALIGN ? 'Select at least 2 runs to align.' : null;
    case 'distribute':
      return usable < MIN_RUNS_DISTRIBUTE
        ? 'Select at least 3 runs to distribute.'
        : null;
    case 'mirror':
      return usable < MIN_RUNS_MIRROR ? 'Select a run to mirror.' : null;
    case 'reorder':
      return usable < MIN_RUNS_REORDER ? 'Select a run to reorder.' : null;
  }
}
