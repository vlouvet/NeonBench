/**
 * scenePrefs — global localStorage persistence for the 3D preview's
 * scene-control state (Tier 3 #56).
 *
 * Scope is **global**, not per-project: the user picks a background +
 * wall + lighting + bloom feel they like and that follows them across
 * every project's preview route. The preview page reads these on mount
 * and writes them (debounced) on every value change.
 *
 * Storage key: `nb.scenePrefs.v1`. The `.v1` suffix is mirrored by the
 * `version: 1` field inside the payload so we have two layers of
 * upgrade safety:
 *
 *   1. Bumping the storage key cleanly orphans stale state from older
 *      versions of the app (no migration code needed for a future v2).
 *   2. The in-payload `version` field lets us reject mismatched data
 *      that may have been hand-edited or accidentally written by a
 *      schema-mixed deploy without trusting the key alone.
 *
 * Validation: every load runs the payload through a strict shape +
 * range check. Any failure (missing field, wrong type, NaN, out-of-
 * range numeric, malformed hex color, version mismatch) falls back to
 * `DEFAULT_SCENE_PREFS` and logs nothing — broken state is the user's
 * to recover from by adjusting sliders, not our problem to surface.
 *
 * SSR-safe: every entry point checks `typeof window === 'undefined'`
 * before touching `localStorage`. On the server we hand back defaults;
 * on the client we round-trip through JSON.
 */
import {
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_THRESHOLD,
  BLOOM_RADIUS,
} from '../preview/Scene';
import { DEFAULT_SCENE_CONTROLS } from '../preview/SceneControls';

/** Storage key. Bumped suffix invalidates older shapes wholesale. */
export const SCENE_PREFS_STORAGE_KEY = 'nb.scenePrefs.v1';

/** Schema version embedded in the payload. Mirror of the key suffix. */
export const SCENE_PREFS_VERSION = 1;

/** Slider clamps (mirror of the range/step in SceneControls.tsx). */
export const SCENE_PREFS_RANGES = {
  ambientIntensity: { min: 0, max: 1 },
  bloomIntensity: { min: 0, max: 3 },
  bloomThreshold: { min: 0, max: 1 },
  bloomRadius: { min: 0, max: 2 },
} as const;

/** Strict 6-digit hex (lower or upper). Matches the swatch values today. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export interface ScenePrefs {
  /** Schema version. Always equals `SCENE_PREFS_VERSION` on a healthy load. */
  version: number;
  /** Background swatch (six-digit hex, e.g. `#1a1a1a`). */
  backgroundColor: string;
  /** Wall plane on/off. */
  wallEnabled: boolean;
  /** Wall surface color (six-digit hex). */
  wallColor: string;
  /** Ambient light intensity. 0..1 (clamped on load). */
  ambientIntensity: number;
  /** Bloom intensity. 0..3 (clamped on load). */
  bloomIntensity: number;
  /** Bloom luminance threshold. 0..1 (clamped on load). */
  bloomThreshold: number;
  /** Bloom mipmap-blur radius. 0..2 (clamped on load). */
  bloomRadius: number;
}

/**
 * Defaults. Pulled from the existing scene-control + Scene module
 * exports so a future tuning of either source is reflected here
 * without manual sync.
 */
export const DEFAULT_SCENE_PREFS: ScenePrefs = {
  version: SCENE_PREFS_VERSION,
  backgroundColor: DEFAULT_SCENE_CONTROLS.backgroundColor,
  wallEnabled: DEFAULT_SCENE_CONTROLS.wallEnabled,
  wallColor: DEFAULT_SCENE_CONTROLS.wallColor,
  ambientIntensity: DEFAULT_SCENE_CONTROLS.ambientIntensity,
  bloomIntensity: BLOOM_INTENSITY,
  bloomThreshold: BLOOM_LUMINANCE_THRESHOLD,
  bloomRadius: BLOOM_RADIUS,
};

/** True when running in a context with a usable `localStorage` (jsdom or browser). */
function hasLocalStorage(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return typeof window.localStorage !== 'undefined';
  } catch {
    // Some sandboxes throw on access (e.g. file:// in older Safari).
    return false;
  }
}

