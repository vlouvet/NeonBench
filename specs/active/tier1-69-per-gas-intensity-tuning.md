# Tier 1 #69 — Per-gas emissive intensity tuning

> **Status:** active · drafted 2026-05-08 · branch `task/1-per-gas-intensity-tuning`

## Goal

The Phase 3 preview's gas-color resolver (`web/src/preview/materials/gasColors.ts`) returns a uniform `DEFAULT_INTENSITY = 1.5` for every gas. Bloom (`EffectComposer` + `Bloom` pass at threshold 0.6) amplifies the brighter base hexes preferentially, so warm-spectrum gases (rose pink, sunset orange) read as "convincingly lit," while cool-spectrum gases (cobalt blue, royal purple, lime green) read as "dull" against the dark scene. The user flagged this on the OPEN-sign render: "only the neon pink color glows at an acceptable level, all other letters look 'dull' compared to it."

This is a Tier 1 fix because the preview is the customer-sign-off surface; if blue / green / purple letters look unlit, operators will reject the preview as broken regardless of the underlying geometry being correct.

"Done" means: every gas in `GAS_COLORS` resolves to a per-gas-tuned `emissiveIntensity` such that, under the existing bloom configuration, all colors read as "convincingly lit" at typical preview zoom — no single color dominates and no color falls below the rose-pink reference. The 10-key editor slug bridge (Tier 1 #67) inherits the new intensities automatically.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-per-gas-intensity-tuning origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/materials/gasColors.ts` — replace the single `DEFAULT_INTENSITY = 1.5` constant with a `GAS_INTENSITY: Record<string, number>` table keyed by the same lowercase gas-name keys as `GAS_COLORS`. Add a `DEFAULT_INTENSITY = 1.8` (or whichever lands as the right baseline after tuning) as the fallback for keys not in the intensity table. `gasToEmissiveColor()` consults `GAS_INTENSITY` first, falls back to `DEFAULT_INTENSITY`.
- `web/src/preview/materials/gasColors.test.ts` — add cases pinning the per-gas mapping for each editor slug + each fallback path. Existing tests for `gasToEmissiveColor` should stay green; new tests assert the intensity for representative gases.

**Don't touch:**

- `EmissiveTubeMaterial.tsx` — it consumes the `intensity` field unchanged; the fix is upstream in the lookup.
- The hex values in `GAS_COLORS` — those were calibrated against trade references (NSI / Voltarc / Strattman); changing them is out of scope. We only adjust the intensity multiplier.
- Bloom config (`BLOOM_INTENSITY` / `BLOOM_LUMINANCE_THRESHOLD` / `BLOOM_RADIUS` in Scene.tsx) — that's row 55's slider work, not this fix.
- The editor slug bridge (`EDITOR_COLOR_TO_GAS`) — bridging is correct; only the resolved intensity changes.

## Deliverables

1. **Per-gas intensity table.** Rough starting calibration (tweak by visual review):

   ```ts
   const GAS_INTENSITY: Record<string, number> = {
     // Argon + mercury (with phosphor coatings) — phosphors lose energy
     // to coating layer; bump bluer / greener phosphors to compensate.
     'ruby red':        1.6,
     'rose pink':       1.5, // user reference — "looks right"
     'neon orange':     1.7,
     'sunset orange':   1.6,
     'lemon yellow':    2.0,
     'gold':            2.0,
     'lime green':      2.4, // green phosphor visually weak under bloom
     'turquoise':       2.4,
     'powder blue':     2.6,
     'cobalt blue':     2.8, // deep blue: highest compensation
     'royal purple':    2.6,
     'deep magenta':    2.2,
     // Pure gases (no phosphor) — cleaner spectrum, slightly brighter
     'neon (red)':      1.8,
     'argon (blue)':    2.6,
     'helium (yellow)': 2.0,
     'krypton (white)': 2.0,
     'xenon (white)':   2.0,
     // Defaults
     'white':           1.8,
     'warm white':      1.6, // already warm; bloom over-compensates
     'cool white':      2.0,
   };
   ```

   These are **starting calibrations**, not load-bearing. The agent should adjust based on a visual smoke pass against project 9 v35 + project 21232 v33 if the cool-spectrum gases still read dim, OR if the warm-spectrum gases now over-bloom. Document final values in the PR description.

2. **`gasToEmissiveColor` consults the table.** Every code path that currently returns `DEFAULT_INTENSITY` (direct hit, bridge hit, substring hit) instead returns `GAS_INTENSITY[key] ?? DEFAULT_INTENSITY` where `key` is the resolved gas key. The fallback / empty-string paths keep `FALLBACK_INTENSITY = 0.75` since "unknown gas" semantically means "render as dim warm white."

3. **Tests.** Extend `gasColors.test.ts`:
   - Each editor slug in `EDITOR_COLOR_TO_GAS` resolves to its expected intensity (10 cases).
   - `gasToEmissiveColor('lime green')` returns `intensity = 2.4` (or whatever the final calibrated value is — whichever lands, pin it so future changes don't silently regress).
   - `gasToEmissiveColor('blockout')` is NOT handled here (that's `isBlockoutColor`'s domain); but `gasToEmissiveColor('cobalt blue 8mm')` substring-hits and returns the cobalt blue intensity.
   - Empty / unknown input still returns `FALLBACK_INTENSITY = 0.75`.

## Constraints

- **No new third-party deps.**
- **No backend / schema changes.** Intensity is a visual constant.
- **Don't change the hex values.** Tuning brightness via intensity multipliers, not by darkening / lightening base color, keeps the gas-spectrum semantics honest.
- **Keep the API stable.** `gasToEmissiveColor` returns the same `{ color, intensity }` shape; only the intensity values change.
- **Don't crank everything to 3.0** — if every gas is super-bright, bloom blows out the highlights and you lose the "lit tube against a dark scene" read. The cool gases need MORE bump; warm gases stay near 1.5–1.7.

## Tests

Unit cases enumerated above. Manual smoke:

1. `/projects/9/versions/35/preview` — the OPEN sign with mixed colors. Cycle through the editor's color palette by changing one run's color and re-rendering. Each color should read as "convincingly lit" at the default zoom — none should look noticeably dimmer than rose-pink.
2. `/projects/21232/versions/33/preview` — verify multi-color crossings still read distinctly; the tube lifted by jumps still reads as the brighter (more in front) tube.
3. Toggle wall backing on; confirm cool-spectrum tubes still cast bloom on the wall (no "flat" colors).

If browser smoke is unavailable from the worktree, say so in the report; the calibration is informed enough by the table above to ship without it, but the PR description should call this out.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Define `GAS_INTENSITY` table in `gasColors.ts`. Keep `DEFAULT_INTENSITY` as the fallback constant.
2. Update `gasToEmissiveColor` to consult the table on every successful resolution path.
3. Add unit tests pinning the intensities for the editor slugs + a couple of substring cases.
4. (If browser available) Smoke against projects 9 v35 + 21232 v33 and adjust the table values.
5. Pre-merge.
6. PR titled `Per-gas emissive intensity tuning (Tier 1 #69)`.
7. **Move this spec from `specs/active/` to `specs/done/`** in the same PR.

## Report back

Under 200 words. Include: PR URL, the final calibrated table values (especially any deviations from the spec's starting point and *why*), test list, smoke result (or explicit "no browser available"), CI state, follow-ups (bloom-config sliders in scene controls — todo row 55; per-project intensity overrides; warm-up flicker animation — second half of todo row 58, which can land separately).
