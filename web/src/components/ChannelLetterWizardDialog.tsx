// Tier 2 #71 — Channel letter wizard dialog.
//
// Closes NeonWizard's primary "type → click → done" channel-letter
// workflow (NW #1 + #123): the user enters text, font, cap height,
// clearance, and (optionally) a raceway-line Y, and the editor inserts
// a fully-populated set of runs — face outlines + parallel tubes +
// face flags + raceway-grouped split — in one undo step.
//
// Architectural twin of HersheyTextDialog (same skeleton, modal-backdrop
// pattern, autoFocus, Esc-to-cancel). We deliberately mirror the shape
// so users moving between the two dialogs don't have to relearn the
// interaction. New here: clearance + raceway controls + tube color.
//
// Why this lives in components/ and not pages/EditorPage: identical
// reason to HersheyTextDialog — EditorPage is high-coupling, and
// modal-level state (text, font, clearance, etc.) is self-contained.
// We emit a single payload to the parent's `onInsert` callback and
// the parent decides where to land the geometry in doc coords.

import { useMemo, useState } from 'react';
import {
  channelLetterFromText,
  type ChannelLetterOptions,
} from '../lib/channelLetter';
import { FONTS, type FontKey } from '../lib/hershey/fonts';
import type { DesignRun } from '../api';

type Props = {
  onCancel: () => void;
  /** Receives the wizard's output runs and the cap-height (mm) for
   *  recentering. The caller is responsible for translating into doc
   *  coords (typically toward the view-box center) and for calling
   *  editDoc / insertChannelLetterRuns. */
  onInsert: (runs: DesignRun[], capHeightMM: number) => void;
};

const PREVIEW_W = 360;
const PREVIEW_H = 220;
const MAX_TEXT_LEN = 64;
const DEFAULT_CAP_MM = 100;
const DEFAULT_TUBE_DIAMETER_MM = 10;
// "Default clearance = 1.5 × tubeDiameter" — see spec deliverable 1.
const DEFAULT_CLEARANCE_MM = DEFAULT_TUBE_DIAMETER_MM * 1.5;
// Warm-white (~3000K filament-tone) is the trade-typical "white"
// channel-letter glass.
const DEFAULT_TUBE_COLOR = '#fff8d2';

