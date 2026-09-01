// Tier 2 #101 — the caret + live preview layer for inline canvas text.
//
// Mounted INSIDE EditorCanvas's world-transform `<g>`, so every
// coordinate here is millimetres in design space and pan/zoom are
// handled by the parent transform — the caret cannot drift away from
// the glyphs when the operator scrolls. The only thing that has to be
// un-scaled is stroke width and type size, hence the `scale` prop
// (every `/ scale` below is "keep this N screen pixels wide").
//
// This component is deliberately dumb: it takes a session and draws it.
// All editing behaviour lives in `lib/inlineTextState.ts`, which has no
// DOM dependency and is unit-tested; `pointerEvents="none"` keeps the
// whole layer from intercepting the clicks the canvas below it needs
// (validation markers over node handles, CLAUDE.md bug class 3).

import {
  caretMetrics,
  kernSlotAtCaret,
  sessionRuns,
  type InlineTextSession,
} from '../lib/inlineTextState';

// In-progress ink is drawn in the same amber the editor uses for
// "staged, not committed" affordances, so an operator can tell at a
// glance that this text is not yet part of the design.
const PREVIEW_STROKE = '#ff8a00';
const CARET_STROKE = '#ff5722';

export default function InlineTextEditor({
  session,
  scale,
}: {
  session: InlineTextSession;
  /** Current canvas zoom (world mm → screen px). */
  scale: number;
}) {
  const runs = sessionRuns(session);
  const caret = caretMetrics(session);
  const slot = kernSlotAtCaret(session);
  const kernMM = slot === null ? null : (session.perPairKerningMM[slot] ?? 0);
  // The caret spans the writing height of the line: from the cap line
  // down past the baseline by a descender's worth, so it reads as a
  // text cursor rather than as a stray tick.
  const descender = (caret.baselineY - caret.capTopY) * 0.25;
  const top = caret.capTopY;
  const bottom = caret.baselineY + descender;
  const px = (n: number) => n / scale;

  return (
    <g className="inline-text-editor" pointerEvents="none">
      {runs.map((run, i) => (
        <polyline
          key={`itext-${i}`}
          points={run.points.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke={PREVIEW_STROKE}
          strokeWidth={px(2)}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      {/* Baseline stub: shows where the line sits even before the first
          character is typed, which is the only feedback an empty caret
          can give that the click landed. */}
      <line
        x1={session.originX}
        y1={caret.baselineY}
        x2={caret.x + px(14)}
        y2={caret.baselineY}
        stroke={PREVIEW_STROKE}
        strokeWidth={px(1)}
        strokeDasharray={`${px(4)} ${px(4)}`}
        opacity={0.65}
      />
      <line
        x1={caret.x}
        y1={top}
        x2={caret.x}
        y2={bottom}
        stroke={CARET_STROKE}
        strokeWidth={px(2)}
        strokeLinecap="butt"
      >
        {/* SVG-native blink: no App.css entry, so nothing to collide
            with another lane's stylesheet edits. */}
        <animate
          attributeName="opacity"
          values="1;1;0;0"
          dur="1.06s"
          repeatCount="indefinite"
        />
      </line>
      {slot !== null && kernMM !== null && (
        // Kerning readout for the pair the caret sits between. Only
        // shown when there IS a pair, which is the same condition under
        // which Alt+Arrow does anything — the UI and the key agree.
        <g>
          <path
            d={`M${caret.x - px(5)} ${top - px(6)}L${caret.x} ${top - px(1)}L${
              caret.x + px(5)
            } ${top - px(6)}Z`}
            fill={CARET_STROKE}
            opacity={0.9}
          />
          <text
            x={caret.x}
            y={top - px(9)}
            textAnchor="middle"
            fontSize={px(11)}
            fill={CARET_STROKE}
            style={{ userSelect: 'none' }}
          >
            {kernMM >= 0 ? '+' : '−'}
            {Math.abs(kernMM).toFixed(1)} mm
          </text>
        </g>
      )}
    </g>
  );
}
