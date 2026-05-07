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
// channel-letter look — every stroke paired with an offset twin), and
// Sans Simplex / Futural (geometric sans). All public domain (NBS via
// Hershey/Hurt). Attribution preserved per JSON file's _license field.
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
    lineHeight = 1.2,
  } = opts;

  const font = getFont(fontKey);
  const scale = capHeightMM / font.capHeightUnits;
  const runs: HersheyRun[] = [];
  // Floor on negative kerning: stop the user from collapsing glyphs into
  // illegible garbage. -capHeight is roughly "up to one cap-height of
  // overlap" which still allows tight optical kerning of e.g. AV/To.
  const kernFloor = -capHeightMM;

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
      continue;
    }

    const glyph = font.data.glyphs[String(code)];
    if (!glyph) {
      console.warn(`hersheyTextToRuns: no glyph for ASCII ${code}`);
      continue;
    }

    // Place glyph: glyph.left is its left bracket; we want the cursor to
    // sit at the bracket's left edge, so subtract glyph.left from JHF X.
    const glyphOffsetX = cursorX - glyph.left * scale;

    for (const stroke of glyph.strokes) {
      if (stroke.length < 2) continue;
      const points: [number, number][] = stroke.map(([gx, gy]) => [
        glyphOffsetX + gx * scale,
        baselineY + gy * scale,
      ]);
      runs.push({ points });
    }

    // Advance cursor by glyph's own advance + uniform letter-spacing +
    // per-pair kerning at the current pairIdx (which represents the gap
    // FROM this glyph TO the next renderable glyph).
    cursorX += (glyph.right - glyph.left) * scale + letterSpacingMM;
    const k = perPairKerningMM?.[pairIdx];
    if (typeof k === 'number') cursorX += Math.max(k, kernFloor);
    pairIdx++;
  }

  return runs;
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
