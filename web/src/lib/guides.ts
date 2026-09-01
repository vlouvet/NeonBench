// Canvas rulers + construction guides (Tier 2 #91).
//
// Three concerns live here, all pure so they unit-test without mounting a
// canvas:
//
//   1. Ruler tick generation — pick a mm step off a fixed ladder so labels
//      never collide at any zoom, then emit ticks in SCREEN px for the
//      visible span.
//   2. Guide CRUD on a DesignDoc — add / move / classify. Ids come from
//      `docOps.nextGuidelineId` so raceway and construction guides share one
//      id space and `raceway_id` foreign keys stay unambiguous.
//   3. Guide hit-testing in screen px, for click-to-select and drag-to-move.
//
// The one rule that matters more than any of them: a construction guide must
// never reach `splitTubesAtRaceway`. It is a layout aid; the raceway
// guideline is a cut line. `racewayGuidelines` / `constructionGuides` are the
// filters that keep the two apart at every call site.

import type { DesignDoc, Guideline, GuidelineAxis } from '../api';
import { nextGuidelineId } from './docOps';

// ---------------------------------------------------------------------------
// Ruler ticks
// ---------------------------------------------------------------------------

// Gutter thickness in CSS px. Matches the `.canvas-ruler` sizing in App.css;
// exported so EditorCanvas can offset its hit-testing by the same number
// instead of hard-coding 22 in two places.
export const RULER_PX = 22;

// Allowed mm steps, in the 1/2/5 decade ladder every drafting tool uses.
// Bounded at both ends deliberately: below 0.1 mm no neon shop is working,
// and above 50 m the design does not fit on a truck.
export const TICK_LADDER_MM = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000,
  20000, 50000,
] as const;

// Minimum screen distance between two LABELLED ticks. Sized for the ~40px a
// five-digit mm label occupies at 10px type plus breathing room, so labels
// never collide — which is the whole reason the ladder exists.
export const MIN_LABEL_SPACING_PX = 56;

// Minimum screen distance between two unlabelled ticks. Below this the ruler
// turns into a grey bar and stops communicating anything.
export const MIN_MINOR_SPACING_PX = 5;

// Hard cap on emitted ticks. The step choice already bounds the count to
// roughly `lengthPx / MIN_MINOR_SPACING_PX`, so this only fires if a caller
// hands us a degenerate scale; it keeps a NaN from hanging the render loop.
const MAX_TICKS = 4000;

export type TickSteps = { majorMM: number; minorMM: number };

// Pick the labelled step (and a finer unlabelled one) for a given zoom.
//
// `scale` is px-per-mm — EditorCanvas's `transform.k`. The major step is the
// SMALLEST ladder entry whose on-screen spacing clears `minLabelPx`; the
// minor step is the LARGEST ladder entry below it that still clears
// `MIN_MINOR_SPACING_PX`. When no finer entry qualifies, minor collapses onto
// major and the ruler simply shows fewer ticks — never zero, never negative.
export function chooseTickSteps(
  scale: number,
  minLabelPx: number = MIN_LABEL_SPACING_PX,
): TickSteps {
  const last = TICK_LADDER_MM[TICK_LADDER_MM.length - 1];
  if (!Number.isFinite(scale) || scale <= 0) {
    return { majorMM: last, minorMM: last };
  }
  let majorIdx = TICK_LADDER_MM.length - 1;
  for (let i = 0; i < TICK_LADDER_MM.length; i++) {
    if (TICK_LADDER_MM[i] * scale >= minLabelPx) {
      majorIdx = i;
      break;
    }
  }
  const majorMM = TICK_LADDER_MM[majorIdx];
  let minorMM = majorMM;
  for (let i = majorIdx - 1; i >= 0; i--) {
    if (TICK_LADDER_MM[i] * scale >= MIN_MINOR_SPACING_PX) {
      minorMM = TICK_LADDER_MM[i];
      break;
    }
  }
  return { majorMM, minorMM };
}

export type RulerTick = {
  // World position in mm.
  mm: number;
  // Screen position in CSS px, along the ruler's own axis.
  px: number;
  // Major ticks get a full-height line and a label.
  major: boolean;
};

export type RulerTicksResult = TickSteps & { ticks: RulerTick[] };

