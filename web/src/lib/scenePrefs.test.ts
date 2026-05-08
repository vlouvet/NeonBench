import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_SCENE_PREFS,
  SCENE_PREFS_STORAGE_KEY,
  SCENE_PREFS_VERSION,
  clearScenePrefs,
  loadScenePrefs,
  saveScenePrefs,
  validateScenePrefs,
  type ScenePrefs,
} from './scenePrefs';

// Vitest's default env is node — no `window`, no `localStorage`.
// Adding jsdom for one helper module would be a new top-level dep
// (CLAUDE.md "no third-party deps without approval"), so we hand-roll
// a tiny in-memory localStorage shim and attach it to a mocked
// `window`. The shim implements just the surface the helper uses
// (`getItem` / `setItem` / `removeItem` / `clear`); deliberate misses
// (`length`, `key`) would be runtime errors in the helper, which is
// what we want.

interface Storable {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function makeMemoryStorage(): Storable & { _store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    _store: store,
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

let memoryStorage: ReturnType<typeof makeMemoryStorage>;

beforeEach(() => {
  memoryStorage = makeMemoryStorage();
  // Install a `window` global with a `localStorage` field. Using
  // `Object.defineProperty` so a per-test override (e.g. the
  // throw-on-getItem case) can re-define the property cleanly.
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: memoryStorage },
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  // Restore "no window" between tests so the SSR-safety case below
  // exercises a real-world server environment, and so a leaked
  // localStorage mock from one test can't bleed into another.
  // @ts-expect-error — the test harness deliberately mutates globals.
  delete globalThis.window;
});

describe('DEFAULT_SCENE_PREFS', () => {
  it('round-trips cleanly through validateScenePrefs', () => {
    expect(validateScenePrefs({ ...DEFAULT_SCENE_PREFS })).toEqual(
      DEFAULT_SCENE_PREFS,
    );
  });

  it('declares the current schema version', () => {
    expect(DEFAULT_SCENE_PREFS.version).toBe(SCENE_PREFS_VERSION);
  });
});

describe('loadScenePrefs / saveScenePrefs round-trip', () => {
  it('returns defaults when storage is empty', () => {
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });

  it('persists user-modified prefs across calls', () => {
    const custom: ScenePrefs = {
      ...DEFAULT_SCENE_PREFS,
      backgroundColor: '#000000',
      wallEnabled: true,
      wallColor: '#222222',
      ambientIntensity: 0.55,
      bloomIntensity: 1.85,
      bloomThreshold: 0.25,
      bloomRadius: 1.1,
    };
    saveScenePrefs(custom);
    expect(loadScenePrefs()).toEqual(custom);
  });

  it('saveScenePrefs always writes the current schema version', () => {
    // Caller passed a stale version; helper must rewrite it to
    // SCENE_PREFS_VERSION so a future load doesn't reject it.
    saveScenePrefs({ ...DEFAULT_SCENE_PREFS, version: 999 });
    const raw = memoryStorage.getItem(SCENE_PREFS_STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.version).toBe(SCENE_PREFS_VERSION);
  });

  it('clearScenePrefs removes the entry so the next load returns defaults', () => {
    saveScenePrefs({ ...DEFAULT_SCENE_PREFS, backgroundColor: '#ffffff' });
    expect(memoryStorage.getItem(SCENE_PREFS_STORAGE_KEY)).not.toBeNull();
    clearScenePrefs();
    expect(memoryStorage.getItem(SCENE_PREFS_STORAGE_KEY)).toBeNull();
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });
});

describe('validateScenePrefs', () => {
  it('rejects null / undefined / non-object payloads', () => {
    expect(validateScenePrefs(null)).toBeNull();
    expect(validateScenePrefs(undefined)).toBeNull();
    expect(validateScenePrefs(42)).toBeNull();
    expect(validateScenePrefs('hello')).toBeNull();
  });

  it('rejects payloads with a mismatched version', () => {
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, version: 0 }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, version: 2 }),
    ).toBeNull();
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        // Missing version field.
        version: undefined as unknown as number,
      }),
    ).toBeNull();
  });

  it('rejects malformed hex colors', () => {
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, backgroundColor: 'red' }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, backgroundColor: '#abc' }),
    ).toBeNull();
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        backgroundColor: '#zzzzzz',
      }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, wallColor: 'rgb(0,0,0)' }),
    ).toBeNull();
  });

  it('rejects out-of-range numerics', () => {
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, ambientIntensity: -0.1 }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, ambientIntensity: 1.5 }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, bloomIntensity: 5 }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, bloomThreshold: -0.01 }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, bloomRadius: 3 }),
    ).toBeNull();
  });

  it('rejects NaN / Infinity numerics', () => {
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        ambientIntensity: Number.NaN,
      }),
    ).toBeNull();
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        bloomIntensity: Number.POSITIVE_INFINITY,
      }),
    ).toBeNull();
  });

  it('rejects wrong-type fields', () => {
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, wallEnabled: 'yes' }),
    ).toBeNull();
    expect(
      validateScenePrefs({ ...DEFAULT_SCENE_PREFS, ambientIntensity: '0.5' }),
    ).toBeNull();
  });

  it('accepts boundary values exactly at the range edges', () => {
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        ambientIntensity: 0,
        bloomIntensity: 0,
        bloomThreshold: 0,
        bloomRadius: 0,
      }),
    ).not.toBeNull();
    expect(
      validateScenePrefs({
        ...DEFAULT_SCENE_PREFS,
        ambientIntensity: 1,
        bloomIntensity: 3,
        bloomThreshold: 1,
        bloomRadius: 2,
      }),
    ).not.toBeNull();
  });
});

