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
