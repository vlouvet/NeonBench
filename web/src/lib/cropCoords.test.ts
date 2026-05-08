import { describe, expect, it } from 'vitest';
import { cacheToFullRes } from './cropCoords';

describe('cacheToFullRes', () => {
  it('is the identity at scale 1.0 (source already fit the cache cap)', () => {
    expect(cacheToFullRes({ x: 10, y: 20, w: 30, h: 40 }, 1.0)).toEqual({
      x: 10,
      y: 20,
      w: 30,
      h: 40,
    });
  });

  it('doubles every component at scale 2.0 (e.g. a 2048-wide source)', () => {
    expect(cacheToFullRes({ x: 10, y: 20, w: 30, h: 40 }, 2.0)).toEqual({
      x: 20,
      y: 40,
      w: 60,
      h: 80,
    });
  });

  it('rounds to integer pixels at non-integer scales', () => {
    // 5 * 1.7 = 8.5 → Math.round bankers? — JS Math.round rounds .5 toward
    // +Inf, so the value lands on 9. Pin all four components to that.
    expect(cacheToFullRes({ x: 5, y: 5, w: 5, h: 5 }, 1.7)).toEqual({
      x: 9,
      y: 9,
      w: 9,
      h: 9,
    });
  });

  it('returns all zeros for a degenerate (zero-size) input', () => {
    // Defensive: callers shouldn't really pass {w:0,h:0} (the submit path
    // gates on cw>0 && ch>0), but if they do we want a clean zero rather
    // than a divide-by-zero or a spurious x/y multiply.
    expect(cacheToFullRes({ x: 0, y: 0, w: 0, h: 0 }, 2.0)).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});