// Generate the ticks visible in `[startPx, endPx]` for an axis whose screen
// position is `offsetPx + mm * scale`.
//
// `offsetPx` is `transform.tx` (top ruler) or `transform.ty` (left ruler) —
// the SAME numbers the canvas `<g transform>` uses, which is what makes a
// tick at 100 mm land on the geometry at 100 mm at every zoom and pan. Any
// sign error here shows up instantly as ticks sliding the wrong way, which
// is why the browser smoke test matters more than these unit tests.
export function rulerTicks(args: {
  scale: number;
  offsetPx: number;
  startPx: number;
  endPx: number;
  minLabelPx?: number;
}): RulerTicksResult {
  const { scale, offsetPx, startPx, endPx, minLabelPx } = args;
  const steps = chooseTickSteps(scale, minLabelPx);
  if (!Number.isFinite(scale) || scale <= 0 || !(endPx > startPx)) {
    return { ...steps, ticks: [] };
  }
  const mmStart = (startPx - offsetPx) / scale;
  const mmEnd = (endPx - offsetPx) / scale;

  const ticks: RulerTick[] = [];
  const seen = new Set<string>();
  // Majors are pushed first so they win the dedupe: the ladder's 2.5x rungs
  // (0.2 → 0.5) mean a minor multiple can coincide with a major, and the
  // label has to survive that collision.
  const push = (mm: number, major: boolean) => {
    const key = mm.toFixed(6);
    if (seen.has(key)) return;
    seen.add(key);
    ticks.push({ mm, px: offsetPx + mm * scale, major });
  };
  const emit = (step: number, major: boolean) => {
    const first = Math.ceil(mmStart / step - 1e-9);
    const lastIdx = Math.floor(mmEnd / step + 1e-9);
    for (let i = first; i <= lastIdx; i++) {
      if (ticks.length >= MAX_TICKS) return;
      // Re-round through the step so 0.1-mm multiples do not accumulate
      // binary-float dust into their labels ("29.999999999999996 mm").
      push(Number((i * step).toFixed(6)), major);
    }
  };
  emit(steps.majorMM, true);
  emit(steps.minorMM, false);
  ticks.sort((a, b) => a.px - b.px);
  return { ...steps, ticks };
}

// Format a tick label. Whole millimetres render bare; sub-mm steps keep just
// enough decimals to distinguish adjacent ticks, so a 0.5 mm ladder does not
// print "10.0" next to "10.5000".
export function formatTickLabel(mm: number, stepMM: number): string {
  const decimals = stepMM >= 1 ? 0 : stepMM >= 0.1 ? 1 : 2;
  const s = mm.toFixed(decimals);
  // Normalize "-0" — a tick sitting exactly on the origin from the negative
  // side should read "0", not "-0".
  return s === '-0' || s === '-0.0' || s === '-0.00' ? (0).toFixed(decimals) : s;
}

// ---------------------------------------------------------------------------
// Guide model
// ---------------------------------------------------------------------------

export const GUIDE_KIND_RACEWAY = 'raceway';
export const GUIDE_KIND_CONSTRUCTION = 'construction';

// Which coordinate a guide's position lives on. Mirrors the Go
// `Guideline.IsVertical` / `PositionMM` pair exactly — the two
// implementations have to agree or a save round-trip moves the line.
export function guideAxis(g: Guideline): GuidelineAxis {
  return g.axis === 'v' ? 'v' : 'h';
}

export function isVerticalGuide(g: Guideline): boolean {
  return guideAxis(g) === 'v';
}

export function guidePositionMM(g: Guideline): number {
  return isVerticalGuide(g) ? (g.x_mm ?? 0) : g.y_mm;
}

// The raceway guideline(s) — the ones that actually cut tubes. Every call
// site that feeds `splitTubesAtRaceway` or the PDF strip page must filter
// through this, never over `doc.guidelines` raw.
export function racewayGuidelines(doc: DesignDoc): Guideline[] {
  return (doc.guidelines ?? []).filter((g) => g.kind === GUIDE_KIND_RACEWAY);
}

