# Phase 3 #3 — Emissive glass material + gas color library

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-3-emissive-material`

## Goal

Phase 3 #2 ships tubes rendered with a flat white-ish placeholder material. This spec replaces it with an emissive glass shader keyed by gas + phosphor color, producing the canonical "neon glow" look — a saturated emissive core that reads as the gas's natural fill color (ruby red argon-mercury, neon orange neon, argon blue argon-mercury without phosphor, etc.).

Bloom post-processing comes in Phase 3 #4. This spec stops at the per-tube material — the glow is convincing enough without bloom on its own, and decoupling lets us iterate on each independently.

"Done" means: the preview shows tubes glowing in their gas-and-phosphor colors; blockout segments render as opaque dark grey (no emission); the gas/color library is documented and lookup-table-driven so adding a gas is a one-line change.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-3-emissive-material origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/preview/Tube.tsx` — swap `meshBasicMaterial` for the new emissive material. Pass the run's color/gas through.

**New:**

- `web/src/preview/materials/gasColors.ts` — gas+phosphor → emissive color hex map. Documents references (real-world fill color charts) inline.
- `web/src/preview/materials/gasColors.test.ts` — lookup tests.
- `web/src/preview/materials/EmissiveTubeMaterial.tsx` — the material component. Uses `THREE.MeshStandardMaterial` with `emissive` + `emissiveIntensity` set to the gas color. (No custom GLSL shader for V1 — `MeshStandardMaterial` already emits convincingly when paired with bloom in #4.)

**Don't touch:**

- `Scene.tsx` (already mapping over runs; Tube.tsx is where the material plugs in).
- Backend.
- `EditorCanvas.tsx`, `EditorPage.tsx`.
- `tube-geom.ts` from Phase 3 #2.

## Deliverables

### Gas color library

Map from "gas description" (free-form `Run.Color` string, or a structured gas/phosphor tag if Phase 3 #2 introduced one — check the design doc) to an emissive hex color. References: NSI Gas Color Chart, Voltarc fills page, Strattman NT Ch.3.

Initial entries (V1, ~20 rows; expand later):

```ts
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
```

The lookup function `gasToEmissiveColor(gasName: string): { color: string; intensity: number }`:
- Lowercase + trim the input.
- Direct lookup by full string first.
- Fallback: substring match (so `"ruby red 8mm"` still picks `'ruby red'`).
- Final fallback: a default warm white at half intensity (so a typo / unknown gas doesn't render invisible).

Intensity is `1.5` for everything in V1 (later: per-gas tuning if certain colors need more punch).

### Material component

```tsx
// EmissiveTubeMaterial.tsx
import { MeshStandardMaterial } from 'three';
import { gasToEmissiveColor } from './gasColors';

export function EmissiveTubeMaterial({ color, isBlockout }: { color: string; isBlockout: boolean }) {
  if (isBlockout) {
    return <meshStandardMaterial color="#222222" emissive="#000000" />;
  }
  const { color: emissive, intensity } = gasToEmissiveColor(color);
  return (
    <meshStandardMaterial
      color="#0a0a0a"           // dark base — emission is the visible component
      emissive={emissive}
      emissiveIntensity={intensity}
      roughness={0.2}
      metalness={0.0}
    />
  );
}
```

`color: "#0a0a0a"` keeps the non-emissive surface dark so the tube looks like glass-housing-the-light, not a solid colored plastic rod. Phase 3 #4's bloom will pick up the emissive component and bloom it.

### Blockout treatment

`Run.Blockouts` segments render as opaque dark grey on the tube. Two options:
1. **V1 (this PR)**: blockouts are NOT yet rendered as separate segments — the whole run uses one material. A `Run.IsBlockout` flag (if it exists) demotes the entire run to dark grey. The per-segment blockout rendering ships in Phase 3 #6 (electrodes + blockouts) where the geometry split happens.
2. **V2 (Phase 3 #6)**: a run with blockouts gets split into multiple geometry pieces, each with its own material — emissive for live segments, dark grey for blockouts.

This spec only does case (1) — entire-run material switching based on a project-wide flag if one exists. If `Run` has no per-run "blockout" boolean, just render every run with the emissive material; #6 picks up the per-segment story.

## Constraints

- **No new dependencies** beyond Phase 3 #1's set.
- **No custom GLSL shaders in V1** — `MeshStandardMaterial` is what `react-three/fiber` apps use 90% of the time. Custom shaders are a far-future optimization.
- **No backend changes.**
- **No edit affordances** — preview stays read-only.
- **Gas library is initial pass** — 20 rows is enough for V1; broader coverage (collector/specialty gases) is a follow-up. Add an "unknown gas → fallback warm white" branch so unmatched colors don't render invisible.
- **No animation** — emission is static intensity. Animated warm-up / flicker is far-future.
- **Color contrast** — bright emissive colors must read against the dark scene background from Phase 3 #1 (`#0a0a0a`). Test on a sample project with multiple gases.

## Geometry / algorithms

None — this is material setup.

## Tests

`gasColors.test.ts`:

- Direct match: `gasToEmissiveColor('ruby red')` returns `{color: '#ff2233', intensity: 1.5}`.
- Case-insensitive: `'RUBY RED'` returns the same.
- Substring fallback: `'ruby red 8mm'` returns the ruby red entry.
- Unknown gas: `'plasma blast'` returns the warm-white fallback at intensity 0.75 (or whatever default we settle on).
- Empty string: returns the default fallback.

For the material itself, no automated test (no RTL); manual smoke confirms the visual.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open the preview on a project with at least three runs in different gas colors.
2. Each tube glows in its expected color.
3. Without bloom (Phase 3 #4 not yet shipped), the glow looks "lit-from-within" but not aggressively glowy. That's expected — bloom is the dramatic step.
4. A run with an unknown gas string (manually edit one run's `Run.Color` to something nonsensical via the editor first) renders with the warm-white fallback, not invisible.
5. The dark scene background lets the colors pop; no blown-out highlights.

## Workflow

1. Build `gasColors.ts` + tests; verify lookup behavior.
2. Build `EmissiveTubeMaterial.tsx`; wire it into `Tube.tsx`.
3. Manual smoke; confirm visual fidelity.
4. Pre-merge checks.
5. Open PR titled "Phase 3 emissive material + gas color library (Phase 3 #3)".
6. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially the gas-library coverage gap; intensity per-gas vs uniform 1.5; the blockout-deferred-to-#6 choice), file-size deltas, CI state, screenshots if you can attach them (drop into the PR body), follow-ups (per-gas intensity tuning, expanded gas library matching real-world phosphor codes, custom GLSL for tube-end light spillage, animated flicker for "warm-up" effect).
