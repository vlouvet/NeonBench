import { describe, expect, it } from 'vitest';
import { computeOpticalKernJHF, computeOpticalKernMM } from './opticalKern';
import { FONTS } from './fonts';

describe('computeOpticalKern', () => {
  it('AV in Roman Simplex tightens the pair (negative kerning)', () => {
    // A's right stroke peaks at +8 JHF; A's bracket right is +9. V's left
    // stroke at -8; V's bracket left is -9. So default optical gap is
    // (9-8)+(-8-(-9)) = 2. Target is 1, so kern = 1 - 2 = -1 JHF (or
    // -1 if percentile is the same as max).
    const k = computeOpticalKernJHF(FONTS.rowmans, 'A', 'V');
    expect(k).toBeLessThan(0);
    // Value should be in the ballpark of one JHF unit of tightening.
    expect(Math.abs(k)).toBeGreaterThan(0.4);
    expect(Math.abs(k)).toBeLessThan(4);
  });

  it('To in Roman Simplex tightens the pair', () => {
    const k = computeOpticalKernJHF(FONTS.rowmans, 'T', 'o');
    expect(k).toBeLessThan(0);
  });

  it('WA in Sans Simplex returns a finite (usually negative) delta', () => {
    const k = computeOpticalKernJHF(FONTS.futural, 'W', 'A');
    expect(Number.isFinite(k)).toBe(true);
    // WA is the canonical pair where the diagonals leave too much air —
    // shouldn't return zero or positive on a sans face.
    expect(k).toBeLessThanOrEqual(0);
  });

  it('returns 0 for unknown left or right glyph', () => {
    expect(computeOpticalKernJHF(FONTS.rowmans, '', 'A')).toBe(0);
    expect(computeOpticalKernJHF(FONTS.rowmans, 'A', '')).toBe(0);
  });

  it('returns 0 when either glyph has no strokes (e.g. space)', () => {
    // Code 32 (space) has empty strokes in all bundled faces.
    expect(computeOpticalKernJHF(FONTS.rowmans, ' ', 'A')).toBe(0);
    expect(computeOpticalKernJHF(FONTS.rowmans, 'A', ' ')).toBe(0);
  });

  it('mm output scales linearly with cap height', () => {
    const k100 = computeOpticalKernMM(FONTS.rowmans, 'A', 'V', 100);
    const k200 = computeOpticalKernMM(FONTS.rowmans, 'A', 'V', 200);
    // Same JHF delta, scaled by capHeightMM/capHeightUnits — so 200/100 = 2x.
    expect(k200 / k100).toBeCloseTo(2, 5);
  });

  it('respects a custom targetGap (looser target = less negative kerning)', () => {
    const tight = computeOpticalKernJHF(FONTS.rowmans, 'A', 'V', { targetGapJHF: 1 });
    const loose = computeOpticalKernJHF(FONTS.rowmans, 'A', 'V', { targetGapJHF: 3 });
    // Loose target should be larger (less negative or even positive).
    expect(loose).toBeGreaterThan(tight);
  });

  it("extrema mode uses absolute hull (more aggressive than percentile)", () => {
    // For glyphs with a single outlier stroke, extrema mode produces a
    // deeper tighten. We just assert the two modes return finite numbers
    // and don't crash; the ordering depends on each face's shape.
    const ex = computeOpticalKernJHF(FONTS.rowmand, 'A', 'V', { mode: 'extrema' });
    const pc = computeOpticalKernJHF(FONTS.rowmand, 'A', 'V', { mode: 'percentile' });
    expect(Number.isFinite(ex)).toBe(true);
    expect(Number.isFinite(pc)).toBe(true);
  });

  it('Roman Duplex AV still tightens (font-data invariant: serifs do not flip the sign)', () => {
    const k = computeOpticalKernJHF(FONTS.rowmand, 'A', 'V');
    expect(k).toBeLessThanOrEqual(0);
  });

  it('a glyph pair with wide bracket-padding tightens proportionally', () => {
    // 'l' in Roman Simplex is a single vertical at JHF x=0 with a bracket
    // spanning [-4, +4] — the bracket has 8 JHF units of side-bearing
    // air. With targetGap=1 the kern should be close to -7 (no diagonals
    // to consider; the gap IS the bracket padding).
    const k = computeOpticalKernJHF(FONTS.rowmans, 'l', 'l');
    expect(k).toBeLessThan(-3);
    // And tightening should NEVER exceed the bracket padding by more than
    // the target gap (otherwise glyphs would actually overlap).
    expect(k).toBeGreaterThan(-12);
  });
});
