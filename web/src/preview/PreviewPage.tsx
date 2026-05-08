import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Canvas } from '@react-three/fiber';
import { api, parseDoc, type DesignDoc, type DesignVersion } from '../api';
import Scene from './Scene';
import './preview.css';

/**
 * PreviewPage is the route component for the Phase 3 read-only 3D
 * preview. Loads the requested design version, parses its design doc,
 * and mounts a `<Canvas>` whose contents render the scene placeholder
 * (Phase 3 #2 will swap the placeholder for tube geometry).
 *
 * No edit affordances here — the preview is read-only and stays that
 * way through every Phase 3 spec. The "Back to project" link is the
 * only navigation; orbit controls and FPS HUD show up in Phase 3 #4
 * (camera) when those concerns can be reasoned about together.
 *
 * Canvas tuning rationale (per spec):
 *   - dpr={[1, 2]} adapts to retina displays without forcing 2x on
 *     low-end machines that can't keep 60 fps at 2x.
 *   - camera position [0, 0, 1500] with fov 50 frames a 1000 × 500 mm
 *     design comfortably from outside; the Phase 3 #4 orbit controls
 *     will override this at runtime once they land.
 *   - Background #0a0a0a (dark grey, not pure black) so emissive
 *     materials in Phase 3 #3 still pop while the scene reads as a
 *     "stage" rather than the void.
 */
export default function PreviewPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          <Canvas
            dpr={[1, 2]}
            camera={{ position: [0, 0, 1500], fov: 50 }}
            style={{ background: '#0a0a0a' }}
          >
            <Scene doc={doc} />
          </Canvas>
        </div>
      )}
    </div>
  );
}