describe('loadScenePrefs failure modes', () => {
  it('returns defaults when stored JSON is corrupt', () => {
    memoryStorage.setItem(SCENE_PREFS_STORAGE_KEY, '{not json');
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });

  it('returns defaults when stored payload has the wrong version', () => {
    memoryStorage.setItem(
      SCENE_PREFS_STORAGE_KEY,
      JSON.stringify({ ...DEFAULT_SCENE_PREFS, version: 999 }),
    );
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });

  it('returns defaults when stored payload is missing required fields', () => {
    memoryStorage.setItem(
      SCENE_PREFS_STORAGE_KEY,
      JSON.stringify({ version: SCENE_PREFS_VERSION }),
    );
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });

  it('returns defaults when localStorage.getItem throws', () => {
    // Replace the storage with one whose getItem throws (simulating
    // private-mode Safari, locked-down extensions, etc.). The helper
    // catches and falls back to defaults.
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: () => {
            throw new Error('blocked');
          },
          setItem: () => {},
          removeItem: () => {},
        },
      },
      configurable: true,
      writable: true,
    });
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
  });
});

describe('saveScenePrefs failure modes', () => {
  it('does not throw when localStorage.setItem rejects (quota / locked)', () => {
    Object.defineProperty(globalThis, 'window', {
      value: {
        localStorage: {
          getItem: () => null,
          setItem: () => {
            throw new Error('QuotaExceeded');
          },
          removeItem: () => {},
        },
      },
      configurable: true,
      writable: true,
    });
    expect(() => saveScenePrefs(DEFAULT_SCENE_PREFS)).not.toThrow();
  });
});

describe('SSR safety', () => {
  it('returns defaults and is a no-op when window is undefined', () => {
    // Explicit teardown for this case: remove `window` so the helper
    // exercises its server-side guard.
    // @ts-expect-error — deliberately remove the global to mimic SSR.
    delete globalThis.window;
    expect(loadScenePrefs()).toEqual(DEFAULT_SCENE_PREFS);
    expect(() => saveScenePrefs(DEFAULT_SCENE_PREFS)).not.toThrow();
    expect(() => clearScenePrefs()).not.toThrow();
  });
});
