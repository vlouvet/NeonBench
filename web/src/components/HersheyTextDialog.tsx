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
//
// Tier 3 #37 polish (this PR):
//  - Preset pair-kerning seeded from the active font on every edit (the
//    user's manual drags are preserved via a parallel `userTouched`
//    array — see `seedFromPresets` for the merge rule).
//  - "Auto-kern this line" button applies the optical-kerning helper to
//    every untouched slot on the current line.
//  - Font picker grew thumbnails (one tiny SVG per face rendered with the
//    same hersheyTextToRuns helper, so no separate code path).
//  - Vertical drag on a kerning handle shifts the baseline of the glyph
//    AFTER that slot (ALL subsequent glyphs on the same line stay where
//    they are; only the immediately-following glyph moves). That's the
//    minimum-surprise interpretation: dragging slot i affects glyph i+1.
//    Users wanting a whole-word shift drag the first slot of the word
//    once and (if needed) drag the next slot back. The shift is in mm,
//    capped at ±1.5×capHeight to stop runaway drags.

import { useMemo, useRef, useState } from 'react';
import { hersheyRunsBBox, hersheyTextToRuns, type HersheyRun } from '../lib/hershey/text';
import { FONTS, type FontKey, type FontEntry } from '../lib/hershey/fonts';
import { computeOpticalKernMM } from '../lib/hershey/opticalKern';

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
  // Parallel to perPairKerningMM: true if the user explicitly set this
  // slot (via drag or auto-kern button). Preset re-seeding skips touched
  // slots. Auto-kern marks a slot touched after applying.
  const [userTouchedKern, setUserTouchedKern] = useState<boolean[]>([]);
  // Per-glyph baseline shift (mm). Index space matches pairIdx +1 — the
  // i-th entry is the shift for the (i+1)-th visible glyph (slot i drags
  // the glyph after it). The 0-th glyph has no slot before it so its
  // baseline shift is held at index 0 and edited via... well, it can't
  // be — that's the rule. (See module-level comment.)
  const [baselineShiftsMM, setBaselineShiftsMM] = useState<number[]>([]);

  const svgRef = useRef<SVGSVGElement | null>(null);
  // Active drag state. We track BOTH X and Y deltas: X edits per-pair
  // kerning, Y edits the baseline-shift of glyph[slot+1].
  const dragRef = useRef<{
    slot: number;
    startX: number;
    startY: number;
    startKern: number;
    startShift: number;
    mmPerPx: number;
    pointerId: number;
  } | null>(null);
  const [activeSlot, setActiveSlot] = useState<number | null>(null);
  const [hoverLabel, setHoverLabel] = useState<
    { x: number; y: number; kerningMM: number; shiftMM: number } | null
  >(null);

  // Compute strokes from the current text + options. Cheap (a few
  // hundred points at most for any reasonable input).
  // Note: applyPresetKerning is FALSE here because the dialog already
  // seeds presets into perPairKerningMM at type-time (so the user can
  // see/drag them). Turning it on here would double-apply.
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
      baselineShiftsMM,
    });
  }, [text, capHeightMM, fontKey, lineHeight, perPairKerningMM, baselineShiftsMM]);

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
    // Vertical drag affects glyph[slotIdx + 1]'s baseline shift.
    const targetGlyph = slotIdx + 1;
    dragRef.current = {
      slot: slotIdx,
      startX: e.clientX,
      startY: e.clientY,
      startKern: perPairKerningMM[slotIdx] ?? 0,
      startShift: baselineShiftsMM[targetGlyph] ?? 0,
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
    const dyScreen = e.clientY - d.startY;
    const deltaXMM = dxScreen * d.mmPerPx;
    const deltaYMM = dyScreen * d.mmPerPx;
    const nextKern = d.startKern + deltaXMM;
    // Cap baseline shift at ±1.5×capHeight — far enough to put a word a
    // line below or above its baseline, close enough to avoid runaway.
    const shiftCap = capHeightMM * 1.5;
    const nextShift = Math.max(-shiftCap, Math.min(shiftCap, d.startShift + deltaYMM));
    setPerPairKerningMM((prev) => {
      const out = prev.slice();
      out[d.slot] = nextKern;
      return out;
    });
    setUserTouchedKern((prev) => {
      // Only mark touched if the user actually moved horizontally; pure
      // vertical drags shouldn't flip the kern-touched flag (the kern
      // value barely moves and we don't want to lock out preset reseeds).
      if (Math.abs(deltaXMM) < 0.5) return prev;
      const out = prev.slice();
      out[d.slot] = true;
      return out;
    });
    setBaselineShiftsMM((prev) => {
      const out = prev.slice();
      out[d.slot + 1] = nextShift;
      return out;
    });
    // Position the floating label near the cursor in viewBox coords.
    if (svgRef.current) {
      const rect = svgRef.current.getBoundingClientRect();
      const vb = svgRef.current.viewBox.baseVal;
      const mx = vb.x + ((e.clientX - rect.left) / rect.width) * vb.width;
      const my = vb.y + ((e.clientY - rect.top) / rect.height) * vb.height;
      setHoverLabel({ x: mx, y: my, kerningMM: nextKern, shiftMM: nextShift });
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
    setUserTouchedKern((prev) => prev.map(() => false));
    setBaselineShiftsMM((prev) => prev.map(() => 0));
    // Re-seed presets after a full reset so the user immediately sees
    // the font's defaults again.
    applySeed(text, fontKey, capHeightMM);
  }

  // Seed (or re-seed) preset kerning into perPairKerningMM. Slots the
  // user has previously dragged (userTouchedKern[i] === true) are NOT
  // overwritten — that's the user-override-survives invariant. Slots
  // that no longer correspond to a visible glyph (e.g. text shrank) are
  // dropped.
  function applySeed(nextText: string, nextFontKey: FontKey, nextCap: number) {
    const visible = collectVisibleGlyphs(nextText, nextFontKey);
    const slotCount = Math.max(0, visible.length - 1);
    const font = FONTS[nextFontKey];
    const scale = nextCap / font.capHeightUnits;
    // Snapshot of touched flags from the previous render. Closure read
    // is safe because applySeed runs from event handlers that don't also
    // mutate userTouchedKern in the same tick.
    const prevTouched = userTouchedKern;
    const prevKern = perPairKerningMM;
    const nextKern = new Array<number>(slotCount).fill(0);
    const nextTouched = new Array<boolean>(slotCount).fill(false);
    for (let i = 0; i < slotCount; i++) {
      if (prevTouched[i] === true) {
        nextTouched[i] = true;
        nextKern[i] = prevKern[i] ?? 0;
        continue;
      }
      const pair = visible[i] + visible[i + 1];
      const presetJHF = font.presetKerning[pair];
      nextKern[i] = typeof presetJHF === 'number' ? presetJHF * scale : 0;
    }
    setPerPairKerningMM(nextKern);
    setUserTouchedKern(nextTouched);
    // Trim/extend baseline shifts to match the new glyph count (preserve
    // values that still have a corresponding glyph).
    const prevShifts = baselineShiftsMM;
    const nextShifts = new Array<number>(visible.length).fill(0);
    for (let i = 0; i < Math.min(prevShifts.length, visible.length); i++) {
      nextShifts[i] = prevShifts[i];
    }
    setBaselineShiftsMM(nextShifts);
  }

  // Apply optical kerning to every untouched slot on every line. The
  // helper returns mm, so this is one pass with no scaling. We do NOT
  // overwrite user-touched slots — that's the entire point of the
  // override-survives semantics.
  function autoKernAllLines() {
    const visible = collectVisibleGlyphs(text, fontKey);
    if (visible.length < 2) return;
    const font = FONTS[fontKey];
    const slotCount = visible.length - 1;
    setPerPairKerningMM((prev) => {
      const out = prev.slice(0, slotCount);
      while (out.length < slotCount) out.push(0);
      for (let i = 0; i < slotCount; i++) {
        if (userTouchedKern[i] === true) continue;
        out[i] = computeOpticalKernMM(font, visible[i], visible[i + 1], capHeightMM);
      }
      return out;
    });
    // Auto-kern values are NOT marked as user-touched — they're a
    // computed default that should yield to manual drags afterwards.
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
                applySeed(next, fontKey, capHeightMM);
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
                if (Number.isFinite(v) && v > 0) {
                  setCapHeightMM(v);
                  // Re-seed preset values: they scale with cap height.
                  applySeed(text, fontKey, v);
                }
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
              onChange={(e) => {
                const next = e.target.value as FontKey;
                setFontKey(next);
                // Different face → different preset table; re-seed.
                applySeed(text, next, capHeightMM);
              }}
            >
              {fontEntries.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.displayName}
                </option>
              ))}
            </select>
          </label>
          <FontPickerThumbnails
            fonts={fontEntries}
            activeKey={fontKey}
            onPick={(k) => {
              setFontKey(k);
              applySeed(text, k, capHeightMM);
            }}
          />
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
                      style={{ cursor: 'move' }}
                      onPointerDown={(e) => handlePointerDown(e, slotIdx)}
                      aria-label={`Kerning slot ${slotIdx + 1} (drag horizontally to kern, vertically to baseline-shift the next glyph)`}
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
                  {formatHoverLabel(hoverLabel.kerningMM, hoverLabel.shiftMM)}
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
                    onClick={autoKernAllLines}
                    style={metaLinkStyle}
                  >
                    Auto-kern this line
                  </button>
                  {' '}
                  ·{' '}
                  <button
                    type="button"
                    onClick={resetKerning}
                    style={metaLinkStyle}
                  >
                    reset
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

const metaLinkStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'inherit',
  textDecoration: 'underline',
  cursor: 'pointer',
  padding: 0,
  font: 'inherit',
};

// Mirrors `collectVisibleChars` in text.ts but is local because we don't
// want to expose another module export just for the dialog. Returns the
// printable single-character glyphs in input order, skipping newlines,
// out-of-range codepoints, and unknown glyphs.
function collectVisibleGlyphs(text: string, fontKey: FontKey): string[] {
  const font = FONTS[fontKey];
  const out: string[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') continue;
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    if (code < 32 || code > 127) continue;
    if (!font.data.glyphs[String(code)]) continue;
    out.push(ch);
  }
  return out;
}

function formatHoverLabel(kernMM: number, shiftMM: number): string {
  const k = `${kernMM >= 0 ? '+' : ''}${kernMM.toFixed(0)}mm`;
  if (Math.abs(shiftMM) < 0.5) return k;
  const s = `${shiftMM >= 0 ? '+' : ''}${shiftMM.toFixed(0)}mm`;
  return `kern ${k} · shift ${s}`;
}

// Tiny preview row of clickable thumbnails — one per font. Each thumbnail
// reuses hersheyTextToRuns to render a fixed sample string at a small cap
// height, so there's no separate code path for the preview vs the main
// preview pane. The label below the SVG is the font's displayName.
//
// Why a row of 96×40 thumbnails instead of CSS `font-family` swatches:
// the bundled fonts are JSON stroke data, not browser typefaces. We
// can't tell the browser "render this label in Hershey Roman Simplex".
// The only honest preview is the actual stroke output.
function FontPickerThumbnails({
  fonts,
  activeKey,
  onPick,
}: {
  fonts: FontEntry[];
  activeKey: FontKey;
  onPick: (k: FontKey) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="Font preview"
      style={{
        display: 'flex',
        gap: 8,
        marginTop: 4,
        flexWrap: 'wrap',
      }}
    >
      {fonts.map((f) => {
        const active = f.key === activeKey;
        return (
          <button
            key={f.key}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={f.displayName}
            onClick={() => onPick(f.key)}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              padding: 4,
              border: `1px solid ${active ? HANDLE_FILL_ACTIVE : 'rgba(255,255,255,0.2)'}`,
              borderRadius: 4,
              background: active ? 'rgba(255, 87, 34, 0.08)' : 'transparent',
              cursor: 'pointer',
              minWidth: 100,
            }}
          >
            <FontThumbnailSVG fontKey={f.key} />
            <span style={{ fontSize: 11, marginTop: 2, color: 'inherit' }}>
              {f.displayName.replace(/\s*\(.*\)\s*$/, '')}
            </span>
          </button>
        );
      })}
    </div>
  );
}

