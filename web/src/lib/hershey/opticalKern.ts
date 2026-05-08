// Optical pair-kerning helper for Hershey single-stroke fonts.
//
// WHY this is its own module: the runs-emitter (text.ts) is intentionally
// free of "smart" defaults — it just maps text + slot deltas to strokes.
// Optical kerning is a one-shot suggestion the dialog applies on the user's
// command (the "Auto-kern this line" button). Keeping it pure + standalone
// means the math is unit-testable against fixture glyph metrics without
// going through the layout walk.
//
// ALGORITHM (in JHF source units, then scaled to mm at the call site):
//
//  1. Place leftGlyph with its left bracket at cursor=0 (the way text.ts
//     does). Its actual right stroke X in cursor coordinates is
//        Lright = stroke-right-edge(leftGlyph) - leftGlyph.left
//  2. The default cursor advance is (leftGlyph.right - leftGlyph.left).
//  3. Place rightGlyph after the advance with its left bracket at the
//     cursor. Its actual left stroke X in cursor coordinates is
//        Rleft = (leftGlyph.right - leftGlyph.left) +
//                (stroke-left-edge(rightGlyph) - rightGlyph.left)
//  4. The optical gap between the two glyph SHAPES (not brackets) is
//        gap = Rleft - Lright = (leftGlyph.right - stroke-right-edge(leftGlyph)) +
//                                (stroke-left-edge(rightGlyph) - rightGlyph.left)
//     i.e. the sum of the right side-bearing of the left glyph and the
//     left side-bearing of the right glyph (both measured from bracket
//     to actual stroke edge).
//  5. We want the optical gap to equal a target side-bearing — roughly
//     one stroke-width — so the kerning delta is
//        kernJHF = targetGap - gap
//     which is usually negative (tighten) for pairs like A·V or T·o where
//     diagonal/round shapes leave too much white air.
//
// EDGE-CASE TRADEOFFS:
//
//  - We use a PERCENTILE of stroke X (default 90th for right edge, 10th
//    for left edge) instead of strict max/min. A single stroke spike (e.g.
//    a serif tip in a Duplex letter, or the top of a Q's tail) shouldn't
//    dominate the optical edge — the bulk of the glyph should. Strict
//    max/min is available via the `mode: 'extrema'` opt-in for callers
//    that want the absolute hull.
//  - Whitespace and unknown glyphs return 0 (no adjustment). The dialog
//    already skips those in the slot index, so this is just a safety net.
//  - The function works in JHF units; the dialog converts to mm at apply
//    time (one multiply by capHeightMM / face.capHeightUnits).

import type { FontEntry, Glyph } from './fonts';

export type OpticalKernOptions = {
  /** Target optical side-bearing in JHF units. Default 1, which gives
   *  pairs like A·V a single-unit gap — visually tight but legible at
   *  100mm cap height. */
  targetGapJHF?: number;
  /** Percentile (0..1) of stroke X used to find the "real" right edge of
   *  the left glyph and the left edge of the right glyph. 1 = strict
   *  max/min (which can be too aggressive). 0.9 hugs the bulk of the
   *  glyph while ignoring single-point spikes. */
  edgePercentile?: number;
  /** Override mode: 'percentile' (default) or 'extrema' (strict max/min). */
  mode?: 'percentile' | 'extrema';
};

/**
 * Compute an optical pair-kerning offset for `(leftGlyph, rightGlyph)`
 * in MILLIMETRES, given the parsed font face and a cap-height in mm.
 *
 * Returns 0 if either glyph is missing or has no strokes (e.g. space,
 * unknown character) — the dialog can safely call this for every slot.
 */
export function computeOpticalKernMM(
  face: FontEntry,
  leftGlyph: string,
  rightGlyph: string,
  capHeightMM: number,
  opts: OpticalKernOptions = {},
): number {
  const jhf = computeOpticalKernJHF(face, leftGlyph, rightGlyph, opts);
  return jhf * (capHeightMM / face.capHeightUnits);
}

/**
 * Same as `computeOpticalKernMM` but in JHF source units (no scaling).
 * Exposed for tests + advanced callers that want to feed the raw delta
 * back into the runs-emitter at a different scale.
 */
export function computeOpticalKernJHF(
  face: FontEntry,
  leftGlyph: string,
  rightGlyph: string,
  opts: OpticalKernOptions = {},
): number {
  const target = opts.targetGapJHF ?? 1;
  const left = lookupGlyph(face, leftGlyph);
  const right = lookupGlyph(face, rightGlyph);
  if (!left || !right) return 0;
  if (!hasStrokes(left) || !hasStrokes(right)) return 0;

  const mode = opts.mode ?? 'percentile';
  const pct = clampPct(opts.edgePercentile ?? 0.9);

  // Right edge of LEFT glyph: high-percentile of stroke X.
  const leftEdgeX =
    mode === 'extrema'
      ? maxStrokeX(left)
      : percentileStrokeX(left, pct);
  // Left edge of RIGHT glyph: low-percentile of stroke X.
  const rightEdgeX =
    mode === 'extrema'
      ? minStrokeX(right)
      : percentileStrokeX(right, 1 - pct);

  // Right side-bearing of the left glyph (bracket - stroke).
  const leftSideBearing = left.right - leftEdgeX;
  // Left side-bearing of the right glyph (stroke - bracket).
  const rightSideBearing = rightEdgeX - right.left;
  // Default optical gap (JHF) when glyphs sit at zero kerning.
  const defaultGap = leftSideBearing + rightSideBearing;
  // Kerning delta needed to reach `target`. Negative = tighten.
  return target - defaultGap;
}

// -- internals ------------------------------------------------------------

function lookupGlyph(face: FontEntry, name: string): Glyph | undefined {
  // Single-character convenience: 'A' → ASCII code → entry key.
  if (name.length === 1) {
    const code = name.codePointAt(0);
    if (code === undefined) return undefined;
    return face.data.glyphs[String(code)];
  }
  // Otherwise treat as the raw key already used in the font JSON.
  return face.data.glyphs[name];
}

function hasStrokes(g: Glyph): boolean {
  for (const s of g.strokes) if (s.length >= 1) return true;
  return false;
}

function maxStrokeX(g: Glyph): number {
  let m = -Infinity;
  for (const s of g.strokes) for (const [x] of s) if (x > m) m = x;
  return Number.isFinite(m) ? m : 0;
}

function minStrokeX(g: Glyph): number {
  let m = Infinity;
  for (const s of g.strokes) for (const [x] of s) if (x < m) m = x;
  return Number.isFinite(m) ? m : 0;
}

/** Pull every X coord in the glyph, sort, and return the value at the
 *  given percentile (0..1). Used for both edges by passing pct or 1-pct. */
function percentileStrokeX(g: Glyph, pct: number): number {
  const xs: number[] = [];
  for (const s of g.strokes) for (const [x] of s) xs.push(x);
  if (xs.length === 0) return 0;
  xs.sort((a, b) => a - b);
  // Use the nearest-rank method (no interpolation — simpler + good enough
  // for stroke-count-bounded glyphs).
  const idx = Math.min(xs.length - 1, Math.max(0, Math.round(pct * (xs.length - 1))));
  return xs[idx];
}

function clampPct(p: number): number {
  if (!Number.isFinite(p)) return 0.9;
  if (p < 0) return 0;
  if (p > 1) return 1;
  return p;
}
