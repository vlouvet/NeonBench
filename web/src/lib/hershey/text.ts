// Hershey Roman Simplex text → polyline converter for the neon editor.
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
// Font: Roman Simplex (rowmans). Public domain (NBS), packed format by
// James Hurt, attribution preserved in rowmans.json#_license.
//
// Coordinate convention:
//   - JHF source units: bytes offset from ASCII 'R'. Cap height ≈ 21 units
//     (the simplex fonts run roughly y ∈ [-12, 9], with -12 = top of caps).
//   - JHF Y-axis: positive points DOWN already in this dataset (caps span
//     y=-12 at top to y=9 at baseline-descender), which matches SVG/screen
//     coordinates. We do NOT flip Y. (The "screen-up positive" caveat in
//     the original Hershey spec was about plotter Y; the rowmans data we
//     ship is already in pen-down-positive orientation.)
//   - Output units: millimeters in the design-doc coordinate system.

import fontData from './rowmans.json' with { type: 'json' };

/** One stroke = one tube run. Multi-stroke glyphs (e.g. 'i' = stem + dot,
 *  'E' = vertical + 3 horizontals) yield multiple HersheyRuns and become
 *  multiple DesignRuns. Each is a real piece of glass — that matches how
 *  channel-letter shops actually build these signs. */
export type HersheyRun = {
  points: [number, number][];
};

type Glyph = {
  left: number;
  right: number;
  strokes: number[][][]; // [stroke][point][xy]
};

type FontData = {
  _license: string;
  glyphs: Record<string, Glyph>;
};

const FONT = fontData as FontData;

// Cap height in JHF units. Empirically, the rowmans uppercase letters run
// from y=-12 (top) to y=9 (descender baseline reach), with the actual
// baseline at y=0 and a typical cap top at y=-12. So cap height = 12 + 0
// = 12 units. (Some references quote ~21 because they use the full
// ascender-to-descender extent; we use the more useful "user-visible cap
// height" so a 100mm setting yields a visible 100mm-tall capital.)
const CAP_HEIGHT_JHF_UNITS = 12;

/**
 * Convert a string to disconnected strokes ready to become DesignRuns.
 *
 * @param text         The text to render. ASCII printable only — non-ASCII
 *                     chars are skipped with a console.warn.
 * @param capHeightMM  Visible uppercase letter height in millimeters.
 * @param originX      X (mm) of the left edge of the first character's
 *                     bounding bracket, in design-doc coordinates.
 * @param originY      Y (mm) of the BASELINE of the text, in design-doc
 *                     coordinates. (Cap tops sit above this; descenders
 *                     of g/j/p/q/y reach below.)
 * @param letterSpacingMM  Optional extra advance between glyphs, in mm.
 *                     Useful for stretching wide signs. Default: 0
 *                     (advance is determined by each glyph's own bracket).
 *
 * Multi-stroke glyphs return multiple HersheyRuns. Whitespace advances
 * the cursor without emitting strokes. Unknown chars are skipped.
 */
export function hersheyTextToRuns(
  text: string,
  capHeightMM: number,
  originX: number,
  originY: number,
  letterSpacingMM: number = 0,
): HersheyRun[] {
  const scale = capHeightMM / CAP_HEIGHT_JHF_UNITS;
  const runs: HersheyRun[] = [];
  let cursorX = originX;

  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;

    // Out-of-range (non-ASCII or control char): skip with a warning so a
    // user pasting an em-dash or accented letter sees a clean console
    // hint instead of an exception or a silent missing glyph.
    if (code < 32 || code > 127) {
      console.warn(`hersheyTextToRuns: skipping unsupported character U+${code.toString(16).padStart(4, '0').toUpperCase()}`);
      continue;
    }

    const glyph = FONT.glyphs[String(code)];
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
        originY + gy * scale,
      ]);
      runs.push({ points });
    }

    // Advance cursor by glyph's own advance width (right - left in JHF
    // units) plus the user's optional extra letter-spacing.
    cursorX += (glyph.right - glyph.left) * scale + letterSpacingMM;
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
