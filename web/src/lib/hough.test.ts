import { describe, expect, it } from 'vitest';
import { estimateSkewDegrees, houghPeaks, __test__ } from './hough';

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

// Build a buffer with BOTH a near-horizontal and a near-vertical band of bars.
// The horizontal bars are tilted by `hTilt`° (their normals near 90°), the
// vertical bars by `vTilt`° (their normals near 0°). Useful for exercising
// the multi-peak path: a perfect grid produces two strong Hough ridges, one
// in each sub-window.
function makeGridBars(
  width: number,
  height: number,
  hTilt: number,
  vTilt: number,
  bars = 5,
  barThickness = 4,
): Uint8ClampedArray {
  const buf = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < buf.length; i += 4) {
    buf[i] = 255;
    buf[i + 1] = 255;
    buf[i + 2] = 255;
    buf[i + 3] = 255;
  }
  const cx = width / 2;
  const cy = height / 2;
  const hRad = (hTilt * Math.PI) / 180;
  const vRad = (vTilt * Math.PI) / 180;
  const hCos = Math.cos(hRad);
  const hSin = Math.sin(hRad);
  const vCos = Math.cos(vRad);
  const vSin = Math.sin(vRad);
  const hSpacing = height / (bars + 1);
  const vSpacing = width / (bars + 1);
  const hCenters: number[] = [];
  for (let i = 1; i <= bars; i++) hCenters.push(i * hSpacing - cy);
  const vCenters: number[] = [];
  for (let i = 1; i <= bars; i++) vCenters.push(i * vSpacing - cx);

  const half = barThickness / 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const rx = x - cx;
      const ry = y - cy;
      const ryH = -rx * hSin + ry * hCos;
      const rxV = rx * vCos + ry * vSin;
      let isBar = false;
      for (let b = 0; b < hCenters.length; b++) {
        if (Math.abs(ryH - hCenters[b]) < half) {
          isBar = true;
          break;
        }
      }
      if (!isBar) {
        for (let b = 0; b < vCenters.length; b++) {
          if (Math.abs(rxV - vCenters[b]) < half) {
            isBar = true;
            break;
          }
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

describe('houghPeaks', () => {
  it('returns up to k peaks ranked by confidence (descending)', () => {
    const W = 200;
    const H = 200;
    const buf = makeGridBars(W, H, 5, -2, 5, 4);
    const peaks = houghPeaks(buf, W, H, { k: 2 });
    expect(peaks.length).toBeGreaterThanOrEqual(1);
    expect(peaks.length).toBeLessThanOrEqual(2);
    // Peaks must be in non-increasing confidence order.
    for (let i = 1; i < peaks.length; i++) {
      expect(peaks[i].confidence).toBeLessThanOrEqual(peaks[i - 1].confidence);
    }
    // Each peak's confidence clears the default threshold (3.0).
    for (const peak of peaks) {
      expect(peak.confidence).toBeGreaterThanOrEqual(3.0);
    }
  });

  it('surfaces both ridges of a strong grid as two distinct peaks', () => {
    const W = 200;
    const H = 200;
    const buf = makeGridBars(W, H, 5, -2, 5, 4);
    const peaks = houghPeaks(buf, W, H, { k: 2 });
    expect(peaks.length).toBe(2);
    // The two peaks shouldn't be sitting on top of each other — for a
    // grid, one ridge corresponds to the horizontal-bar tilt (folds to
    // near 5°) and the other to the vertical-bar tilt (folds to near
    // -2°). At minimum they're at least a few degrees apart.
    expect(Math.abs(peaks[0].angleDeg - peaks[1].angleDeg)).toBeGreaterThan(2);
  });

  it('respects the k cap', () => {
    const W = 200;
    const H = 200;
    const buf = makeGridBars(W, H, 5, -2, 5, 4);
    const single = houghPeaks(buf, W, H, { k: 1 });
    expect(single.length).toBeLessThanOrEqual(1);
    const five = houghPeaks(buf, W, H, { k: 5 });
    // Even when asked for 5, only ridges with confidence >= threshold and
    // separated by NMS get returned. Two is the realistic ceiling for a
    // simple grid.
    expect(five.length).toBeGreaterThanOrEqual(1);
    expect(five.length).toBeLessThanOrEqual(5);
  });

  it('matches estimateSkewDegrees for k=1', () => {
    const W = 200;
    const H = 200;
    const buf = makeTiltedBars(W, H, 5);
    const single = estimateSkewDegrees(buf, W, H);
    const peaks = houghPeaks(buf, W, H, { k: 1 });
    expect(peaks.length).toBe(1);
    expect(single).not.toBeNull();
    expect(peaks[0].angleDeg).toBe(single!.angleDeg);
    expect(peaks[0].confidence).toBe(single!.confidence);
  });

  it('returns an empty array for degenerate (all-black) input', () => {
    const W = 200;
    const H = 200;
    const buf = new Uint8ClampedArray(W * H * 4);
    for (let i = 0; i < buf.length; i += 4) {
      buf[i] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = 255;
    }
    expect(houghPeaks(buf, W, H, { k: 2 })).toEqual([]);
  });

  it('returns an empty array for pure-noise input', () => {
    const W = 200;
    const H = 200;
    const buf = makeNoiseBuffer(W, H, 0xdeadbeef);
    expect(houghPeaks(buf, W, H, { k: 2 })).toEqual([]);
  });

  it('handles ties deterministically (lower bin wins)', () => {
    // For a perfectly aligned grid both ridges have the same accumulator
    // peak. The function must still return both without crashing — and
    // because the peak search scans in ascending bin order, the first-
    // bin tie breaks deterministically rather than non-deterministically.
    const W = 200;
    const H = 200;
    const buf = makeGridBars(W, H, 0, 0, 5, 4);
    const peaks = houghPeaks(buf, W, H, { k: 2 });
    // Two strong, equal ridges — both should clear the threshold.
    expect(peaks.length).toBe(2);
    // Ties allowed: each peak's confidence is >= the next.
    expect(peaks[0].confidence).toBeGreaterThanOrEqual(peaks[1].confidence);
  });
});
