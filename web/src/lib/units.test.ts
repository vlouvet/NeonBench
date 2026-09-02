import { describe, expect, it } from 'vitest';
import {
  INCH_DENOMINATOR,
  MM_PER_FOOT,
  MM_PER_INCH,
  formatFootageMM,
  formatInchesFraction,
  formatLengthMM,
  formatSizeMM,
  inchesToMM,
  mmToInches,
  normalizeUnits,
  parseLengthToMM,
} from './units';

describe('normalizeUnits', () => {
  it('accepts the two stored values', () => {
    expect(normalizeUnits('mm')).toBe('mm');
    expect(normalizeUnits('in')).toBe('in');
  });

  // mm wins every tie on purpose: the doc holds mm, so an unreadable
  // preference shows the operator the STORED number rather than a guess.
  it('degrades anything else to mm', () => {
    for (const v of [undefined, null, '', 'IN', 'inches', 'cm', 'ft', '  in']) {
      expect(normalizeUnits(v as string | null | undefined)).toBe('mm');
    }
  });
});

describe('conversion', () => {
  it('round-trips through the exact factor', () => {
    for (const mm of [0, 1, 12.7, 25.4, 200, 1219.2, -76.2]) {
      expect(inchesToMM(mmToInches(mm))).toBeCloseTo(mm, 9);
    }
  });

  it('pins the trade constants', () => {
    expect(mmToInches(25.4)).toBe(1);
    expect(mmToInches(304.8)).toBeCloseTo(12, 12);
    expect(inchesToMM(0.5)).toBe(12.7);
    expect(inchesToMM(3 / 8)).toBeCloseTo(9.525, 12);
  });
});

describe('formatInchesFraction', () => {
  it('prints a whole number with no fraction', () => {
    expect(formatInchesFraction(8)).toBe('8');
    expect(formatInchesFraction(0)).toBe('0');
  });

  it('reduces the fraction', () => {
    expect(formatInchesFraction(0.5)).toBe('1/2');
    expect(formatInchesFraction(0.25)).toBe('1/4');
    expect(formatInchesFraction(0.125)).toBe('1/8');
    expect(formatInchesFraction(0.0625)).toBe('1/16');
    expect(formatInchesFraction(7.875)).toBe('7 7/8');
    expect(formatInchesFraction(48.5)).toBe('48 1/2');
  });

  // The carry is the reason rounding happens BEFORE the split. 7.9999 in
  // sixteenths is 128/16, which is 8 — not "7 16/16".
  it('carries a rounded-up fraction into the whole part', () => {
    expect(formatInchesFraction(7.9999)).toBe('8');
    expect(formatInchesFraction(0.9999)).toBe('1');
    expect(formatInchesFraction(15.96875)).toBe('16'); // exactly 15 + 31/32
  });

  it('rounds away anything below half a denominator step', () => {
    expect(formatInchesFraction(0.03)).toBe('0');
    expect(formatInchesFraction(0.0312)).toBe('0'); // just under 1/32
  });

  // The sign is applied once, at the end, so a negative value under one inch
  // can never print as "-0 1/2".
  it('carries the sign on the whole part only', () => {
    expect(formatInchesFraction(-7.875)).toBe('-7 7/8');
    expect(formatInchesFraction(-0.5)).toBe('-1/2');
    expect(formatInchesFraction(-8)).toBe('-8');
  });

  it('never prints a negative zero', () => {
    expect(formatInchesFraction(-0.001)).toBe('0');
  });

  it('honours a finer denominator when asked', () => {
    expect(formatInchesFraction(0.03125, 32)).toBe('1/32');
    expect(formatInchesFraction(0.09375, 32)).toBe('3/32');
    // The same value in sixteenths has no exact rung and rounds (see below).
    expect(formatInchesFraction(0.09375, 16)).toBe('1/8');
  });

  // Exactly half a rung rounds AWAY FROM ZERO, which is what a tape measure
  // reader expects and what Math.round already does for positives. Pinned
  // because it is a decision, not an accident: 1/32 shown in sixteenths is
  // 1/16, never 0.
  it('rounds an exact half-rung up', () => {
    expect(formatInchesFraction(0.03125, 16)).toBe('1/16'); // 1/32 -> 1/16
    expect(formatInchesFraction(0.09375, 16)).toBe('1/8'); // 3/32 -> 2/16
  });

  it('answers an em dash for non-finite input', () => {
    expect(formatInchesFraction(NaN)).toBe('—');
    expect(formatInchesFraction(Infinity)).toBe('—');
  });
});

describe('formatLengthMM', () => {
  it('prints millimetres with one decimal and a spaced suffix', () => {
    expect(formatLengthMM(203.2, 'mm')).toBe('203.2 mm');
    expect(formatLengthMM(200, 'mm')).toBe('200.0 mm');
  });

  it('prints inches as a fraction with a tight suffix', () => {
    expect(formatLengthMM(1219.2, 'in')).toBe('48″');
    expect(formatLengthMM(203.2, 'in')).toBe('8″');
    expect(formatLengthMM(12.7, 'in')).toBe('1/2″');
  });

  // The demo's own input. 200 mm is 7.8740", which is 7 7/8" to the
  // sixteenth — and 7 7/8" is 200.025 mm. That 0.025 mm gap is exactly why
  // a formatted value must never be stored.
  it('rounds the demo case to the nearest sixteenth', () => {
    expect(formatLengthMM(200, 'in')).toBe('7 7/8″');
    expect(inchesToMM(7 + 7 / 8)).toBeCloseTo(200.025, 6);
  });

  it('suppresses the suffix on request', () => {
    expect(formatLengthMM(203.2, 'mm', { suffix: false })).toBe('203.2');
    expect(formatLengthMM(203.2, 'in', { suffix: false })).toBe('8');
  });

  it('honours mmDecimals', () => {
    expect(formatLengthMM(203.25, 'mm', { mmDecimals: 0 })).toBe('203 mm');
    expect(formatLengthMM(203.25, 'mm', { mmDecimals: 2 })).toBe('203.25 mm');
  });

  it('never prints a negative zero in mm', () => {
    expect(formatLengthMM(-0.001, 'mm')).toBe('0.0 mm');
    expect(formatLengthMM(-0.04, 'mm', { mmDecimals: 1 })).toBe('0.0 mm');
  });

  it('answers an em dash for non-finite input in both units', () => {
    expect(formatLengthMM(NaN, 'mm')).toBe('—');
    expect(formatLengthMM(NaN, 'in')).toBe('—');
    expect(formatLengthMM(Infinity, 'mm')).toBe('—');
  });
});

