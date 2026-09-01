// Outline text layout: a string + a loaded face → closed contours in mm.
//
// THE DISTINCTION THAT SHAPES THIS FILE. `hershey/text.ts` emits
// single-stroke CENTRELINES: each stroke already IS the path the bender
// follows, one tube per stroke. This file emits filled-outline CONTOURS:
// the boundary of the ink, which is not a tube path at all. An outline
// has to go on to become one, by exactly one of two routes:
//
//   Neonize            — offset the contour by ±spacing/2, giving the
//                        pair of parallel tubes that trace a thick stroke
//                        (docOps.ts `neonize`).
//   Channel-letter face — mark the contour `is_channel_letter_face` and
//                        the print path emits an unfolded return strip to
//                        wrap sheet metal around (`is_channel_letter_face`
//                        on DesignRun).
//
// Insert an outline and bend it as drawn and you get a hollow letter: two
// tubes per stroke, which is not what "set this in the customer's font"
// means. The dialog says so; this comment exists so the next person to
// read the code knows it is a property of outlines, not an oversight.
//
// Everything here is pure. No opentype.js call escapes `face.ts` /
// `outline.ts` except the two the layout genuinely needs — `charToGlyph`
// and `getKerningValue`.

import { DEFAULT_CHORD_TOLERANCE_MM } from './flatten';
import { glyphContours, type Contour, type ContourRole } from './outline';
import { capHeightWarning, mmPerUnit } from './metrics';
import type { LoadedFace } from './face';

export type OutlineTextOptions = {
  face: LoadedFace;
  /** Newlines start a new baseline; everything else is set as glyphs. */
  text: string;
  /** Measured ink height of a capital 'H', in millimetres. See metrics.ts
   *  — this is a promise the tests hold us to, not a nominal size. */
  capHeightMM: number;
  /** Millimetre X of the first line's pen origin. Default 0. */
  originX?: number;
  /** Millimetre Y of the FIRST LINE'S BASELINE. Default 0. Unlike the
   *  Hershey path (whose origin is a JHF y=0 anchor that is not the
   *  baseline — see the warning in hershey/text.ts), this really is the
   *  baseline: font-unit y=0 maps here. */
  originY?: number;
  /** Extra advance between glyphs, mm. Default 0. */
  letterSpacingMM?: number;
  /** Baseline-to-baseline distance as a multiple of capHeightMM.
   *  Default 1.2, matching the Hershey dialog. */
  lineHeight?: number;
  /** Max distance a flattened curve may stray from the true outline, mm. */
  chordToleranceMM?: number;
  /** Apply the face's own kerning (GPOS, then the legacy `kern` table)
   *  via opentype.js. Default true — the pairs are the foundry's design
   *  intent and Arial alone ships 909 of them. Set false to lay out on
   *  advance widths only. */
  applyKerning?: boolean;
};

export type OutlineRun = {
  /** Closed polyline, millimetres, y-down, `first === last`. */
  points: [number, number][];
  /** The character this contour came from. */
  char: string;
  /** Index among the renderable (non-newline) characters, in input order.
   *  Same index space the Hershey dialog uses for kerning slots. */
  glyphIndex: number;
  /** Which contour of that glyph — 0-based, in the font's own order. */
  contourIndex: number;
  /** 0-based line, counting '\n'. */
  lineIndex: number;
  /** `outer` = ink boundary, `counter` = hole (the middle of an 'o'). */
  role: ContourRole;
  /** Shoelace area, mm². Sign is the face's winding after the y-flip;
   *  a counter's sign is opposite its parent's. `signedArea` in
   *  shapes/offset.ts computes the same number from `points`. */
  areaSigned: number;
};

export type OutlineTextResult = {
  runs: OutlineRun[];
  /** Characters with no glyph in this face, de-duplicated. */
  missing: string[];
  /** Operator-facing notes: cap-height provenance, odd winding, dropped
   *  degenerate contours. Empty when everything was ordinary. */
  warnings: string[];
  /** Millimetres per font unit actually used. `scale * capHeightUnits`
   *  is `capHeightMM` by construction — that identity IS the feature. */
  mmPerFontUnit: number;
};

const DEFAULT_LINE_HEIGHT = 1.2;

