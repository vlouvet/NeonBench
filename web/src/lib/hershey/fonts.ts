// Hershey font registry. Indirection so the converter and the dialog
// can both look up font data + display metadata + per-font cap-height
// units from one place. Adding a new face is: drop a JSON via the build
// script, append an entry here.

import rowmans from './rowmans.json' with { type: 'json' };
import rowmand from './rowmand.json' with { type: 'json' };
import futural from './futural.json' with { type: 'json' };
import cursive from './cursive.json' with { type: 'json' };

export type FontKey = 'rowmans' | 'rowmand' | 'futural' | 'cursive';

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
  /** Cap height in JHF source units: the distance from the cap line to
   *  the baseline. `hersheyTextToRuns` scales every glyph by
   *  `capHeightMM / capHeightUnits`, so this number is what makes
   *  `capHeightMM` a literal millimetre measurement of a capital rather
   *  than an arbitrary size knob.
   *
   *  MEASURED, not assumed — `capHeight.test.ts` re-derives it from the
   *  bundled glyph JSON on every run. It was declared as 12 until Bug
   *  #13; the real span is 21, which is why all single-stroke text
   *  rendered 21/12 = 1.75× the requested height. */
  capHeightUnits: number;
  /** JHF source y of the BASELINE. Positive because the Hershey data
   *  hangs its capitals above y=0: a capital runs from
   *  `baselineUnits - capHeightUnits` (cap line) to `baselineUnits`.
   *
   *  Needed because `hersheyTextToRuns`'s `originY` anchors JHF y=0,
   *  which is neither the cap line nor the baseline. Anything wanting a
   *  real cap line must use `originY + (baselineUnits - capHeightUnits)
   *  * scale`. Before Bug #13 that expression happened to equal
   *  `originY - capHeightMM`, so callers hard-coded the shortcut; it
   *  only worked because the declared cap height was wrong. */
  baselineUnits: number;
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
   *  ever ship). Today all four faces use the same 21 units, but the
   *  data model doesn't have to assume that.
   *
   *  Sign convention: NEGATIVE = tighten (shapes move closer), positive
   *  = loosen. Matches per-pair kerning + optical-kern outputs. */
  presetKerning: Record<string, number>;
  /** If true, `hersheyTextToRuns` will attempt to stitch adjacent glyphs
   *  into one continuous run using `joinAdjacentGlyphs`. Cursive faces
   *  set this; all other faces leave glyphs isolated (the historical
   *  Hershey behaviour). Spaces always interrupt joining regardless. */
  joinAdjacent?: boolean;
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

// Cursive face uses joining instead of preset kerning — the connecting
// bridge handles inter-letter spacing automatically. Leave the table
// empty so the dialog's preset-seed path doesn't fight the joiner.
const CURSIVE_PRESET_KERNING: Record<string, number> = {};

// Cap-height metrics per face. All four bundled faces use the standard
// Hershey Roman metric: cap line at JHF y=-12, baseline at y=+9, so a
// capital spans 21 units. (x-height starts at y=-5 for the Roman/sans
// faces and y=0 for cursive; descenders reach y=+16.) Stored per-entry
// so a future face with different metrics doesn't have to be a special
// case — and re-measured from the glyph data by `capHeight.test.ts`,
// because a declared metric that nothing checks is how Bug #13 happened.
export const FONTS: Record<FontKey, FontEntry> = {
  rowmans: {
    key: 'rowmans',
    displayName: 'Roman Simplex (default)',
    capHeightUnits: 21,
    baselineUnits: 9,
    data: rowmans as FontData,
    presetKerning: ROMAN_PRESET_KERNING,
  },
  rowmand: {
    key: 'rowmand',
    displayName: 'Roman Duplex (thicker)',
    capHeightUnits: 21,
    baselineUnits: 9,
    data: rowmand as FontData,
    presetKerning: ROMAN_PRESET_KERNING,
  },
  futural: {
    key: 'futural',
    displayName: 'Sans Simplex (Futural)',
    capHeightUnits: 21,
    baselineUnits: 9,
    data: futural as FontData,
    presetKerning: SANS_PRESET_KERNING,
  },
  cursive: {
    key: 'cursive',
    displayName: 'Cursive (connecting script)',
    capHeightUnits: 21,
    baselineUnits: 9,
    data: cursive as FontData,
    presetKerning: CURSIVE_PRESET_KERNING,
    joinAdjacent: true,
  },
};

export const DEFAULT_FONT: FontKey = 'rowmans';

export function getFont(key: FontKey | undefined): FontEntry {
  return FONTS[key ?? DEFAULT_FONT] ?? FONTS[DEFAULT_FONT];
}
