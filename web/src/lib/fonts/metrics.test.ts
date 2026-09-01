import { describe, expect, it } from 'vitest';
import {
  CAP_HEIGHT_DISAGREEMENT_WARN,
  EM_FRACTION_FALLBACK,
  capHeightWarning,
  mmPerUnit,
  resolveCapHeight,
  type CapHeightFontLike,
} from './metrics';
import { SYNTH_CAP_UNITS, SYNTH_UPM, synthFace } from './synthFont';

// Bug #13 was a DECLARED metric that did not match the DATA it claimed to
// describe: `capHeightUnits: 12` against faces that measure 21, so every
// letter came out 1.75x too tall. The fix there was to assert the
// constant against the bundled data. There is no bundled data here — the
// operator brings the font — so the equivalent guarantee is that the
// number we scale by is READ OUT OF THE FONT, and these tests pin which
// branch produced it.

function stub(over: Partial<CapHeightFontLike> & { hHeight?: number | null }): CapHeightFontLike {
  const { hHeight = null, ...rest } = over;
  return {
    unitsPerEm: 1000,
    tables: {},
    charToGlyph: () => ({
      getBoundingBox: () => ({ y1: 0, y2: hHeight ?? 0 }),
    }),
    ...rest,
  } as CapHeightFontLike;
}

describe('resolveCapHeight', () => {
  it('measures the H ink on a real parsed face', () => {
    const face = synthFace();
    expect(face.capHeight.source).toBe('measured-H');
    expect(face.capHeight.capHeightUnits).toBe(SYNTH_CAP_UNITS);
    expect(face.capHeight.measuredUnits).toBe(SYNTH_CAP_UNITS);
  });

  it('prefers the measured H over a disagreeing OS/2 declaration', () => {
    const info = resolveCapHeight(
      stub({ tables: { os2: { sCapHeight: 900 } }, hHeight: 700 }),
    );
    expect(info.source).toBe('measured-H');
    expect(info.capHeightUnits).toBe(700);
    expect(info.declaredUnits).toBe(900);
    expect(info.disagreementRatio).toBeCloseTo(200 / 700, 12);
    expect(capHeightWarning(info)).toMatch(/Sizing follows the outline/);
  });

  it('stays quiet when the declaration is within the slop threshold', () => {
    // Arial.ttf, measured on this machine with opentype.js 2.0.0:
    // OS/2 sCapHeight 1467 against an 'H' that measures 1466 units of
    // 2048. One unit — real, and not worth a warning.
    const info = resolveCapHeight(
      stub({ unitsPerEm: 2048, tables: { os2: { sCapHeight: 1467 } }, hHeight: 1466 }),
    );
    expect(info.capHeightUnits).toBe(1466);
    expect(info.disagreementRatio).toBeLessThan(CAP_HEIGHT_DISAGREEMENT_WARN);
    expect(capHeightWarning(info)).toBeNull();
  });

  it('warns on a face whose declaration is genuinely off', () => {
    // Apple Symbols.ttf, measured on this machine: declares 1119,
    // its 'H' measures 1102 — 1.5%, comfortably over the threshold.
    const info = resolveCapHeight(
      stub({ unitsPerEm: 2048, tables: { os2: { sCapHeight: 1119 } }, hHeight: 1102 }),
    );
    expect(info.disagreementRatio).toBeGreaterThan(CAP_HEIGHT_DISAGREEMENT_WARN);
    expect(capHeightWarning(info)).toMatch(/1\.5%/);
  });

  it('falls back to OS/2 when the face has no H to measure', () => {
    const face = synthFace({ omitH: true });
    expect(face.capHeight.measuredUnits).toBeNull();
    expect(face.capHeight.source).toBe('os2-sCapHeight');
    expect(face.capHeight.capHeightUnits).toBeGreaterThan(0);
    expect(capHeightWarning(face.capHeight)).toMatch(/no 'H' outline/);
  });

  it('falls back to a fraction of the em when the face offers neither', () => {
    const info = resolveCapHeight(stub({ unitsPerEm: 2048, hHeight: 0 }));
    expect(info.source).toBe('em-fraction-fallback');
    expect(info.capHeightUnits).toBe(2048 * EM_FRACTION_FALLBACK);
    expect(capHeightWarning(info)).toMatch(/approximate/);
  });

  it('ignores a zero or negative OS/2 declaration', () => {
    for (const bad of [0, -100, Number.NaN]) {
      const info = resolveCapHeight(
        stub({ tables: { os2: { sCapHeight: bad } }, hHeight: 0 }),
      );
      expect(info.declaredUnits).toBeNull();
      expect(info.source).toBe('em-fraction-fallback');
    }
  });

  it('survives a face whose charToGlyph throws', () => {
    const broken = {
      unitsPerEm: 1000,
      tables: { os2: { sCapHeight: 640 } },
      charToGlyph: () => {
        throw new Error('broken cmap');
      },
    } as unknown as CapHeightFontLike;
    const info = resolveCapHeight(broken);
    expect(info.source).toBe('os2-sCapHeight');
    expect(info.capHeightUnits).toBe(640);
  });
});

describe('mmPerUnit', () => {
  it('is exactly the identity the cap-height promise rests on', () => {
    const face = synthFace();
    for (const mm of [1, 25.4, 100, 250, 1200]) {
      const scale = mmPerUnit(face.capHeight, mm);
      expect(scale * face.capHeight.capHeightUnits).toBeCloseTo(mm, 10);
    }
  });

  it('never derives the scale from unitsPerEm when an H exists', () => {
    // The Bug #13 shape: a plausible constant that is not the data.
    // 0.7 x 1000 = 700, but the synthetic H measures 660, so a scale
    // built from the em would be 700/660 = 1.06x too small.
    const face = synthFace();
    expect(SYNTH_CAP_UNITS).not.toBe(SYNTH_UPM * EM_FRACTION_FALLBACK);
    expect(mmPerUnit(face.capHeight, 100)).toBeCloseTo(100 / SYNTH_CAP_UNITS, 12);
    expect(mmPerUnit(face.capHeight, 100)).not.toBeCloseTo(
      100 / (SYNTH_UPM * EM_FRACTION_FALLBACK),
      6,
    );
  });

  it('returns 0 for a degenerate cap height rather than Infinity', () => {
    expect(
      mmPerUnit(
        {
          capHeightUnits: 0,
          source: 'em-fraction-fallback',
          declaredUnits: null,
          measuredUnits: null,
          disagreementRatio: null,
        },
        100,
      ),
    ).toBe(0);
  });
});
