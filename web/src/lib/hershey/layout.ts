// Geometric post-passes over Hershey text: slant (oblique), vertical
// stacking, and text on an arc.
//
// EVERY function here is a PURE transform of `HersheyRun[]` → `HersheyRun[]`.
// None of them re-walks the glyph loop; they consume whatever
// `hersheyTextToRuns` produced. That is the whole architectural point:
// kerning, preset kerning, per-glyph baseline shifts, cursive joining and
// stroke smoothing all happen ONCE, in text.ts, and these passes inherit
// the result for free. Fork the glyph walk and every one of those
// features has to be re-implemented (and will drift).
//
// ── THE COMPOSITION ORDER IS FIXED ────────────────────────────────────
//
//     case  →  layout (stackVertical XOR arcRuns)  →  slant
//
// 1. Case runs first and on the TEXT, not the strokes (see changeCase.ts).
// 2. Layout places the glyphs. Stacking and arcing are mutually exclusive
//    — they are both "where does the baseline go" answers, and the UI
//    disables one while the other is on.
// 3. Slant runs LAST, so the shear applies to already-placed glyphs.
//    That is what "italic" means in every other tool. Slanting before an
//    arc would shear the arc itself into an ellipse, which is a
//    different (and unrequested) effect.
//
// `applyTextTransforms` at the bottom of this file is the single place
// that order is encoded; the dialog calls it for BOTH its live preview
// and the runs it hands to onInsert, so preview and insert cannot drift.
//
// Coordinate convention is text.ts's: millimeters, +Y points DOWN
// (SVG/screen), so a glyph's cap top is one cap-height ABOVE — i.e. at a
// SMALLER y than — its baseline.

import { hersheyRunsBBox, type HersheyRun } from './text';

// ── glyph grouping ────────────────────────────────────────────────────

/** Split a flat run list into one group per glyph, preserving order.
 *
 *  Preferred path: `hersheyTextToRuns` stamps `glyphIndex` / `lineIndex`
 *  on every stroke it emits, so the split is exact — including for
 *  glyphs whose ink overlaps a neighbour's (any tight kern pair: "AV"
 *  ships at −2 JHF units and genuinely overlaps).
 *
 *  Fallback, used only when at least one run is untagged (hand-built
 *  runs, or a cursive stitch that spans two glyphs and therefore has no
 *  single glyph index): merge CONSECUTIVE runs whose x-intervals
 *  overlap. That is right for a multi-stroke glyph like 'E' and for
 *  loosely-set text, and deliberately conservative everywhere else — the
 *  worst case is that two glyphs stack as one unit rather than tearing a
 *  stitched cursive stroke in half. */
export function groupRunsByGlyph(runs: HersheyRun[]): HersheyRun[][] {
  if (runs.length === 0) return [];
  const groups: HersheyRun[][] = [];
  const allTagged = runs.every((r) => typeof r.glyphIndex === 'number');
  if (allTagged) {
    let current: HersheyRun[] = [];
    let key: string | null = null;
    for (const r of runs) {
      const k = `${r.lineIndex ?? 0}:${r.glyphIndex}`;
      if (k !== key) {
        if (current.length > 0) groups.push(current);
        current = [];
        key = k;
      }
      current.push(r);
    }
    if (current.length > 0) groups.push(current);
    return groups;
  }
  let current: HersheyRun[] = [runs[0]];
  let [curMinX, curMaxX] = runXRange(runs[0]);
  for (let i = 1; i < runs.length; i++) {
    const [minX, maxX] = runXRange(runs[i]);
    if (minX <= curMaxX && maxX >= curMinX) {
      current.push(runs[i]);
      curMinX = Math.min(curMinX, minX);
      curMaxX = Math.max(curMaxX, maxX);
    } else {
      groups.push(current);
      current = [runs[i]];
      curMinX = minX;
      curMaxX = maxX;
    }
  }
  groups.push(current);
  return groups;
}

function runXRange(run: HersheyRun): [number, number] {
  let min = Infinity;
  let max = -Infinity;
  for (const [x] of run.points) {
    if (x < min) min = x;
    if (x > max) max = x;
  }
  return [min, max];
}

function mapRun(run: HersheyRun, fn: (x: number, y: number) => [number, number]): HersheyRun {
  return { ...run, points: run.points.map(([x, y]) => fn(x, y)) };
}

// ── slant (oblique) ───────────────────────────────────────────────────

/** Maximum absolute slant. Beyond ~45° the strokes read as a smear
 *  rather than an italic, and tan() starts amplifying every rounding
 *  error in the glyph data. */
export const MAX_SLANT_DEG = 45;

/** Clamp a slant to the supported range; non-finite input means "none". */
export function clampSlant(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return Math.max(-MAX_SLANT_DEG, Math.min(MAX_SLANT_DEG, degrees));
}

