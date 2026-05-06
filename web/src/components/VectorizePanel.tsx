import { useState } from 'react';
import { api, type DesignVersion, type VectorizeRequest } from '../api';

const TURN_POLICIES = ['black', 'white', 'left', 'right', 'minority', 'majority', 'random'] as const;

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
  const [turnPolicy, setTurnPolicy] = useState<typeof TURN_POLICIES[number]>('minority');
  const [turdsize, setTurdsize] = useState(2);
  const [alphamax, setAlphamax] = useState(1.0);
  const [opttolerance, setOpttolerance] = useState(0.2);
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
        body.turn_policy = turnPolicy;
        body.turdsize = turdsize;
        body.alphamax = alphamax;
        body.opttolerance = opttolerance;
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
          <summary>Advanced potrace options</summary>
          <div className="vp-grid">
            <label>
              Turn policy
              <select value={turnPolicy} onChange={(e) => setTurnPolicy(e.target.value as typeof TURN_POLICIES[number])}>
                {TURN_POLICIES.map((p) => (
                  <option key={p} value={p}>{p}</option>
                ))}
              </select>
            </label>
            <label>
              Turdsize (px)
              <input type="number" min={0} max={1000} value={turdsize} onChange={(e) => setTurdsize(Number(e.target.value))} />
            </label>
            <label>
              Alphamax
              <input type="number" step={0.05} min={0} max={1.3334} value={alphamax} onChange={(e) => setAlphamax(Number(e.target.value))} />
            </label>
            <label>
              Opttolerance
              <input type="number" step={0.05} min={0} max={5} value={opttolerance} onChange={(e) => setOpttolerance(Number(e.target.value))} />
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
