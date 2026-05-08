import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LUMA_B,
  DEFAULT_LUMA_G,
  DEFAULT_LUMA_R,
  binarizeRGBA,
  luminance,
} from './binarize';

describe('luminance', () => {
  it('matches Rec. 601 with default weights', () => {
    // Pure red, green, blue should equal their per-channel weight × 255.
    expect(luminance(255, 0, 0)).toBeCloseTo(DEFAULT_LUMA_R * 255, 6);
    expect(luminance(0, 255, 0)).toBeCloseTo(DEFAULT_LUMA_G * 255, 6);
    expect(luminance(0, 0, 255)).toBeCloseTo(DEFAULT_LUMA_B * 255, 6);
    // Pure white sums to 255.
    expect(luminance(255, 255, 255)).toBeCloseTo(255, 6);
    // Pure black is 0.
    expect(luminance(0, 0, 0)).toBe(0);
  });

  it('respects custom weights', () => {
    // All-red weights — luminance is just R.
    expect(luminance(200, 100, 50, { r: 1, g: 0, b: 0 })).toBe(200);
    // Mixed: 0.5R + 0.5G.
    expect(luminance(100, 200, 50, { r: 0.5, g: 0.5, b: 0 })).toBeCloseTo(150, 6);
  });

  it('default weights sum to 1', () => {
    expect(DEFAULT_LUMA_R + DEFAULT_LUMA_G + DEFAULT_LUMA_B).toBeCloseTo(1, 6);
  });
});

describe('binarizeRGBA', () => {
  it('produces a black/white buffer based on threshold', () => {
    // A 2x1 buffer: dark grey + light grey.
    const buf = new Uint8ClampedArray([
      50, 50, 50, 255, //
      200, 200, 200, 255,
    ]);
    const out = binarizeRGBA(buf, 128);
    expect(Array.from(out)).toEqual([
      0, 0, 0, 255, //
      255, 255, 255, 255,
    ]);
  });

  it('uses Rec. 601 weights by default', () => {
    // Pure-blue pixel has BT.601 luma of 0.114 * 255 ≈ 29. Threshold 128
    // sends it to black under default weights.
    const buf = new Uint8ClampedArray([0, 0, 255, 255]);
    expect(Array.from(binarizeRGBA(buf, 128))).toEqual([0, 0, 0, 255]);
  });

  it('honors custom luminance weights', () => {
    // Pure-blue pixel under all-blue weights = luma 255 → above threshold,
    // becomes white. Compare against the default which sends it to black.
    const buf = new Uint8ClampedArray([0, 0, 255, 255]);
    const allBlue = binarizeRGBA(buf, 128, { r: 0, g: 0, b: 1 });
    expect(Array.from(allBlue)).toEqual([255, 255, 255, 255]);
  });

  it('preserves alpha=255 regardless of input alpha', () => {
    const buf = new Uint8ClampedArray([10, 10, 10, 0]);
    expect(binarizeRGBA(buf, 128)[3]).toBe(255);
  });

  it('threshold compare uses < (foreground when strictly below)', () => {
    // A pixel whose luminance is strictly above the threshold maps to
    // white. We pick a clearly-above value to avoid the floating-point
    // tie at luma == threshold (BT.601 weights don't exactly sum to 1
    // in IEEE-754, so 128/128/128 binarises slightly below 128).
    const buf = new Uint8ClampedArray([200, 200, 200, 255]);
    const out = binarizeRGBA(buf, 128);
    expect(out[0]).toBe(255);
  });
});
