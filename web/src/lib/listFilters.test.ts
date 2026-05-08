import { describe, expect, it } from 'vitest';
import {
  DEFAULT_FILTERS,
  DEFAULT_SORT,
  MAX_QUERY_LENGTH,
  STORAGE_KEY,
  filtersToSearchParams,
  isSortMode,
  loadStoredFilters,
  parseFiltersFromSearch,
  resolveInitialFilters,
  saveStoredFilters,
} from './listFilters';

// MemoryStorage mimics the slice of `Storage` we actually use without
// pulling in jsdom. Keeps these tests Node-safe and decoupled from the
// browser's quota / origin rules.
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key) {
      return store.has(key) ? (store.get(key) as string) : null;
    },
    key(index) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key) {
      store.delete(key);
    },
    setItem(key, value) {
      store.set(key, value);
    },
  } satisfies Storage;
}

describe('isSortMode', () => {
  it('accepts known sort modes', () => {
    expect(isSortMode('updated')).toBe(true);
    expect(isSortMode('due')).toBe(true);
    expect(isSortMode('name')).toBe(true);
  });

  it('rejects unknown values, including casing variants', () => {
    expect(isSortMode('Updated')).toBe(false);
    expect(isSortMode('garbage')).toBe(false);
    expect(isSortMode('')).toBe(false);
    expect(isSortMode(null)).toBe(false);
    expect(isSortMode(undefined)).toBe(false);
    expect(isSortMode(42)).toBe(false);
  });
});

describe('parseFiltersFromSearch', () => {
  it('returns defaults for empty input', () => {
    expect(parseFiltersFromSearch('')).toEqual(DEFAULT_FILTERS);
    expect(parseFiltersFromSearch('?')).toEqual(DEFAULT_FILTERS);
  });

  it('parses both fields when present', () => {
    expect(parseFiltersFromSearch('?sort=name&q=foo')).toEqual({
      sort: 'name',
      q: 'foo',
    });
  });

  it('accepts a search without the leading ?', () => {
    expect(parseFiltersFromSearch('sort=due&q=bar')).toEqual({
      sort: 'due',
      q: 'bar',
    });
  });

  it('falls back to default sort for unknown values', () => {
    expect(parseFiltersFromSearch('?sort=Recent').sort).toBe(DEFAULT_SORT);
    expect(parseFiltersFromSearch('?sort=alphabetical').sort).toBe(DEFAULT_SORT);
  });

  it('preserves an unknown sort param without cross-polluting q', () => {
    // A garbage ?sort= must not block ?q= from coming through. This is
    // the regression guard for shared links from older builds.
    expect(parseFiltersFromSearch('?sort=garbage&q=hello')).toEqual({
      sort: DEFAULT_SORT,
      q: 'hello',
    });
  });

  it('decodes URL-escaped query characters', () => {
    expect(parseFiltersFromSearch('?q=hello%20world').q).toBe('hello world');
    expect(parseFiltersFromSearch('?q=a%26b').q).toBe('a&b');
  });

  it('clamps q to MAX_QUERY_LENGTH characters', () => {
    const long = 'x'.repeat(MAX_QUERY_LENGTH + 50);
    expect(parseFiltersFromSearch(`?q=${long}`).q.length).toBe(MAX_QUERY_LENGTH);
  });
});

describe('filtersToSearchParams', () => {
  it('omits both fields at default', () => {
    const params = filtersToSearchParams(DEFAULT_FILTERS);
    expect(params.toString()).toBe('');
  });

  it('writes only non-default fields', () => {
    expect(filtersToSearchParams({ sort: 'updated', q: 'hi' }).toString()).toBe(
      'q=hi',
    );
    expect(filtersToSearchParams({ sort: 'name', q: '' }).toString()).toBe(
      'sort=name',
    );
  });

  it('round-trips with parseFiltersFromSearch for non-default values', () => {
    const filters = { sort: 'due' as const, q: 'neon sign' };
    const re = parseFiltersFromSearch('?' + filtersToSearchParams(filters).toString());
    expect(re).toEqual(filters);
  });

  it('URL-encodes characters that would break the round-trip', () => {
    const params = filtersToSearchParams({ sort: 'name', q: 'a&b=c d' });
    // URLSearchParams.toString() encodes & = and space as +; we don't
    // assert the exact form (it's browser-stable), only that the
    // round-trip survives it.
    const re = parseFiltersFromSearch('?' + params.toString());
    expect(re).toEqual({ sort: 'name', q: 'a&b=c d' });
  });
});

