import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { api, parseDoc, type DesignDoc, type DesignVersion, type Project } from '../api';
import Scene, { type CaptureContext, type PresetRequest } from './Scene';
import { PREVIEW_CAMERA_CONFIG, type CameraPreset } from './cameraPresets';
import SceneControls, {
  DEFAULT_SCENE_CONTROLS,
  type SceneControlsState,
} from './SceneControls';
import { captureCanvasToPNG, screenshotFilename } from './screenshot';
import {
  DEFAULT_SCENE_PREFS,
  clearScenePrefs,
  loadScenePrefs,
  saveScenePrefs,
  type ScenePrefs,
} from '../lib/scenePrefs';
import './preview.css';

/**
 * PreviewPage is the route component for the Phase 3 read-only 3D
 * preview. Loads the requested design version, parses its design
 * doc, and mounts a `<Canvas>` whose contents render the tube
 * scene.
 *
 * Phase 3 #5 layered preset-view buttons (Front / Iso / Top / Side).
 * Phase 3 #7 added the floating scene-controls sidebar (background,
 * wall, ambient, screenshot). Tier 3 #55 + #56 (this revision) layer:
 *
 *   1. Three bloom sliders (intensity, threshold, radius) inside the
 *      scene-controls panel, surfacing the previously hard-coded
 *      `BLOOM_*` constants for per-session tuning.
 *   2. Global localStorage persistence of every scene-control value
 *      (background, wall enabled / color, ambient, the three bloom
 *      sliders). Camera position is *not* persisted — it auto-fits
 *      per doc, and a stale orbit pose would yank the user out of the
 *      design on every mount. Writes are debounced (250 ms) to avoid
 *      hammering localStorage on slider drag.
 *   3. A "↺ Reset to defaults" button on the panel that clears
 *      localStorage and restores the baked-in defaults.
 *
 * Canvas tuning rationale (per Phase 3 #1 spec):
 *   - dpr={[1, 2]} adapts to retina displays without forcing 2x on
 *     low-end machines that can't keep 60 fps at 2x.
 *   - camera position [0, 0, 1500] with fov 50 is the *initial*
 *     framing; on doc load Scene snaps the camera to a fit-to-
 *     content front view (Phase 3 #5), so this default is only
 *     visible for the brief moment between Canvas mount and the
 *     first effect tick.
 *   - The Canvas `style.background` is now driven by SceneControls
 *     (Phase 3 #7); `<color attach="background">` inside Scene is
 *     the source of truth so the screenshot picks it up. The CSS
 *     fallback below is a paint-flash guard.
 *
 * No edit affordances here — the preview is read-only and stays
 * that way through every Phase 3 spec. The "Back to project" link
 * is the only navigation chrome besides the preset bar + the
 * scene-controls sidebar.
 *
 * Tier 3 #53 wires the project's tube-spec diameter through to
 * `<Scene defaultDiameterMM>` so runs without a per-run
 * `diameter_mm_override` render at the project's actual diameter.
 * The fetch is best-effort: while it's in flight (or if it fails)
 * Scene falls back to its 12 mm defensive constant, and the route
 * isn't blocked on the network call.
 */

const PRESETS: { preset: CameraPreset; label: string; hint: string }[] = [
  { preset: 'front', label: 'Front', hint: 'Customer view (looking at the sign face)' },
  { preset: 'iso', label: 'Iso', hint: 'Three-quarter / marketing-render angle' },
  { preset: 'top', label: 'Top', hint: 'Bird’s-eye for layout review' },
  { preset: 'side', label: 'Side', hint: 'Profile / depth view' },
];

/**
 * Debounce window for `saveScenePrefs`. 250 ms is the sweet spot for
 * slider drag: slow enough that a continuous drag doesn't fire 60
 * writes/sec, fast enough that the user perceives the next route
 * mount as "remembered". Tier 3 #56.
 */
const SCENE_PREFS_SAVE_DEBOUNCE_MS = 250;

/**
 * Project the persisted prefs onto the SceneControls state shape. The
 * persisted layer is a strict superset of the controls layer (it adds
 * a `version` field) so this is a one-line projection — kept as a
 * helper so a future addition (e.g. per-project overrides) only has
 * to plug in here.
 */
function prefsToControlsState(prefs: ScenePrefs): SceneControlsState {
  return {
    backgroundColor: prefs.backgroundColor,
    wallEnabled: prefs.wallEnabled,
    wallColor: prefs.wallColor,
    ambientIntensity: prefs.ambientIntensity,
    bloomIntensity: prefs.bloomIntensity,
    bloomThreshold: prefs.bloomThreshold,
    bloomRadius: prefs.bloomRadius,
  };
}

