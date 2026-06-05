// Hershey single-stroke text → polyline converter for the neon editor.
//
// WHY this lives here, not as a canvas tool: see CLAUDE.md hazard map —
// EditorCanvas.tsx is high-coupling. The "Add text" feature drops new
// runs into the design doc via the existing save flow, so it's a modal
// that emits HersheyRun[] and never touches the canvas-rendering code.
//
// WHY Hershey instead of OpenType outlines: real neon tubes follow the
// stroke center, not the outline edge. Hershey single-stroke fonts were
// designed for plotters/engravers/CNC routers — the strokes ARE the path
// the bender will follow. No raster trace, no centerline extraction.
//
// Fonts: Roman Simplex (rowmans, default), Roman Duplex (rowmand, thicker
// channel-letter look — every stroke paired with an offset twin), Sans
// Simplex / Futural (geometric sans), and Cursive (connecting script,
// adjacent lowercase letters stitched into one tube via
// joinAdjacentGlyphs.ts; toggled per-face via fonts.ts's joinAdjacent
// flag). All public domain (NBS via Hershey/Hurt). Attribution preserved
// per JSON file's _license field.
//
// Coordinate convention:
//   - JHF source units: bytes offset from ASCII 'R'. Cap height ≈ 12 JHF
//     units (caps span y=-12 at top to y=0 at baseline; descenders reach
//     ~y=9). Stored per-font in fonts.ts so future faces with different
//     metrics don't need a special case.
//   - JHF Y-axis: positive points DOWN already in this dataset, which
//     matches SVG/screen coordinates. We do NOT flip Y.
//   - Output units: millimeters in the design-doc coordinate system.

import { getFont, type FontKey } from './fonts';
import { joinAdjacentGlyphs } from './joinAdjacentGlyphs';
import { smoothStrokePoints } from './smooth';

/** One stroke = one tube run. Multi-stroke glyphs (e.g. 'i' = stem + dot,
 *  'E' = vertical + 3 horizontals) yield multiple HersheyRuns and become
 *  multiple DesignRuns. Each is a real piece of glass — that matches how
 *  channel-letter shops actually build these signs. */
export type HersheyRun = {
  points: [number, number][];
};

/**
 * Convert a string to disconnected strokes ready to become DesignRuns.
 *
 * @param text                The text to render. ASCII printable only —
 *                            non-ASCII chars are skipped with a console.warn.
 *                            Newlines (`\n`) start a new baseline.
 * @param font                Font key. Default: 'rowmans' (Roman Simplex).
 * @param capHeightMM         Visible uppercase letter height in millimeters.
 * @param originX             X (mm) of the left edge of the first character's
 *                            bounding bracket on the FIRST line.
 * @param originY             Y (mm) of the BASELINE of the first line.
 *                            Each subsequent line's baseline is at
 *                            `originY + i * capHeightMM * lineHeight`.
 * @param letterSpacingMM     Optional uniform extra advance between glyphs.
 *                            Default: 0.
 * @param perPairKerningMM    Optional per-pair extra advance. Indexed by the
 *                            non-newline character pair: slot i sits between
 *                            the i-th and (i+1)-th renderable glyphs in input
 *                            order, IGNORING newlines. So for "AB\nCD" the
 *                            three slots are A-B (slot 0), B-C (slot 1, spans
 *                            the line break), and C-D (slot 2). Slots whose
 *                            second glyph is on a fresh line have no visible
 *                            effect — cursor X resets at every newline — but
 *                            we still consume the slot index to keep array
 *                            length = (#glyph chars - 1). Out-of-range entries
 *                            are treated as 0. (Tradeoff: slots stay
 *                            positionally stable across newline edits, which
 *                            keeps the dialog's drag handles aligned to the
 *                            visible inter-glyph gaps. See spec.)
 * @param applyPresetKerning  If true, consult `font.presetKerning` for each
 *                            visible-glyph pair (e.g. 'AV', 'To') and add
 *                            the table value (in JHF units) to that slot's
 *                            kerning AS A FALLBACK when `perPairKerningMM`
 *                            has no explicit entry for that slot. The
 *                            user-supplied per-pair value always wins —
 *                            so dragging a handle persists past edits even
 *                            when the preset would also apply.
 *                            Default: false (back-compat with existing tests).
 * @param baselineShiftsMM    Optional per-glyph vertical offset (mm) added
 *                            to that glyph's baseline. Length matches the
 *                            visible-glyph index space (newlines do NOT
 *                            consume a slot). Useful for aligning two
 *                            stacked words ('OPEN' + '2026') by metaposition
 *                            within their own line. Out-of-range entries =
 *                            0. Doesn't shift the cursor — only Y.
 * @param lineHeight          Multi-line line-height multiplier. Default: 1.2.
 *
 * Multi-stroke glyphs return multiple HersheyRuns. Whitespace advances
 * the cursor without emitting strokes. Unknown chars are skipped.
 */
