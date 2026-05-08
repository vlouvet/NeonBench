// react-refresh/only-export-components flags non-component named
// exports because Fast Refresh can't preserve their identity across
// HMR boundaries. The constants below (color swatches + default
// state) ride along with the component file because they're tightly
// coupled to it — splitting them into a separate module would make
// the file scope balloon for V1. Disable the rule file-wide; if HMR
// state-keeping for the sidebar ever becomes a real friction we can
// hoist the constants then.
/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
import {
  BLOOM_INTENSITY,
  BLOOM_LUMINANCE_THRESHOLD,
  BLOOM_RADIUS,
} from './Scene';

/**
 * Phase 3 #7 — floating scene-controls sidebar for the preview page.
 *
 * Top-right panel (the preset bar from #5 takes top-left) with the
 * scene-chrome controls: background color, wall on/off + color,
 * ambient-light intensity, the three bloom sliders (Tier 3 #55), a
 * reset-to-defaults link (Tier 3 #56), and a screenshot button.
 *
 * The sidebar is collapsible: a compact header bar is always visible;
 * the body shows when expanded. Default is expanded — first-visit
 * users should see the controls without hunting. The expanded/collapsed
 * preference is component-local (cheap state, not worth persisting).
 *
 * Persistence (Tier 3 #56): the *values* (not the expanded flag) are
 * persisted globally to localStorage by PreviewPage via
 * `lib/scenePrefs.ts`. This component stays a controlled view — it
 * never reads/writes localStorage itself, which keeps it pure for
 * tests and lets the parent throttle writes.
 *
 * No edit affordances. No drag-to-reposition. No widget libraries.
 * Plain `<select>`, `<input>`, `<button>`. The spec calls this out
 * explicitly: this UI is meant to be obvious and dull.
 */

/** The four background swatches the spec ships. Hex values are exact. */
export const BACKGROUND_OPTIONS = [
  { value: '#000000', label: 'Black' },
  { value: '#1a1a1a', label: 'Dark grey' },
  { value: '#888888', label: 'Neutral grey' },
  { value: '#ffffff', label: 'White' },
] as const;

/** Wall colors — applied to the `<meshStandardMaterial color>` of the wall plane. */
export const WALL_COLOR_OPTIONS = [
  { value: '#f0f0f0', label: 'White' },
  { value: '#888888', label: 'Steel grey' },
  { value: '#222222', label: 'Black' },
  { value: '#8a6a3a', label: 'Wood' },
] as const;

export interface SceneControlsState {
  backgroundColor: string;
  wallEnabled: boolean;
  wallColor: string;
  ambientIntensity: number;
  /** Bloom strength (0..3). Tier 3 #55 surfaces this as a slider. */
  bloomIntensity: number;
  /** Bloom luminance threshold (0..1). Below = doesn't glow. */
  bloomThreshold: number;
  /** Bloom mipmap-blur radius (0..2). Larger = softer halo. */
  bloomRadius: number;
}

/**
 * The defaults used both at first mount and as the values handed to
 * Scene. Bloom defaults are sourced from Scene's exported constants so
 * a future tuning of either value flows through automatically.
 */
export const DEFAULT_SCENE_CONTROLS: SceneControlsState = {
  // Matches the dark-grey scene Phase 3 #4 ships, so this PR is a
  // strict superset (no first-paint regression).
  backgroundColor: '#1a1a1a',
  wallEnabled: false,
  wallColor: '#f0f0f0',
  ambientIntensity: 0.3,
  bloomIntensity: BLOOM_INTENSITY,
  bloomThreshold: BLOOM_LUMINANCE_THRESHOLD,
  bloomRadius: BLOOM_RADIUS,
};

export interface SceneControlsProps {
  state: SceneControlsState;
  onChange: (next: SceneControlsState) => void;
  onScreenshot: () => void;
  /**
   * Reset the panel to the baked-in defaults. Wired by PreviewPage to
   * also clear localStorage so the next mount starts fresh.
   */
  onResetDefaults: () => void;
}

