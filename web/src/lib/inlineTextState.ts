// Tier 2 #101 — inline canvas text: the pure state layer.
//
// WHY A SEPARATE MODULE: `web/`'s test suite is deliberately pure-logic
// (no jsdom, no testing-library — 700 tests in ~1s). A caret that lives
// inside EditorCanvas can only be tested by driving a browser, so
// everything except the SVG markup and the DOM event plumbing lives
// here, where vitest can reach it.
//
// WHAT THIS IS NOT: a second text engine. `hersheyTextToRuns` remains
// the only thing that turns characters into strokes — this module owns
// a string, a caret index and a kerning array, and hands all three to
// that function. The one rule the modal (`HersheyTextDialog`) enforces
// for itself applies here too: the runs the canvas DRAWS and the runs
// the canvas COMMITS are the same value, so the preview cannot drift
// from what lands in the doc.
//
// CARET GEOMETRY: the caret X is the pen position after laying out the
// prefix `text.slice(0, caret)`. That walk has to agree with the one in
// `hersheyTextToRuns` exactly — same skip rules, same kerning-slot
// accounting, same negative-kern floor — or the caret drifts away from
// the glyphs as you type. `inlineTextState.test.ts` pins it against the
// real engine rather than against a copy of these numbers.

import { FONTS, getFont, type FontEntry, type FontKey } from './hershey/fonts';
import { hersheyTextToRuns, type HersheyRun } from './hershey/text';

export type InlineTextSession = {
  /** X (mm) of the left bracket of the first glyph on every line. */
  originX: number;
  /** Y (mm) that JHF y=0 maps to on the FIRST line — i.e. exactly the
   *  `originY` argument of `hersheyTextToRuns`, NOT the baseline. Use
   *  `baselineOffsetMM` to convert between the two; the shortcut
   *  `originY - capHeightMM` is Bug #13's ghost and is wrong. */
  originY: number;
  text: string;
  /** Insertion point as an index into `text` (0 … text.length). */
  caret: number;
  font: FontKey;
  capHeightMM: number;
  lineHeight: number;
  /** Dense, length = visibleGlyphCount - 1. Same index space and same
   *  meaning as the modal's array: slot i is the gap between the i-th
   *  and (i+1)-th visible glyphs, newlines excluded, spaces INCLUDED
   *  (a space is a real glyph in the JHF data — it has left/right
   *  brackets and no strokes — so it consumes a slot). */
  perPairKerningMM: number[];
  /** Parallel to `perPairKerningMM`: true where the operator has
   *  explicitly kerned that slot. Preset re-seeding skips those, which
   *  is the same user-override-survives rule `HersheyTextDialog`'s
   *  `applySeed` implements. */
  kernTouched: boolean[];
};

export type InlineTextDefaults = {
  font: FontKey;
  capHeightMM: number;
  lineHeight: number;
};

/** The subset of KeyboardEvent this module reads. Keeps the helper (and
 *  its tests) free of DOM types. */
export type KeyEventLike = {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
};

export type InlineKeyResult =
  /** Not ours — the caller must let the event through untouched. */
  | { kind: 'ignored' }
  /** Consumed; carry on typing with this session. */
  | { kind: 'update'; session: InlineTextSession }
  /** Consumed, and the operator asked to finish: commit this session. */
  | { kind: 'commit'; session: InlineTextSession };

/** One Alt+Arrow press moves a kerning slot by this fraction of the cap
 *  height (2 mm at a 100 mm cap). Holding Shift multiplies it by
 *  `KERN_COARSE_MULTIPLIER`. Expressed as a fraction so the feel of the
 *  key does not change when the operator changes size. */
export const KERN_STEP_FRACTION = 1 / 50;
export const KERN_COARSE_MULTIPLIER = 5;

/** Distance (mm) from JHF y=0 down to the typographic baseline. */
export function baselineOffsetMM(font: FontEntry, capHeightMM: number): number {
  return font.baselineUnits * (capHeightMM / font.capHeightUnits);
}

/**
 * Start a session with the caret at a clicked point.
 *
 * `x`/`y` are where the operator clicked, and they mean "the start of
 * the first line's BASELINE" — the same thing a text cursor means in
 * every other program. `originY` is derived from it, because
 * `hersheyTextToRuns` anchors JHF y=0 rather than the baseline.
 */
export function startSession(
  x: number,
  y: number,
  defaults: InlineTextDefaults,
): InlineTextSession {
  const font = getFont(defaults.font);
  return {
    originX: x,
    originY: y - baselineOffsetMM(font, defaults.capHeightMM),
    text: '',
    caret: 0,
    font: defaults.font,
    capHeightMM: defaults.capHeightMM,
    lineHeight: defaults.lineHeight,
    perPairKerningMM: [],
    kernTouched: [],
  };
}

