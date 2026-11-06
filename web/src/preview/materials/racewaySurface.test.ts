import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  BLOOM_CONTENT_FLOOR,
  fractionAboveLuminance,
  LUMA_B,
  LUMA_G,
  LUMA_R,
} from '../bloomMetric';
import { BLOOM_LUMINANCE_THRESHOLD } from '../Scene';
import {
  RACEWAY_BRIGHTEST_LIGHTING,
  RACEWAY_COLOR,
  RACEWAY_EMISSIVE,
  RACEWAY_METALNESS,
  RACEWAY_ROUGHNESS,
  hexToRGB8,
  linearToSrgb8,
  racewayPeakLinearEstimate,
  srgb8ToLinear,
} from './racewaySurface';

// Tier 3 #138 — the raceway is scene chrome, not glass. These pin the
// property that matters: a raceway-only frame gives `bloomMetric.ts` nothing
// to act on, so the box cannot glow and cannot trip the capture guard into
// enforcing on a frame that has no neon in it.
//
// The pixel values come from `racewayPeakLinearEstimate` (a shading estimate
// at the brightest configuration the sidebar allows), not from a GPU — web/
// has no renderer. The real-render measurement is recorded in the PR.

/** A whole frame filled with the raceway's estimated peak pixel. */
function peakFrame(colorHex: string, roughness: number): Uint8ClampedArray {
  const lin = racewayPeakLinearEstimate(
    colorHex,
    roughness,
    RACEWAY_BRIGHTEST_LIGHTING,
  );
  const px = lin.map(linearToSrgb8);
  const buf = new Uint8ClampedArray(64 * 64 * 4);
  for (let o = 0; o < buf.length; o += 4) {
    buf[o] = px[0];
    buf[o + 1] = px[1];
    buf[o + 2] = px[2];
    buf[o + 3] = 255;
  }
  return buf;
}

describe('raceway material — the bloom delta is unmoved by the raceway', () => {
  it('is not emissive', () => {
    expect(RACEWAY_EMISSIVE).toBe('#000000');
    expect(RACEWAY_METALNESS).toBe(0);
  });

  it('a raceway-only frame stays under the bloom content floor', () => {
    const frame = peakFrame(RACEWAY_COLOR, RACEWAY_ROUGHNESS);
    expect(fractionAboveLuminance(frame, BLOOM_LUMINANCE_THRESHOLD)).toBeLessThan(
      BLOOM_CONTENT_FLOOR,
    );
  });

  it('never reaches the Bloom pass luminance threshold in linear light', () => {
    // The Bloom effect thresholds the LINEAR buffer; below the threshold its
    // contribution is exactly zero, so the box adds no halo at all.
    const [r, g, b] = racewayPeakLinearEstimate(
      RACEWAY_COLOR,
      RACEWAY_ROUGHNESS,
      RACEWAY_BRIGHTEST_LIGHTING,
    );
    expect(LUMA_R * r + LUMA_G * g + LUMA_B * b).toBeLessThan(
      BLOOM_LUMINANCE_THRESHOLD,
    );
  });

  it('negative control: a white or glossy raceway WOULD trip the metric', () => {
    // If these pass, the assertion above is measuring something.
    const white = peakFrame('#ffffff', RACEWAY_ROUGHNESS);
    expect(fractionAboveLuminance(white, BLOOM_LUMINANCE_THRESHOLD)).toBe(1);
    // The editor's own raceway wash colour is too bright for the 3D scene —
    // the reason RACEWAY_COLOR is darker than it.
    const editorGrey = peakFrame('#9a8f7a', RACEWAY_ROUGHNESS);
    expect(fractionAboveLuminance(editorGrey, BLOOM_LUMINANCE_THRESHOLD)).toBe(1);
    // Same colour, glassy finish: the specular hot spot crosses the line.
    const glossy = peakFrame(RACEWAY_COLOR, 0.3);
    expect(fractionAboveLuminance(glossy, BLOOM_LUMINANCE_THRESHOLD)).toBe(1);
  });

  it('assumes three r155+ physically-correct lights (Lambert divides by π)', () => {
    // The estimate's diffuse term is albedo·E/π. Under the pre-r155 legacy
    // light units it would be albedo·E and the estimate would be ~3× low.
    expect(Number(THREE.REVISION)).toBeGreaterThanOrEqual(155);
  });
});

describe('raceway material — colour helpers', () => {
  it('round-trips sRGB through linear', () => {
    for (let c = 0; c <= 255; c += 17) {
      expect(linearToSrgb8(srgb8ToLinear(c))).toBe(c);
    }
  });

  it('parses #rrggbb and rejects anything else', () => {
    expect(hexToRGB8('#6e6a63')).toEqual([0x6e, 0x6a, 0x63]);
    expect(() => hexToRGB8('grey')).toThrow();
  });
});
