import { describe, expect, it } from 'vitest';
import {
  HOUSING_LIBRARY,
  isStockHousing,
  resolveHousing,
} from './housingLibrary';

describe('HOUSING_LIBRARY', () => {
  it('exposes the two stock shells with the documented dimensions', () => {
    expect(HOUSING_LIBRARY['shell-15'].boreMM).toBe(9.5);
    expect(HOUSING_LIBRARY['shell-15'].outsideMM).toBe(33.3);
    expect(HOUSING_LIBRARY['shell-19'].boreMM).toBe(12.7);
    expect(HOUSING_LIBRARY['shell-19'].outsideMM).toBe(41.3);
  });

  it('every shell entry has a non-empty label', () => {
    for (const key of Object.keys(HOUSING_LIBRARY) as Array<keyof typeof HOUSING_LIBRARY>) {
      expect(HOUSING_LIBRARY[key].label.length).toBeGreaterThan(0);
    }
  });
});

describe('resolveHousing', () => {
  it('returns the sentinel zero-bore "None" entry for empty/undefined housing_type', () => {
    expect(resolveHousing('').boreMM).toBe(0);
    expect(resolveHousing(undefined).boreMM).toBe(0);
    expect(resolveHousing('').label).toBe('None');
  });

  it('looks up shell-15 dimensions from the library', () => {
    const got = resolveHousing('shell-15');
    expect(got.boreMM).toBe(9.5);
    expect(got.outsideMM).toBe(33.3);
    expect(got.label).toContain('15-shell');
  });

  it('looks up shell-19 dimensions from the library', () => {
    const got = resolveHousing('shell-19');
    expect(got.boreMM).toBe(12.7);
    expect(got.outsideMM).toBe(41.3);
    expect(got.label).toContain('19-shell');
  });

  it('ignores user-supplied bore for stock shells (library is authoritative)', () => {
    const got = resolveHousing('shell-15', 99);
    expect(got.boreMM).toBe(9.5);
  });

  it('returns user-supplied bore for custom housings', () => {
    const got = resolveHousing('custom', 11);
    expect(got.boreMM).toBe(11);
    expect(got.label).toBe('Custom');
  });

  it('treats a missing bore on custom housings as 0 (degenerate, but does not throw)', () => {
    const got = resolveHousing('custom');
    expect(got.boreMM).toBe(0);
    expect(got.label).toBe('Custom');
  });

  it('falls back to NO_HOUSING for an unknown housing_type', () => {
    const got = resolveHousing('shell-99');
    expect(got.boreMM).toBe(0);
    expect(got.label).toBe('None');
  });
});

describe('isStockHousing', () => {
  it('returns true for the two library entries', () => {
    expect(isStockHousing('shell-15')).toBe(true);
    expect(isStockHousing('shell-19')).toBe(true);
  });

  it('returns false for empty / custom / unknown', () => {
    expect(isStockHousing('')).toBe(false);
    expect(isStockHousing(undefined)).toBe(false);
    expect(isStockHousing('custom')).toBe(false);
    expect(isStockHousing('shell-25')).toBe(false);
  });
});