/** The strokes for a session. The canvas draws THIS and commits THIS —
 *  there is deliberately no second path that could disagree. */
export function sessionRuns(s: InlineTextSession): HersheyRun[] {
  if (!s.text) return [];
  return hersheyTextToRuns({
    text: s.text,
    font: s.font,
    capHeightMM: s.capHeightMM,
    originX: s.originX,
    originY: s.originY,
    lineHeight: s.lineHeight,
    perPairKerningMM: s.perPairKerningMM,
    // FALSE for the same reason the modal passes false: presets are
    // already baked into `perPairKerningMM` by `seedKerning`, and
    // turning this on would apply them twice.
    applyPresetKerning: false,
  });
}

/** True when the session would commit nothing (empty, or only
 *  characters that emit no ink — spaces and newlines). */
export function isSessionEmpty(s: InlineTextSession): boolean {
  return sessionRuns(s).length === 0;
}

/** The characters that occupy a slot in the visible-glyph index space:
 *  in `[32,127]`, present in the face, newlines excluded. Mirrors
 *  `collectVisibleChars` in `hershey/text.ts` — including the part
 *  people trip over, that ASCII space counts. */
export function visibleGlyphs(text: string, fontKey: FontKey): string[] {
  const font = getFont(fontKey);
  const out: string[] = [];
  for (const ch of text) {
    if (ch === '\n') continue;
    const code = ch.codePointAt(0);
    if (code === undefined || code < 32 || code > 127) continue;
    if (!font.data.glyphs[String(code)]) continue;
    out.push(ch);
  }
  return out;
}

/** How many visible glyphs sit strictly before `caret`. Also the index
 *  of the glyph the next typed character becomes. */
export function visibleGlyphsBefore(
  text: string,
  caret: number,
  fontKey: FontKey,
): number {
  return visibleGlyphs(text.slice(0, caret), fontKey).length;
}

/**
 * Re-seed the kerning arrays for `text`.
 *
 * Same rule as `HersheyTextDialog.applySeed`, deliberately: slots the
 * operator has touched keep their value (by index), every other slot is
 * re-filled from the face's preset table, and the arrays are trimmed or
 * grown to `visibleGlyphs - 1`. Two editors that disagreed about this
 * would hand the same document two different kern arrays.
 */
export function seedKerning(
  text: string,
  fontKey: FontKey,
  capHeightMM: number,
  prevKern: number[],
  prevTouched: boolean[],
): { perPairKerningMM: number[]; kernTouched: boolean[] } {
  const visible = visibleGlyphs(text, fontKey);
  const slots = Math.max(0, visible.length - 1);
  const font = FONTS[fontKey];
  const scale = capHeightMM / font.capHeightUnits;
  const kern = new Array<number>(slots).fill(0);
  const touched = new Array<boolean>(slots).fill(false);
  for (let i = 0; i < slots; i++) {
    if (prevTouched[i] === true) {
      touched[i] = true;
      kern[i] = prevKern[i] ?? 0;
      continue;
    }
    const preset = font.presetKerning[visible[i] + visible[i + 1]];
    kern[i] = typeof preset === 'number' ? preset * scale : 0;
  }
  return { perPairKerningMM: kern, kernTouched: touched };
}

/** Replace the text + caret, re-seeding kerning for the new glyph run. */
export function retext(
  s: InlineTextSession,
  text: string,
  caret: number,
): InlineTextSession {
  const seeded = seedKerning(text, s.font, s.capHeightMM, s.perPairKerningMM, s.kernTouched);
  return {
    ...s,
    text,
    caret: Math.max(0, Math.min(caret, text.length)),
    perPairKerningMM: seeded.perPairKerningMM,
    kernTouched: seeded.kernTouched,
  };
}

export function insertText(s: InlineTextSession, chunk: string): InlineTextSession {
  const next = s.text.slice(0, s.caret) + chunk + s.text.slice(s.caret);
  return retext(s, next, s.caret + chunk.length);
}

export function deleteBackward(s: InlineTextSession): InlineTextSession {
  if (s.caret === 0) return s;
  const next = s.text.slice(0, s.caret - 1) + s.text.slice(s.caret);
  return retext(s, next, s.caret - 1);
}

export function deleteForward(s: InlineTextSession): InlineTextSession {
  if (s.caret >= s.text.length) return s;
  const next = s.text.slice(0, s.caret) + s.text.slice(s.caret + 1);
  return retext(s, next, s.caret);
}

// -- caret movement -------------------------------------------------------

