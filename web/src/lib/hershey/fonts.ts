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
  },
  rowmand: {
    key: 'rowmand',
    displayName: 'Roman Duplex (thicker)',
    capHeightUnits: 12,
    data: rowmand as FontData,
  },
  futural: {
    key: 'futural',
    displayName: 'Sans Simplex (Futural)',
    capHeightUnits: 12,
    data: futural as FontData,
  },
};

export const DEFAULT_FONT: FontKey = 'rowmans';

export function getFont(key: FontKey | undefined): FontEntry {
  return FONTS[key ?? DEFAULT_FONT] ?? FONTS[DEFAULT_FONT];
}