function FontThumbnailSVG({ fontKey }: { fontKey: FontKey }) {
  // 'OPEN 2026' is the canonical neon-shop sample. ~24 JHF units tall,
  // about 100mm wide at the chosen cap, fits in 100×30 SVG.
  const sampleText = 'OPEN 2026';
  const sampleCap = 12; // mm; small but readable
  const runs = useMemo(
    () =>
      hersheyTextToRuns({
        text: sampleText,
        font: fontKey,
        capHeightMM: sampleCap,
        originX: 0,
        originY: 0,
      }),
    [fontKey],
  );
  const bbox = useMemo(() => hersheyRunsBBox(runs), [runs]);
  if (!bbox) return <svg width={100} height={30} />;
  const pad = 2;
  const minX = bbox.minX - pad;
  const minY = bbox.minY - pad;
  const w = bbox.maxX - bbox.minX + 2 * pad;
  const h = bbox.maxY - bbox.minY + 2 * pad;
  return (
    <svg
      width={100}
      height={30}
      viewBox={`${minX} ${minY} ${w} ${h}`}
      preserveAspectRatio="xMidYMid meet"
      aria-hidden="true"
    >
      {runs.map((run, i) => (
        <polyline
          key={`thumb-${i}`}
          points={run.points.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke="currentColor"
          strokeWidth={0.6}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  );
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
