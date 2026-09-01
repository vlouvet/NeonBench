// Minimal ambient types for opentype.js 2.0.0.
//
// WHY hand-written instead of `@types/opentype.js`: the DefinitelyTyped
// package tracks the 1.x API and would be a SECOND dependency to justify
// under CLAUDE.md's "new third-party dependencies" rule. opentype.js 2.0
// ships no types of its own. What we actually use is a dozen members, so
// declaring exactly those is smaller, honest about the version we pinned,
// and fails loudly if the surface moves under us.
//
// Everything here was read off `node_modules/opentype.js/dist/opentype.mjs`
// at version 2.0.0 — do not widen it from memory.

declare module 'opentype.js' {
  /** One command of a glyph outline. Coordinates are in FONT UNITS with
   *  the y-axis pointing UP (the OpenType convention), unless the path
   *  came from `Glyph.getPath()`, which bakes in a scale and a y-flip.
   *  We read `glyph.path.commands` directly and do our own transform, so
   *  everything this codebase sees from here is y-up font units. */
  export type PathCommand =
    | { type: 'M'; x: number; y: number }
    | { type: 'L'; x: number; y: number }
    | { type: 'Q'; x1: number; y1: number; x: number; y: number }
    | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
    | { type: 'Z' };

  export class Path {
    commands: PathCommand[];
    unitsPerEm?: number;
    moveTo(x: number, y: number): void;
    lineTo(x: number, y: number): void;
    quadraticCurveTo(x1: number, y1: number, x: number, y: number): void;
    curveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    close(): void;
  }

  export type BoundingBox = { x1: number; y1: number; x2: number; y2: number };

  export class Glyph {
    constructor(options: {
      name?: string;
      unicode?: number;
      unicodes?: number[];
      advanceWidth?: number;
      path?: Path;
    });
    index: number;
    name: string | null;
    unicode?: number;
    advanceWidth?: number;
    path: Path;
    getBoundingBox(): BoundingBox;
  }

  /** OS/2 is the table that carries the declared cap height. `version`
   *  matters: `sCapHeight` only exists from OS/2 version 2 onward, and a
   *  font that predates it (or that a foundry filled in carelessly) is
   *  exactly the case `resolveCapHeight` has to survive. */
  export type OS2Table = {
    version?: number;
    sCapHeight?: number;
    sxHeight?: number;
    sTypoAscender?: number;
    sTypoDescender?: number;
  };

  export type NameRecord = Record<string, string | undefined>;
  export type NameTable = {
    fontFamily?: NameRecord;
    fontSubfamily?: NameRecord;
    [key: string]: unknown;
  };

  export class Font {
    constructor(options: {
      familyName: string;
      styleName: string;
      unitsPerEm: number;
      ascender: number;
      descender: number;
      glyphs: Glyph[];
    });
    unitsPerEm: number;
    ascender: number;
    descender: number;
    numGlyphs: number;
    glyphs: { length: number; get(index: number): Glyph };
    tables: { os2?: OS2Table; head?: Record<string, unknown>; [key: string]: unknown };
    names: { unicode?: NameTable; macintosh?: NameTable; windows?: NameTable };
    kerningPairs: Record<string, number>;
    charToGlyph(c: string): Glyph;
    getKerningValue(left: Glyph | number, right: Glyph | number): number;
    toArrayBuffer(): ArrayBuffer;
  }

  export function parse(buffer: ArrayBuffer, options?: Record<string, unknown>): Font;
}
