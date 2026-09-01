// A font built at test time, so no font file is ever committed.
//
// TEST SUPPORT ONLY. Nothing in the app imports this; it is here rather
// than in a `.test.ts` because four test files share it.
//
// WHY NOT A REAL FONT FILE. Every typeface on this machine is licensed,
// and checking one into a public repo is redistribution — the same rule
// that stops NeonBench bundling faces for operators (see face.ts). Nor
// can the suite read /System/Library/Fonts: CI runs on Linux, and a test
// that passes here and skips there is worse than no test.
//
// So we build a face with opentype.js's own Font/Glyph/Path writers and
// serialise it with `toArrayBuffer()`. The bytes go back through the real
// `parse()`, so the tests exercise the actual load path — cmap, CFF
// charstrings, OS/2 — on ~1.5 KB of data we authored and can assert
// exact numbers against.
//
// ONE GAP, STATED RATHER THAN PAPERED OVER: opentype.js writes CFF, so
// this font's curves come back as CUBIC ('C') commands. Real TrueType
// faces are QUADRATIC ('Q') — measured: Arial, Georgia, Times New Roman,
// Verdana, SFNS and Geneva all return Q for 'o'. The quadratic branch is
// therefore covered two other ways: `flatten.test.ts` drives
// `flattenQuadratic` directly against densely sampled true-curve points,
// and `outline.test.ts` feeds hand-written 'Q' command arrays to
// `contoursFromCommands`. Neither needs a font binary.

import { Font, Glyph, Path } from 'opentype.js';
import { loadFace, type LoadedFace } from './face';

/** Units per em of the synthetic face. 1000 (not the 2048 of the TrueType
 *  faces on this machine) precisely so a bug that assumes 2048 shows up. */
export const SYNTH_UPM = 1000;

/** Ink height of the synthetic 'H', in font units. The cap-height
 *  round-trip test asserts that requesting `capHeightMM` yields an 'H'
 *  exactly `capHeightMM` tall, whatever this number is.
 *
 *  660 is chosen so it is NOT `EM_FRACTION_FALLBACK * SYNTH_UPM` (=700).
 *  If it were, the measured-H branch and the em-fraction guess would
 *  produce the same scale and the headline test could not tell a correct
 *  implementation from Bug #13 all over again. */
export const SYNTH_CAP_UNITS = 660;

/** Advance widths, font units. Chosen distinct and round so a layout
 *  assertion can be written in closed form. */
export const SYNTH_ADVANCE = { H: 500, O: 800, I: 200, space: 300 } as const;

/** Kappa: the cubic control-point offset that approximates a quarter
 *  ellipse to within ~0.02% of the radius. */
const K = 0.5522847498307936;

function ellipse(
  path: Path,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  counterClockwise: boolean,
): void {
  const ox = rx * K;
  const oy = ry * K;
  if (counterClockwise) {
    path.moveTo(cx + rx, cy);
    path.curveTo(cx + rx, cy + oy, cx + ox, cy + ry, cx, cy + ry);
    path.curveTo(cx - ox, cy + ry, cx - rx, cy + oy, cx - rx, cy);
    path.curveTo(cx - rx, cy - oy, cx - ox, cy - ry, cx, cy - ry);
    path.curveTo(cx + ox, cy - ry, cx + rx, cy - oy, cx + rx, cy);
  } else {
    path.moveTo(cx + rx, cy);
    path.curveTo(cx + rx, cy - oy, cx + ox, cy - ry, cx, cy - ry);
    path.curveTo(cx - ox, cy - ry, cx - rx, cy - oy, cx - rx, cy);
    path.curveTo(cx - rx, cy + oy, cx - ox, cy + ry, cx, cy + ry);
    path.curveTo(cx + ox, cy + ry, cx + rx, cy + oy, cx + rx, cy);
  }
  path.close();
}

export type SynthFontOptions = {
  /** Drop the 'H' so `resolveCapHeight` has nothing to measure — the
   *  branch that falls back to the declared OS/2 value. */
  omitH?: boolean;
};

/**
 * Serialise the synthetic face. Glyph inventory:
 *
 *   .notdef  empty
 *   space    empty, advance 300
 *   H        straight-line capital, ink y ∈ [0, SYNTH_CAP_UNITS],
 *            x ∈ [0, 400], ONE contour (the silhouette, not two stems)
 *   O        two contours: an outer ellipse (CCW in font units) and a
 *            counter (CW). Ink y ∈ [0, SYNTH_CAP_UNITS], caps-aligned
 *            with H.
 *   I        rectangle, ink y ∈ [0, SYNTH_CAP_UNITS], x ∈ [0, 100]
 */
export function buildSynthFontBuffer(options: SynthFontOptions = {}): ArrayBuffer {
  const glyphs: Glyph[] = [
    new Glyph({ name: '.notdef', unicode: 0, advanceWidth: 600, path: new Path() }),
    new Glyph({
      name: 'space',
      unicode: 32,
      advanceWidth: SYNTH_ADVANCE.space,
      path: new Path(),
    }),
  ];

  if (!options.omitH) {
    const h = new Path();
    // Single closed contour tracing the H silhouette, counter-clockwise
    // in font units. Stems x ∈ [0,100] and [300,400]; crossbar
    // y ∈ [300,400].
    h.moveTo(0, 0);
    h.lineTo(100, 0);
    h.lineTo(100, 300);
    h.lineTo(300, 300);
    h.lineTo(300, 0);
    h.lineTo(400, 0);
    h.lineTo(400, SYNTH_CAP_UNITS);
    h.lineTo(300, SYNTH_CAP_UNITS);
    h.lineTo(300, 400);
    h.lineTo(100, 400);
    h.lineTo(100, SYNTH_CAP_UNITS);
    h.lineTo(0, SYNTH_CAP_UNITS);
    h.close();
    glyphs.push(
      new Glyph({
        name: 'H',
        unicode: 'H'.charCodeAt(0),
        advanceWidth: SYNTH_ADVANCE.H,
        path: h,
      }),
    );
  }

  const o = new Path();
  ellipse(o, 350, SYNTH_CAP_UNITS / 2, 300, SYNTH_CAP_UNITS / 2, true);
  ellipse(o, 350, SYNTH_CAP_UNITS / 2, 150, SYNTH_CAP_UNITS / 4, false);
  glyphs.push(
    new Glyph({
      name: 'O',
      unicode: 'O'.charCodeAt(0),
      advanceWidth: SYNTH_ADVANCE.O,
      path: o,
    }),
  );

  const i = new Path();
  i.moveTo(0, 0);
  i.lineTo(100, 0);
  i.lineTo(100, SYNTH_CAP_UNITS);
  i.lineTo(0, SYNTH_CAP_UNITS);
  i.close();
  glyphs.push(
    new Glyph({
      name: 'I',
      unicode: 'I'.charCodeAt(0),
      advanceWidth: SYNTH_ADVANCE.I,
      path: i,
    }),
  );

  const font = new Font({
    familyName: 'NeonBench Synth',
    styleName: 'Regular',
    unitsPerEm: SYNTH_UPM,
    ascender: 800,
    descender: -200,
    glyphs,
  });
  return font.toArrayBuffer();
}

/** The synthetic face, loaded through the real `loadFace` path. */
export function synthFace(options: SynthFontOptions = {}): LoadedFace {
  return loadFace(buildSynthFontBuffer(options), 'NeonBenchSynth-Regular.otf');
}