export type HersheyTextOptions = {
  text: string;
  font?: FontKey;
  capHeightMM: number;
  originX: number;
  originY: number;
  letterSpacingMM?: number;
  perPairKerningMM?: number[];
  applyPresetKerning?: boolean;
  baselineShiftsMM?: number[];
  lineHeight?: number;
};

export function hersheyTextToRuns(opts: HersheyTextOptions): HersheyRun[] {
  const {
    text,
    font: fontKey,
    capHeightMM,
    originX,
    originY,
    letterSpacingMM = 0,
    perPairKerningMM,
    applyPresetKerning = false,
    baselineShiftsMM,
    lineHeight = 1.2,
  } = opts;

  const font = getFont(fontKey);
  const scale = capHeightMM / font.capHeightUnits;
  // For non-joining faces we'd just push directly into a flat runs array.
  // For joining faces (cursive) we collect per-glyph stroke groups so a
  // post-pass can stitch adjacent glyphs together. Use the grouped path
  // unconditionally — it's a few extra array allocations, no correctness
  // cost — and flatten/join at the end based on font.joinAdjacent.
  const glyphGroups: HersheyRun[][] = [];
  // Parallel flags: true means "do not join glyphGroups[i] with
  // glyphGroups[i-1]" (i.e. there was a space, newline, or unknown char
  // between this glyph and the previous one). The 0-th flag is always
  // true (no glyph before the first).
  const breakBefore: boolean[] = [];
  // Floor on negative kerning: stop the user from collapsing glyphs into
  // illegible garbage. -capHeight is roughly "up to one cap-height of
  // overlap" which still allows tight optical kerning of e.g. AV/To.
  const kernFloor = -capHeightMM;
  // Tracks whether the next emitted glyph starts a fresh joinable
  // sequence (set true at start, after every space, after every newline,
  // and after every skipped non-glyph character).
  let breakNext = true;

  // First walk: collect the visible-glyph sequence (the printable
  // characters in input order, skipping '\n', whitespace, and unknown
  // codepoints — anything that does NOT consume a pairIdx slot in the
  // existing semantics). Used so preset lookup can see the NEXT visible
  // glyph during the second walk without a second nested loop.
  const visibleChars = collectVisibleChars(text, font);

  let cursorX = originX;
  let baselineY = originY;
  // pairIdx counts gaps between RENDERED glyphs (newlines don't count as
  // glyphs). After rendering the i-th glyph we look up
  // perPairKerningMM[pairIdx] for the gap to the (i+1)-th glyph and then
  // increment pairIdx. When a newline immediately follows, the kerning
  // is added to cursorX but then discarded by the newline reset, which
  // is the agreed-on no-op behaviour: slot indices stay aligned with
  // visible inter-glyph gaps. See HersheyTextOptions doc above.
  let pairIdx = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === '\n') {
      // Newline: advance baseline, reset cursor. Doesn't consume pairIdx
      // because the previous glyph already advanced it; the kerning we
      // tentatively added for the gap-before-newline is wiped here.
      baselineY += capHeightMM * lineHeight;
      cursorX = originX;
      // Newline interrupts a join sequence (the next glyph sits on a new
      // baseline, so even if X happens to align, joining would draw a
      // bridge across two lines).
      breakNext = true;
      continue;
    }

    const code = ch.codePointAt(0);
    if (code === undefined) continue;

    // Out-of-range (non-ASCII or control char): skip with a warning so a
    // user pasting an em-dash or accented letter sees a clean console
    // hint instead of an exception or a silent missing glyph.
    if (code < 32 || code > 127) {
      console.warn(
        `hersheyTextToRuns: skipping unsupported character U+${code
          .toString(16)
          .padStart(4, '0')
          .toUpperCase()}`,
      );
      // Skipped chars don't consume a kerning slot — the user pasted
      // garbage; their kerning array is keyed to the visible glyphs.
      // They DO interrupt joining (treated like a space): if a user
      // pastes "foéo" the o's on either side of the dropped é
      // should not be stitched.
      breakNext = true;
      continue;
    }

    const glyph = font.data.glyphs[String(code)];
    if (!glyph) {
      console.warn(`hersheyTextToRuns: no glyph for ASCII ${code}`);
      // Missing glyph also interrupts joining (same reasoning as above).
      breakNext = true;
      continue;
    }


    // Per-glyph baseline shift (mm) — Y-only, doesn't affect cursorX.
    const shiftY = baselineShiftsMM?.[pairIdx];
    const shifted = typeof shiftY === 'number' && Number.isFinite(shiftY) ? shiftY : 0;

    // Place glyph: glyph.left is its left bracket; we want the cursor to
    // sit at the bracket's left edge, so subtract glyph.left from JHF X.
    const glyphOffsetX = cursorX - glyph.left * scale;

    const glyphRuns: HersheyRun[] = [];
    for (const stroke of glyph.strokes) {
      if (stroke.length < 2) continue;
      const points: [number, number][] = stroke.map(([gx, gy]) => [
        glyphOffsetX + gx * scale,
        baselineY + gy * scale + shifted,
      ]);
      // Bug #07: densify curved strokes (e.g. the 21-point "O") along a
      // corner-preserving Catmull-Rom spline so the validator's bend-radius
      // sampling sees smooth curvature instead of polygon facets. Straight
      // strokes and hard corners pass through unchanged.
      glyphRuns.push({ points: smoothStrokePoints(points) });
    }
    // Glyphs that emit no strokes (e.g. ASCII space, whose only "stroke"
    // is < 2 points and gets dropped at build time) do NOT contribute to
    // glyphGroups but DO interrupt joining — a word break.
    if (glyphRuns.length === 0) {
      breakNext = true;
    } else {
      glyphGroups.push(glyphRuns);
      breakBefore.push(breakNext);
      breakNext = false;
    }

    // Advance cursor by glyph's own advance + uniform letter-spacing.
    cursorX += (glyph.right - glyph.left) * scale + letterSpacingMM;

    // Determine the kerning delta for the gap AFTER this glyph. User-
    // supplied per-pair kerning takes precedence; preset is the fallback
    // when the user has not explicitly set this slot. We treat "explicit"
    // as "the slot exists in the array AND its value is a finite number".
    // Why this rule, not just typeof === 'number': if the dialog seeds
    // user values with NaN as a sentinel for "untouched", the preset
    // can fill in. Today the dialog stores 0 for untouched, so this
    // path falls through to user value 0 (no-op for matching pairs and
    // the back-compat tests still pass).
    const userK = perPairKerningMM?.[pairIdx];
    let k: number | undefined;
    if (typeof userK === 'number' && Number.isFinite(userK)) {
      k = userK;
    } else if (applyPresetKerning) {
      const nextGlyph = visibleChars[pairIdx + 1];
      if (nextGlyph) {
        const pair = ch + nextGlyph;
        const presetJHF = font.presetKerning[pair];
        if (typeof presetJHF === 'number') k = presetJHF * scale;
      }
    }
    if (typeof k === 'number') cursorX += Math.max(k, kernFloor);
    pairIdx++;
  }

  // For non-joining faces (the historical Hershey behaviour), just flatten
  // glyphGroups into the output run list — same result as the pre-Tier-3
  // straight-into-runs path. For joining faces, walk consecutive groups
  // and try to stitch them at the boundaries.
  if (!font.joinAdjacent || glyphGroups.length === 0) {
    return glyphGroups.flat();
  }

  // Build the joined run list incrementally. We carry a "current"
  // accumulator that holds the running stitched glyph (one glyph's
  // worth of HersheyRun[]). On each subsequent glyph, attempt to join;
  // if it succeeds we replace the accumulator with the joined result. If
  // it fails (or breakBefore[i] is set), flush the accumulator and start
  // a fresh one.
  const out: HersheyRun[] = [];
  let acc: HersheyRun[] = glyphGroups[0];
  for (let i = 1; i < glyphGroups.length; i++) {
    if (breakBefore[i]) {
      // Word boundary: flush acc, start fresh.
      out.push(...acc);
      acc = glyphGroups[i];
      continue;
    }
    const { joined, joinedStrokes } = joinAdjacentGlyphs(acc, glyphGroups[i], {
      capHeightMM,
    });
    if (joined) {
      // Successful stitch — the result becomes the new acc.
      acc = joinedStrokes;
    } else {
      // Failed eligibility (e.g. 't' exiting at cap-top, or huge user
      // kerning): flush prev, start fresh with this glyph isolated.
      out.push(...acc);
      acc = glyphGroups[i];
    }
  }
  out.push(...acc);
  return out;
}

/** Collect the sequence of printable characters that consume a pairIdx
 *  slot. Mirrors the skip logic in `hersheyTextToRuns` exactly. */
function collectVisibleChars(text: string, font: ReturnType<typeof getFont>): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') continue;
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 32 || code > 127) continue;
    if (!font.data.glyphs[String(code)]) continue;
    out.push(ch);
  }
  return out;
}

/** Tight bounding box of every emitted stroke point. Useful for placing
 *  the inserted text near the document center without a separate pass. */
export function hersheyRunsBBox(runs: HersheyRun[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const r of runs) {
    for (const [x, y] of r.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
      any = true;
    }
  }
  if (!any) return null;
  return { minX, minY, maxX, maxY };
}