/**
 * X-shear about the baseline: `x' = x + (baselineY - y) * tan(θ)`.
 * Positive degrees lean RIGHT (the top of a glyph is at a smaller y than
 * its baseline, so `baselineY - y` is positive there and the top slides
 * in +x).
 *
 * The pivot is the BASELINE, never the bbox centre. Pivoting on the
 * centre slides the whole word sideways and lifts it off its line;
 * pivoting on the baseline leaves every baseline point exactly where it
 * was, which is the definition of an oblique.
 *
 * Multi-line text shears about EACH LINE'S OWN baseline, read from the
 * run's `baselineY` tag. The `baselineY` parameter is the fallback for
 * untagged runs.
 *
 * y is never touched, so per-pair kerning and per-glyph baseline shifts —
 * both already baked into the points by `hersheyTextToRuns` — survive.
 * A baseline-shifted glyph correctly leans FURTHER out than its
 * neighbours, exactly as a raised letter would in a real italic.
 *
 * `degrees` is clamped to ±`MAX_SLANT_DEG`. 0° is the exact identity:
 * coordinates are copied, not recomputed, so no `-0` or rounding
 * artefacts leak into a document the user never slanted.
 */
export function slantRuns(runs: HersheyRun[], degrees: number, baselineY = 0): HersheyRun[] {
  const deg = clampSlant(degrees);
  if (deg === 0) return runs.map((r) => mapRun(r, (x, y) => [x, y]));
  const t = Math.tan((deg * Math.PI) / 180);
  return runs.map((r) => {
    const base =
      typeof r.baselineY === 'number' && Number.isFinite(r.baselineY) ? r.baselineY : baselineY;
    return mapRun(r, (x, y) => [x + (base - y) * t, y]);
  });
}

// ── vertical stacking ─────────────────────────────────────────────────

export type StackAlign = 'center' | 'left' | 'right';

export type StackVerticalOptions = {
  /** Cap height (mm) the text was rendered at. Only used to size the
   *  default gap — see the note on `gapMM` about why the SPACING is
   *  measured off the ink, not off this number. */
  capHeightMM: number;
  /** Clear space (mm) between one glyph's ink and the next glyph's ink.
   *  Default 0.25 × cap. */
  gapMM?: number;
  /** How each glyph's INK bbox lines up on the axis. Default 'center'. */
  align?: StackAlign;
  /** X (mm) of the common axis. Default: horizontal centre of the input. */
  axisX?: number;
  /** Baseline (mm) of the first stacked glyph. Default: the first
   *  glyph's own baseline, so nothing moves vertically until it has to. */
  startBaselineY?: number;
};

/** Default gap between stacked glyphs, as a fraction of cap height. */
export const DEFAULT_STACK_GAP_FACTOR = 0.25;

/**
 * Re-lay the glyphs one per line down a common vertical axis — a blade
 * sign.
 *
 * Glyphs stay UPRIGHT: no per-glyph rotation. That is how stacked blade
 * signs are actually built; rotating each letter 90° would be a
 * different feature.
 *
 * SPACING IS MEASURED INK-TO-INK, not by a baseline pitch of
 * `capHeightMM + gap`. `capHeightMM` stays the knob that sizes the
 * DEFAULT gap; the placement itself only ever looks at where the ink
 * actually is, which is correct whatever the font's metrics claim.
 *
 * This was originally forced by Bug #13: `fonts.ts` declared
 * `capHeightUnits: 12` against font data that measures 21, so rendered
 * text was 1.75× `capHeightMM` tall and a `capHeightMM + gap` pitch
 * overlapped consecutive glyphs by half a letter. (Verified in a
 * browser at the time: eight min-spacing errors and two stroke
 * crossings on a four-letter stack.) That metric is now correct, so the
 * two approaches agree for plain capitals — but ink-to-ink stays,
 * because it is still the only one that gets DESCENDERS right. A
 * baseline pitch lets a 'g' tail run into the glyph below it; see the
 * "keeps a descender from eating the gap below it" test.
 *
 * Ink-to-ink also means a descender does not eat into the gap below it,
 * and the air between letters reads as even down the whole column —
 * which is what a blade sign wants.
 *
 * Horizontal alignment is computed from each glyph's own INK bbox, NOT
 * its advance width — an 'I' has a wide advance and a narrow stroke, so
 * advance-width centring would leave it visibly off the axis an 'M' sits
 * on.
 *
 * A newline in the source text becomes an EXTRA `gapMM` between the two
 * glyphs that straddle it, so "OPEN\n24H" stacks as one column with a
 * visible phrase break rather than two columns.
 */
