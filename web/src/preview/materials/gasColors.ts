/**
 * Gas + phosphor → emissive color lookup table for the Phase 3 preview.
 *
 * Sources for the V1 entries (the spec was drafted against these):
 *   - NSI Gas Color Chart (industry-standard fill chart)
 *   - Voltarc fills page (manufacturer reference)
 *   - Strattman, "Neon Techniques" (Ch.3, gas/phosphor families)
 *
 * The emissive hex values approximate the perceived "in-tube" fill
 * color of a charged tube. They are NOT spectroscopically calibrated —
 * production calibration with a reference photograph is a follow-up.
 *
 * Adding a gas: append one row, lower-case key, hex value. The
 * substring matcher in `gasToEmissiveColor` lets users tag runs with
 * suffixed strings like "ruby red 8mm" and still hit the entry.
 */
export const GAS_COLORS: Record<string, string> = {
  // Argon + mercury (with phosphor coatings)
  'ruby red':        '#ff2233',
  'rose pink':       '#ff80a0',
  'neon orange':     '#ff7733',
  'sunset orange':   '#ff5511',
  'lemon yellow':    '#ffe040',
  'gold':            '#ffc833',
  'lime green':      '#7fff00',
  'turquoise':       '#33ddcc',
  'powder blue':     '#88ccff',
  'cobalt blue':     '#3355ff',
  'royal purple':    '#7733ff',
  'deep magenta':    '#cc33ff',
  // Pure gases (no phosphor)
  'neon (red)':      '#ff5520',  // pure neon, no phosphor
  'argon (blue)':    '#5588ff',  // argon-mercury, clear glass
  'helium (yellow)': '#ffaa55',  // rare, included for collectors
  'krypton (white)': '#eeeeff',
  'xenon (white)':   '#ddddff',
  // Defaults
  'white':           '#eeeeee',
  'warm white':      '#fff0d0',
  'cool white':      '#e8eeff',
};

/**
 * Default fallback when the gas string is empty, missing, or doesn't
 * match any entry (direct or substring). A warm white at half
 * intensity reads as "lit but unidentified" — better than rendering
 * the tube invisible (which a dark `color: '#0a0a0a'` plus zero
 * emission would do) and better than guessing.
 */
const FALLBACK_COLOR = '#fff0d0';
const FALLBACK_INTENSITY = 0.75;

/**
 * V1 emissive intensity for every known gas. Per-gas tuning (some
 * phosphors visually punch harder than others) is a deliberate
 * Phase 3 follow-up; uniform 1.5 was chosen because it reads as
 * "convincingly lit" without bloom, and bloom in Phase 3 #4 will
 * pick up the brighter gases preferentially anyway.
 */
const DEFAULT_INTENSITY = 1.5;

export type EmissiveLookup = {
  color: string;
  intensity: number;
};

/**
 * Resolve a `Run.Color` free-form string to an emissive color and
 * intensity for the Phase 3 preview material.
 *
 * Resolution order:
 *   1. Trim + lower-case the input.
 *   2. Empty string → fallback warm white at 0.75 intensity.
 *   3. Direct GAS_COLORS lookup.
 *   4. Substring match: any GAS_COLORS key contained in the input
 *      wins. ("ruby red 8mm" → "ruby red".) Longest matching key
 *      wins so "warm white" beats "white" when both could hit.
 *   5. Fallback warm white at 0.75 intensity.
 *
 * Blockout handling is NOT done here — the caller (the material
 * component) checks for the blockout convention before consulting
 * this function, because blockouts have their own dark-grey,
 * non-emissive treatment.
 */
export function gasToEmissiveColor(gasName: string | undefined | null): EmissiveLookup {
  const normalized = (gasName ?? '').trim().toLowerCase();
  if (normalized === '') {
    return { color: FALLBACK_COLOR, intensity: FALLBACK_INTENSITY };
  }
  const direct = GAS_COLORS[normalized];
  if (direct !== undefined) {
    return { color: direct, intensity: DEFAULT_INTENSITY };
  }
  // Substring fallback: longest matching key wins (so "warm white"
  // beats "white" in "warm white tube"). Iterate keys sorted by
  // length descending and pick the first one contained in input.
  const keys = Object.keys(GAS_COLORS).sort((a, b) => b.length - a.length);
  for (const key of keys) {
    if (normalized.includes(key)) {
      return { color: GAS_COLORS[key], intensity: DEFAULT_INTENSITY };
    }
  }
  return { color: FALLBACK_COLOR, intensity: FALLBACK_INTENSITY };
}

/**
 * Convention for marking a run as a blockout (paint-covered) segment.
 * The design doc has no per-run boolean for this in V1; the only
 * place a designer can express "this whole run is dark" is the
 * free-form `Run.Color` string. Treat the literal string "blockout"
 * (case-insensitive, trimmed) as the convention. Phase 3 #6 will
 * introduce per-segment blockout rendering by splitting geometry,
 * at which point this whole-run flag becomes a fallback rather
 * than the only mechanism.
 */
export function isBlockoutColor(gasName: string | undefined | null): boolean {
  return (gasName ?? '').trim().toLowerCase() === 'blockout';
}
