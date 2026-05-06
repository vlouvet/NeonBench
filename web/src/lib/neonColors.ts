// Common neon gas/phosphor colors. The hex is a rough on-screen
// approximation of the lit tube color — close enough for design intent,
// not a calibrated render (Phase 3 glow shader will do that).
//
// Empty `value` represents "no color assigned"; rendered as the neutral
// stroke so the editor still works for unassigned runs.
export type NeonColor = {
  value: string;     // stored in DesignRun.color
  label: string;     // shown in the dropdown
  hex: string;       // CSS color used in the editor
};

export const NEON_COLORS: NeonColor[] = [
  { value: '',                label: '— Unassigned',     hex: '#222222' },
  { value: 'classic-red',     label: 'Classic Red (Ne)',  hex: '#ff2a2a' },
  { value: 'ruby-red',        label: 'Ruby Red',          hex: '#c8102e' },
  { value: 'hot-pink',        label: 'Hot Pink',          hex: '#ff5fa2' },
  { value: 'orange',          label: 'Orange',            hex: '#ff8a1f' },
  { value: 'yellow',          label: 'Yellow',            hex: '#ffd60a' },
  { value: 'green',           label: 'Green',             hex: '#3ddc84' },
  { value: 'aqua',            label: 'Aqua',              hex: '#3dd9d6' },
  { value: 'blue',            label: 'Blue (Ar/Hg)',      hex: '#2f80ff' },
  { value: 'purple',          label: 'Purple',            hex: '#9b51e0' },
  { value: 'white',           label: 'White (Ar+phos)',   hex: '#f5f5f5' },
];

const COLOR_MAP: Record<string, string> = Object.fromEntries(
  NEON_COLORS.map((c) => [c.value, c.hex]),
);

export function colorHex(value: string | undefined | null): string {
  if (!value) return COLOR_MAP[''];
  return COLOR_MAP[value] ?? COLOR_MAP[''];
}