export function stackVertical(runs: HersheyRun[], opts: StackVerticalOptions): HersheyRun[] {
  const groups = groupRunsByGlyph(runs);
  if (groups.length === 0) return [];
  const cap = opts.capHeightMM;
  const gap =
    typeof opts.gapMM === 'number' && Number.isFinite(opts.gapMM)
      ? opts.gapMM
      : cap * DEFAULT_STACK_GAP_FACTOR;
  const align: StackAlign = opts.align ?? 'center';
  const full = hersheyRunsBBox(runs);
  const axisX =
    typeof opts.axisX === 'number' && Number.isFinite(opts.axisX)
      ? opts.axisX
      : full
        ? (full.minX + full.maxX) / 2
        : 0;
  const startBaselineY =
    typeof opts.startBaselineY === 'number' && Number.isFinite(opts.startBaselineY)
      ? opts.startBaselineY
      : (groups[0][0]?.baselineY ?? 0);
  // The first glyph only moves by however much `startBaselineY` differs
  // from where it already sits, so the default is "nothing moves".
  const firstBaseline = groups[0][0]?.baselineY ?? startBaselineY;
  const leadDy = startBaselineY - firstBaseline;

  const out: HersheyRun[] = [];
  // Y (mm) where the next glyph's ink must start.
  let inkCursorY = Number.NaN;
  let prevLine = groups[0][0]?.lineIndex;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    const line = group[0]?.lineIndex;
    const gb = hersheyRunsBBox(group);
    if (!gb) continue;
    if (Number.isNaN(inkCursorY)) {
      inkCursorY = gb.minY + leadDy;
    } else if (
      typeof line === 'number' &&
      typeof prevLine === 'number' &&
      line !== prevLine
    ) {
      // A source newline reads as a phrase break; give it extra air.
      inkCursorY += gap * Math.max(1, line - prevLine);
    }
    prevLine = line;
    const dx =
      align === 'left'
        ? axisX - gb.minX
        : align === 'right'
          ? axisX - gb.maxX
          : axisX - (gb.minX + gb.maxX) / 2;
    const dy = inkCursorY - gb.minY;
    const srcBaseline =
      typeof group[0].baselineY === 'number' ? group[0].baselineY : startBaselineY;
    for (const r of group) {
      out.push({
        ...r,
        points: r.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
        lineIndex: i,
        // Carry the glyph's baseline through the move so the slant pass
        // that runs after this still shears about the right line.
        baselineY: srcBaseline + dy,
      });
    }
    inkCursorY = gb.maxY + dy + gap;
  }
  return out;
}

// ── text on an arc ────────────────────────────────────────────────────

export type ArcDirection = 'up' | 'down';

export type ArcOptions = {
  /** Arc radius (mm), measured to the BASELINE. Must be > 0. */
  radiusMM: number;
  /** 'up' arches the text over a centre BELOW it (a doorway sign);
   *  'down' sags it under a centre above. Default 'up'. */
  direction?: ArcDirection;
  /** X (mm) that maps to the crown of the arc. Default: the horizontal
   *  centre of the input's bbox. */
  centerX?: number;
  /** The flat baseline the text currently sits on. Default: the first
   *  run's `baselineY` tag, else 0. */
  baselineY?: number;
  /** Densification target: no output segment spans more than this many
   *  radians of arc. Default 2°. */
  maxSegmentAngleRad?: number;
};

const DEFAULT_ARC_SEGMENT_RAD = (2 * Math.PI) / 180;
const MAX_SUBDIVISIONS = 256;

/**
 * Bend the baseline onto a circle.
 *
 * Each point is mapped by ARC LENGTH along the original baseline: a
 * point `s` mm to the right of `centerX` lands at angle `φ = s / R`
 * around the circle, and its signed height above the baseline
 * (`h = baselineY − y`, positive above) becomes a radial offset:
 *
 *   up:    centre at (centerX, baselineY + R), radius' = R + h
 *   down:  centre at (centerX, baselineY − R), radius' = R − h
 *
 * For 'up' the glyph's outer edge — its cap top, above the baseline —
 * ends up FARTHER from the centre than the baseline is, which is what
 * makes the letters splay outward around the arch instead of pinching.
 * A point exactly on the baseline always lands exactly `R` from the
 * centre, at any `s`. 'up' and 'down' are mirror images about the
 * baseline.
 *
 * Glyphs rotate AS A WHOLE with the baseline tangent — there is no
 * separate per-character rotation step. A letter near the end of a
 * tight arc is therefore slightly fanned (its left edge sits at a
 * smaller φ than its right edge), which is what a bent neon word
 * actually looks like.
 *
 * Long straight segments are subdivided BEFORE mapping. Without that a
 * horizontal stroke — the bar of an 'E', an underscore — would chord
 * straight across the arc instead of following it, because the map only
 * moves the endpoints. `smoothStrokePoints` in text.ts densifies curves
 * but deliberately leaves straight strokes alone, so this is the only
 * place that can fix it.
 *
 * Guard: a non-finite or non-positive radius returns the input unchanged
 * (as a copy). The UI clamps radius to a positive minimum, but the
 * function must not emit NaNs if something slips through.
 */
