// Tier 3 #103 — step and repeat: array duplication over the selection.
//
// Borders, repeated letters and multi-unit signs are built by duplicating a
// run at a fixed pitch. This module turns that from copy-paste-nudge into one
// op: a countX x countY grid whose cell (0, 0) IS the original selection.
//
// Distinct from PR #145's print-time `copies`, which repeats PAGES. This
// repeats geometry inside the design, so the copies validate, print, unfold
// and cost like any other run.
//
// Three things here are load-bearing and have burned this codebase before:
//
//   1. The pitch is measured off the ARC-AWARE selection bbox from
//      `arrange.ts`. A bbox built from `polyline.points` is too small for any
//      run with an arc segment, and in 'gap' mode that error goes straight
//      into the step, mis-spacing every copy of a curved run.
//
//   2. `raceway_id` is NOT carried to the copies (CLAUDE.md carry-and-remap
//      table). A copy 500 mm to the right is not screwed to the same
//      back-channel, and the print path emits ONE combined unfolded strip per
//      raceway_id — so carrying it would put geometry on a fabrication
//      drawing for hardware it is not mounted to. Everything else on that
//      table is carried; see `copyRun`.
//
//   3. Every copy is a pure TRANSLATION. Points are not renumbered and not
//      reordered, so `segment_types`, `electrodes[].point_index` and the
//      live-arc indices behind `blockouts` / `annotations` / `bends` are all
//      still correct as-is — and arc handedness is safe, because `arcFor`
//      bows toward the chord normal and translation does not change a chord's
//      direction. The invariant a test can pin: `flatRunPoints(copy)` equals
//      `flatRunPoints(source)` translated, element for element.
//
// Like `arrange.ts`, every op is a pure `DesignDoc -> DesignDoc` and returns
// the SAME doc object when there is nothing to do — EditorPage's `applyOp`
// and the undo-coalescing window both key off reference identity.

import type { Annotation, Bend, Blockout, DesignDoc, DesignRun, Group } from '../api';
import { arrangeableRunIds, selectionBBoxMM, type BBoxMM } from './arrange';
import { nextGroupId, nextRunId } from './docOps';

// 'gap' measures edge-to-edge from the selection bbox; 'centre' measures
// centre-to-centre. Operators think in both — "50 mm between the letters" and
// "letters on 300 mm centres" are both everyday instructions — and guessing
// wrong silently halves or doubles the spacing, so the mode is explicit and
// always visible in the panel rather than inferred.
export type PitchMode = 'gap' | 'centre';

export type StepRepeatOptions = {
  countX: number;
  countY: number;
  pitchXMM: number;
  pitchYMM: number;
  pitchMode: PitchMode;
};

// Runaway guard. 400 is roughly "a full sheet of small parts" and well past
// any real sign; beyond it the array is almost certainly a typo in a count
// field, and the cost of finding out is a doc with thousands of runs, an
// unusable canvas and an undo the operator has to trust.
export const MAX_ARRAY_RUNS = 400;

export const DEFAULT_STEP_REPEAT: StepRepeatOptions = {
  countX: 2,
  countY: 1,
  pitchXMM: 25,
  pitchYMM: 25,
  pitchMode: 'gap',
};

export type StepRepeatPlan = {
  // The source runs, filtered and de-duplicated the same way arrange.ts does
  // (doc order, minus anything in a locked layer).
  runIds: string[];
  countX: number;
  countY: number;
  // Grid cells including the original, copies excluding it, and the number of
  // runs the op would actually add.
  cells: number;
  copies: number;
  newRuns: number;
  // Centre-to-centre translation per column / row, whichever mode was asked
  // for. This is what the op applies; the panel shows it so 'gap' mode is
  // never a black box.
  stepXMM: number;
  stepYMM: number;
  source: BBoxMM | null;
  extent: BBoxMM | null;
  widthMM: number;
  heightMM: number;
  // Why the array cannot run, or null. Non-null disables the button and
  // becomes its tooltip: "nothing happened" is never the whole story.
  error: string | null;
  // Runs, but probably not what was meant.
  warning: string | null;
};

const EMPTY_PLAN = {
  cells: 0,
  copies: 0,
  newRuns: 0,
  stepXMM: 0,
  stepYMM: 0,
  source: null,
  extent: null,
  widthMM: 0,
  heightMM: 0,
  warning: null,
} as const;

function normalizeCount(n: number): number | null {
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
}

// stepFor turns a pitch into the centre-to-centre translation per step.
// 'gap' adds the selection's own extent along that axis, which is why the
// bbox has to be the arc-aware one.
function stepFor(mode: PitchMode, pitch: number, span: number): number {
  return mode === 'centre' ? pitch : span + pitch;
}

