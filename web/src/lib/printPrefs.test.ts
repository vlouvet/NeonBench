import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { api } from '../api';
import {
  DEFAULT_PRINT_PREFS,
  describePrintPrefs,
  loadPrintPrefs,
  printPrefsKey,
  printPrefsToURLOpts,
  sanitizePrintPrefs,
  savePrintPrefs,
  type PrintPopoverValues,
} from './printPrefs';

// Tier 2 #93 — Quick plot is a one-click print of whatever the operator
// last used, so two things have to hold: the settings must survive a
// round-trip through localStorage, and the URL built from them must be
// exactly those settings and nothing else.
//
// Vitest's default env is node — no `window`, no `localStorage` — and
// adding jsdom for one helper module would be a new top-level dep
// (CLAUDE.md: no third-party deps without approval). So we reuse the
// in-memory shim pattern scenePrefs.test.ts established.

interface Storable {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeMemoryStorage(): Storable {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, String(value));
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => {
      store.clear();
    },
  };
}

function installWindow(localStorage: unknown) {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
}

beforeEach(() => {
  installWindow(makeMemoryStorage());
});

afterEach(() => {
  // Restore "no window" so the SSR case below sees a real server
  // environment and no mock leaks between tests.
  // @ts-expect-error — the test harness deliberately mutates globals.
  delete globalThis.window;
});

describe('printPrefs storage round-trip', () => {
  it('returns defaults when nothing is stored', () => {
    expect(loadPrintPrefs(7)).toEqual(DEFAULT_PRINT_PREFS);
  });

  it('round-trips a full settings object', () => {
    const values: PrintPopoverValues = {
      paper: 'a3',
      landscape: true,
      stripsOnly: true,
      frontFacing: true,
      rotate: 'fit',
      copies: 6,
    };
    savePrintPrefs(7, values);
    expect(loadPrintPrefs(7)).toEqual(values);
  });

  it('keys storage per project, so one job does not leak into another', () => {
    savePrintPrefs(7, { ...DEFAULT_PRINT_PREFS, paper: 'a2', copies: 4 });
    expect(loadPrintPrefs(7).paper).toBe('a2');
    expect(loadPrintPrefs(7).copies).toBe(4);
    expect(loadPrintPrefs(8)).toEqual(DEFAULT_PRINT_PREFS);
    expect(printPrefsKey(7)).not.toBe(printPrefsKey(8));
  });

  it('falls back to defaults on unparseable JSON without throwing', () => {
    window.localStorage.setItem(printPrefsKey(7), '{not json');
    expect(() => loadPrintPrefs(7)).not.toThrow();
    expect(loadPrintPrefs(7)).toEqual(DEFAULT_PRINT_PREFS);
  });

  it('falls back to defaults when the payload is not a settings object', () => {
    for (const junk of ['null', '42', '"letter"', '[]', 'true']) {
      window.localStorage.setItem(printPrefsKey(7), junk);
      // An array IS an object, so it sanitizes field-by-field down to
      // the defaults rather than being rejected wholesale — either way
      // the caller gets a complete, usable settings object.
      expect(loadPrintPrefs(7)).toEqual(DEFAULT_PRINT_PREFS);
    }
  });

  it('does not throw when localStorage itself refuses to work', () => {
    // Safari private browsing throws on setItem; a locked-down browser
    // can throw on getItem. Neither is worth failing a print over.
    installWindow({
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => {},
      clear: () => {},
    });
    expect(() => savePrintPrefs(7, DEFAULT_PRINT_PREFS)).not.toThrow();
    expect(loadPrintPrefs(7)).toEqual(DEFAULT_PRINT_PREFS);
  });

  it('is SSR-safe: no window means defaults, not a crash', () => {
    // @ts-expect-error — the test harness deliberately mutates globals.
    delete globalThis.window;
    expect(loadPrintPrefs(7)).toEqual(DEFAULT_PRINT_PREFS);
    expect(() => savePrintPrefs(7, DEFAULT_PRINT_PREFS)).not.toThrow();
  });
});

