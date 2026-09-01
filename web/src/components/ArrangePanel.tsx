// Tier 2 #90 — the sidebar Arrange section: align, distribute, mirror and
// depth order over the current multi-selection.
//
// The component owns no doc state. It renders buttons, reports which op the
// operator picked, and asks `arrange.ts` (the same module the ops live in)
// why a family is unavailable so the disabled tooltip says something better
// than nothing.
//
// Styling stays inline rather than adding classes to App.css: this section
// shipped in a parallel round alongside other editor work, and a shared
// stylesheet is the one file guaranteed to conflict. The buttons reuse the
// existing `btn-secondary` / `meta` classes so they inherit the panel's type
// and hover treatment.

import type { DesignDoc } from '../api';
import {
  disabledReason,
  arrangeableRunIds,
  type AlignEdge,
  type Axis,
  type DepthMove,
} from '../lib/arrange';

export type ArrangePanelProps = {
  doc: DesignDoc | null;
  selectedRunIds: string[];
  onAlign: (edge: AlignEdge) => void;
  onDistribute: (axis: Axis) => void;
  onMirror: (axis: Axis) => void;
  onReorder: (move: DepthMove) => void;
};

const gridStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
  gap: 4,
  marginBottom: 8,
};

const pairStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 4,
  marginBottom: 8,
};

const btnStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 2,
  padding: '5px 2px',
  fontSize: 10,
  lineHeight: 1.1,
  minWidth: 0,
};

const subheadStyle: React.CSSProperties = {
  margin: '0 0 4px',
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.06em',
  opacity: 0.6,
};

// 16-viewBox glyphs, drawn in currentColor so they follow the button's
// enabled / disabled text colour. The heavy stroke is the edge the op pins
// to; the light rectangles are the runs that move onto it.
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden focusable={false}>
      {children}
    </svg>
  );
}

const rail = (d: string) => (
  <path d={d} stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
);
const box = (x: number, y: number, w: number, h: number) => (
  <rect
    x={x}
    y={y}
    width={w}
    height={h}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.1"
    opacity="0.75"
    rx="0.6"
  />
);

const ALIGN_BUTTONS: {
  edge: AlignEdge;
  label: string;
  title: string;
  glyph: React.ReactNode;
}[] = [
  {
    edge: 'left',
    label: 'Left',
    title: 'Align the left edge of every selected run to the left edge of the selection.',
    glyph: <>{rail('M2.5 2 L2.5 14')}{box(4, 3.5, 9, 3.5)}{box(4, 9, 5.5, 3.5)}</>,
  },
  {
    edge: 'hcenter',
    label: 'Center',
    title: 'Centre every selected run horizontally on the selection centre.',
    glyph: <>{rail('M8 2 L8 14')}{box(2, 3.5, 12, 3.5)}{box(5, 9, 6, 3.5)}</>,
  },
  {
    edge: 'right',
    label: 'Right',
    title: 'Align the right edge of every selected run to the right edge of the selection.',
    glyph: <>{rail('M13.5 2 L13.5 14')}{box(3, 3.5, 9, 3.5)}{box(6.5, 9, 5.5, 3.5)}</>,
  },
  {
    edge: 'top',
    label: 'Top',
    title: 'Align the top edge of every selected run to the top edge of the selection.',
    glyph: <>{rail('M2 2.5 L14 2.5')}{box(3.5, 4, 3.5, 9)}{box(9, 4, 3.5, 5.5)}</>,
  },
  {
    edge: 'vcenter',
    label: 'Middle',
    title: 'Centre every selected run vertically on the selection centre.',
    glyph: <>{rail('M2 8 L14 8')}{box(3.5, 2, 3.5, 12)}{box(9, 5, 3.5, 6)}</>,
  },
  {
    edge: 'bottom',
    label: 'Bottom',
    title: 'Align the bottom edge of every selected run to the bottom edge of the selection.',
    glyph: <>{rail('M2 13.5 L14 13.5')}{box(3.5, 3, 3.5, 9)}{box(9, 6.5, 3.5, 5.5)}</>,
  },
];

const DEPTH_BUTTONS: { move: DepthMove; label: string; title: string }[] = [
  {
    move: 'front',
    label: 'To front',
    title: 'Draw the selected runs on top of everything else.',
  },
  {
    move: 'forward',
    label: 'Forward',
    title: 'Draw the selected runs one step nearer the front.',
  },
  {
    move: 'backward',
    label: 'Backward',
    title: 'Draw the selected runs one step nearer the back.',
  },
  {
    move: 'back',
    label: 'To back',
    title: 'Draw the selected runs behind everything else.',
  },
];

