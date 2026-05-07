import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { api, type DesignVersion, type VectorizeRequest } from '../api';

// Max dimension we'll render the preview at. Source images larger than this
// are downsampled before being binarized — this is a UI hint, not the actual
// pixels the backend will see.
const PREVIEW_MAX_DIM = 320;
// If the source image is huge (typical phone photo), the offscreen canvas we
// hold the pixel cache in is capped to this on the longest side. The backend
// still works on the full-resolution upload; this is preview-only.
const SOURCE_CACHE_MAX_DIM = 1024;

type SourceState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      // Cached pixel data + dimensions, downsampled to fit SOURCE_CACHE_MAX_DIM.
      pixels: Uint8ClampedArray;
      width: number;
      height: number;
      // Display dimensions for the preview canvases (capped to PREVIEW_MAX_DIM).
      displayWidth: number;
      displayHeight: number;
    };

export default function VectorizePanel({
  projectId,
  assetId,
  isSVG,
  onCreated,
}: {
  projectId: number;
  assetId: number;
  isSVG: boolean;
  onCreated: (dv: DesignVersion) => void;
}) {
  const [targetWidthMM, setTargetWidthMM] = useState(600);
  const [threshold, setThreshold] = useState(128);
  const [label, setLabel] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [smoothingMM, setSmoothingMM] = useState<number | ''>('');
  const [minSpurMM, setMinSpurMM] = useState<number | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live preview state: source pixel cache + canvas refs for the two panels.
  // We use useDeferredValue on threshold so dragging the slider stays smooth
  // while the binarize pass catches up — re-binarizing a 1k-pixel image on
  // every onChange is fast but not free.
  const [source, setSource] = useState<SourceState>({ kind: 'loading' });
  // Track which asset/isSVG combo `source` corresponds to. When this changes,
  // we reset to 'loading' during render rather than in an effect — that way
  // we don't trip the react-hooks/set-state-in-effect rule.
  const [sourceKey, setSourceKey] = useState<string>(`${assetId}:${isSVG}`);
  const currentKey = `${assetId}:${isSVG}`;
  if (sourceKey !== currentKey) {
    setSourceKey(currentKey);
    setSource({ kind: 'loading' });
  }
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const binCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const deferredThreshold = useDeferredValue(threshold);

  // Load the source image once per assetId. Decode → composite onto white
  // (matching backend preprocess.go) → downsample to SOURCE_CACHE_MAX_DIM →
  // cache the RGBA pixel buffer for repeated binarize passes.
  useEffect(() => {
    if (isSVG) return;
    let cancelled = false;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      if (srcW === 0 || srcH === 0) {
        setSource({ kind: 'error' });
        return;
      }
      // Downsample for caching; preview width capped separately below.
      const cacheScale = Math.min(1, SOURCE_CACHE_MAX_DIM / Math.max(srcW, srcH));
      const cw = Math.max(1, Math.round(srcW * cacheScale));
      const ch = Math.max(1, Math.round(srcH * cacheScale));
      const off = document.createElement('canvas');
      off.width = cw;
      off.height = ch;
      const ctx = off.getContext('2d');
      if (!ctx) {
        setSource({ kind: 'error' });
        return;
      }
      // Composite onto white so transparent pixels read as background, not
      // black — matches DecodeImage in internal/vectorize/preprocess.go.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      let data: ImageData;
      try {
        data = ctx.getImageData(0, 0, cw, ch);
      } catch {
        // Tainted canvas (cross-origin without CORS). Shouldn't happen for
        // same-origin /api/projects/... but degrade gracefully.
        setSource({ kind: 'error' });
        return;
      }
      const displayScale = Math.min(1, PREVIEW_MAX_DIM / Math.max(cw, ch));
      setSource({
        kind: 'ready',
        pixels: data.data,
        width: cw,
        height: ch,
        displayWidth: Math.max(1, Math.round(cw * displayScale)),
        displayHeight: Math.max(1, Math.round(ch * displayScale)),
      });
    };
    img.onerror = () => {
      if (!cancelled) setSource({ kind: 'error' });
    };
    img.src = api.assetURL(projectId, assetId);

    return () => {
      cancelled = true;
    };
  }, [projectId, assetId, isSVG]);

  // Paint the source canvas once when pixels become available.
  useEffect(() => {
    if (source.kind !== 'ready') return;
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = new ImageData(
      new Uint8ClampedArray(source.pixels),
      source.width,
      source.height,
    );
    ctx.putImageData(imageData, 0, 0);
  }, [source]);

  // Re-binarize whenever the deferred threshold or the cached source change.
  // Backend convention: luminance < threshold → foreground (black). We use
  // Rec. 601 luma; the source is already composited onto white above so
  // transparent pixels won't surprise us.
  useEffect(() => {
    if (source.kind !== 'ready') return;
    const canvas = binCanvasRef.current;
    if (!canvas) return;
    canvas.width = source.width;
    canvas.height = source.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const px = source.pixels;
    const out = new Uint8ClampedArray(px.length);
    const t = deferredThreshold;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = lum < t ? 0 : 255;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
    ctx.putImageData(new ImageData(out, source.width, source.height), 0, 0);
  }, [source, deferredThreshold]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const body: VectorizeRequest = {
      asset_id: assetId,
      target_width_mm: targetWidthMM,
    };
    if (label.trim()) body.label = label.trim();
    if (!isSVG) {
      body.threshold = threshold;
      if (showAdvanced) {
        if (smoothingMM !== '' && smoothingMM > 0) body.smoothing_mm = smoothingMM;
        if (minSpurMM !== '' && minSpurMM > 0) body.min_spur_mm = minSpurMM;
      }
    }
    try {
      const dv = await api.vectorize(projectId, body);
      onCreated(dv);
      setLabel('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="vectorize-panel" onSubmit={submit}>
      <h3>{isSVG ? 'Import SVG' : 'Vectorize'}</h3>
      <div className="vp-grid">
        <label>
          Target width (mm)
          <input
            type="number"
            min={1}
            max={5000}
            value={targetWidthMM}
            onChange={(e) => setTargetWidthMM(Number(e.target.value))}
          />
        </label>
        {!isSVG && (
          <label>
            Threshold (0–255)
            <input
              type="range"
              min={1}
              max={254}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <span className="meta">{threshold}</span>
          </label>
        )}
        <label className="vp-full">
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. 'tighter corners' or 'final draft'"
          />
        </label>
      </div>

      {!isSVG && (
        <div className="vp-preview" aria-label="Threshold preview">
          {source.kind === 'loading' && (
            <p className="vp-preview-status">Loading source…</p>
          )}
          {source.kind === 'error' && (
            <p className="vp-preview-status">
              Preview unavailable; vectorize anyway will use the latest threshold.
            </p>
          )}
          {source.kind === 'ready' && (
            <div className="vp-preview-pair">
              <figure className="vp-preview-figure">
                <canvas
                  ref={sourceCanvasRef}
                  className="vp-preview-canvas"
                  style={{
                    width: source.displayWidth,
                    height: source.displayHeight,
                  }}
                />
                <figcaption>Source</figcaption>
              </figure>
              <figure className="vp-preview-figure">
                <canvas
                  ref={binCanvasRef}
                  className="vp-preview-canvas"
                  style={{
                    width: source.displayWidth,
                    height: source.displayHeight,
                  }}
                />
                <figcaption>Binarized (preview)</figcaption>
              </figure>
            </div>
          )}
        </div>
      )}

      {!isSVG && (
        <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced centerline options</summary>
          <div className="vp-grid">
            <label title="Ramer-Douglas-Peucker tolerance in mm. Higher values smooth more aggressively (fewer vertices, more rounded corners). Blank uses an automatic value derived from the project tube diameter.">
              Smoothing ε (mm)
              <input
                type="number"
                step={0.1}
                min={0}
                max={5}
                value={smoothingMM}
                onChange={(e) => {
                  const v = e.target.value;
                  setSmoothingMM(v === '' ? '' : Number(v));
                }}
                placeholder="auto"
              />
            </label>
            <label title="Minimum branch length to keep, in mm. Skeleton spurs shorter than this get pruned. Blank uses an automatic value of about 2× the project tube diameter.">
              Min spur (mm)
              <input
                type="number"
                step={0.5}
                min={0}
                max={50}
                value={minSpurMM}
                onChange={(e) => {
                  const v = e.target.value;
                  setMinSpurMM(v === '' ? '' : Number(v));
                }}
                placeholder="auto"
              />
            </label>
          </div>
        </details>
      )}

      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={submitting || targetWidthMM <= 0}>
          {submitting ? 'Working…' : isSVG ? 'Import as design' : 'Vectorize'}
        </button>
      </div>
    </form>
  );
}