describe('sanitizePrintPrefs', () => {
  it('upgrades a payload written before rotate/copies existed', () => {
    const legacy = {
      paper: 'a4',
      landscape: true,
      stripsOnly: false,
      frontFacing: true,
    };
    expect(sanitizePrintPrefs(legacy)).toEqual({
      ...legacy,
      rotate: '',
      copies: 1,
    });
  });

  it('rejects an unknown paper and an unknown rotate mode', () => {
    const got = sanitizePrintPrefs({ paper: 'a0', rotate: 'upside-down' });
    expect(got.paper).toBe(DEFAULT_PRINT_PREFS.paper);
    expect(got.rotate).toBe('');
  });

  it('clamps copies into 1..50 instead of rejecting it', () => {
    expect(sanitizePrintPrefs({ copies: 0 }).copies).toBe(1);
    expect(sanitizePrintPrefs({ copies: -4 }).copies).toBe(1);
    expect(sanitizePrintPrefs({ copies: 999 }).copies).toBe(50);
    expect(sanitizePrintPrefs({ copies: 2.6 }).copies).toBe(3);
    expect(sanitizePrintPrefs({ copies: Number.NaN }).copies).toBe(1);
    // A stringified number is a shape error, not a bounds error.
    expect(sanitizePrintPrefs({ copies: '3' }).copies).toBe(1);
  });

  it('ignores non-boolean flags', () => {
    const got = sanitizePrintPrefs({ landscape: 'yes', stripsOnly: 1 });
    expect(got.landscape).toBe(false);
    expect(got.stripsOnly).toBe(false);
  });
});

describe('quick-plot URL builder', () => {
  const url = (values: PrintPopoverValues) =>
    api.printPDFURL(7, 42, printPrefsToURLOpts(values));

  it('adds no new params for untouched defaults', () => {
    // The absent-safety contract: an operator who never opened the
    // popover gets the same PDF NeonBench always produced. `paper` was
    // already on the pre-Tier-2-#93 URL; rotate and copies must not be.
    expect(url(DEFAULT_PRINT_PREFS)).toBe(
      '/api/projects/7/design_versions/42/print.pdf?paper=letter',
    );
  });

  it('emits exactly the stored settings and nothing else', () => {
    expect(
      url({
        paper: 'a3',
        landscape: true,
        stripsOnly: true,
        frontFacing: true,
        rotate: 'fit',
        copies: 4,
      }),
    ).toBe(
      '/api/projects/7/design_versions/42/print.pdf' +
        '?paper=a3&landscape=1&strips_only=1&mirror=0&rotate=fit&copies=4',
    );
  });

  it('omits rotate when no rotation is asked for', () => {
    expect(url({ ...DEFAULT_PRINT_PREFS, rotate: '' })).not.toContain('rotate');
    expect(url({ ...DEFAULT_PRINT_PREFS, rotate: '90' })).toContain(
      'rotate=90',
    );
  });

  it('omits copies for a single copy (the server default)', () => {
    expect(url({ ...DEFAULT_PRINT_PREFS, copies: 1 })).not.toContain('copies');
    expect(url({ ...DEFAULT_PRINT_PREFS, copies: 2 })).toContain('copies=2');
  });

  it('keeps the mirror opt-out inverted, not duplicated', () => {
    // frontFacing=false is the trade default (mirrored) and must emit
    // nothing; only the opt-out reaches the wire.
    expect(url({ ...DEFAULT_PRINT_PREFS, frontFacing: false })).not.toContain(
      'mirror',
    );
    expect(url({ ...DEFAULT_PRINT_PREFS, frontFacing: true })).toContain(
      'mirror=0',
    );
  });

  it('prints what was stored, after a real storage round-trip', () => {
    const values: PrintPopoverValues = {
      ...DEFAULT_PRINT_PREFS,
      paper: 'tabloid',
      rotate: '90',
      copies: 3,
    };
    savePrintPrefs(11, values);
    expect(api.printPDFURL(11, 99, printPrefsToURLOpts(loadPrintPrefs(11)))).toBe(
      '/api/projects/11/design_versions/99/print.pdf?paper=tabloid&rotate=90&copies=3',
    );
  });
});

describe('describePrintPrefs', () => {
  it('spells out the default job so a one-click print is never a mystery', () => {
    expect(describePrintPrefs(DEFAULT_PRINT_PREFS)).toBe(
      'US Letter (8.5 × 11 in) · portrait · mirrored · 1 copy',
    );
  });

  it('names every active option', () => {
    expect(
      describePrintPrefs({
        paper: 'a3',
        landscape: true,
        stripsOnly: true,
        frontFacing: true,
        rotate: 'fit',
        copies: 6,
      }),
    ).toBe(
      'A3 (297 × 420 mm) · landscape · front-facing (un-mirrored) · ' +
        'strip pages only · rotated to fit · 6 copies',
    );
  });

  it('distinguishes always-rotate from rotate-to-fit', () => {
    expect(
      describePrintPrefs({ ...DEFAULT_PRINT_PREFS, rotate: '90' }),
    ).toContain('rotated 90°');
    expect(
      describePrintPrefs({ ...DEFAULT_PRINT_PREFS, rotate: 'fit' }),
    ).toContain('rotated to fit');
  });
});