export default function ArrangePanel({
  doc,
  selectedRunIds,
  onAlign,
  onDistribute,
  onMirror,
  onReorder,
}: ArrangePanelProps) {
  const usable = doc ? arrangeableRunIds(doc, selectedRunIds).length : 0;
  const alignWhy = disabledReason(doc, selectedRunIds, 'align');
  const distributeWhy = disabledReason(doc, selectedRunIds, 'distribute');
  const mirrorWhy = disabledReason(doc, selectedRunIds, 'mirror');
  const reorderWhy = disabledReason(doc, selectedRunIds, 'reorder');

  return (
    <div className="arrange-panel" data-testid="arrange-panel">
      <p className="meta" data-testid="arrange-count" style={{ margin: '0 0 6px' }}>
        {usable === selectedRunIds.length
          ? `${selectedRunIds.length} run${selectedRunIds.length === 1 ? '' : 's'} selected`
          : `${usable} of ${selectedRunIds.length} selected runs arrangeable (rest are in a locked layer)`}
      </p>

      <p style={subheadStyle}>Align</p>
      <div style={gridStyle}>
        {ALIGN_BUTTONS.map((b) => (
          <button
            key={b.edge}
            type="button"
            className="btn-secondary"
            style={btnStyle}
            data-testid={`align-${b.edge}`}
            disabled={alignWhy !== null}
            title={alignWhy ?? b.title}
            onClick={() => onAlign(b.edge)}
          >
            <Glyph>{b.glyph}</Glyph>
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      <p style={subheadStyle}>Distribute</p>
      <div style={pairStyle}>
        {(
          [
            ['h', 'Horizontal', 'Space the selected runs evenly left-to-right by bounding-box centre. The leftmost and rightmost runs stay put.'],
            ['v', 'Vertical', 'Space the selected runs evenly top-to-bottom by bounding-box centre. The topmost and bottommost runs stay put.'],
          ] as [Axis, string, string][]
        ).map(([axis, label, title]) => (
          <button
            key={axis}
            type="button"
            className="btn-secondary"
            style={btnStyle}
            data-testid={`distribute-${axis}`}
            disabled={distributeWhy !== null}
            title={distributeWhy ?? title}
            onClick={() => onDistribute(axis)}
          >
            <Glyph>
              {axis === 'h' ? (
                <>{box(1, 5, 3, 6)}{box(6.5, 5, 3, 6)}{box(12, 5, 3, 6)}</>
              ) : (
                <>{box(5, 1, 6, 3)}{box(5, 6.5, 6, 3)}{box(5, 12, 6, 3)}</>
              )}
            </Glyph>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <p style={subheadStyle}>Mirror</p>
      <div style={pairStyle}>
        {(
          [
            ['h', 'Flip H', 'Flip the selection left-to-right about its own centre. Arc segments keep the side they bow to.'],
            ['v', 'Flip V', 'Flip the selection top-to-bottom about its own centre. Arc segments keep the side they bow to.'],
          ] as [Axis, string, string][]
        ).map(([axis, label, title]) => (
          <button
            key={axis}
            type="button"
            className="btn-secondary"
            style={btnStyle}
            data-testid={`mirror-${axis}`}
            disabled={mirrorWhy !== null}
            title={mirrorWhy ?? title}
            onClick={() => onMirror(axis)}
          >
            <Glyph>
              {axis === 'h' ? (
                <>
                  <path d="M8 1.5 L8 14.5" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.6" />
                  <path d="M6.5 4 L2 8 L6.5 12 Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M9.5 4 L14 8 L9.5 12 Z" fill="currentColor" opacity="0.45" />
                </>
              ) : (
                <>
                  <path d="M1.5 8 L14.5 8" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.6" />
                  <path d="M4 6.5 L8 2 L12 6.5 Z" fill="none" stroke="currentColor" strokeWidth="1.1" />
                  <path d="M4 9.5 L8 14 L12 9.5 Z" fill="currentColor" opacity="0.45" />
                </>
              )}
            </Glyph>
            <span>{label}</span>
          </button>
        ))}
      </div>

      <p style={subheadStyle}>Order</p>
      <div style={pairStyle}>
        {DEPTH_BUTTONS.map((b) => (
          <button
            key={b.move}
            type="button"
            className="btn-secondary"
            style={btnStyle}
            data-testid={`order-${b.move}`}
            disabled={reorderWhy !== null}
            title={reorderWhy ?? b.title}
            onClick={() => onReorder(b.move)}
          >
            <Glyph>
              {b.move === 'front' || b.move === 'forward' ? (
                <>{box(2, 6, 8, 8)}<rect x="6" y="2" width="8" height="8" rx="0.6" fill="currentColor" opacity="0.55" /></>
              ) : (
                <>{box(6, 2, 8, 8)}<rect x="2" y="6" width="8" height="8" rx="0.6" fill="currentColor" opacity="0.55" /></>
              )}
            </Glyph>
            <span>{b.label}</span>
          </button>
        ))}
      </div>

      <p className="meta hint-line" style={{ margin: 0 }}>
        Align and distribute use each run&rsquo;s true outline, so a curved tube
        lands by its bow rather than by its end points.
      </p>
    </div>
  );
}
