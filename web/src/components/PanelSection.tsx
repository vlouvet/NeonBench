import type { ReactNode } from 'react';

// Category / annotation-kind icons for the editor sidebar lists. Each is a
// 16-viewBox inline SVG sized to 14px so it sits inline with the section
// header text. Colors loosely mirror the on-canvas markers (electrodes amber,
// block-out slate, bends blue, annotation kinds their marker hues).
export type IconKind =
  | 'electrode'
  | 'blockout'
  | 'bend'
  | 'annotation'
  | 'jump'
  | 'support'
  | 'doubleback'
  | 'drop_bend';

export function CategoryIcon({ kind }: { kind: IconKind }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 16 16',
    'aria-hidden': true,
    focusable: false as const,
  };
  switch (kind) {
    case 'electrode':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill="none" stroke="#f0a020" strokeWidth="2" />
          <circle cx="8" cy="8" r="1.6" fill="#f0a020" />
        </svg>
      );
    case 'blockout':
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke="#94a3b8" strokeWidth="1.6" />
          <path d="M3 9 L9 3 M6 13 L13 6" stroke="#94a3b8" strokeWidth="1.4" />
        </svg>
      );
    case 'bend':
      return (
        <svg {...common}>
          <path d="M3 13 L3 6 Q3 3 6 3 L13 3" fill="none" stroke="#3b82f6" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'jump':
      return (
        <svg {...common}>
          <path d="M2 12 Q8 1 14 12" fill="none" stroke="#22c55e" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'support':
      return (
        <svg {...common}>
          <path d="M8 2 L8 10 M4 13 L12 13 M8 10 L5 13 M8 10 L11 13" stroke="#a855f7" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </svg>
      );
    case 'doubleback':
      return (
        <svg {...common}>
          <path d="M5 13 L5 6 Q5 3 8 3 Q11 3 11 6 L11 13" fill="none" stroke="#06b6d4" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
      );
    case 'drop_bend':
      return (
        <svg {...common}>
          <path d="M8 2 L8 11 M5 8 L8 11 L11 8" stroke="#ef4444" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      );
    case 'annotation':
    default:
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5.5" fill="none" stroke="#cbd5e1" strokeWidth="1.6" />
          <circle cx="8" cy="8" r="1.4" fill="#cbd5e1" />
        </svg>
      );
  }
}

// A collapsible section header for the run-detail panel. Renders as a button
// row with a leading category icon, a chevron showing collapsed state, and the
// caller-supplied label/summary. The body is rendered by the caller, gated on
// `collapsed`.
export function SectionHeader({
  icon,
  collapsed,
  onToggle,
  children,
}: {
  icon: IconKind;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className="panel-section-header"
      aria-expanded={!collapsed}
      onClick={onToggle}
    >
      <span className="panel-section-chevron" aria-hidden>
        {collapsed ? '▸' : '▾'}
      </span>
      <CategoryIcon kind={icon} />
      <span className="panel-section-label">{children}</span>
    </button>
  );
}
