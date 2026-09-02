// Tier 3 #137 — the URL contract for the 3D preview route.
//
// The preview route used to be configurable only by clicking: pick a
// preset, toggle the wall, drag the sliders. Producing a customer proof
// therefore meant a Playwright script that screen-scraped the UI —
// navigate, wait for the canvas, find the wall checkbox, click a preset,
// click Save PNG, catch the download. Every one of those steps breaks
// when the sidebar is restyled.
//
// This module turns the same knobs into query parameters, so the route
// itself is the stable automation surface:
//
//   /projects/18/versions/62/preview?preset=iso&wall=steel&bg=dark&autocapture=1
//
// Two properties matter and are easy to lose:
//
//   1. **URL beats localStorage.** Scene controls persist globally
//      (`scenePrefs`, Tier 3 #56). If the persisted layer won, the same
//      URL would render differently on two machines — the opposite of
//      what a proof pipeline needs. Anything named in the URL overrides
//      the persisted value; anything absent falls through to it.
//   2. **Unknown values fall back loudly.** A typo (`wall=steal`) must
//      not silently render the default and hand back a file that looks
//      plausible. Parsing collects warnings; the driver prints them and
//      `--strict` turns them into a non-zero exit.
//
// Pure module — no React, no DOM. Unit-tested in node.
import {
  isCameraPreset,
  CAMERA_PRESET_NAMES,
  type CameraPreset,
} from './cameraPresets';
import {
  BACKGROUND_OPTIONS,
  WALL_COLOR_OPTIONS,
  type SceneControlsState,
} from './SceneControls';

/** Six-digit hex, the form every scene-control colour already uses. */
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/**
 * Named wall surfaces. The hex values are not re-typed literals — each
 * one is asserted against `WALL_COLOR_OPTIONS` in the test suite, so a
 * future retune of the swatch cannot leave `wall=steel` pointing at a
 * colour that is no longer in the picker (CLAUDE.md bug class #6:
 * a constant that claims to describe other data must be checked
 * against it).
 */
export const WALL_PRESETS: Record<string, { enabled: boolean; color?: string }> = {
  off: { enabled: false },
  white: { enabled: true, color: '#f0f0f0' },
  steel: { enabled: true, color: '#888888' },
  black: { enabled: true, color: '#222222' },
  wood: { enabled: true, color: '#8a6a3a' },
};

/** Named backgrounds, mirroring `BACKGROUND_OPTIONS`. */
export const BACKGROUND_PRESETS: Record<string, string> = {
  black: '#000000',
  dark: '#1a1a1a',
  grey: '#888888',
  gray: '#888888',
  white: '#ffffff',
};

export const WALL_PRESET_NAMES = Object.keys(WALL_PRESETS);
export const BACKGROUND_PRESET_NAMES = Object.keys(BACKGROUND_PRESETS);

/** The camera-preset names, re-exported so callers need one import. */
export { CAMERA_PRESET_NAMES };

export interface RenderParams {
  /** Camera preset named in the URL, or null to keep the default front fit. */
  preset: CameraPreset | null;
  /** `?autocapture` present — install the headless capture handshake. */
  autocapture: boolean;
  /** `?nobloom` present — Scene skips the EffectComposer wrap entirely. */
  noBloom: boolean;
  /** Scene-control fields named in the URL. Absent fields fall through to prefs. */
  overrides: Partial<SceneControlsState>;
  /** Capture timeout override in ms (`?timeout=`), or null for the default. */
  timeoutMs: number | null;
  /** Human-readable complaints about the URL. Never thrown; the caller decides. */
  warnings: string[];
}

/**
 * `?nobloom` matcher. Kept as an exported regex because `Scene.tsx` has
 * its own copy of this test against `window.location.search` (it reads
 * the flag at mount, outside React Router) and the two must agree — if
 * they ever disagree, the page would install a bloom-expecting capture
 * guard over a scene rendering without a composer, and the capture would
 * fail with a confusing message instead of producing a flat PNG.
 */