export function outlineTextToRuns(opts: OutlineTextOptions): OutlineTextResult {
  const {
    face,
    text,
    capHeightMM,
    originX = 0,
    originY = 0,
    letterSpacingMM = 0,
    lineHeight = DEFAULT_LINE_HEIGHT,
    chordToleranceMM = DEFAULT_CHORD_TOLERANCE_MM,
    applyKerning = true,
  } = opts;

  const warnings: string[] = [];
  const runs: OutlineRun[] = [];
  const missing: string[] = [];
  const seenMissing = new Set<string>();

  const scale = mmPerUnit(face.capHeight, capHeightMM);
  if (!(scale > 0) || !Number.isFinite(scale)) {
    return { runs, missing, warnings: ['Cap height must be a positive number.'], mmPerFontUnit: 0 };
  }

  const capNote = capHeightWarning(face.capHeight);
  if (capNote) warnings.push(capNote);

  let degenerateDropped = 0;
  let oddWinding = false;

  let glyphIndex = 0;
  let lineIndex = 0;
  let penXMM = originX;
  let baselineYMM = originY;
  // Kerning is a property of the PAIR, so the previous glyph has to
  // survive across the loop. It resets at a newline: there is no kern
  // pair across a line break.
  let prevGlyph: ReturnType<typeof face.font.charToGlyph> | null = null;

  for (const ch of text) {
    if (ch === '\n') {
      lineIndex += 1;
      penXMM = originX;
      baselineYMM = originY + lineIndex * capHeightMM * lineHeight;
      prevGlyph = null;
      continue;
    }
    if (ch === '\r') continue;

    let hasGlyph: boolean;
    try {
      hasGlyph = face.font.hasChar(ch);
    } catch {
      hasGlyph = false;
    }
    if (!hasGlyph && !seenMissing.has(ch)) {
      seenMissing.add(ch);
      missing.push(ch);
    }

    const glyph = face.font.charToGlyph(ch);

    if (applyKerning && prevGlyph) {
      let kern: number;
      try {
        kern = face.font.getKerningValue(prevGlyph, glyph);
      } catch {
        kern = 0;
      }
      if (Number.isFinite(kern)) penXMM += kern * scale;
    }

    const commands = glyph.path?.commands ?? [];
    if (commands.length > 0) {
      const result = glyphContours(
        commands,
        { scale, originXMM: penXMM, baselineYMM },
        chordToleranceMM,
      );
      degenerateDropped += result.degenerateDropped;
      if (!result.windingAgreesWithNesting) oddWinding = true;
      result.contours.forEach((c: Contour, contourIndex: number) => {
        runs.push({
          points: c.points,
          char: ch,
          glyphIndex,
          contourIndex,
          lineIndex,
          role: c.role,
          areaSigned: c.areaSigned,
        });
      });
    }

    const advanceUnits = Number.isFinite(glyph.advanceWidth) ? (glyph.advanceWidth as number) : 0;
    penXMM += advanceUnits * scale + letterSpacingMM;
    prevGlyph = glyph;
    glyphIndex += 1;
  }

  if (degenerateDropped > 0) {
    warnings.push(
      `${degenerateDropped} degenerate contour${degenerateDropped === 1 ? '' : 's'} ` +
        'in this face had fewer than three distinct points and were skipped.',
    );
  }
  if (oddWinding) {
    warnings.push(
      'This face draws some counters with the same winding as their outer contour. ' +
        'Holes are still identified by nesting, but a filled preview may look solid.',
    );
  }
  if (missing.length > 0) {
    warnings.push(`This face has no glyph for: ${missing.join(' ')}`);
  }

  return { runs, missing, warnings, mmPerFontUnit: scale };
}

/** Bounding box of emitted outline runs, mm. `null` for an empty set —
 *  the same shape `hersheyRunsBBox` returns, so the caller's centring
 *  code reads the same either way. */
export function outlineRunsBBox(runs: OutlineRun[]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const r of runs) {
    for (const [x, y] of r.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minX, minY, maxX, maxY };
}

/** Translate every run by (dx, dy) mm. Used to centre an insert on the
 *  view box without rebuilding the layout. */
export function translateOutlineRuns(
  runs: OutlineRun[],
  dx: number,
  dy: number,
): OutlineRun[] {
  if (dx === 0 && dy === 0) return runs;
  return runs.map((r) => ({
    ...r,
    points: r.points.map(([x, y]) => [x + dx, y + dy] as [number, number]),
  }));
}