export function arcRuns(runs: HersheyRun[], opts: ArcOptions): HersheyRun[] {
  const R = opts.radiusMM;
  if (runs.length === 0) return [];
  if (!Number.isFinite(R) || R <= 0) return runs.map((r) => mapRun(r, (x, y) => [x, y]));
  const direction: ArcDirection = opts.direction ?? 'up';
  const bbox = hersheyRunsBBox(runs);
  const centerX =
    typeof opts.centerX === 'number' && Number.isFinite(opts.centerX)
      ? opts.centerX
      : bbox
        ? (bbox.minX + bbox.maxX) / 2
        : 0;
  const baselineY =
    typeof opts.baselineY === 'number' && Number.isFinite(opts.baselineY)
      ? opts.baselineY
      : (runs[0]?.baselineY ?? 0);
  const stepRad =
    typeof opts.maxSegmentAngleRad === 'number' && opts.maxSegmentAngleRad > 0
      ? opts.maxSegmentAngleRad
      : DEFAULT_ARC_SEGMENT_RAD;
  const maxChordMM = R * stepRad;

  // `sign` is the only difference between the two directions: it flips
  // both the centre's side of the baseline and the radial direction of
  // "above the baseline", which is exactly what makes up/down mirrors.
  const sign = direction === 'up' ? 1 : -1;
  const cy = baselineY + sign * R;

  const map = (x: number, y: number): [number, number] => {
    const s = x - centerX;
    const h = baselineY - y; // positive = above the baseline
    const phi = s / R;
    const r = R + sign * h;
    return [centerX + r * Math.sin(phi), cy - sign * r * Math.cos(phi)];
  };

  return runs.map((run) => {
    const dense = densifyByX(run.points, maxChordMM);
    return { ...run, points: dense.map(([x, y]) => map(x, y)), baselineY };
  });
}

/** Insert interpolated points so no segment spans more than `maxChordMM`
 *  of horizontal distance (which is what turns into arc angle). */
function densifyByX(points: [number, number][], maxChordMM: number): [number, number][] {
  if (points.length < 2 || !Number.isFinite(maxChordMM) || maxChordMM <= 0) return points;
  const out: [number, number][] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    const n = Math.min(MAX_SUBDIVISIONS, Math.max(1, Math.ceil(Math.abs(x1 - x0) / maxChordMM)));
    for (let k = 1; k < n; k++) {
      const t = k / n;
      out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t]);
    }
    out.push([x1, y1]);
  }
  return out;
}

/** Total angle (degrees) the text sweeps at this radius. The dialog
 *  warns past 360°, where the word laps itself and becomes unreadable. */
export function arcSweepDeg(runs: HersheyRun[], radiusMM: number): number {
  const bbox = hersheyRunsBBox(runs);
  if (!bbox || !Number.isFinite(radiusMM) || radiusMM <= 0) return 0;
  return ((bbox.maxX - bbox.minX) / radiusMM) * (180 / Math.PI);
}

// ── the fixed composition ─────────────────────────────────────────────

export type TextLayoutMode = 'none' | 'stack' | 'arc';

export type TextTransformOptions = {
  capHeightMM: number;
  /** 'stack' and 'arc' are mutually exclusive by construction — one
   *  field, not two booleans, so the impossible state can't be built. */
  layout?: TextLayoutMode;
  stack?: Omit<StackVerticalOptions, 'capHeightMM'>;
  arc?: ArcOptions;
  slantDeg?: number;
  /** Fallback baseline for untagged runs. */
  baselineY?: number;
};

/**
 * Apply the layout and slant passes in the ONE canonical order:
 *
 *     layout (stack XOR arc)  →  slant
 *
 * Case has already been applied to the text itself before these runs
 * were generated — see the module header and changeCase.ts.
 *
 * The dialog uses this for its live preview AND for the runs it inserts,
 * which is the only way to guarantee the two agree. Transforming runs on
 * only one of those paths is a bug waiting to ship.
 */
export function applyTextTransforms(
  runs: HersheyRun[],
  opts: TextTransformOptions,
): HersheyRun[] {
  let out = runs;
  const layout = opts.layout ?? 'none';
  if (layout === 'stack') {
    out = stackVertical(out, { capHeightMM: opts.capHeightMM, ...(opts.stack ?? {}) });
  } else if (layout === 'arc' && opts.arc) {
    out = arcRuns(out, { baselineY: opts.baselineY, ...opts.arc });
  }
  const slant = clampSlant(opts.slantDeg ?? 0);
  if (slant !== 0) out = slantRuns(out, slant, opts.baselineY ?? 0);
  return out;
}
