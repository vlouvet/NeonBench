// Tier 3 #33c — eye / hidden-eye icon for the Layers panel visibility
// toggle. Inline SVG, no new dep. Two states:
//   open  — eye outline + pupil (group is visible)
//   closed — eye outline with a slash through it (group is hidden)
//
// Both states share the same 16×16 viewBox so the layout doesn't jitter
// when the user toggles. `currentColor` strokes/fills so the icon picks
// up its parent's text color (CSS dims it at 50% opacity for hidden
// rows).

import type { CSSProperties } from 'react';

type Props = {
  open: boolean;
  size?: number;
  style?: CSSProperties;
  'aria-hidden'?: boolean;
};

export function Eye({ open, size = 14, style, ...rest }: Props) {
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
      {/* Eye almond shape: two cubic arcs meeting at the corners. */}
      <path d="M1.5 8 C 4 4, 12 4, 14.5 8 C 12 12, 4 12, 1.5 8 Z" />
      {/* Pupil. */}
      <circle cx={8} cy={8} r={2} fill="currentColor" stroke="none" />
      {open ? null : (
        // Slash from upper-left to lower-right marks the hidden state.
        // Drawn over the eye so the path stays legible at small sizes.
        <line x1={2.5} y1={2.5} x2={13.5} y2={13.5} />
      )}
    </svg>
  );
}
