// Hershey font registry. Indirection so the converter and the dialog
// can both look up font data + display metadata + per-font cap-height
// units from one place. Adding a new face is: drop a JSON via the build
// script, append an entry here.

import rowmans from './rowmans.json' with { type: 'json' };
import rowmand from './rowmand.json' with { type: 'json' };
import futural from './futural.json' with { type: 'json' };

export type FontKey = 'rowmans' | 'rowmand' | 'futural';

export type Glyph = {
  left: number;
  right: number;
  strokes: number[][][]; // [stroke][point][xy]
};

export type FontData = {
  _license: string;
  glyphs: Record<string, Glyph>;
};

export type FontEntry = {
  key: FontKey;
  displayName: string;
  capHeightUnits: number; // JHF units; one cap-height in source coordinates
  data: FontData;
  /** Static "preset" pair-kerning table. Keys are 2-char strings (the
   *  literal pair, e.g. 'AV', 'To', 'WA'); values are kerning offsets in
   *  JHF SOURCE units (NOT mm) so the table is cap-height independent.
   *  The text dialog scales each value by capHeightMM/capHeightUnits at
   *  apply time.
   *
   *  Why JHF units, not a normalised "fraction of cap height"? Because
   *  Hershey side-bearings are already integers in JHF; pinning the
   *  preset to integer JHF values means a "−1 unit" tighten is the same
   *  visual amount across faces with different cap-height-units (if any
   *  ever ship). Today all three faces use 12 units, but the data model
   *  doesn't have to assume that.
   *
   *  Sign convention: NEGATIVE = tighten (shapes move closer), positive
   *  = loosen. Matches per-pair kerning + optical-kern outputs. */
  presetKerning: Record<string, number>;
};

// Pair-kerning preset tables. Values in JHF source units (negative =
// tighten). The starter set covers the canonical "white-air" pairs every
// type designer kerns first: diagonals beside diagonals (AV/VA/AW/WA),
// uppercase-followed-by-lowercase-round (To/Ta/Te/Ty/Yo/Wo), and the
// classic LT/LV/PA pairs. Tuned by-eye against the bundled font data —
// the user can still drag any slot to override post-insert.
//
// We deliberately keep this list small (~22 pairs). Bigger preset tables
// drift quickly across faces and are better generated dynamically with
// the optical-kern helper (which is why "Auto-kern this line" exists).
const ROMAN_PRESET_KERNING: Record<string, number> = {
  AV: -2, VA: -2, AW: -2, WA: -2, AY: -2, YA: -2, AT: -1, TA: -1,
  LV: -2, LY: -2, LT: -1, LW: -2, PA: -2, FA: -1,
  To: -2, Ta: -1, Te: -1, Ty: -1, Tr: -1, Yo: -2, Ya: -1, Wo: -2,
};

// Sans faces have less side-bearing slop than the Roman serif look, so
// we kern slightly less aggressively. Same shape pairs — different magnitudes.
const SANS_PRESET_KERNING: Record<string, number> = {
  AV: -1, VA: -1, AW: -1, WA: -1, AY: -1, YA: -1, AT: -1, TA: -1,
  LV: -1, LY: -1, LT: -1, LW: -1, PA: -1, FA: -1,
  To: -1, Ta: -1, Te: -1, Ty: -1, Tr: -1, Yo: -1, Ya: -1, Wo: -1,
};

// Cap-height units per face. All Hershey simplex/duplex faces we ship
// run from y=-12 (cap top) to y=0 (baseline), so cap-height = 12. Stored
// per-entry so a future face with different metrics doesn't have to be a
// special case.
export const FONTS: Record<FontKey, FontEntry> = {
  rowmans: {
    key: 'rowmans',
    displayName: 'Roman Simplex (default)',
    capHeightUnits: 12,
    data: rowmans as FontData,
    presetKerning: ROMAN_PRESET_KERNING,
  },
  rowmand: {
    key: 'rowmand',
    displayName: 'Roman Duplex (thicker)',
    capHeightUnits: 12,
    data: rowmand as FontData,
    presetKerning: ROMAN_PRESET_KERNING,
  },
  futural: {
    key: 'futural',
    displayName: 'Sans Simplex (Futural)',
    capHeightUnits: 12,
    data: futural as FontData,
    presetKerning: SANS_PRESET_KERNING,
  },
};

export const DEFAULT_FONT: FontKey = 'rowmans';

export function getFont(key: FontKey | undefined): FontEntry {
  return FONTS[key ?? DEFAULT_FONT] ?? FONTS[DEFAULT_FONT];
}
