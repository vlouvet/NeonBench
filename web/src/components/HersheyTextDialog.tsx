// Hershey text insertion modal. Lives outside EditorCanvas (which is a
// high-coupling file per CLAUDE.md hazard map) and emits HersheyRuns to
// the parent's onInsert callback. The parent wraps each run as a fresh
// DesignRun and appends to the doc — so this dialog never has to know
// about the design-doc schema or save flow.
//
// Tier 3 #19 polish: multi-line input (textarea + line-height), per-letter
// kerning handles drawn over the preview, and a font picker covering
// Roman Simplex (default), Roman Duplex (thicker channel-letter look),
// and Sans Simplex / Futural (geometric sans).

import { useMemo, useRef, useState } from 'react';
import { hersheyRunsBBox, hersheyTextToRuns, type HersheyRun } from '../lib/hershey/text';
import { FONTS, type FontKey } from '../lib/hershey/fonts';

type Props = {
  onCancel: () => void;
  onInsert: (runs: HersheyRun[], capHeightMM: number) => void;
};

const PREVIEW_W = 360;
const PREVIEW_H = 160;
const MAX_TEXT_LEN = 256;

// Inline styles for the kerning-handle layer — kept inline (not in App.css)
// to avoid touching shared stylesheets that other parallel tasks own.
const HANDLE_FILL = '#3a86ff';
const HANDLE_FILL_ACTIVE = '#ff5722';