/** Reverse projection — same fields, plus the schema version. */
function controlsStateToPrefs(state: SceneControlsState): ScenePrefs {
  return {
    version: DEFAULT_SCENE_PREFS.version,
    backgroundColor: state.backgroundColor,
    wallEnabled: state.wallEnabled,
    wallColor: state.wallColor,
    ambientIntensity: state.ambientIntensity,
    bloomIntensity: state.bloomIntensity,
    bloomThreshold: state.bloomThreshold,
    bloomRadius: state.bloomRadius,
  };
}

export default function PreviewPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);

  // Tier 3 #63 — read the focused group id from the URL (`?groupId=`).
  // URL is the canonical source of truth for the selection: a refresh
  // round-trips cleanly, and the link is shareable/bookmarkable. The
  // sidebar `<select>` writes back via `useNavigate` (see
  // SceneControls). An empty string is normalized to `null` so Scene
  // and SceneControls can both treat "no filter" uniformly.
  const location = useLocation();
  const selectedGroupId = useMemo<string | null>(() => {
    const v = new URLSearchParams(location.search).get('groupId');
    if (!v) return null;
    return v;
  }, [location.search]);

  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Project's tube-spec diameter. Held separately from `project` so
  // Scene re-renders the moment the diameter resolves, without
  // waiting on the doc parse. Stays `null` while in flight; Scene
  // falls back to its defensive 12 mm constant in that window. Wires
  // the project's actual diameter into runs that don't carry a
  // `diameter_mm_override` (Tier 3 #53).
  const [defaultDiameterMM, setDefaultDiameterMM] = useState<number | null>(
    null,
  );

  // Preset request envelope — `nonce` is bumped per click so a
  // double-tap on the same preset re-fires the animation (useful
  // for "I orbited away, take me back to Front"). Held in state so
  // React can pass it down as a prop and the child's `useEffect`
  // dep watches it for changes.
  const [presetRequest, setPresetRequest] = useState<PresetRequest | null>(null);
  const nonceRef = useRef(0);

  // Scene-chrome state. Initial value comes from localStorage (or
  // baked-in defaults if storage is empty / corrupt / SSR). The lazy
  // initializer form means `loadScenePrefs()` only runs once at mount
  // — subsequent re-renders of PreviewPage don't re-read storage.
  const [sceneState, setSceneState] = useState<SceneControlsState>(() =>
    prefsToControlsState(loadScenePrefs()),
  );

  // Debounced persistence (Tier 3 #56). We stash the timer id in a
  // ref so a fast sequence of slider events keeps resetting the same
  // timer rather than spawning a new one per change. The cleanup
  // effect flushes a pending write on unmount so a user navigating
  // away mid-drag still keeps their last value.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPrefsRef = useRef<ScenePrefs | null>(null);
  useEffect(() => {
    return () => {
      if (saveTimerRef.current !== null) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        if (pendingPrefsRef.current) {
          // Flush the latest pending write so a quick "drag slider →
          // close tab" sequence doesn't lose the value.
          saveScenePrefs(pendingPrefsRef.current);
          pendingPrefsRef.current = null;
        }
      }
    };
  }, []);

  const handleSceneStateChange = useCallback((next: SceneControlsState) => {
    setSceneState(next);
    pendingPrefsRef.current = controlsStateToPrefs(next);
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      if (pendingPrefsRef.current) {
        saveScenePrefs(pendingPrefsRef.current);
        pendingPrefsRef.current = null;
      }
      saveTimerRef.current = null;
    }, SCENE_PREFS_SAVE_DEBOUNCE_MS);
  }, []);

  const handleResetDefaults = useCallback(() => {
    // Cancel any pending debounced write — otherwise it could race
    // ahead of `clearScenePrefs` and resurrect the previous values.
    if (saveTimerRef.current !== null) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    pendingPrefsRef.current = null;
    clearScenePrefs();
    setSceneState({ ...DEFAULT_SCENE_CONTROLS });
  }, []);

  // Capture context lives in a ref because the `Save PNG` click
  // handler is a stable callback that shouldn't re-run on every
  // re-register. ScreenshotBridge calls `setCaptureCtx` (via the
  // ref) once mounted; the click reads the current value.
  const captureCtxRef = useRef<CaptureContext | null>(null);
  const handleCaptureReady = useCallback(
    (ctx: CaptureContext | null) => {
      captureCtxRef.current = ctx;
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    api
      .getDesignVersion(projectId, versionId)
      .then((dv) => {
        if (cancelled) return;
        setVersion(dv);
        setDoc(parseDoc(dv));
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    // Project name is best-effort — used only to seed the screenshot
    // filename. A 404 here just means we fall back to "preview" in
    // the filename; not worth surfacing as an error to the user.
    //
    // The project carries a `tube_spec_id`; once we have the project
    // we list tube specs and look up the matching diameter so Scene
    // can render runs at the project's actual tube size (Tier 3 #53).
    // Failing that lookup is also non-fatal — Scene's 12 mm fallback
    // covers it, same as before.
    api
      .getProject(projectId)
      .then((p) => {
        if (cancelled) return;
        setProject(p);
        return api.listTubeSpecs().then((specs) => {
          if (cancelled) return;
          const spec = specs.find((s) => s.id === p.tube_spec_id);
          if (spec) setDefaultDiameterMM(spec.diameter_mm);
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, versionId]);

  function handlePreset(preset: CameraPreset) {
    nonceRef.current += 1;
    setPresetRequest({ preset, nonce: nonceRef.current });
  }

  function handleScreenshot() {
    const ctx = captureCtxRef.current;
    if (!ctx) {
      // Defensive: if the bridge hasn't registered yet (Canvas not
      // mounted, or context lost) drop the click. The button is
      // visible only after `version` loads, so this is rare.
      return;
    }
    const filename = screenshotFilename(project?.name ?? null);
    // Forward the live `EffectComposer` (when bloom is active) so
    // the PNG is captured through the post-process pipeline. When
    // `?nobloom` is set the composer wrap is skipped inside Scene
    // and `ctx.composer` is null/undefined; the helper then falls
    // back to the bare `gl.render(scene, camera)` path. Tier 1 #68.
    captureCanvasToPNG(
      ctx.gl,
      ctx.scene,
      ctx.camera,
      filename,
      undefined,
      ctx.composer ?? null,
    );
  }

  return (
    <div className="preview-page">
      <div className="preview-page__topbar">
        <Link to={`/projects/${projectId}`}>&larr; Back to project</Link>
        <h1>
          3D preview
          {version ? ` — v${version.version_no}${version.label ? ` · ${version.label}` : ''}` : ''}
        </h1>
      </div>
      {error ? (
        <div className="preview-page__error">
          Failed to load design version: {error}
        </div>
      ) : !version ? (
        <div className="preview-page__status">Loading 3D preview…</div>
      ) : (
        <div className="preview-page__canvas">
          {/*
            Preset bar sits ABOVE the canvas (sticky / pinned to the
            top of the canvas pane, not the page). Buttons fire a
            new `PresetRequest`; Scene picks up the change and
            animates the camera. The bar uses `aria-label` so
            screen readers announce it as a navigation landmark
            rather than a meaningless row of buttons.
          */}
          <div
            className="preview-page__preset-bar"
            role="toolbar"
            aria-label="Camera preset views"
          >
            {PRESETS.map(({ preset, label, hint }) => (
              <button
                key={preset}
                type="button"
                className="preview-page__preset-btn"
                onClick={() => handlePreset(preset)}
                title={hint}
              >
                {label}
              </button>
            ))}
          </div>
          <SceneControls
            state={sceneState}
            onChange={handleSceneStateChange}
            onScreenshot={handleScreenshot}
            onResetDefaults={handleResetDefaults}
            doc={doc}
            selectedGroupId={selectedGroupId}
          />
          <Canvas
            dpr={[1, 2]}
            camera={PREVIEW_CAMERA_CONFIG}
            // CSS background is just a paint-flash guard — the real
            // background is `<color attach="background">` inside
            // Scene, which the screenshot path reads.
            style={{ background: sceneState.backgroundColor }}
          >
            <Scene
              doc={doc}
              defaultDiameterMM={defaultDiameterMM ?? undefined}
              presetRequest={presetRequest ?? undefined}
              selectedGroupId={selectedGroupId}
              backgroundColor={sceneState.backgroundColor}
              ambientIntensity={sceneState.ambientIntensity}
              wallEnabled={sceneState.wallEnabled}
              wallColor={sceneState.wallColor}
              bloomIntensity={sceneState.bloomIntensity}
              bloomThreshold={sceneState.bloomThreshold}
              bloomRadius={sceneState.bloomRadius}
              onCaptureReady={handleCaptureReady}
            />
          </Canvas>
        </div>
      )}
    </div>
  );
}
