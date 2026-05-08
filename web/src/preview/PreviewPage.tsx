import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { api, parseDoc, type DesignDoc, type DesignVersion, type Project } from '../api';
import Scene, { type CaptureContext, type PresetRequest } from './Scene';
import { PREVIEW_CAMERA_CONFIG, type CameraPreset } from './cameraPresets';
import SceneControls, {
  DEFAULT_SCENE_CONTROLS,
  type SceneControlsState,
} from './SceneControls';
import { captureCanvasToPNG, screenshotFilename } from './screenshot';
import './preview.css';

/**
 * PreviewPage is the route component for the Phase 3 read-only 3D
 * preview. Loads the requested design version, parses its design
 * doc, and mounts a `<Canvas>` whose contents render the tube
 * scene.
 *
 * Phase 3 #5 layered preset-view buttons (Front / Iso / Top / Side).
 * Phase 3 #7 (this revision) adds:
 *
 *   1. A floating sidebar (top-right, opposite the preset bar) that
 *      owns scene-chrome state — background color, wall on/off +
 *      color, ambient-light intensity.
 *   2. A "Save PNG" button that captures the current canvas frame to
 *      a download. Capture is wired through a `<ScreenshotBridge>`
 *      child of `<Canvas>` (see Scene.tsx) — that's the only way to
 *      get the live `gl / scene / camera` triple out to a sibling
 *      button without a context provider, and a context provider
 *      would add a stale-renderer hazard on context loss + restore.
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
 * is the only navigation chrome besides the preset bar + the new
 * scene-controls sidebar.
 */

const PRESETS: { preset: CameraPreset; label: string; hint: string }[] = [
  { preset: 'front', label: 'Front', hint: 'Customer view (looking at the sign face)' },
  { preset: 'iso', label: 'Iso', hint: 'Three-quarter / marketing-render angle' },
  { preset: 'top', label: 'Top', hint: 'Bird’s-eye for layout review' },
  { preset: 'side', label: 'Side', hint: 'Profile / depth view' },
];

export default function PreviewPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preset request envelope — `nonce` is bumped per click so a
  // double-tap on the same preset re-fires the animation (useful
  // for "I orbited away, take me back to Front"). Held in state so
  // React can pass it down as a prop and the child's `useEffect`
  // dep watches it for changes.
  const [presetRequest, setPresetRequest] = useState<PresetRequest | null>(null);
  const nonceRef = useRef(0);

  // Scene-chrome state (background, wall, ambient). Component-local
  // — no URL params, no localStorage. Persistence is a follow-up
  // (see report).
  const [sceneState, setSceneState] = useState<SceneControlsState>(
    DEFAULT_SCENE_CONTROLS,
  );

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
    api
      .getProject(projectId)
      .then((p) => {
        if (cancelled) return;
        setProject(p);
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
            onChange={setSceneState}
            onScreenshot={handleScreenshot}
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
              presetRequest={presetRequest ?? undefined}
              backgroundColor={sceneState.backgroundColor}
              ambientIntensity={sceneState.ambientIntensity}
              wallEnabled={sceneState.wallEnabled}
              wallColor={sceneState.wallColor}
              onCaptureReady={handleCaptureReady}
            />
          </Canvas>
        </div>
      )}
    </div>
  );
}