export default function HersheyTextDialog({ onCancel, onInsert }: Props) {
  const [text, setText] = useState('');
  const [capHeightMM, setCapHeightMM] = useState(100);
  const [lineHeight, setLineHeight] = useState(1.2);
  const [fontKey, setFontKey] = useState<FontKey>('rowmans');
  // perPairKerning is keyed by visible-glyph-pair index (newlines don't
  // consume a slot). Length is glyphCount-1 where glyphCount = text length
  // minus the count of '\n'. Trailing slots default to 0.
  const [perPairKerningMM, setPerPairKerningMM] = useState<number[]>([]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  // Active drag state: { slotIdx, startScreenX, startKernMM, mmPerPx }.
  // Held in a ref instead of state because we don't need re-renders on
  // pointermove — the kerning array setter does that for us.
  const dragRef = useRef<{
    slot: number;
    startX: number;
    startKern: number;
    mmPerPx: number;
    pointerId: number;
  } | null>(null);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [hoverLabel, setHoverLabel] = useState<{ x: number; y: number; mm: number } | null>(null);

  // Compute strokes from the current text + options. Cheap (a few
  // hundred points at most for any reasonable input).
  const previewRuns = useMemo<HersheyRun[]>(() => {
    if (!text) return [];
    return hersheyTextToRuns({
      text,
      font: fontKey,
      capHeightMM,
      originX: 0,
      originY: 0,
      lineHeight,
      perPairKerningMM,
    });
  }, [text, capHeightMM, fontKey, lineHeight, perPairKerningMM]);

  const previewBBox = useMemo(() => hersheyRunsBBox(previewRuns), [previewRuns]);

  // For drawing kerning handles we need the X of each visible-glyph-pair
  // gap, plus the Y of the line that gap belongs to. Build that by
  // re-walking the input with single-glyph slices and reading the bbox
  // of each glyph. We don't need stroke-level detail; we just need the
  // baseline-Y per character and the cursor-X between adjacent glyphs.
  const handles = useMemo(() => {
    return computeHandlePositions(text, fontKey, capHeightMM, lineHeight, perPairKerningMM);
  }, [text, fontKey, capHeightMM, lineHeight, perPairKerningMM]);

  // Fit the preview into the SVG with margin, preserving aspect.
  // Include the handle row above the topmost line so the triangles aren't
  // clipped at the viewBox edge.
  const previewViewBox = useMemo(() => {
    if (!previewBBox) return `0 0 ${PREVIEW_W} ${PREVIEW_H}`;
    const pad = capHeightMM * 0.2;
    const handleRowH = capHeightMM * 0.35;
    const minX = previewBBox.minX - pad;
    const minY = previewBBox.minY - handleRowH - pad;
    const w = previewBBox.maxX - previewBBox.minX + 2 * pad;
    const h = previewBBox.maxY - minY + pad;
    return `${minX} ${minY} ${w} ${h}`;
  }, [previewBBox, capHeightMM]);

  // We never resize perPairKerningMM eagerly — instead we resize on the
  // fly when the user types via setText, and the converter tolerates
  // out-of-range indices anyway (entries beyond the array default to 0).

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

  function handlePointerDown(e: React.PointerEvent<SVGElement>, slotIdx: number) {
    if (!svgRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const rect = svgRef.current.getBoundingClientRect();
    const vb = svgRef.current.viewBox.baseVal;
    // viewBox-mm per screen-px. Spec says "1 px in screen space = 1 mm in
    // design space at the preview's current scale" — i.e. use the actual
    // screen-to-mm scale of the preview, which is vb.width / rect.width.
    const mmPerPx = vb.width / rect.width;
    dragRef.current = {
      slot: slotIdx,
      startX: e.clientX,
      startKern: perPairKerningMM[slotIdx] ?? 0,
      mmPerPx,
      pointerId: e.pointerId,
    };
    setActiveSlot(slotIdx);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
  }

  function handlePointerMove(e: React.PointerEvent<SVGElement>) {
    const d = dragRef.current;
    if (!d || d.pointerId !== e.pointerId) return;
    const dxScreen = e.clientX - d.startX;
    const deltaMM = dxScreen * d.mmPerPx;
    const next = d.startKern + deltaMM;
    setPerPairKerningMM((prev) => {
      const out = prev.slice();
      out[d.slot] = next;
      return out;
    });
    // Position the floating label near the cursor in viewBox coords.
    if (svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const vb = svgRef.current.viewBox.baseVal;
      const mx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.width;
      const my = vb.y + ((e.clientY - rect.top) / rect.height) * vb.height;
      setHoverLabel({ x: mx, y: my, mm: next });
    }
  }

  function handlePointerUp(e: React.PointerEvent<SVGElement>) {
    if (!dragRef.current || dragRef.current.pointerId !== e.pointerId) return;
    dragRef.current = null;
    setActiveSlot(null);
    setHoverLabel(null);
  }

  function resetKerning() {
    setPerPairKerningMM((prev) => prev.map(() => 0));
  }

  const fontEntries = Object.values(FONTS);

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
            <textarea
              value={text}
              onChange={(e) => {
                const next = e.target.value.slice(0, MAX_TEXT_LEN);
                setText(next);
                // Trim kerning array if the new glyph count is smaller —
                // avoids stale slots quietly persisting past the visible
                // text. Entries beyond the new array length are gone.
                const newSlotCount = Math.max(0, countGlyphs(next) - 1);
                setPerPairKerningMM((prev) =>
                  prev.length > newSlotCount ? prev.slice(0, newSlotCount) : prev,
                );
              }}
              placeholder={'OPEN\n2026'}
              autoFocus
              rows={3}
              maxLength={MAX_TEXT_LEN}
              style={{ resize: 'vertical', width: '100%', fontFamily: 'inherit' }}
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
          <label>
            Line height (× cap)
            <input
              type="number"
              min={0.8}
              max={3.0}
              step={0.1}
              value={lineHeight}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v >= 0.8 && v <= 3.0) setLineHeight(v);
              }}
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
          <div className="hershey-preview" aria-label="Preview of Hershey strokes">
            <svg
              ref={svgRef}
              width={PREVIEW_W}
              height={PREVIEW_H}
              viewBox={previewViewBox}
              preserveAspectRatio="xMidYMid meet"
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
              style={{ touchAction: 'none' }}
            >
              {previewRuns.map((run, i) => (
                <polyline
                  key={`stroke-${i}`}
                  points={run.points.map(([x, y]) => `${x},${y}`).join(' ')}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={Math.max(capHeightMM * 0.04, 1)}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              ))}
              {handles.map((h, slotIdx) => {
                const tri = capHeightMM * 0.18;
                const yTop = h.lineMinY - tri * 1.4;
                const isActive = activeSlot === slotIdx;
                return (
                  <g key={`kh-${slotIdx}`}>
                    <polygon
                      points={`${h.x - tri},${yTop} ${h.x + tri},${yTop} ${h.x},${yTop + tri}`}
                      fill={isActive ? HANDLE_FILL_ACTIVE : HANDLE_FILL}
                      style={{ cursor: 'ew-resize' }}
                      onPointerDown={(e) => handlePointerDown(e, slotIdx)}
                      aria-label={`Kerning slot ${slotIdx + 1}`}
                    />
                  </g>
                );
              })}
              {hoverLabel && (
                <text
                  x={hoverLabel.x + capHeightMM * 0.05}
                  y={hoverLabel.y - capHeightMM * 0.05}
                  fill={HANDLE_FILL_ACTIVE}
                  fontSize={capHeightMM * 0.18}
                  style={{ pointerEvents: 'none', fontFamily: 'sans-serif' }}
                >
                  {`${hoverLabel.mm >= 0 ? '+' : ''}${hoverLabel.mm.toFixed(0)}mm`}
                </text>
              )}
            </svg>
            <p className="meta hershey-preview-meta">
              {previewRuns.length} stroke{previewRuns.length === 1 ? '' : 's'}
              {previewBBox &&
                ` · ${(previewBBox.maxX - previewBBox.minX).toFixed(0)}mm wide`}
              {handles.length > 0 && (
                <>
                  {' '}
                  ·{' '}
                  <button
                    type="button"
                    onClick={resetKerning}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: 'inherit',
                      textDecoration: 'underline',
                      cursor: 'pointer',
                      padding: 0,
                      font: 'inherit',
                    }}
                  >
                    reset kerning
                  </button>
                </>
              )}
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

