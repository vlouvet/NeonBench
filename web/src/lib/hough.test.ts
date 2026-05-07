import { describe, expect, it } from 'vitest';
import { estimateSkewDegrees, __test__ } from './hough';

// Build an RGBA buffer of WxH white pixels with `bars` evenly-spaced black
// horizontal bars (each `barThickness` pixels tall) rotated by `tiltDeg`
// around the image centre. A pixel ends up black iff its (rotated) y
// distance from the nearest bar centre is less than barThickness/2.
function makeTiltedBars(
  width: number,
  height: number,
  tiltDeg: number,
  bars = 5,
  barThickness = 4,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  // Default: all-white opaque.
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 255;
  }
  const cx = width / 2;
  const cy = height / 2;
  const rad = (tiltDeg * Math.PI) / 180;
  const cosT = Math.cos(rad);
  const sinT = Math.sin(rad);
  // Spacing chosen to give 5 evenly-spaced bars across the height.
  const spacing = height / (bars + 1);
  const barCenters: number[] = [];
  for (let i = 1; i <= bars; i++) barCenters.push(i * spacing - cy);

  const half = barThickness / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rx = x - cx;
      const ry = y - cy;
      // Rotate by -tilt so a "horizontal bar at +tilt" reads as a bar in
      // the rotated frame at y = barCenter.
      const ry2 = -rx * sinT + ry * cosT;
      let isBar = false;
      for (let b = 0; b < barCenters.length; b++) {
        if (Math.abs(ry2 - barCenters[b]) < half) {
          isBar = true;
          break;
        }
      }
      if (isBar) {
        const idx = (y * width + x) * 4;
        buf[idx] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 255;
      }
    }
  }
  return buf;
}

function makeNoiseBuffer(width: number, height: number, seed: number): Uint8ClampedArray {
  // Simple LCG so the test is deterministic.
  let s = seed >>> 0;
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const r = s & 0xff;
    s = (s * 1664525 + 1013904223) >>> 0;
    const g = s & 0xff;
    s = (s * 1664525 + 1013904223) >>> 0;
    const b = s & 0xff;
    buf[i] = r;
    buf[i + 1] = g;
    buf[i + 2] = b;
    buf[i + 3] = 255;
  }
  return buf;
}

describe('estimateSkewDegrees', () => {
  it('detects +5° tilted horizontal bars', () => {
    const W = 200;
    const H = 200;
    const buf = makeTiltedBars(W, H, 5);
    const result = estimateSkewDegrees(buf, W, H);
    expect(result).not.toBeNull();
    expect(result!.angleDeg).toBeGreaterThanOrEqual(4);
    expect(result!.angleDeg).toBeLessThanOrEqual(6);
    expect(result!.confidence).toBeGreaterThanOrEqual(3.0);
  });

  it('detects -3° tilted horizontal bars', () => {
    const W = 200;
    const H = 200;
    const buf = makeTiltedBars(W, H, -3);
    const result = estimateSkewDegrees(buf, W, H);
    expect(result).not.toBeNull();
    expect(result!.angleDeg).toBeGreaterThanOrEqual(-4);
    expect(result!.angleDeg).toBeLessThanOrEqual(-2);
    expect(result!.confidence).toBeGreaterThanOrEqual(3.0);
  });

  it('returns near-zero for already-aligned bars', () => {
    const W = 200;
    const H = 200;
    const buf = makeTiltedBars(W, H, 0);
    const result = estimateSkewDegrees(buf, W, H);
    expect(result).not.toBeNull();
    expect(Math.abs(result!.angleDeg)).toBeLessThanOrEqual(1);
  });

  it('rejects pure-noise input as low confidence', () => {
    const W = 200;
    const H = 200;
    const buf = makeNoiseBuffer(W, H, 0xdeadbeef);
    const result = estimateSkewDegrees(buf, W, H);
    expect(result).toBeNull();
  });

  it('returns null when the dominant tilt is outside the search range', () => {
    const W = 200;
    const H = 200;
    const buf = makeTiltedBars(W, H, 30);
    const result = estimateSkewDegrees(buf, W, H, { searchRangeDeg: 15 });
    expect(result).toBeNull();
  });

  it('thetaToRotation folds (-90, +90] into (-45, +45]', () => {
    const f = __test__.thetaToRotation;
    // Values inside (-45, +45] are pass-through.
    expect(f(0)).toBe(0);
    expect(f(5)).toBe(5);
    expect(f(-5)).toBe(-5);
    expect(f(45)).toBe(45);
    // Theta near +90° (a horizontal line) folds to near 0°.
    expect(f(89)).toBeCloseTo(-1, 6);
    expect(f(-89)).toBeCloseTo(1, 6);
    // Theta near +50° folds to near -40°.
    expect(f(50)).toBeCloseTo(-40, 6);
    expect(f(-50)).toBeCloseTo(40, 6);
    // Wraps from outside (-90, +90].
    expect(f(180)).toBe(0);
    expect(f(-180)).toBe(0);
  });
});