// The inert layout guides. Snappable, draggable, and invisible to every
// emitted artifact.
export function constructionGuides(doc: DesignDoc): Guideline[] {
  return (doc.guidelines ?? []).filter((g) => g.kind === GUIDE_KIND_CONSTRUCTION);
}

export function isRacewayGuideline(g: Guideline | undefined | null): boolean {
  return !!g && g.kind === GUIDE_KIND_RACEWAY;
}

export function findGuide(doc: DesignDoc, id: string | null | undefined): Guideline | null {
  if (!id) return null;
  return (doc.guidelines ?? []).find((g) => g.id === id) ?? null;
}

// Add a construction guide at `posMM` on `axis`. Horizontal guides write
// `y_mm` and omit `x_mm` entirely; vertical ones write both `x_mm` and
// `axis` and pin `y_mm` to 0. That shape is not cosmetic — it is what keeps
// a doc that has never seen a vertical guide serializing byte-identically
// through the Go `omitempty` tags.
export function addConstructionGuide(
  doc: DesignDoc,
  axis: GuidelineAxis,
  posMM: number,
): DesignDoc {
  if (!Number.isFinite(posMM)) return doc;
  const id = nextGuidelineId(doc);
  const g: Guideline =
    axis === 'v'
      ? { id, kind: GUIDE_KIND_CONSTRUCTION, y_mm: 0, x_mm: posMM, axis: 'v' }
      : { id, kind: GUIDE_KIND_CONSTRUCTION, y_mm: posMM };
  return { ...doc, guidelines: [...(doc.guidelines ?? []), g] };
}

// Move any guide — raceway or construction — along its own axis. The axis is
// read off the guide, never off the caller, so a drag can never turn a
// horizontal raceway into a vertical one (which the Go decoder would reject
// on the next save anyway).
export function moveGuide(doc: DesignDoc, id: string, posMM: number): DesignDoc {
  if (!Number.isFinite(posMM)) return doc;
  const list = doc.guidelines ?? [];
  const idx = list.findIndex((g) => g.id === id);
  if (idx < 0) return doc;
  const cur = list[idx];
  if (guidePositionMM(cur) === posMM) return doc;
  const next = list.slice();
  next[idx] = isVerticalGuide(cur) ? { ...cur, x_mm: posMM } : { ...cur, y_mm: posMM };
  return { ...doc, guidelines: next };
}

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

// How close (in CSS px) the cursor has to be to a guide to grab it. Matches
// the 10px transparent hit-line the raceway guideline already renders.
export const GUIDE_HIT_PX = 6;

export type GuideHit = { id: string; axis: GuidelineAxis; posMM: number; distancePx: number };

// Nearest guide to a world-space point, measured in SCREEN px so the grab
// radius feels identical at 25% and 400% zoom. Vertical guides are compared
// on x, horizontal on y; the closest across both wins, and a tie goes to the
// one that appears later in the list (the most recently added, which is the
// one sitting on top).
export function hitTestGuides(
  guides: ReadonlyArray<Guideline>,
  world: [number, number],
  scale: number,
  tolPx: number = GUIDE_HIT_PX,
): GuideHit | null {
  if (!Number.isFinite(scale) || scale <= 0) return null;
  let best: GuideHit | null = null;
  for (const g of guides) {
    const vertical = isVerticalGuide(g);
    const pos = guidePositionMM(g);
    const d = Math.abs((vertical ? world[0] : world[1]) - pos) * scale;
    if (d > tolPx) continue;
    if (!best || d <= best.distancePx) {
      best = { id: g.id, axis: vertical ? 'v' : 'h', posMM: pos, distancePx: d };
    }
  }
  return best;
}

// Shape `snap.ts` wants: id + axis + position, with the DesignDoc dependency
// already stripped off.
export type SnapGuide = { id: string; axis: GuidelineAxis; posMM: number };

// Every guide on the doc, as snap targets. Raceway guidelines are included
// deliberately — snapping a vertex onto the cut line is exactly what an
// operator laying out a raceway sign wants. Only the SPLIT path discriminates
// by kind; snapping does not care.
export function snapGuidesForDoc(doc: DesignDoc): SnapGuide[] {
  return (doc.guidelines ?? []).map((g) => ({
    id: g.id,
    axis: guideAxis(g),
    posMM: guidePositionMM(g),
  }));
}