export default function ChannelLetterWizardDialog({ onCancel, onInsert }: Props) {
  const [text, setText] = useState('');
  const [capHeightMM, setCapHeightMM] = useState(DEFAULT_CAP_MM);
  const [fontKey, setFontKey] = useState<FontKey>('rowmand'); // duplex = thicker channel-letter look
  const [clearanceMM, setClearanceMM] = useState(DEFAULT_CLEARANCE_MM);
  const [tubeColor, setTubeColor] = useState<string>(DEFAULT_TUBE_COLOR);
  const [tubeDiameterMM, setTubeDiameterMM] = useState(DEFAULT_TUBE_DIAMETER_MM);
  const [racewayEnabled, setRacewayEnabled] = useState(false);
  // Default raceway-Y at "10% above baseline" — typical Strattman /
  // Miller convention puts the back-channel through the lower third of
  // the letter. Negative Y because the JHF baseline is y=0 and caps
  // grow upward (negative Y).
  const [racewayYMM, setRacewayYMM] = useState(-10);
  const [racewayName, setRacewayName] = useState('main-raceway');

  const previewOpts = useMemo<ChannelLetterOptions>(
    () => ({
      text,
      font: fontKey,
      capHeightMM,
      clearanceMM,
      tubeColor,
      tubeDiameterMM,
      racewayY: racewayEnabled ? racewayYMM : undefined,
      racewayId: racewayEnabled ? racewayName : undefined,
      originX: 0,
      originY: 0,
    }),
    [text, fontKey, capHeightMM, clearanceMM, tubeColor, tubeDiameterMM, racewayEnabled, racewayYMM, racewayName],
  );

  const runs = useMemo<DesignRun[]>(() => channelLetterFromText(previewOpts), [previewOpts]);

  const bbox = useMemo(() => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let any = false;
    for (const r of runs) {
      for (const [x, y] of r.polyline.points) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
        any = true;
      }
    }
    if (racewayEnabled && any) {
      // Include the raceway line in the preview bbox so it shows up even
      // when it sits below the lowest stroke.
      minY = Math.min(minY, racewayYMM);
      maxY = Math.max(maxY, racewayYMM);
    }
    if (!any) return null;
    return { minX, minY, maxX, maxY };
  }, [runs, racewayEnabled, racewayYMM]);

  const previewViewBox = useMemo(() => {
    if (!bbox) return `0 0 ${PREVIEW_W} ${PREVIEW_H}`;
    const pad = capHeightMM * 0.25;
    const w = bbox.maxX - bbox.minX + 2 * pad;
    const h = bbox.maxY - bbox.minY + 2 * pad;
    return `${bbox.minX - pad} ${bbox.minY - pad} ${w} ${h}`;
  }, [bbox, capHeightMM]);

  const canInsert =
    text.trim().length > 0 &&
    capHeightMM > 0 &&
    clearanceMM >= 0 &&
    tubeDiameterMM > 0 &&
    runs.length > 0;

  // Count face vs tube runs for the meta line.
  const faceCount = runs.filter((r) => r.is_channel_letter_face).length;
  const tubeCount = runs.length - faceCount;

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!canInsert) return;
    onInsert(runs, capHeightMM);
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  }

  const fontEntries = Object.values(FONTS);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal hershey-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Channel letter wizard"
      >
        <h2>Channel letter wizard</h2>
        <p className="meta hershey-modal-blurb">
          Type → choose font → set clearance → insert. Each letter ships as a
          closed face outline plus two parallel tubes (inner + outer return),
          with the channel-letter face flag set so the print PDF emits the
          return strip. Add a raceway baseline to auto-split tubes for a
          combined back-channel.
        </p>
        <form onSubmit={submit} onKeyDown={onKey}>
          <label>
            Text
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value.slice(0, MAX_TEXT_LEN))}
              placeholder="OPEN"
              autoFocus
              maxLength={MAX_TEXT_LEN}
              style={{ width: '100%' }}
            />
          </label>
          <label>
            Font
            <select
              value={fontKey}
              onChange={(e) => setFontKey(e.target.value as FontKey)}
            >
              {fontEntries.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.displayName}
                </option>
              ))}
            </select>
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
          <label>
            Tube clearance (mm) — face return inset
            <input
              type="number"
              min={0}
              step={1}
              value={clearanceMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0) setClearanceMM(v);
              }}
            />
          </label>
          <label>
            Tube outside diameter (mm)
            <input
              type="number"
              min={1}
              step={1}
              value={tubeDiameterMM}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v > 0) setTubeDiameterMM(v);
              }}
            />
          </label>
          <label>
            Tube color
            <input
              type="color"
              value={tubeColor}
              onChange={(e) => setTubeColor(e.target.value)}
              style={{ width: 60, marginLeft: 8 }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="checkbox"
              checked={racewayEnabled}
              onChange={(e) => setRacewayEnabled(e.target.checked)}
              style={{ marginRight: 4 }}
            />
            Add raceway baseline
          </label>
          {racewayEnabled && (
            <>
              <label>
                Raceway Y (mm from baseline)
                <input
                  type="number"
                  step={1}
                  value={racewayYMM}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    if (Number.isFinite(v)) setRacewayYMM(v);
                  }}
                />
              </label>
              <label>
                Raceway group name
                <input
                  type="text"
                  value={racewayName}
                  onChange={(e) => setRacewayName(e.target.value.slice(0, 32))}
                  maxLength={32}
                  style={{ width: '100%' }}
                />
              </label>
            </>
          )}
          <div className="hershey-preview" aria-label="Channel letter preview">
            <svg
              width={PREVIEW_W}
              height={PREVIEW_H}
              viewBox={previewViewBox}
              preserveAspectRatio="xMidYMid meet"
              style={{ touchAction: 'none', background: '#1c1c1c' }}
            >
              {runs.map((r, i) => {
                const isFace = Boolean(r.is_channel_letter_face);
                const pts = r.polyline.points
                  .map(([x, y]) => `${x},${y}`)
                  .join(' ');
                const closingTail =
                  r.polyline.closed && r.polyline.points.length > 0
                    ? ` ${r.polyline.points[0][0]},${r.polyline.points[0][1]}`
                    : '';
                return (
                  <polyline
                    key={`ch-${i}`}
                    points={pts + closingTail}
                    fill="none"
                    stroke={isFace ? '#888' : tubeColor}
                    strokeWidth={isFace ? Math.max(capHeightMM * 0.015, 0.6) : Math.max(tubeDiameterMM * 0.5, 1)}
                    strokeDasharray={isFace ? `${capHeightMM * 0.03} ${capHeightMM * 0.02}` : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                );
              })}
              {racewayEnabled && bbox && (
                <line
                  x1={bbox.minX}
                  x2={bbox.maxX}
                  y1={racewayYMM}
                  y2={racewayYMM}
                  stroke="#ff5722"
                  strokeWidth={Math.max(capHeightMM * 0.01, 0.5)}
                  strokeDasharray={`${capHeightMM * 0.05} ${capHeightMM * 0.03}`}
                />
              )}
            </svg>
            <p className="meta hershey-preview-meta">
              {faceCount} face{faceCount === 1 ? '' : 's'} ·{' '}
              {tubeCount} tube run{tubeCount === 1 ? '' : 's'}
              {bbox && ` · ${(bbox.maxX - bbox.minX).toFixed(0)}mm wide`}
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
