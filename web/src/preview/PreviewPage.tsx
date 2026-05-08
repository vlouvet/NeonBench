import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { api, parseDoc, type DesignDoc, type DesignVersion } from '../api';
import Scene, { type PresetRequest } from './Scene';
import type { CameraPreset } from './cameraPresets';
import './preview.css';

/**
 * PreviewPage is the route component for the Phase 3 read-only 3D
 * preview. Loads the requested design version, parses its design
 * doc, and mounts a `<Canvas>` whose contents render the tube
 * scene.
 *
 * Phase 3 #5 layers preset-view buttons (Front / Iso / Top / Side)
 * across the top of the canvas pane, sticky so they stay reachable
 * while the user orbits. Click a button → `Scene` animates the
 * camera + orbit target to a framing computed from the design's
 * bbox (see `cameraPresets.ts`).
 *
 * Canvas tuning rationale (per Phase 3 #1 spec):
 *   - dpr={[1, 2]} adapts to retina displays without forcing 2x on
 *     low-end machines that can't keep 60 fps at 2x.
 *   - camera position [0, 0, 1500] with fov 50 is the *initial*
 *     framing; on doc load Scene snaps the camera to a fit-to-
 *     content front view (Phase 3 #5), so this default is only
 *     visible for the brief moment between Canvas mount and the
 *     first effect tick.
 *   - Background #0a0a0a (dark grey, not pure black) so emissive
 *     materials in Phase 3 #3 still pop while the scene reads as a
 *     "stage" rather than the void.
 *
 * No edit affordances here — the preview is read-only and stays
 * that way through every Phase 3 spec. The "Back to project" link
 * is the only navigation chrome besides the preset bar.
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
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Preset request envelope — `nonce` is bumped per click so a
  // double-tap on the same preset re-fires the animation (useful
  // for "I orbited away, take me back to Front"). Held in state so
  // React can pass it down as a prop and the child's `useEffect`
  // dep watches it for changes.
  const [presetRequest, setPresetRequest] = useState<PresetRequest | null>(null);
  const nonceRef = useRef(0);

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
    return () => {
      cancelled = true;
    };
  }, [projectId, versionId]);

  function handlePreset(preset: CameraPreset) {
    nonceRef.current += 1;
    setPresetRequest({ preset, nonce: nonceRef.current });
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
          <Canvas
            dpr={[1, 2]}
            camera={{ position: [0, 0, 1500], fov: 50 }}
            style={{ background: '#0a0a0a' }}
          >
            <Scene doc={doc} presetRequest={presetRequest ?? undefined} />
          </Canvas>
        </div>
      )}
    </div>
  );
}