// stepRepeatPlan answers everything the UI needs to preview an array and
// everything `stepRepeat` needs to build one, without touching the doc. Pure,
// cheap, and safe to call on every keystroke.
export function stepRepeatPlan(
  doc: DesignDoc | null,
  runIds: readonly string[],
  opts: StepRepeatOptions,
): StepRepeatPlan {
  const base = { ...EMPTY_PLAN, runIds: [] as string[], countX: 0, countY: 0 };
  if (!doc) return { ...base, error: 'No design loaded.' };

  const ids = arrangeableRunIds(doc, runIds);
  const raw = new Set(runIds).size;
  if (raw === 0) return { ...base, error: 'Select at least one run to array.' };
  if (ids.length === 0) {
    return {
      ...base,
      error: `All ${raw} selected run${raw === 1 ? ' is' : 's are'} in a locked layer.`,
    };
  }

  const countX = normalizeCount(opts.countX);
  const countY = normalizeCount(opts.countY);
  if (countX === null || countY === null) {
    return {
      ...base,
      runIds: ids,
      error: 'Counts must be whole numbers of 1 or more.',
    };
  }
  if (!Number.isFinite(opts.pitchXMM) || !Number.isFinite(opts.pitchYMM)) {
    return {
      ...base,
      runIds: ids,
      countX,
      countY,
      error: 'Pitch must be a number of millimetres.',
    };
  }

  const source = selectionBBoxMM(doc, ids);
  if (!source) {
    return {
      ...base,
      runIds: ids,
      countX,
      countY,
      error: 'The selected runs have no geometry to array.',
    };
  }

  const srcW = source.maxX - source.minX;
  const srcH = source.maxY - source.minY;
  const stepXMM = stepFor(opts.pitchMode, opts.pitchXMM, srcW);
  const stepYMM = stepFor(opts.pitchMode, opts.pitchYMM, srcH);

  const spanX = (countX - 1) * stepXMM;
  const spanY = (countY - 1) * stepYMM;
  const extent: BBoxMM = {
    minX: source.minX + Math.min(0, spanX),
    maxX: source.maxX + Math.max(0, spanX),
    minY: source.minY + Math.min(0, spanY),
    maxY: source.maxY + Math.max(0, spanY),
  };

  const cells = countX * countY;
  const copies = cells - 1;
  const newRuns = copies * ids.length;

  // Overlap is legal (a deliberate -5 mm gap tucks copies under each other)
  // but it is far more often a mode mix-up: 300 entered as a centre pitch
  // reads as "300 mm apart", the same 300 entered as a gap on a 250 mm-wide
  // selection puts them 550 apart. Say so rather than silently obeying.
  const tight: string[] = [];
  if (countX > 1 && Math.abs(stepXMM) + 1e-9 < srcW) tight.push('horizontally');
  if (countY > 1 && Math.abs(stepYMM) + 1e-9 < srcH) tight.push('vertically');

  const plan: StepRepeatPlan = {
    runIds: ids,
    countX,
    countY,
    cells,
    copies,
    newRuns,
    stepXMM,
    stepYMM,
    source,
    extent,
    widthMM: extent.maxX - extent.minX,
    heightMM: extent.maxY - extent.minY,
    error: null,
    warning:
      tight.length > 0
        ? `Copies overlap ${tight.join(' and ')} — the step is smaller than the selection.`
        : null,
  };

  if (copies === 0) {
    return { ...plan, error: 'Set a count above 1 across or down to make copies.' };
  }
  if (newRuns > MAX_ARRAY_RUNS) {
    return {
      ...plan,
      error: `That array would add ${newRuns} runs; the limit is ${MAX_ARRAY_RUNS}. Reduce the counts or the selection.`,
    };
  }
  return plan;
}

// copyRun translates one run into a new instance.
//
// The carry-and-remap walk from CLAUDE.md, field by field:
//
//   polyline.points        translated; count and order unchanged
//   polyline.segment_types copied verbatim — segment i still leaves vertex i,
//                          and translation does not flip arc handedness
//   electrodes[]           copied; point_index still addresses the same vertex
//   blockouts/annotations/bends  copied; live indices are positions along the
//                          run's OWN live arc, which translation preserves
//   direction              copied; no reversal happened
//   is_channel_letter_face, channel_letter_depth_mm, kind   carried
//   group_id               replaced with this cell's fresh group (see below)
//   raceway_id             DROPPED — see the header note
//   id                     freshly allocated by the caller, never reused
//
// Children are cloned rather than shared: nothing here mutates in place
// today, but an aliased blockout object between an original and its copy is
// exactly the kind of thing a later in-place edit turns into a bug report.
function copyRun(
  src: DesignRun,
  id: string,
  dx: number,
  dy: number,
  groupId: string | undefined,
): DesignRun {
  const polyline: DesignRun['polyline'] = {
    ...src.polyline,
    points: src.polyline.points.map(([x, y]): [number, number] => [x + dx, y + dy]),
  };
  if (src.polyline.segment_types) {
    polyline.segment_types = src.polyline.segment_types.slice();
  }

  const out: DesignRun = { ...src, id, polyline };

  // Deleted, not blanked: the Go decoder runs omitempty, and a "" here would
  // still round-trip, but dropping the key keeps copied docs byte-comparable
  // with hand-written ones (same reason dissolveGroup deletes group_id).
  delete out.raceway_id;

  if (groupId) out.group_id = groupId;
  else delete out.group_id;

  if (src.electrodes) out.electrodes = src.electrodes.map((e) => ({ ...e }));
  if (src.blockouts) out.blockouts = src.blockouts.map((b): Blockout => ({ ...b }));
  if (src.annotations) {
    out.annotations = src.annotations.map((a): Annotation => ({ ...a }));
  }
  if (src.bends) out.bends = src.bends.map((b): Bend => ({ ...b }));

  return out;
}

