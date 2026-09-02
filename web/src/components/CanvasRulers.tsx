// Tier 2 #91 — mm rulers along the canvas top and left edge.
//
// Purely presentational: it is handed the same `scale` / `tx` / `ty` the
// canvas `<g transform>` uses and maps mm → px with the identical formula
// (`px = offset + mm * scale`). That shared formula is the whole contract —
// a tick labelled 100 mm sits on the geometry at 100 mm at any zoom and pan
// precisely because neither side has its own copy of the math.
//
// The gutters OVERLAY the canvas rather than shrinking its viewport, so the
// transform needs no ruler-sized correction anywhere. Drag-create lives in
// EditorCanvas; this component only reports which gutter got pressed.

import {
  RULER_PX,
  formatTickLabel,
  guidePositionMM,
  isVerticalGuide,
  rulerTicks,
} from '../lib/guides';
import { UNIT_SUFFIX, type DisplayUnits } from '../lib/units';
import type { Guideline } from '../api';

// Tick lengths in px, measured from the ruler's inner edge (the edge
// touching the canvas) so ticks grow toward the design like a real rule.
const MAJOR_TICK_PX = 9;
const MINOR_TICK_PX = 4;

export default function CanvasRulers({
  width,
  height,
  scale,
  tx,
  ty,
  cursor,
  guidelines,
  units = 'mm',
  onRulerPointerDown,
}: {
  // Canvas container size in CSS px.
  width: number;
  height: number;
  // EditorCanvas's `transform.k` / `.tx` / `.ty`.
  scale: number;
  tx: number;
  ty: number;
  // Latest cursor position in CSS px relative to the container, or null
  // when the pointer is off the canvas. Drives the position indicator.
  cursor: { x: number; y: number } | null;
  // Guides get a tick mark on their ruler too, so a guide scrolled off
  // the visible area still announces where it is.
  guidelines: ReadonlyArray<Guideline>;
  // Tier 1 #130 — the project's display unit. Changes the tick ladder and the
  // label text only; every number crossing this boundary is still mm.
  units?: DisplayUnits;
  onRulerPointerDown: (axis: 'h' | 'v', e: React.PointerEvent<SVGSVGElement>) => void;
}) {
  // Horizontal ruler: world x maps through tx. Start the visible span at
  // RULER_PX because the corner box covers everything to its left.
  const h = rulerTicks({ scale, offsetPx: tx, startPx: RULER_PX, endPx: width, units });
  // Vertical ruler: world y maps through ty.
  const v = rulerTicks({ scale, offsetPx: ty, startPx: RULER_PX, endPx: height, units });

  const guideMarks = guidelines.map((g) => ({
    id: g.id,
    vertical: isVerticalGuide(g),
    px: (isVerticalGuide(g) ? tx : ty) + guidePositionMM(g) * scale,
    construction: g.kind === 'construction',
  }));

  return (
    <>
      <svg
        className="canvas-ruler canvas-ruler-h"
        width={width}
        height={RULER_PX}
        aria-hidden
        onPointerDown={(e) => onRulerPointerDown('h', e)}
      >
        <rect x={0} y={0} width={width} height={RULER_PX} className="ruler-bg" />
        {h.ticks.map((t) => (
          <line
            key={t.mm}
            x1={t.px}
            x2={t.px}
            y1={RULER_PX - (t.major ? MAJOR_TICK_PX : MINOR_TICK_PX)}
            y2={RULER_PX}
            className={t.major ? 'ruler-tick major' : 'ruler-tick'}
          />
        ))}
        {h.ticks
          .filter((t) => t.major)
          .map((t) => (
            <text key={`l${t.mm}`} x={t.px + 2} y={9} className="ruler-label">
              {formatTickLabel(t.mm, h.majorMM, units)}
            </text>
          ))}
        {guideMarks
          .filter((g) => g.vertical)
          .map((g) => (
            <line
              key={g.id}
              x1={g.px}
              x2={g.px}
              y1={0}
              y2={RULER_PX}
              className={g.construction ? 'ruler-guide-mark construction' : 'ruler-guide-mark'}
            />
          ))}
        {cursor && (
          <line
            x1={cursor.x}
            x2={cursor.x}
            y1={0}
            y2={RULER_PX}
            className="ruler-cursor"
          />
        )}
        <line x1={0} x2={width} y1={RULER_PX - 0.5} y2={RULER_PX - 0.5} className="ruler-edge" />
      </svg>

      <svg
        className="canvas-ruler canvas-ruler-v"
        width={RULER_PX}
        height={height}
        aria-hidden
        onPointerDown={(e) => onRulerPointerDown('v', e)}
      >
        <rect x={0} y={0} width={RULER_PX} height={height} className="ruler-bg" />
        {v.ticks.map((t) => (
          <line
            key={t.mm}
            y1={t.px}
            y2={t.px}
            x1={RULER_PX - (t.major ? MAJOR_TICK_PX : MINOR_TICK_PX)}
            x2={RULER_PX}
            className={t.major ? 'ruler-tick major' : 'ruler-tick'}
          />
        ))}
        {v.ticks
          .filter((t) => t.major)
          .map((t) => (
            // Rotated so the label reads bottom-to-top, the convention every
            // drafting tool uses for a left-hand rule.
            <text
              key={`l${t.mm}`}
              x={0}
              y={0}
              transform={`translate(9,${t.px - 2}) rotate(-90)`}
              className="ruler-label"
            >
              {formatTickLabel(t.mm, v.majorMM, units)}
            </text>
          ))}
        {guideMarks
          .filter((g) => !g.vertical)
          .map((g) => (
            <line
              key={g.id}
              y1={g.px}
              y2={g.px}
              x1={0}
              x2={RULER_PX}
              className={g.construction ? 'ruler-guide-mark construction' : 'ruler-guide-mark'}
            />
          ))}
        {cursor && (
          <line y1={cursor.y} y2={cursor.y} x1={0} x2={RULER_PX} className="ruler-cursor" />
        )}
        <line y1={0} y2={height} x1={RULER_PX - 0.5} x2={RULER_PX - 0.5} className="ruler-edge" />
      </svg>

      {/* Corner box — covers the overlap so neither ruler's ticks bleed
          into the other's gutter. */}
      {/* The corner box names the unit both rules are reading in — the only
          place a bare "mm" / "in" belongs, since every tick label is a bare
          number. */}
      <div className="canvas-ruler-corner" aria-hidden>
        {UNIT_SUFFIX[units]}
      </div>
    </>
  );
}