// -- helpers ---------------------------------------------------------------

function countGlyphs(text: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] !== '\n') n++;
  return n;
}

// Compute per-slot handle positions in design-mm coordinates. Slot i sits
// at the gap between the i-th and (i+1)-th visible glyphs in input order
// (newlines NOT counted). For each slot we return the X between the two
// glyphs' bounding boxes plus the Y of the topmost cap on that line so
// the handle row can sit above the strokes.
type Handle = { x: number; lineMinY: number };

function computeHandlePositions(
  text: string,
  fontKey: FontKey,
  capHeightMM: number,
  lineHeight: number,
  perPairKerningMM: number[],
): Handle[] {
  if (!text) return [];
  const font = FONTS[fontKey];
  const scale = capHeightMM / font.capHeightUnits;
  const handles: Handle[] = [];
  let cursorX = 0;
  let baselineY = 0;
  let pairIdx = 0;
  // Track per-line cap top — at this baseline, JHF y=-12 maps to
  // baselineY + (-12 * scale) = baselineY - capHeightMM. We use that for
  // the handle row.
  let lineCapTop = baselineY - capHeightMM;
  // We also need to know the right-edge X of the previous glyph and the
  // left-edge X of the next glyph to position the handle at their midpoint.
  let prevGlyphRightX: number | null = null;
  let prevGlyphLineMinY: number | null = null;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      baselineY += capHeightMM * lineHeight;
      cursorX = 0;
      lineCapTop = baselineY - capHeightMM;
      // Newline ends the previous "pending" pair without emitting a handle
      // — slot i conceptually spans the line break and has no visible
      // home in the preview. Keep pairIdx as-is so it lines up with the
      // next glyph; we just won't draw a handle here.
      prevGlyphRightX = null;
      prevGlyphLineMinY = null;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === undefined || code < 32 || code > 127) continue;
    const glyph = font.data.glyphs[String(code)];
    if (!glyph) continue;
    const glyphLeftX = cursorX;
    const glyphRightX = cursorX + (glyph.right - glyph.left) * scale;
    if (prevGlyphRightX !== null && prevGlyphLineMinY !== null) {
      // The handle sits at the midpoint between prevGlyphRightX and
      // glyphLeftX, on the higher of the two lines (smaller Y) so the
      // triangle clears both lines if the user has wild line-heights.
      const mid = (prevGlyphRightX + glyphLeftX) / 2;
      const lineMinY = Math.min(prevGlyphLineMinY, lineCapTop);
      handles.push({ x: mid, lineMinY });
    }
    // Advance cursor by glyph width + per-pair kerning at this slot.
    cursorX += (glyph.right - glyph.left) * scale;
    const k = perPairKerningMM[pairIdx];
    if (typeof k === 'number') cursorX += k;
    pairIdx++;
    prevGlyphRightX = glyphRightX;
    prevGlyphLineMinY = lineCapTop;
  }
  return handles;
}
