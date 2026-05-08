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

/**
 * Phase 3 #7 — floating scene-controls sidebar for the preview page.
 *
 * Top-right panel (the preset bar from #5 takes top-left) with four
 * controls: background color, wall on/off + color, ambient-light
 * intensity, and a screenshot button.
 *
 * The sidebar is collapsible: a compact header bar is always visible;
 * the body shows when expanded. Default is expanded — first-visit
 * users should see the controls without hunting. State is component-
 * local (no localStorage in V1; persistence is a flagged follow-up).
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
}

/** The defaults used both at first mount and as the values handed to Scene. */
export const DEFAULT_SCENE_CONTROLS: SceneControlsState = {
  // Matches the dark-grey scene Phase 3 #4 ships, so this PR is a
  // strict superset (no first-paint regression).
  backgroundColor: '#1a1a1a',
  wallEnabled: false,
  wallColor: '#f0f0f0',
  ambientIntensity: 0.3,
};

export interface SceneControlsProps {
  state: SceneControlsState;
  onChange: (next: SceneControlsState) => void;
  onScreenshot: () => void;
}

export default function SceneControls({
  state,
  onChange,
  onScreenshot,
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

          <button
            type="button"
            className="preview-page__scene-screenshot"
            onClick={onScreenshot}
          >
            Save PNG
          </button>
        </div>
      )}
    </div>
  );
}
