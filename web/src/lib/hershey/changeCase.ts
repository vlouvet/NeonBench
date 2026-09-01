// One-shot case transforms for the Hershey text dialog's entry box.
//
// These operate on the RAW TEXT, not on strokes — they run before
// `hersheyTextToRuns`, which is why they live in their own module rather
// than in layout.ts (which is strictly geometry). The dialog wires them
// to a button row: the user clicks "Title", the textarea contents are
// rewritten, and they can keep editing afterwards. There is deliberately
// no persistent "case mode" — a sticky mode would fight manual edits.

export type CaseMode = 'upper' | 'lower' | 'title' | 'sentence';

export const CASE_MODES: readonly CaseMode[] = ['upper', 'lower', 'title', 'sentence'];

/** Human label for each mode, rendered verbatim on the dialog buttons. */
export const CASE_MODE_LABELS: Record<CaseMode, string> = {
  upper: 'UPPER',
  lower: 'lower',
  title: 'Title',
  sentence: 'Sentence',
};

/**
 * Rewrite `text` in the requested case.
 *
 * - `upper` / `lower` — plain `toUpperCase()` / `toLowerCase()`.
 *
 * - `title` — uppercase the FIRST LETTER of each whitespace-delimited
 *   word and leave every other character exactly as typed. That rule is
 *   deliberate: it means an interior capital survives, so "McDonald"
 *   round-trips unchanged and "OPEN" stays "OPEN". The cost is that
 *   title-casing an all-caps entry is a no-op — the user hits "lower"
 *   first, then "Title". Destroying interior capitals is the worse
 *   failure for shop signage ("McDonald's", "3M", "BBQ"), so we take
 *   the no-op.
 *
 *   Word boundaries are whitespace only, NOT punctuation — otherwise
 *   "don't" becomes "Don'T". Leading punctuation is skipped so
 *   "(neon)" becomes "(Neon)".
 *
 * - `sentence` — lowercase everything, then uppercase the first letter
 *   of each sentence. Sentence starts are: the start of the string,
 *   anything after `.`, `!` or `?`, and anything after a newline.
 *   Intervening whitespace, quotes and brackets don't end the pending
 *   start, so `he said. "neon"` becomes `He said. "Neon"`.
 *   Unlike `title`, this one DOES flatten interior capitals — that is
 *   what every other tool's "Sentence case" does, and the mode is
 *   meaningless otherwise.
 *
 * Pure: never mutates its input.
 */
export function changeCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'upper':
      return text.toUpperCase();
    case 'lower':
      return text.toLowerCase();
    case 'title':
      return titleCase(text);
    case 'sentence':
      return sentenceCase(text);
    default:
      return text;
  }
}

/** True for characters that can carry a case distinction. We only ship
 *  ASCII glyphs, but the textarea accepts anything, so test with the
 *  Unicode-aware round-trip rather than an A–Z range: a pasted "é" is
 *  still a letter even though the renderer will drop it. */
function isCased(ch: string): boolean {
  return ch.toLowerCase() !== ch.toUpperCase();
}

function titleCase(text: string): string {
  const out = text.split('');
  // `atWordStart` stays true through leading punctuation so the first
  // *letter* of the token gets the capital, not the bracket.
  let atWordStart = true;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (/\s/.test(ch)) {
      atWordStart = true;
      continue;
    }
    if (atWordStart && isCased(ch)) {
      out[i] = ch.toUpperCase();
      atWordStart = false;
      continue;
    }
    // A non-cased, non-space character (digit, punctuation) does NOT
    // consume the pending capital — "(neon" still capitalises the n.
    if (isCased(ch)) atWordStart = false;
  }
  return out.join('');
}

const SENTENCE_ENDERS = new Set(['.', '!', '?']);

function sentenceCase(text: string): string {
  const out = text.toLowerCase().split('');
  let atSentenceStart = true;
  for (let i = 0; i < out.length; i++) {
    const ch = out[i];
    if (ch === '\n') {
      // A newline is a hard sentence break: shop signage is written one
      // phrase per line and each line reads as its own sentence.
      atSentenceStart = true;
      continue;
    }
    if (SENTENCE_ENDERS.has(ch)) {
      atSentenceStart = true;
      continue;
    }
    if (atSentenceStart && isCased(ch)) {
      out[i] = ch.toUpperCase();
      atSentenceStart = false;
    }
    // Whitespace, quotes and brackets fall through without clearing the
    // flag, so `. "neon"` still capitalises the n.
  }
  return out.join('');
}
