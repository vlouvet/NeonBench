// Cap height for an operator-supplied OpenType face.
//
// THE WHOLE POINT OF THIS FILE: when the operator types "100" into the
// cap-height box, a capital H on the printed pattern must measure 100 mm
// with a tape. Nothing else in here matters more than that.
//
// Bug #13 is the cautionary tale one layer down: `hershey/fonts.ts`
// DECLARED `capHeightUnits: 12` while every bundled face actually measured
// 21 JHF units, so every piece of single-stroke text came out 21/12 = 1.75×
// the requested size, and it shipped. The lesson written into CLAUDE.md is
// "when a constant claims to describe data, assert it against that data".
//
// The same trap exists in OpenType, just with a table instead of a
// constant: OS/2 `sCapHeight` is a NUMBER A FOUNDRY TYPED IN, not a
// measurement. Measured on this machine with opentype.js 2.0.0:
//
//   font                       OS/2 sCapHeight   measured 'H' ink
//   Arial.ttf (upm 2048)       1467              1466       ← disagrees
//   Georgia.ttf (upm 2048)     1419              1419
//   Times New Roman (upm 2048) 1356              1356
//   SFNS.ttf (upm 2048)        1443              1443
//
// Arial is off by one unit. That is only 0.07 % — 99.93 mm instead of
// 100 mm — but it is proof that the declared number and the ink are
// different quantities, and it means "scale by sCapHeight" cannot satisfy
// the round-trip assertion for every font.
//
// So the resolution order is: MEASURE the 'H' ink and scale by that;
// use the declared OS/2 `sCapHeight` when the font has no 'H' to measure
// (icon faces, non-Latin faces, a blank 'H'); fall back to a fraction of
// the em only when the font offers neither. `source` says which branch
// ran and `disagreementRatio` reports how far the declaration was from the
// ink, so the UI can tell the operator when a face is describing itself
// badly instead of silently absorbing it.
//
// Both of the first two branches read the font's OWN tables — `glyf`/`CFF`
// via the glyph bounding box is as much "the font's own data" as OS/2 is,
// and it is the half of it that the bender actually holds a tape to.

import type { Font } from 'opentype.js';

export type CapHeightSource =
  /** Ink height of the 'H' glyph. Preferred: it is the thing being measured. */
  | 'measured-H'
  /** OS/2 sCapHeight. Used when there is no 'H' outline to measure. */
  | 'os2-sCapHeight'
  /** 0.7 × unitsPerEm. Last resort; flagged to the operator. */
  | 'em-fraction-fallback';

export type CapHeightInfo = {
  /** Font units that one cap height spans. The mm-per-unit scale is
   *  `capHeightMM / capHeightUnits` — that identity is the round trip. */
  capHeightUnits: number;
  source: CapHeightSource;
  /** OS/2 sCapHeight exactly as declared, or null when absent/unusable. */
  declaredUnits: number | null;
  /** Ink height of 'H' in font units, or null when there is no 'H' ink. */
  measuredUnits: number | null;
  /** |declared - measured| / measured, or null when one side is missing.
   *  Anything above CAP_HEIGHT_DISAGREEMENT_WARN is worth telling the
   *  operator about — the face is mis-describing itself. */
  disagreementRatio: number | null;
};

/** Above this relative gap between OS/2 sCapHeight and the measured 'H'
 *  we surface a warning. 0.5 % clears Arial's 1-unit-in-2048 slop and
 *  still catches a face that is genuinely wrong. */
export const CAP_HEIGHT_DISAGREEMENT_WARN = 0.005;

/** Fraction of the em used when a face has neither an 'H' nor a usable
 *  OS/2 sCapHeight. ~0.7 is the common ratio for Latin text faces; it is
 *  a guess and `source` says so. */
export const EM_FRACTION_FALLBACK = 0.7;

/** The slice of an opentype.js Font this module needs. Narrow on purpose:
 *  the unit tests build stubs for the disagreement / missing-table cases,
 *  which no real font on the machine would reproduce on demand. */
export type CapHeightFontLike = {
  unitsPerEm: number;
  tables: { os2?: { sCapHeight?: number } | undefined };
  charToGlyph(c: string): { getBoundingBox(): { y1: number; y2: number } } | undefined;
};

export function resolveCapHeight(font: CapHeightFontLike | Font): CapHeightInfo {
  const f = font as CapHeightFontLike;
  const declaredRaw = f.tables?.os2?.sCapHeight;
  const declaredUnits =
    typeof declaredRaw === 'number' && Number.isFinite(declaredRaw) && declaredRaw > 0
      ? declaredRaw
      : null;

  let measuredUnits: number | null = null;
  try {
    const h = f.charToGlyph('H');
    const bb = h?.getBoundingBox();
    if (bb && Number.isFinite(bb.y1) && Number.isFinite(bb.y2)) {
      const height = bb.y2 - bb.y1;
      // A missing glyph resolves to .notdef, and a blank .notdef has a
      // zero-height box. Treat "no ink" as "nothing to measure".
      if (height > 0) measuredUnits = height;
    }
  } catch {
    // charToGlyph throws on fonts with a broken cmap. Fall through to the
    // declared value; a parse-level failure is reported by the loader.
    measuredUnits = null;
  }

  const disagreementRatio =
    declaredUnits !== null && measuredUnits !== null
      ? Math.abs(declaredUnits - measuredUnits) / measuredUnits
      : null;

  if (measuredUnits !== null) {
    return {
      capHeightUnits: measuredUnits,
      source: 'measured-H',
      declaredUnits,
      measuredUnits,
      disagreementRatio,
    };
  }
  if (declaredUnits !== null) {
    return {
      capHeightUnits: declaredUnits,
      source: 'os2-sCapHeight',
      declaredUnits,
      measuredUnits,
      disagreementRatio,
    };
  }
  const upm = Number.isFinite(f.unitsPerEm) && f.unitsPerEm > 0 ? f.unitsPerEm : 1000;
  return {
    capHeightUnits: upm * EM_FRACTION_FALLBACK,
    source: 'em-fraction-fallback',
    declaredUnits,
    measuredUnits,
    disagreementRatio,
  };
}

/** Millimetres per font unit for a requested cap height. This single
 *  expression is the round trip the tests pin: scale × capHeightUnits
 *  === capHeightMM, and capHeightUnits is the measured 'H' ink, so the
 *  emitted 'H' is capHeightMM tall. */
export function mmPerUnit(info: CapHeightInfo, capHeightMM: number): number {
  if (!(info.capHeightUnits > 0)) return 0;
  return capHeightMM / info.capHeightUnits;
}

/** Human-readable note for the UI when the face describes itself badly,
 *  or when we had to guess. `null` when everything agrees. */
export function capHeightWarning(info: CapHeightInfo): string | null {
  if (info.source === 'em-fraction-fallback') {
    return `This face declares no cap height and has no 'H' to measure — sizing falls back to ${EM_FRACTION_FALLBACK} × em, so the letter height is approximate.`;
  }
  if (info.source === 'os2-sCapHeight') {
    return "This face has no 'H' outline to measure — sizing uses the declared OS/2 cap height.";
  }
  if (
    info.disagreementRatio !== null &&
    info.disagreementRatio > CAP_HEIGHT_DISAGREEMENT_WARN
  ) {
    const pct = (info.disagreementRatio * 100).toFixed(1);
    return `This face declares a cap height ${pct}% away from its own 'H' outline. Sizing follows the outline, so the printed 'H' matches the number you typed.`;
  }
  return null;
}