export const NO_BLOOM_RE = /(^\?|&)nobloom(=|&|$)/;

function resolveColor(
  raw: string,
  presets: Record<string, string>,
): string | null {
  const key = raw.trim().toLowerCase();
  if (Object.prototype.hasOwnProperty.call(presets, key)) return presets[key];
  if (HEX_COLOR_RE.test(raw.trim())) return raw.trim().toLowerCase();
  return null;
}

/**
 * Parse a `location.search` string into render parameters.
 *
 * Accepts the string with or without its leading `?`. Unknown keys are
 * ignored (the route already carries `groupId`, and future params
 * should not break older drivers); unknown *values* warn.
 */
export function parseRenderParams(search: string): RenderParams {
  const warnings: string[] = [];
  const qs = new URLSearchParams(
    search.startsWith('?') ? search.slice(1) : search,
  );
  const overrides: Partial<SceneControlsState> = {};

  let preset: CameraPreset | null = null;
  const rawPreset = qs.get('preset');
  if (rawPreset !== null) {
    const v = rawPreset.trim().toLowerCase();
    if (isCameraPreset(v)) {
      preset = v;
    } else {
      warnings.push(
        `unknown preset "${rawPreset}" (expected one of ${CAMERA_PRESET_NAMES.join(', ')}); using the default front fit`,
      );
    }
  }

  const rawWall = qs.get('wall');
  if (rawWall !== null) {
    const key = rawWall.trim().toLowerCase();
    if (Object.prototype.hasOwnProperty.call(WALL_PRESETS, key)) {
      const w = WALL_PRESETS[key];
      overrides.wallEnabled = w.enabled;
      if (w.color) overrides.wallColor = w.color;
    } else if (HEX_COLOR_RE.test(rawWall.trim())) {
      // A raw hex means "show a wall in this colour" — asking for a
      // wall colour and getting no wall would be a surprise.
      overrides.wallEnabled = true;
      overrides.wallColor = rawWall.trim().toLowerCase();
    } else {
      warnings.push(
        `unknown wall "${rawWall}" (expected one of ${WALL_PRESET_NAMES.join(', ')} or #rrggbb); leaving the wall as configured`,
      );
    }
  }

  const rawBg = qs.get('bg');
  if (rawBg !== null) {
    const color = resolveColor(rawBg, BACKGROUND_PRESETS);
    if (color) {
      overrides.backgroundColor = color;
    } else {
      warnings.push(
        `unknown bg "${rawBg}" (expected one of ${BACKGROUND_PRESET_NAMES.join(', ')} or #rrggbb); leaving the background as configured`,
      );
    }
  }

  let timeoutMs: number | null = null;
  const rawTimeout = qs.get('timeout');
  if (rawTimeout !== null) {
    const n = Number(rawTimeout);
    if (Number.isFinite(n) && n > 0) {
      timeoutMs = n;
    } else {
      warnings.push(`ignoring non-positive timeout "${rawTimeout}"`);
    }
  }

  const normalisedSearch = search.startsWith('?') ? search : `?${search}`;
  return {
    preset,
    autocapture: qs.has('autocapture') && qs.get('autocapture') !== '0',
    noBloom: NO_BLOOM_RE.test(normalisedSearch),
    overrides,
    timeoutMs,
    warnings,
  };
}

/**
 * Layer the URL overrides on top of a base scene-control state (which
 * is normally the persisted prefs). Pure; returns a new object.
 */
export function applyRenderParams(
  base: SceneControlsState,
  params: RenderParams,
): SceneControlsState {
  return { ...base, ...params.overrides };
}

/**
 * The set of background swatch values the picker offers, for the test
 * that pins `BACKGROUND_PRESETS` against the UI.
 */
export const BACKGROUND_SWATCH_VALUES: readonly string[] =
  BACKGROUND_OPTIONS.map((o) => o.value);

/** Same, for the wall swatches. */
export const WALL_SWATCH_VALUES: readonly string[] = WALL_COLOR_OPTIONS.map(
  (o) => o.value,
);