function isFiniteNumberInRange(
  v: unknown,
  min: number,
  max: number,
): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function isHexColor(v: unknown): v is string {
  return typeof v === 'string' && HEX_COLOR_RE.test(v);
}

/**
 * Validate a parsed JSON payload against `ScenePrefs`. Returns the
 * validated object (typed) on success or `null` on any structural /
 * range / version mismatch. Validation is strict — no silent coercion
 * of numbers from strings, no unknown-field tolerance — because a
 * malformed payload usually means a stale app version, and the safest
 * thing is to fall back to defaults rather than render with junk.
 */
export function validateScenePrefs(raw: unknown): ScenePrefs | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== SCENE_PREFS_VERSION) return null;
  if (!isHexColor(obj.backgroundColor)) return null;
  if (typeof obj.wallEnabled !== 'boolean') return null;
  if (!isHexColor(obj.wallColor)) return null;
  if (
    !isFiniteNumberInRange(
      obj.ambientIntensity,
      SCENE_PREFS_RANGES.ambientIntensity.min,
      SCENE_PREFS_RANGES.ambientIntensity.max,
    )
  ) {
    return null;
  }
  if (
    !isFiniteNumberInRange(
      obj.bloomIntensity,
      SCENE_PREFS_RANGES.bloomIntensity.min,
      SCENE_PREFS_RANGES.bloomIntensity.max,
    )
  ) {
    return null;
  }
  if (
    !isFiniteNumberInRange(
      obj.bloomThreshold,
      SCENE_PREFS_RANGES.bloomThreshold.min,
      SCENE_PREFS_RANGES.bloomThreshold.max,
    )
  ) {
    return null;
  }
  if (
    !isFiniteNumberInRange(
      obj.bloomRadius,
      SCENE_PREFS_RANGES.bloomRadius.min,
      SCENE_PREFS_RANGES.bloomRadius.max,
    )
  ) {
    return null;
  }
  return {
    version: SCENE_PREFS_VERSION,
    backgroundColor: obj.backgroundColor,
    wallEnabled: obj.wallEnabled,
    wallColor: obj.wallColor,
    ambientIntensity: obj.ambientIntensity,
    bloomIntensity: obj.bloomIntensity,
    bloomThreshold: obj.bloomThreshold,
    bloomRadius: obj.bloomRadius,
  };
}

/**
 * Read scene prefs from localStorage. Returns a fresh copy of
 * `DEFAULT_SCENE_PREFS` if storage is unavailable, missing, malformed,
 * or version-mismatched. Never throws.
 */
export function loadScenePrefs(): ScenePrefs {
  if (!hasLocalStorage()) return { ...DEFAULT_SCENE_PREFS };
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(SCENE_PREFS_STORAGE_KEY);
  } catch {
    return { ...DEFAULT_SCENE_PREFS };
  }
  if (!raw) return { ...DEFAULT_SCENE_PREFS };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_SCENE_PREFS };
  }
  const validated = validateScenePrefs(parsed);
  return validated ?? { ...DEFAULT_SCENE_PREFS };
}

/**
 * Persist scene prefs to localStorage. Silently no-ops if storage is
 * unavailable (SSR, file://, quota exhausted). Always writes the
 * current `SCENE_PREFS_VERSION`, regardless of what `prefs.version`
 * claims — callers can pass partial objects spread over defaults
 * without thinking about the version field.
 */
export function saveScenePrefs(prefs: ScenePrefs): void {
  if (!hasLocalStorage()) return;
  const payload: ScenePrefs = { ...prefs, version: SCENE_PREFS_VERSION };
  try {
    window.localStorage.setItem(
      SCENE_PREFS_STORAGE_KEY,
      JSON.stringify(payload),
    );
  } catch {
    // Quota exceeded / private mode / extension lockdown — drop silently.
  }
}

/**
 * Erase the persisted prefs entirely. Used by the "↺ defaults" reset
 * button on the scene-controls panel. Subsequent `loadScenePrefs()`
 * calls return defaults until the next `saveScenePrefs()`.
 */
export function clearScenePrefs(): void {
  if (!hasLocalStorage()) return;
  try {
    window.localStorage.removeItem(SCENE_PREFS_STORAGE_KEY);
  } catch {
    // Drop silently — symmetric with saveScenePrefs's failure mode.
  }
}