function lineStart(text: string, caret: number): number {
  const nl = text.lastIndexOf('\n', caret - 1);
  return nl < 0 ? 0 : nl + 1;
}

function lineEnd(text: string, caret: number): number {
  const nl = text.indexOf('\n', caret);
  return nl < 0 ? text.length : nl;
}

export function moveCaret(
  s: InlineTextSession,
  how: 'left' | 'right' | 'up' | 'down' | 'home' | 'end',
): InlineTextSession {
  const { text, caret } = s;
  switch (how) {
    case 'left':
      return caret === 0 ? s : { ...s, caret: caret - 1 };
    case 'right':
      return caret >= text.length ? s : { ...s, caret: caret + 1 };
    case 'home':
      return { ...s, caret: lineStart(text, caret) };
    case 'end':
      return { ...s, caret: lineEnd(text, caret) };
    case 'up': {
      const start = lineStart(text, caret);
      if (start === 0) return { ...s, caret: 0 };
      const col = caret - start;
      const prevStart = lineStart(text, start - 1);
      const prevEnd = start - 1;
      return { ...s, caret: Math.min(prevStart + col, prevEnd) };
    }
    case 'down': {
      const end = lineEnd(text, caret);
      if (end >= text.length) return { ...s, caret: text.length };
      const col = caret - lineStart(text, caret);
      const nextStart = end + 1;
      const nextEnd = lineEnd(text, nextStart);
      return { ...s, caret: Math.min(nextStart + col, nextEnd) };
    }
  }
}

// -- kerning at the caret -------------------------------------------------

/**
 * The kerning slot the caret sits in, or null when it is not between
 * two glyphs (start of the text, end of the text, or a text with fewer
 * than two glyphs).
 *
 * Slot i is the gap AFTER visible glyph i, so a caret with `n` visible
 * glyphs behind it sits in slot `n - 1`.
 */
export function kernSlotAtCaret(s: InlineTextSession): number | null {
  const before = visibleGlyphsBefore(s.text, s.caret, s.font);
  const total = visibleGlyphs(s.text, s.font).length;
  const slot = before - 1;
  if (slot < 0 || slot >= total - 1) return null;
  return slot;
}

/** Nudge the caret's kerning slot by `deltaMM`. No-op when the caret is
 *  not between two glyphs. Marks the slot user-touched so a later
 *  re-seed does not overwrite it — matching the modal's drag. */
export function adjustKernAtCaret(s: InlineTextSession, deltaMM: number): InlineTextSession {
  const slot = kernSlotAtCaret(s);
  if (slot === null) return s;
  const kern = s.perPairKerningMM.slice();
  const touched = s.kernTouched.slice();
  while (kern.length <= slot) kern.push(0);
  while (touched.length <= slot) touched.push(false);
  // Floor matches `hersheyTextToRuns`'s own `kernFloor`: the engine
  // clamps at apply time, so without the same clamp here the number the
  // HUD reports would keep marching past the geometry.
  kern[slot] = Math.max(kern[slot] + deltaMM, -s.capHeightMM);
  touched[slot] = true;
  return { ...s, perPairKerningMM: kern, kernTouched: touched };
}

// -- layout metrics -------------------------------------------------------

export type CaretMetrics = {
  /** Pen X (mm) after the prefix — where the next glyph's left bracket
   *  would land. */
  x: number;
  /** JHF y=0 for the caret's line. */
  anchorY: number;
  /** Typographic baseline Y (mm) for the caret's line. */
  baselineY: number;
  /** Cap-line Y (mm) for the caret's line. */
  capTopY: number;
  lineIndex: number;
};

/**
 * Lay out the prefix before the caret and report where the caret sits.
 *
 * This walk MIRRORS `hersheyTextToRuns`: identical skip rules (control
 * and non-ASCII characters and unmapped codes advance nothing and
 * consume no slot), identical advance (`(right - left) * scale`),
 * identical kerning-slot accounting, identical negative-kern floor.
 * `inlineTextState.test.ts` proves the mirror by comparing against the
 * strokes the engine actually emits.
 */
export function caretMetrics(s: InlineTextSession): CaretMetrics {
  const font = getFont(s.font);
  const scale = s.capHeightMM / font.capHeightUnits;
  const kernFloor = -s.capHeightMM;
  let cursorX = s.originX;
  let anchorY = s.originY;
  let lineIndex = 0;
  let pairIdx = 0;
  const prefix = s.text.slice(0, s.caret);
  for (const ch of prefix) {
    if (ch === '\n') {
      anchorY += s.capHeightMM * s.lineHeight;
      lineIndex++;
      cursorX = s.originX;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === undefined || code < 32 || code > 127) continue;
    const glyph = font.data.glyphs[String(code)];
    if (!glyph) continue;
    cursorX += (glyph.right - glyph.left) * scale;
    const k = s.perPairKerningMM[pairIdx];
    if (typeof k === 'number' && Number.isFinite(k)) cursorX += Math.max(k, kernFloor);
    pairIdx++;
  }
  return {
    x: cursorX,
    anchorY,
    baselineY: anchorY + font.baselineUnits * scale,
    capTopY: anchorY + (font.baselineUnits - font.capHeightUnits) * scale,
    lineIndex,
  };
}

