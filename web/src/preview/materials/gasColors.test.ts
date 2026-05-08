import { describe, expect, it } from 'vitest';
import {
  GAS_COLORS,
  gasToEmissiveColor,
  isBlockoutColor,
} from './gasColors';

// gasToEmissiveColor is a pure lookup: trim + lowercase + direct hit
// → substring fallback → warm-white default. The tests exercise each
// branch so future edits to the resolution order surface as failures
// rather than silent drift.

describe('gasToEmissiveColor', () => {
  it('returns the table entry for a direct match', () => {
    expect(gasToEmissiveColor('ruby red')).toEqual({
      color: '#ff2233',
      intensity: 1.5,
    });
  });

  it('is case-insensitive', () => {
    expect(gasToEmissiveColor('RUBY RED')).toEqual({
      color: '#ff2233',
      intensity: 1.5,
    });
    expect(gasToEmissiveColor('Ruby Red')).toEqual({
      color: '#ff2233',
      intensity: 1.5,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(gasToEmissiveColor('  ruby red  ')).toEqual({
      color: '#ff2233',
      intensity: 1.5,
    });
  });

  it('does substring fallback for suffixed strings', () => {
    // "ruby red 8mm" should still pick the "ruby red" entry.
    expect(gasToEmissiveColor('ruby red 8mm')).toEqual({
      color: '#ff2233',
      intensity: 1.5,
    });
  });

  it('prefers the longest matching key on substring fallback', () => {
    // "warm white tube" contains both "warm white" (10 chars) and
    // "white" (5 chars); the longer key must win.
    expect(gasToEmissiveColor('warm white tube')).toEqual({
      color: '#fff0d0',
      intensity: 1.5,
    });
  });

  it('returns the warm-white fallback for unknown gas strings', () => {
    expect(gasToEmissiveColor('plasma blast')).toEqual({
      color: '#fff0d0',
      intensity: 0.75,
    });
  });

  it('returns the warm-white fallback for an empty string', () => {
    expect(gasToEmissiveColor('')).toEqual({
      color: '#fff0d0',
      intensity: 0.75,
    });
  });

  it('returns the warm-white fallback for whitespace-only input', () => {
    expect(gasToEmissiveColor('   ')).toEqual({
      color: '#fff0d0',
      intensity: 0.75,
    });
  });

  it('returns the warm-white fallback for null / undefined', () => {
    expect(gasToEmissiveColor(null)).toEqual({
      color: '#fff0d0',
      intensity: 0.75,
    });
    expect(gasToEmissiveColor(undefined)).toEqual({
      color: '#fff0d0',
      intensity: 0.75,
    });
  });

  it('resolves every entry in the GAS_COLORS table by its own key', () => {
    // Cheap smoke test — guarantees the table and resolver agree on
    // every documented gas, so a future typo (or duplicate key) shows
    // up as a vitest failure instead of a silent fallback at runtime.
    for (const [key, hex] of Object.entries(GAS_COLORS)) {
      expect(gasToEmissiveColor(key)).toEqual({
        color: hex,
        intensity: 1.5,
      });
    }
  });

  // Tier 1 #67 — every editor-picker slug must resolve to a non-fallback
  // emissive. Without the EDITOR_COLOR_TO_GAS bridge these fell through
  // to warm-white at 0.75 intensity and the preview was useless for
  // anything but white tubes.
  describe('editor color slug bridge', () => {
    const editorSlugToExpectedHex: Record<string, string> = {
      'classic-red': '#ff5520', // → "neon (red)"
      'ruby-red':    '#ff2233', // → "ruby red"
      'hot-pink':    '#ff80a0', // → "rose pink"
      'orange':      '#ff7733', // → "neon orange"
      'yellow':      '#ffe040', // → "lemon yellow"
      'green':       '#7fff00', // → "lime green"
      'aqua':        '#33ddcc', // → "turquoise"
      'blue':        '#3355ff', // → "cobalt blue"
      'purple':      '#7733ff', // → "royal purple"
      'white':       '#eeeeee', // → "white"
    };

    for (const [slug, hex] of Object.entries(editorSlugToExpectedHex)) {
      it(`bridges editor slug "${slug}" to a calibrated emissive hex`, () => {
        expect(gasToEmissiveColor(slug)).toEqual({
          color: hex,
          intensity: 1.5,
        });
      });
    }

    it('regression: ruby-red must NOT resolve to the warm-white fallback', () => {
      const result = gasToEmissiveColor('ruby-red');
      expect(result.color).not.toBe('#fff0d0');
      expect(result.intensity).toBe(1.5);
    });
  });
});

describe('isBlockoutColor', () => {
  it('matches the literal string "blockout"', () => {
    expect(isBlockoutColor('blockout')).toBe(true);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(isBlockoutColor('BLOCKOUT')).toBe(true);
    expect(isBlockoutColor('  Blockout  ')).toBe(true);
  });

  it('returns false for any other gas name', () => {
    expect(isBlockoutColor('ruby red')).toBe(false);
    expect(isBlockoutColor('blockout paint')).toBe(false); // not a substring match
  });

  it('returns false for empty / null / undefined', () => {
    expect(isBlockoutColor('')).toBe(false);
    expect(isBlockoutColor(null)).toBe(false);
    expect(isBlockoutColor(undefined)).toBe(false);
  });
});
