import { useState } from 'react';
import { api, type DesignVersion, type VectorizeRequest } from '../api';

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