// -- keyboard -------------------------------------------------------------

function isPrintable(key: string): boolean {
  // Named keys ('Enter', 'ArrowLeft', 'Dead', …) are longer than one
  // code point; a printable character is exactly one.
  return Array.from(key).length === 1;
}

/**
 * Does an active caret consume this key?
 *
 * THE POINT OF THIS PREDICATE: the editor binds a pile of bare-key
 * shortcuts — `o` (break/move opening), `c` (connect tubes), `j` / `k` /
 * `[` / `]` (issue nav), Delete/Backspace (delete the selected runs or
 * guideline), Escape, Enter — spread across BOTH `EditorPage` and
 * `EditorCanvas`. A text caret claims every printable key, so typing
 * "open channel" would otherwise switch tools twice and delete a run
 * mid-word. Everything this returns true for is swallowed (capture
 * phase, `stopPropagation`) while the caret is live, and nothing is
 * swallowed while it is not — see `suppressesGlobalShortcut`.
 *
 * Cmd/Ctrl combinations are deliberately NOT consumed: Cmd+S, Cmd+Z and
 * friends keep working while typing.
 */
export function consumesKey(e: KeyEventLike): boolean {
  const meta = !!e.metaKey || !!e.ctrlKey;
  if (meta) return false;
  if (e.altKey) {
    // Alt+Arrow is inline kerning; every other Alt combination belongs
    // to the browser / OS.
    return e.key === 'ArrowLeft' || e.key === 'ArrowRight';
  }
  switch (e.key) {
    case 'Escape':
    case 'Enter':
    case 'Backspace':
    case 'Delete':
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Home':
    case 'End':
      return true;
    case 'Tab':
      // Leave focus traversal alone — the operator needs a way out to
      // the toolbar that does not type a character.
      return false;
    default:
      return isPrintable(e.key);
  }
}

/** The suppression rule itself, as one testable expression: a key is
 *  taken away from the global shortcut handlers only while a caret is
 *  actually live. */
export function suppressesGlobalShortcut(active: boolean, e: KeyEventLike): boolean {
  return active && consumesKey(e);
}

/** Fold one key press into the session. */
export function applyKey(s: InlineTextSession, e: KeyEventLike): InlineKeyResult {
  if (!consumesKey(e)) return { kind: 'ignored' };
  if (e.altKey) {
    const dir = e.key === 'ArrowRight' ? 1 : -1;
    const step =
      s.capHeightMM * KERN_STEP_FRACTION * (e.shiftKey ? KERN_COARSE_MULTIPLIER : 1);
    return { kind: 'update', session: adjustKernAtCaret(s, dir * step) };
  }
  switch (e.key) {
    // Escape COMMITS. Losing a typed word to a stray key is the failure
    // mode operators actually hit; undo is the way back, and it is one
    // step because nothing was written to the doc until now.
    case 'Escape':
      return { kind: 'commit', session: s };
    case 'Enter':
      return { kind: 'update', session: insertText(s, '\n') };
    case 'Backspace':
      return { kind: 'update', session: deleteBackward(s) };
    case 'Delete':
      return { kind: 'update', session: deleteForward(s) };
    case 'ArrowLeft':
      return { kind: 'update', session: moveCaret(s, 'left') };
    case 'ArrowRight':
      return { kind: 'update', session: moveCaret(s, 'right') };
    case 'ArrowUp':
      return { kind: 'update', session: moveCaret(s, 'up') };
    case 'ArrowDown':
      return { kind: 'update', session: moveCaret(s, 'down') };
    case 'Home':
      return { kind: 'update', session: moveCaret(s, 'home') };
    case 'End':
      return { kind: 'update', session: moveCaret(s, 'end') };
    default:
      return { kind: 'update', session: insertText(s, e.key) };
  }
}

/** Convenience for tests and for driving a session from a string. */
export function typeString(s: InlineTextSession, text: string): InlineTextSession {
  let cur = s;
  for (const ch of text) {
    const r = applyKey(cur, { key: ch === '\n' ? 'Enter' : ch });
    if (r.kind === 'update' || r.kind === 'commit') cur = r.session;
  }
  return cur;
}
