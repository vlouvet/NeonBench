// Loading an operator-supplied OpenType / TrueType face.
//
// LICENSING IS THE REASON THIS FILE LOOKS LIKE THIS. NeonBench ships no
// font files. Typefaces are licensed, and putting one inside a binary we
// distribute is redistribution — a different licence grant from the one a
// shop bought. So the operator supplies the file from their own machine,
// it is parsed in the browser, and nothing about it is written to the
// project except the outlines the operator chose to insert. There is
// deliberately no "font library", no download button, and no server-side
// font store. `describeLicence` is the sentence the dialog shows so the
// responsibility is stated rather than assumed.
//
// Formats: opentype.js 2.0.0 reads `.ttf`, `.otf` and `.woff`. It does NOT
// read collections (`.ttc`, `.otc`) — measured, not assumed: it throws
// "Unsupported OpenType signature ttcf". Since macOS ships most of its
// system faces as .ttc, that is the error an operator is most likely to
// hit first, so it gets its own message instead of the raw throw.

import type { Font } from 'opentype.js';
import { parse } from 'opentype.js';
import { resolveCapHeight, type CapHeightInfo } from './metrics';

export type LoadedFace = {
  font: Font;
  /** Name the operator picked the file by. Kept for the UI only. */
  fileName: string;
  familyName: string;
  styleName: string;
  unitsPerEm: number;
  numGlyphs: number;
  /** Where the cap height came from and what it measures. See metrics.ts. */
  capHeight: CapHeightInfo;
};

export class FontLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FontLoadError';
  }
}

/** `names` is keyed by name-table platform, and which platforms a face
 *  populates varies: Arial.ttf carries `macintosh` + `windows`, a font
 *  built by opentype.js itself carries `unicode`. Try all three rather
 *  than picking one and shipping "Unknown" for half the world's fonts. */
function pickName(
  names: Font['names'] | undefined,
  key: 'fontFamily' | 'fontSubfamily',
): string | null {
  if (!names) return null;
  for (const platform of ['windows', 'macintosh', 'unicode'] as const) {
    const table = names[platform];
    const record = table?.[key];
    if (!record || typeof record !== 'object') continue;
    const byLang = record as Record<string, string | undefined>;
    const value = byLang.en ?? Object.values(byLang).find((v) => typeof v === 'string');
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return null;
}

/**
 * Parse a font file the operator supplied. Throws {@link FontLoadError}
 * with an operator-readable message — every failure here is something a
 * human did (wrong file, a collection, a corrupt download), not a bug.
 */
export function loadFace(buffer: ArrayBuffer, fileName: string): LoadedFace {
  if (!buffer || buffer.byteLength === 0) {
    throw new FontLoadError(`${fileName} is empty.`);
  }
  let font: Font;
  try {
    font = parse(buffer);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (/ttcf|otto?c|signature\s+ttcf/i.test(msg)) {
      throw new FontLoadError(
        `${fileName} is a font COLLECTION (.ttc/.otc), which bundles several faces in one file. ` +
          'Export or download the single face you want as .ttf or .otf and load that. ' +
          '(Most macOS system fonts are collections.)',
      );
    }
    throw new FontLoadError(`${fileName} could not be read as a font: ${msg}`);
  }

  const upm = Number.isFinite(font.unitsPerEm) && font.unitsPerEm > 0 ? font.unitsPerEm : 0;
  if (upm === 0) {
    throw new FontLoadError(`${fileName} declares no usable units-per-em.`);
  }

  return {
    font,
    fileName,
    familyName: pickName(font.names, 'fontFamily') ?? fileName.replace(/\.[^.]+$/, ''),
    styleName: pickName(font.names, 'fontSubfamily') ?? 'Regular',
    unitsPerEm: upm,
    numGlyphs: font.numGlyphs,
    capHeight: resolveCapHeight(font),
  };
}

/**
 * Characters in `text` the face has no glyph for. opentype.js maps an
 * unmapped codepoint to `.notdef`, which renders as a hollow box or as
 * nothing at all — silently emitting that is exactly the kind of "it
 * returned something so it worked" failure CLAUDE.md warns about, so the
 * dialog lists them instead.
 *
 * Newlines and the space character are layout, not glyphs; they never
 * count as missing.
 */
export function missingChars(face: LoadedFace, text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    let has: boolean;
    try {
      has = face.font.hasChar(ch);
    } catch {
      has = false;
    }
    if (!has) out.push(ch);
  }
  return out;
}

/** The licence sentence the UI shows next to a loaded face. NeonBench
 *  ships no fonts, so the grant that covers converting this face to
 *  outlines is between the shop and the foundry. */
export function describeLicence(face: LoadedFace): string {
  return (
    `${face.familyName} ${face.styleName} was read from your machine and is not stored by NeonBench. ` +
    'Outlines derived from a licensed typeface are covered by your licence with its foundry, ' +
    'not by NeonBench — check that it permits conversion to artwork before you fabricate.'
  );
}