describe('formatSizeMM', () => {
  // One suffix per dimension line, not two. "203.2 mm × 101.6 mm" makes the
  // operator read past a redundant unit on every glance.
  it('carries a single trailing suffix', () => {
    expect(formatSizeMM(203.2, 101.6, 'mm')).toBe('203.2 × 101.6 mm');
    expect(formatSizeMM(1219.2, 609.6, 'in')).toBe('48 × 24″');
  });

  it('drops the suffix on request', () => {
    expect(formatSizeMM(203.2, 101.6, 'mm', { suffix: false })).toBe('203.2 × 101.6');
  });

  it('propagates an em dash per axis', () => {
    expect(formatSizeMM(NaN, 101.6, 'mm')).toBe('— × 101.6 mm');
  });
});

describe('parseLengthToMM', () => {
  it('reads a plain decimal in mm mode', () => {
    expect(parseLengthToMM('203.2', 'mm')).toBeCloseTo(203.2, 9);
    expect(parseLengthToMM('  200 ', 'mm')).toBeCloseTo(200, 9);
    expect(parseLengthToMM('200mm', 'mm')).toBeCloseTo(200, 9);
    expect(parseLengthToMM('-12.7', 'mm')).toBeCloseTo(-12.7, 9);
  });

  // Nobody writes "1219 1/2 mm". Accepting it would invent a precision the
  // unit does not carry.
  it('refuses a fraction in mm mode', () => {
    expect(parseLengthToMM('48 1/2', 'mm')).toBeNull();
  });

  it('reads every form a sign shop writes', () => {
    const cases: [string, number][] = [
      ['48', 48],
      ['48.5', 48.5],
      ['48 1/2', 48.5],
      ['48-1/2', 48.5],
      ['1/2', 0.5],
      ['48"', 48],
      ['48 in', 48],
      ['48 inches', 48],
      ["4'", 48],
      ["4' 6\"", 54],
      ["4'6", 54],
      ['4 ft 6 in', 54],
      ["4' 6 1/2\"", 54.5],
      ['48″', 48],
      ["4′", 48],
    ];
    for (const [text, inches] of cases) {
      expect(parseLengthToMM(text, 'in'), text).toBeCloseTo(inchesToMM(inches), 9);
    }
  });

  // "-48 1/2" is -48.5, not -47.5: the whole part owns the fraction.
  it('applies a negative whole part to the fraction too', () => {
    expect(parseLengthToMM('-48 1/2', 'in')).toBeCloseTo(inchesToMM(-48.5), 9);
  });

  it('returns null rather than guessing', () => {
    for (const bad of ['', '   ', 'abc', '1/0', '1/', 'x 1/2', '48 1/2 3/4']) {
      expect(parseLengthToMM(bad, 'in'), bad).toBeNull();
    }
    expect(parseLengthToMM('abc', 'mm')).toBeNull();
  });

  // The contract that keeps geometry still: parse(format(x)) is NOT x in inch
  // mode, and no caller may treat it as a round trip. Pinned with the numbers
  // so a future "helpful" change to make it lossless fails loudly.
  it('is deliberately NOT the inverse of formatLengthMM in inches', () => {
    const mm = 200;
    const shown = formatLengthMM(mm, 'in'); // "7 7/8″"
    const back = parseLengthToMM(shown, 'in')!;
    expect(back).not.toBe(mm);
    expect(back).toBeCloseTo(200.025, 6);
    expect(Math.abs(back - mm)).toBeLessThan(MM_PER_INCH / INCH_DENOMINATOR);
  });

  it('IS the inverse of formatLengthMM in mm, to the printed decimal', () => {
    const mm = 203.25;
    const back = parseLengthToMM(formatLengthMM(mm, 'mm', { mmDecimals: 2 }), 'mm')!;
    expect(back).toBeCloseTo(mm, 9);
  });
});

describe('formatFootageMM', () => {
  // Bulk glass, not a dimension: the unit follows what the material is BOUGHT
  // in, matching internal/takeoff's UnitFoot.
  it('reads metres for a metric shop and feet for an imperial one', () => {
    expect(formatFootageMM(1256, 'mm')).toBe('1.26 m');
    expect(formatFootageMM(1256, 'in')).toBe('4.12 ft');
  });

  it('pins the exact foot', () => {
    expect(formatFootageMM(MM_PER_FOOT, 'in')).toBe('1.00 ft');
    expect(formatFootageMM(MM_PER_FOOT * 8, 'in')).toBe('8.00 ft'); // one stick
    expect(formatFootageMM(1000, 'mm')).toBe('1.00 m');
  });

  it('honours a decimals override', () => {
    expect(formatFootageMM(1256, 'in', 1)).toBe('4.1 ft');
    expect(formatFootageMM(1256, 'mm', 0)).toBe('1 m');
  });

  it('answers an em dash for non-finite input', () => {
    expect(formatFootageMM(NaN, 'in')).toBe('—');
  });
});
