// Hershey text insertion modal. Lives outside EditorCanvas (which is a
// high-coupling file per CLAUDE.md hazard map) and emits HersheyRuns to
// the parent's onInsert callback. The parent wraps each run as a fresh
// DesignRun and appends to the doc — so this dialog never has to know
// about the design-doc schema or save flow.

import { useMemo, useState } from 'react';
import { hersheyRunsBBox, hersheyTextToRuns, type HersheyRun } from '../lib/hershey/text';

type Props = {
  onCancel: () => void;
  onInsert: (runs: HersheyRun[], capHeightMM: number) => void;
};

const PREVIEW_W = 360;
const PREVIEW_H = 120;

export default function HersheyTextDialog({ onCancel, onInsert }: Props) {
  const [text, setText] = useState('');
  const [capHeightMM, setCapHeightMM] = useState(100);

  // Recompute strokes on every keystroke; the conversion is cheap (a few
  // hundred points at most for any reasonable single-line input).
  const previewRuns = useMemo<HersheyRun[]>(() => {
    if (!text) return [];
    return hersheyTextToRuns(text, capHeightMM, 0, 0);
  }, [text, capHeightMM]);

  const previewBBox = useMemo(() => hersheyRunsBBox(previewRuns), [previewRuns]);

  // Fit the preview into the SVG with margin, preserving aspect.
  const previewViewBox = useMemo(() => {
    if (!previewBBox) return `0 0 ${PREVIEW_W} ${PREVIEW_H}`;
    const pad = capHeightMM * 0.2;
    const w = previewBBox.maxX - previewBBox.minX + 2 * pad;
    const h = previewBBox.maxY - previewBBox.minY + 2 * pad;
    return `${previewBBox.minX - pad} ${previewBBox.minY - pad} ${w} ${h}`;
  }, [previewBBox, capHeightMM]);

  const canInsert = text.trim().length > 0 && capHeightMM > 0 && previewRuns.length > 0;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canInsert) return;
    onInsert(previewRuns, capHeightMM);
  }

  // Esc closes via the form's onKeyDown so users don't have to mouse to Cancel.
  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal hershey-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Add text to design"
      >
        <h2>Add text</h2>
        <p className="meta hershey-modal-blurb">
          Hershey single-stroke font. Each letter renders as one or more disconnected
          tube paths — exactly how a channel-letter shop would build it.
        </p>
        <form onSubmit={submit} onKeyDown={onKey}>
          <label>
            Text
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="OPEN"
              autoFocus
              maxLength={64}
            />
          </label>
          <label>
            Cap height (mm)
            <input
              type="number"
              min={1}
              step={1}
              value={capHeightMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setCapHeightMM(v);
              }}
            />
          </label>
          <div className="hershey-preview" aria-label="Preview of Hershey strokes">
            <svg
              width={PREVIEW_W}
              height={PREVIEW_H}
              viewBox={previewViewBox}
              preserveAspectRatio="xMidYMid meet"
            >
              {previewRuns.map((run, i) => (
                <polyline
                  key={i}
                  points={run.points.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={Math.max(capHeightMM * 0.04, 1)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
            </svg>
            <p className="meta hershey-preview-meta">
              {previewRuns.length} stroke{previewRuns.length === 1 ? '' : 's'}
              {previewBBox &&
                ` · ${(previewBBox.maxX - previewBBox.minX).toFixed(0)}mm wide`}
            </p>
          </div>
          <div className="actions">
            <button type="button" className="btn-secondary" onClick={onCancel}>
              Cancel
            </button>
            <button
              type="submit"
              className={`btn-primary ${canInsert ? '' : 'disabled'}`}
              disabled={!canInsert}
            >
              Insert
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