describe('loadStoredFilters', () => {
  it('returns defaults when storage is null/undefined', () => {
    expect(loadStoredFilters(null)).toEqual(DEFAULT_FILTERS);
    expect(loadStoredFilters(undefined)).toEqual(DEFAULT_FILTERS);
  });

  it('returns defaults when the key is unset', () => {
    expect(loadStoredFilters(memoryStorage())).toEqual(DEFAULT_FILTERS);
  });

  it('parses a well-formed stored value', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'hello' }),
    });
    expect(loadStoredFilters(storage)).toEqual({ sort: 'name', q: 'hello' });
  });

  it('returns defaults for unparseable JSON', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '{not json' });
    expect(loadStoredFilters(storage)).toEqual(DEFAULT_FILTERS);
  });

  it('returns defaults for non-object payloads', () => {
    const storage = memoryStorage({ [STORAGE_KEY]: '"hello"' });
    expect(loadStoredFilters(storage)).toEqual(DEFAULT_FILTERS);
    const storage2 = memoryStorage({ [STORAGE_KEY]: 'null' });
    expect(loadStoredFilters(storage2)).toEqual(DEFAULT_FILTERS);
  });

  it('falls back to defaults for unknown sort values', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'rubbish', q: 'kept' }),
    });
    expect(loadStoredFilters(storage)).toEqual({ sort: DEFAULT_SORT, q: 'kept' });
  });

  it('clamps overlong stored q values', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'x'.repeat(MAX_QUERY_LENGTH + 50) }),
    });
    expect(loadStoredFilters(storage).q.length).toBe(MAX_QUERY_LENGTH);
  });

  it('survives a getItem that throws (private-mode style)', () => {
    const throwing: Pick<Storage, 'getItem'> = {
      getItem() {
        throw new Error('private mode');
      },
    };
    expect(loadStoredFilters(throwing)).toEqual(DEFAULT_FILTERS);
  });
});

describe('saveStoredFilters', () => {
  it('writes the JSON payload under STORAGE_KEY', () => {
    const storage = memoryStorage();
    saveStoredFilters(storage, { sort: 'due', q: 'foo' });
    expect(storage.getItem(STORAGE_KEY)).toBe(
      JSON.stringify({ sort: 'due', q: 'foo' }),
    );
  });

  it('is a no-op when storage is null/undefined', () => {
    expect(() => saveStoredFilters(null, DEFAULT_FILTERS)).not.toThrow();
    expect(() => saveStoredFilters(undefined, DEFAULT_FILTERS)).not.toThrow();
  });

  it('swallows setItem errors (quota / disabled)', () => {
    const throwing: Pick<Storage, 'setItem'> = {
      setItem() {
        throw new Error('quota');
      },
    };
    expect(() => saveStoredFilters(throwing, DEFAULT_FILTERS)).not.toThrow();
  });

  it('round-trips with loadStoredFilters', () => {
    const storage = memoryStorage();
    const filters = { sort: 'name' as const, q: 'sample' };
    saveStoredFilters(storage, filters);
    expect(loadStoredFilters(storage)).toEqual(filters);
  });
});

describe('resolveInitialFilters', () => {
  it('returns defaults when neither URL nor storage has anything', () => {
    expect(resolveInitialFilters('', memoryStorage())).toEqual(DEFAULT_FILTERS);
  });

  it('prefers URL values over storage on conflict', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'stored' }),
    });
    expect(resolveInitialFilters('?sort=due&q=fromurl', storage)).toEqual({
      sort: 'due',
      q: 'fromurl',
    });
  });

  it('falls back to storage for fields the URL omits', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'stored' }),
    });
    // URL only sets sort; q should fall back to storage. This is the
    // shared-link case where someone overrides one knob without
    // wiping out the user's saved query.
    expect(resolveInitialFilters('?sort=due', storage)).toEqual({
      sort: 'due',
      q: 'stored',
    });
    // Inverse: URL only sets q; sort should fall back to storage.
    expect(resolveInitialFilters('?q=fromurl', storage)).toEqual({
      sort: 'name',
      q: 'fromurl',
    });
  });

  it('treats an empty ?q= as a present (cleared) value, not a fallback', () => {
    // A user who clears the search box should see the URL update with
    // q removed, but if they shared `?q=`, that should clear the
    // stored q rather than fall back to it. URLSearchParams returns
    // '' (not null) for `?q=`, which our code treats as "present".
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'stored' }),
    });
    expect(resolveInitialFilters('?q=', storage)).toEqual({
      sort: 'name',
      q: '',
    });
  });

  it('ignores garbage URL values when storage has good ones', () => {
    const storage = memoryStorage({
      [STORAGE_KEY]: JSON.stringify({ sort: 'name', q: 'stored' }),
    });
    // ?sort=garbage is not a sort mode → fall back to storage's 'name'.
    expect(resolveInitialFilters('?sort=garbage', storage)).toEqual({
      sort: 'name',
      q: 'stored',
    });
  });

  it('returns defaults when both sources are empty / missing', () => {
    expect(resolveInitialFilters('', null)).toEqual(DEFAULT_FILTERS);
  });
});
