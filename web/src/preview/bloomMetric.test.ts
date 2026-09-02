import { describe, expect, it } from 'vitest';
import {
  BLOOM_CONTENT_FLOOR,
  BLOOM_DELTA_FLOOR,
  fractionAboveLuminance,
  luminance8,
  meanAbsLuminanceDelta,
  verifyBloomDelta,
} from './bloomMetric';

// Tier 3 #137. These are the arithmetic the headless capture uses to
// decide whether the post-process pass actually landed in the file.
// `web/` has no DOM test environment (deliberately — CLAUDE.md), so the
// metric is written as pure functions over RGBA buffers and exercised
// here with synthetic images that stand in for "bloomed" and "flat"
// renders of the same scene.

/** Build an RGBA buffer from a per-pixel greyscale function. */
function image(
  w: number,
  h: number,
  value: (x: number, y: number) => number,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = value(x, y);
      const o = (y * w + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

const W = 64;
const H = 64;
const CX = 32;
const CY = 32;

function radius(x: number, y: number): number {
  return Math.hypot(x - CX, y - CY);
}

/**
 * "Flat emissive": a hard-edged bright core on a dark ground, which is
 * what the bare `gl.render` path produces — the tube is lit, but there
 * is no halo around it.
 */
const flat = image(W, H, (x, y) => (radius(x, y) <= 4 ? 255 : 10));

/**
 * "Bloomed": the same core plus the falloff halo the EffectComposer
 * pass adds. This is the difference a customer sees and a filename
 * does not record.
 */
const bloomed = image(W, H, (x, y) => {
  const r = radius(x, y);
  if (r <= 4) return 255;
  const halo = Math.max(0, 200 * Math.exp(-((r - 4) ** 2) / 40));
  return 10 + halo;
});

describe('luminance8', () => {
  it('normalises to 0..1 with Rec. 709 weights', () => {
    expect(luminance8(0, 0, 0)).toBe(0);
    expect(luminance8(255, 255, 255)).toBeCloseTo(1, 10);
    // Green carries most of the luma weight; blue the least.
    expect(luminance8(0, 255, 0)).toBeGreaterThan(luminance8(255, 0, 0));
    expect(luminance8(255, 0, 0)).toBeGreaterThan(luminance8(0, 0, 255));
  });
});

describe('meanAbsLuminanceDelta', () => {
  it('is exactly zero for identical buffers', () => {
    // Exactness matters: the bloom guard keys off "the composer pass
    // changed nothing at all", and a fuzzy zero would blur the signal.
    expect(meanAbsLuminanceDelta(flat, flat)).toBe(0);
    expect(meanAbsLuminanceDelta(bloomed, bloomed)).toBe(0);
  });

  it('measures a bloom halo well above the guard floor', () => {
    const delta = meanAbsLuminanceDelta(flat, bloomed);
    expect(delta).toBeGreaterThan(BLOOM_DELTA_FLOOR);
    // Sanity: an order of magnitude of headroom, so the floor is not
    // sitting on top of the signal it is meant to separate from zero.
    expect(delta).toBeGreaterThan(BLOOM_DELTA_FLOOR * 10);
  });

  it('is symmetric', () => {
    expect(meanAbsLuminanceDelta(flat, bloomed)).toBeCloseTo(
      meanAbsLuminanceDelta(bloomed, flat),
      12,
    );
  });

  it('throws on a length mismatch rather than comparing garbage', () => {
    expect(() => meanAbsLuminanceDelta(flat, new Uint8ClampedArray(8))).toThrow(
      /length mismatch/,
    );
  });

  it('returns 0 for empty buffers', () => {
    expect(meanAbsLuminanceDelta(new Uint8ClampedArray(0), new Uint8ClampedArray(0))).toBe(0);
  });
});

describe('fractionAboveLuminance', () => {
  it('finds the emissive core above the bloom threshold', () => {
    // Threshold 0.4 is the shipped `BLOOM_LUMINANCE_THRESHOLD`.
    const f = fractionAboveLuminance(flat, 0.4);
    expect(f).toBeGreaterThan(0);
    // The core is a ~4 px radius disc in a 64×64 frame: ~1.2%.
    expect(f).toBeLessThan(0.05);
  });

  it('is zero for a frame with nothing bright in it', () => {
    const dark = image(W, H, () => 10);
    expect(fractionAboveLuminance(dark, 0.4)).toBe(0);
  });
});

describe('verifyBloomDelta', () => {
  it('accepts a real post-process delta', () => {
    const v = verifyBloomDelta({
      delta: meanAbsLuminanceDelta(flat, bloomed),
      fractionAbove: fractionAboveLuminance(bloomed, 0.4),
    });
    expect(v.ok).toBe(true);
    expect(v.enforced).toBe(true);
  });

  // The negative control. This is the Tier 1 #68 regression expressed as
  // numbers: the "composed" frame is byte-identical to the bare one,
  // because the capture took `gl.render` instead of `composer.render()`.
  // The verdict must refuse, and the reason must name the trap so
  // whoever hits it in CI knows what they broke.
  it('REFUSES when the composer pass changed nothing', () => {
    const v = verifyBloomDelta({
      delta: meanAbsLuminanceDelta(flat, flat),
      fractionAbove: fractionAboveLuminance(flat, 0.4),
    });
    expect(v.ok).toBe(false);
    expect(v.enforced).toBe(true);
    expect(v.reason).toMatch(/bare gl\.render/);
    expect(v.reason).toMatch(/#68/);
  });

  it('skips enforcement when nothing in frame is above the bloom threshold', () => {
    // An empty or very dim design legitimately produces no halo. Failing
    // that capture would be a false alarm, so the guard stands down —
    // and says so, rather than silently reporting success.
    const v = verifyBloomDelta({ delta: 0, fractionAbove: 0 });
    expect(v.ok).toBe(true);
    expect(v.enforced).toBe(false);
    expect(v.reason).toMatch(/not enforced/);
  });

  it('enforces as soon as there is any meaningful bright content', () => {
    const v = verifyBloomDelta({
      delta: 0,
      fractionAbove: BLOOM_CONTENT_FLOOR * 2,
    });
    expect(v.ok).toBe(false);
    expect(v.enforced).toBe(true);
  });

  it('rejects a non-finite delta instead of passing it through', () => {
    const v = verifyBloomDelta({ delta: NaN, fractionAbove: 0.5 });
    expect(v.ok).toBe(false);
  });

  it('honours caller-supplied floors', () => {
    const delta = meanAbsLuminanceDelta(flat, bloomed);
    expect(
      verifyBloomDelta({ delta, fractionAbove: 0.01, deltaFloor: delta * 2 }).ok,
    ).toBe(false);
    expect(
      verifyBloomDelta({ delta, fractionAbove: 0.01, deltaFloor: delta / 2 }).ok,
    ).toBe(true);
  });
});
