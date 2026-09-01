import { describe, expect, it } from 'vitest';
import { changeCase, CASE_MODES, CASE_MODE_LABELS } from './changeCase';

describe('changeCase', () => {
  it('uppercases and lowercases the whole entry', () => {
    expect(changeCase('Open 24 Hours', 'upper')).toBe('OPEN 24 HOURS');
    expect(changeCase('Open 24 Hours', 'lower')).toBe('open 24 hours');
  });

  it('title-cases the first letter of every word', () => {
    expect(changeCase('open all night', 'title')).toBe('Open All Night');
  });

  it('leaves interior capitals alone in title case (the McDonald invariant)', () => {
    // The whole point of the "only touch the first letter" rule: a shop
    // name with an interior capital must survive a round-trip.
    expect(changeCase('McDonald', 'title')).toBe('McDonald');
    expect(changeCase(changeCase('McDonald', 'title'), 'title')).toBe('McDonald');
    expect(changeCase("McDonald's Diner", 'title')).toBe("McDonald's Diner");
    // Acronyms too — 3M, BBQ, and an already-caps entry are all no-ops.
    expect(changeCase('BBQ', 'title')).toBe('BBQ');
    expect(changeCase('NEON BAR', 'title')).toBe('NEON BAR');
  });

  it('does not treat an apostrophe as a word boundary', () => {
    expect(changeCase("don't stop", 'title')).toBe("Don't Stop");
  });

  it('capitalises the first LETTER past leading punctuation', () => {
    expect(changeCase('(neon) "bar"', 'title')).toBe('(Neon) "Bar"');
  });

  it('title-cases every line of multi-line input', () => {
    expect(changeCase('open now\nfree parking', 'title')).toBe('Open Now\nFree Parking');
  });

  it('sentence-cases and restarts after . ! and ?', () => {
    expect(changeCase('hello world. goodbye now', 'sentence')).toBe('Hello world. Goodbye now');
    expect(changeCase('wow! amazing? sure', 'sentence')).toBe('Wow! Amazing? Sure');
  });

  it('sentence case restarts after a newline', () => {
    expect(changeCase('open now\nfree parking', 'sentence')).toBe('Open now\nFree parking');
  });

  it('sentence case flattens interior capitals (unlike title case)', () => {
    // Documented divergence: "Sentence case" in every other tool
    // lowercases the body of the sentence, and the mode is meaningless
    // if it does not.
    expect(changeCase('NEON BAR. OPEN LATE', 'sentence')).toBe('Neon bar. Open late');
  });

  it('sentence case skips whitespace and quotes to find the letter', () => {
    expect(changeCase('he said.   "neon"', 'sentence')).toBe('He said.   "Neon"');
  });

  it('handles empty input and digit-only input for every mode', () => {
    for (const mode of CASE_MODES) {
      expect(changeCase('', mode)).toBe('');
      expect(changeCase('2026', mode)).toBe('2026');
    }
  });

  it('never mutates its input and always returns the same length', () => {
    const src = 'McDonald\'s BBQ. open 24h!';
    for (const mode of CASE_MODES) {
      const out = changeCase(src, mode);
      expect(src).toBe("McDonald's BBQ. open 24h!");
      expect(out.length).toBe(src.length);
    }
  });

  it('exposes a label for every mode', () => {
    for (const mode of CASE_MODES) {
      expect(typeof CASE_MODE_LABELS[mode]).toBe('string');
      expect(CASE_MODE_LABELS[mode].length).toBeGreaterThan(0);
    }
  });
});
