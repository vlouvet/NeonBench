// Tier 3 #33c — padlock icon for the Layers panel lock toggle. Inline
// SVG, no new dep. Two states:
//   locked   — body + closed shackle (group is click-protected)
//   unlocked — body + shackle pulled open to the side
//
// Both states share the same 16×16 viewBox so the layout doesn't
// shift when toggled. `currentColor` strokes/fills so the icon
// follows the parent's text color (CSS dims it at 50% opacity for
// locked rows).

import type { CSSProperties } from 'react';

type Props = {
  locked: boolean;
  size?: number;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
};

export function Padlock({ locked, size = 14, style, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.4}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={style}
      aria-hidden={rest['aria-hidden'] ?? true}
      focusable="false"
    >
      {/* Lock body — rounded rectangle. */}
      <rect x={3.5} y={7.5} width={9} height={6.5} rx={1.2} ry={1.2} />
      {/* Keyhole — a small dot inside the body so the icon reads at 14px. */}
      <circle cx={8} cy={10.5} r={0.9} fill="currentColor" stroke="none" />
      {locked ? (
        // Closed shackle — symmetric U sitting on top of the body.
        <path d="M5.5 7.5 V 5.2 A 2.5 2.5 0 0 1 10.5 5.2 V 7.5" />
      ) : (
        // Open shackle — the right post is pulled up-right and the
        // top is rotated, suggesting the lock is hanging open.
        <path d="M5.5 7.5 V 5.2 A 2.5 2.5 0 0 1 10.5 5.2" />
      )}
    </svg>
  );
}