export default function SceneControls({
  state,
  onChange,
  onScreenshot,
  onResetDefaults,
}: SceneControlsProps) {
  const [expanded, setExpanded] = useState(true);

  function patch<K extends keyof SceneControlsState>(
    key: K,
    value: SceneControlsState[K],
  ) {
    onChange({ ...state, [key]: value });
  }

  return (
    <div
      className="preview-page__scene-controls"
      role="region"
      aria-label="Scene controls"
    >
      <button
        type="button"
        className="preview-page__scene-controls-header"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
      >
        <span>Scene</span>
        <span aria-hidden="true">{expanded ? '−' : '+'}</span>
      </button>
      {expanded && (
        <div className="preview-page__scene-controls-body">
          <label className="preview-page__scene-control">
            <span className="preview-page__scene-control-label">Background</span>
            <select
              value={state.backgroundColor}
              onChange={(e) => patch('backgroundColor', e.target.value)}
            >
              {BACKGROUND_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="preview-page__scene-control preview-page__scene-control--group">
            <legend className="preview-page__scene-control-label">Wall backing</legend>
            <label className="preview-page__scene-checkbox">
              <input
                type="checkbox"
                checked={state.wallEnabled}
                onChange={(e) => patch('wallEnabled', e.target.checked)}
              />
              <span>Show wall backing</span>
            </label>
            <select
              aria-label="Wall color"
              value={state.wallColor}
              onChange={(e) => patch('wallColor', e.target.value)}
              disabled={!state.wallEnabled}
            >
              {WALL_COLOR_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </fieldset>

          <label className="preview-page__scene-control">
            <span className="preview-page__scene-control-label">
              Ambient light{' '}
              <span className="preview-page__scene-control-value">
                {state.ambientIntensity.toFixed(2)}
              </span>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={state.ambientIntensity}
              onChange={(e) =>
                patch('ambientIntensity', Number(e.target.value))
              }
            />
          </label>

          {/* Bloom sub-section (Tier 3 #55). Three sliders mirror the
              ambient-light layout: tabular-nums readout next to the
              label so digits don't jitter on drag. Wrapped in a
              `<fieldset>` (re-uses the same `--group` styling as the
              wall backing block) so the sub-section reads as a unit. */}
          <fieldset className="preview-page__scene-control preview-page__scene-control--group">
            <legend className="preview-page__scene-control-label">Bloom</legend>
            <label className="preview-page__scene-control">
              <span className="preview-page__scene-control-label">
                Intensity{' '}
                <span className="preview-page__scene-control-value">
                  {state.bloomIntensity.toFixed(2)}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={3}
                step={0.05}
                value={state.bloomIntensity}
                onChange={(e) =>
                  patch('bloomIntensity', Number(e.target.value))
                }
                aria-label="Bloom intensity"
              />
            </label>
            <label className="preview-page__scene-control">
              <span className="preview-page__scene-control-label">
                Threshold{' '}
                <span className="preview-page__scene-control-value">
                  {state.bloomThreshold.toFixed(2)}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={state.bloomThreshold}
                onChange={(e) =>
                  patch('bloomThreshold', Number(e.target.value))
                }
                aria-label="Bloom luminance threshold"
              />
            </label>
            <label className="preview-page__scene-control">
              <span className="preview-page__scene-control-label">
                Radius{' '}
                <span className="preview-page__scene-control-value">
                  {state.bloomRadius.toFixed(2)}
                </span>
              </span>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={state.bloomRadius}
                onChange={(e) =>
                  patch('bloomRadius', Number(e.target.value))
                }
                aria-label="Bloom radius"
              />
            </label>
          </fieldset>

          <button
            type="button"
            className="preview-page__scene-screenshot"
            onClick={onScreenshot}
          >
            Save PNG
          </button>

          {/* Reset link (Tier 3 #56). Subdued styling so it sits below
              the screenshot CTA without competing for attention; the
              `↺` glyph reads as "rewind" / "restore" and is widely
              recognised across locales. Clicking clears localStorage
              and sets the in-memory state back to the baked-in
              defaults. */}
          <button
            type="button"
            className="preview-page__scene-reset"
            onClick={onResetDefaults}
            title="Reset all scene controls to their baked-in defaults"
          >
            ↺ Reset to defaults
          </button>
        </div>
      )}
    </div>
  );
}