// stepRepeat arrays the selection into a countX x countY grid. Cell (0, 0) is
// the original — it is not moved and not duplicated — so a 3 x 1 array adds
// two runs per selected run and the operator's existing geometry keeps its
// ids, its raceway and its group.
//
// Copies are appended to `doc.runs`, which IS the draw order, so an array
// paints over whatever was underneath it. Cell order is row-major (across,
// then down), and within a cell the selection is copied in doc order — that
// ordering is what makes the allocated ids reproducible.
//
// GROUP POLICY: each cell gets its OWN new group per source group, named
// "<source name> copy N". Carrying the source `group_id` would mean selecting
// one copy selects the whole array and the Layers panel's hide/lock acts on
// all of it at once, so no single cell could be nudged; dropping the group
// entirely would break up a multi-run unit (the three runs of an "E") that
// the operator grouped precisely so it would travel as one. A group is "these
// runs are one unit", and each cell is a new instance of that unit.
//
// `locked` is deliberately not inherited by those new groups: a locked
// group's runs never get here, because `arrangeableRunIds` filters them out
// of the selection first. `visible: false` IS inherited — a copy of something
// hidden is hidden, and the panel reports the count so the operator is not
// left wondering whether the click did anything.
export function stepRepeat(
  doc: DesignDoc,
  runIds: readonly string[],
  opts: StepRepeatOptions,
): DesignDoc {
  const plan = stepRepeatPlan(doc, runIds, opts);
  if (plan.error !== null || plan.copies === 0) return doc;

  const idSet = new Set(plan.runIds);
  const sources = doc.runs.filter((r) => idSet.has(r.id));
  if (sources.length === 0) return doc;

  const runs = doc.runs.slice();
  const groups: Group[] = [...(doc.groups ?? [])];
  const byId = new Map(groups.map((g) => [g.id, g]));

  let copyNo = 0;
  for (let iy = 0; iy < plan.countY; iy++) {
    for (let ix = 0; ix < plan.countX; ix++) {
      if (ix === 0 && iy === 0) continue;
      copyNo++;
      const dx = ix * plan.stepXMM;
      const dy = iy * plan.stepYMM;
      // One new group per SOURCE group per cell, so a selection spanning two
      // groups arrays into two groups per cell rather than merging them.
      const cellGroups = new Map<string, string>();
      for (const src of sources) {
        let groupId: string | undefined;
        if (src.group_id) {
          groupId = cellGroups.get(src.group_id);
          if (!groupId) {
            groupId = nextGroupId({ ...doc, groups });
            const base = byId.get(src.group_id);
            const g: Group = {
              id: groupId,
              name: `${base?.name ?? src.group_id} copy ${copyNo}`,
            };
            if (base?.visible === false) g.visible = false;
            groups.push(g);
            cellGroups.set(src.group_id, groupId);
          }
        }
        // Allocated one at a time against the growing runs array so two
        // copies can never claim the same slot. `nextRunId` hands back the
        // LOWEST unused id, so a doc with gaps fills them before extending:
        // the ids of a large array are not in cell order until Tier 3 #89's
        // high-water-mark allocator lands. Uniqueness holds either way.
        runs.push(copyRun(src, nextRunId({ ...doc, runs }), dx, dy, groupId));
      }
    }
  }

  const next: DesignDoc = { ...doc, runs };
  // Only touch `groups` when there is something to say, so a doc that never
  // had the key does not grow an empty array on its next save.
  if (groups.length > (doc.groups?.length ?? 0)) next.groups = groups;
  return next;
}

// disabledReason is the step-and-repeat sibling of `arrange.disabledReason`:
// null when the array can run, otherwise the sentence the panel shows as the
// button's tooltip.
export function disabledReason(
  doc: DesignDoc | null,
  runIds: readonly string[],
  opts: StepRepeatOptions,
): string | null {
  return stepRepeatPlan(doc, runIds, opts).error;
}
