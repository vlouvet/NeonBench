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
//
// Per-gas intensity (Tier 1 #69): each gas resolves to a tuned
// emissiveIntensity that compensates for bloom amplifying brighter
// hexes preferentially. The expected intensities below are pinned to
// the calibrated table in gasColors.ts so future tuning shows up as a
// failure to update; an unknown / empty input still falls back to the
// 0.75 "dim warm white" semantic.

// Source-of-truth mirror of GAS_INTENSITY in gasColors.ts. Kept
// duplicated here on purpose — pinning tests against the production
// table by re-importing it would silently rubber-stamp regressions.
const EXPECTED_INTENSITY: Record<string, number> = {
  'ruby red':        1.6,
  'rose pink':       1.5,
  'neon orange':     1.7,
  'sunset orange':   1.6,
  'lemon yellow':    2.0,
  'gold':            2.0,
  'lime green':      2.4,
  'turquoise':       2.4,
  'powder blue':     2.6,
  'cobalt blue':     2.8,
  'royal purple':    2.6,
  'deep magenta':    2.2,
  'neon (red)':      1.8,
  'argon (blue)':    2.6,
  'helium (yellow)': 2.0,
  'krypton (white)': 2.0,
  'xenon (white)':   2.0,
  'white':           1.8,
  'warm white':      1.6,
  'cool white':      2.0,
};

describe('gasToEmissiveColor', () => {
  it('returns the table entry for a direct match', () => {
    expect(gasToEmissiveColor('ruby red')).toEqual({
      color: '#ff2233',
      intensity: 1.6,
    });
  });

  it('is case-insensitive', () => {
    expect(gasToEmissiveColor('RUBY RED')).toEqual({
      color: '#ff2233',
      intensity: 1.6,
    });
    expect(gasToEmissiveColor('Ruby Red')).toEqual({
      color: '#ff2233',
      intensity: 1.6,
    });
  });

  it('trims surrounding whitespace', () => {
    expect(gasToEmissiveColor('  ruby red  ')).toEqual({
      color: '#ff2233',
      intensity: 1.6,
    });
  });

  it('does substring fallback for suffixed strings', () => {
    // "ruby red 8mm" should still pick the "ruby red" entry —
    // including its calibrated 1.6 intensity (Tier 1 #69).
    expect(gasToEmissiveColor('ruby red 8mm')).toEqual({
      color: '#ff2233',
      intensity: 1.6,
    });
  });

  it('substring-hits cobalt blue with the cool-spectrum bump', () => {
    // Cool-spectrum gases get the largest intensity bump (2.8) since
    // bloom under-amplifies their darker base hexes. Pinning this case
    // separately so future bloom-config tweaks can't silently drift it.
    expect(gasToEmissiveColor('cobalt blue 8mm')).toEqual({
      color: '#3355ff',
      intensity: 2.8,
    });
  });

  it('prefers the longest matching key on substring fallback', () => {
    // "warm white tube" contains both "warm white" (10 chars) and
    // "white" (5 chars); the longer key must win — and so must its
    // own calibrated intensity (warm white = 1.6, white = 1.8).
    expect(gasToEmissiveColor('warm white tube')).toEqual({
      color: '#fff0d0',
      intensity: 1.6,
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
    // every documented gas, AND that every gas has a per-gas intensity
    // mapped (rather than silently falling through to DEFAULT_INTENSITY).
    // A future GAS_COLORS addition without a matching GAS_INTENSITY row
    // will fail here, prompting the contributor to calibrate it.
    for (const [key, hex] of Object.entries(GAS_COLORS)) {
      const expectedIntensity = EXPECTED_INTENSITY[key];
      expect(expectedIntensity).toBeDefined();
      expect(gasToEmissiveColor(key)).toEqual({
        color: hex,
        intensity: expectedIntensity,
      });
    }
  });

  // Tier 1 #67 — every editor-picker slug must resolve to a non-fallback
  // emissive. Without the EDITOR_COLOR_TO_GAS bridge these fell through
  // to warm-white at 0.75 intensity and the preview was useless for
  // anything but white tubes.
  //
  // Tier 1 #69 — each slug now pins to its bridged gas's per-gas
  // intensity (not a uniform 1.5). Cool-spectrum slugs (blue, purple,
  // green, aqua) get bigger bumps; warm-spectrum slugs stay near 1.5–1.8.
  describe('editor color slug bridge', () => {
    const editorSlugToExpected: Record<string, { hex: string; intensity: number }> = {
      'classic-red': { hex: '#ff5520', intensity: 1.8 }, // → "neon (red)"
      'ruby-red':    { hex: '#ff2233', intensity: 1.6 }, // → "ruby red"
      'hot-pink':    { hex: '#ff80a0', intensity: 1.5 }, // → "rose pink" (user reference)
      'orange':      { hex: '#ff7733', intensity: 1.7 }, // → "neon orange"
      'yellow':      { hex: '#ffe040', intensity: 2.0 }, // → "lemon yellow"
      'green':       { hex: '#7fff00', intensity: 2.4 }, // → "lime green"
      'aqua':        { hex: '#33ddcc', intensity: 2.4 }, // → "turquoise"
      'blue':        { hex: '#3355ff', intensity: 2.8 }, // → "cobalt blue"
      'purple':      { hex: '#7733ff', intensity: 2.6 }, // → "royal purple"
      'white':       { hex: '#eeeeee', intensity: 1.8 }, // → "white"
    };

    for (const [slug, { hex, intensity }] of Object.entries(editorSlugToExpected)) {
      it(`bridges editor slug "${slug}" to its calibrated emissive (hex + intensity)`, () => {
        expect(gasToEmissiveColor(slug)).toEqual({
          color: hex,
          intensity,
        });
      });
    }

    it('regression: ruby-red must NOT resolve to the warm-white fallback', () => {
      const result = gasToEmissiveColor('ruby-red');
      expect(result.color).not.toBe('#fff0d0');
      expect(result.intensity).toBe(1.6);
    });

    it('regression: cool-spectrum slugs get a bigger bump than rose-pink reference', () => {
      // The whole point of Tier 1 #69 — under bloom, cool gases must
      // resolve to a higher intensity than rose-pink (the user's "looks
      // right" reference) or they read as dull. Pinning this invariant
      // so future re-tuning can't accidentally invert it.
      const rosePink = gasToEmissiveColor('hot-pink').intensity;
      expect(gasToEmissiveColor('blue').intensity).toBeGreaterThan(rosePink);
      expect(gasToEmissiveColor('purple').intensity).toBeGreaterThan(rosePink);
      expect(gasToEmissiveColor('green').intensity).toBeGreaterThan(rosePink);
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
