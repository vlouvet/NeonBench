# Tier 1 #67 — 3D preview ignores per-run color (every tube glows warm white)

> **Status:** active · drafted 2026-05-08 · branch `task/1-preview-color-bridge`

## Goal

Editor and preview disagree on the vocabulary for `Run.Color`:

- The editor's color picker (`web/src/lib/neonColors.ts`) stores **slug values** like `ruby-red`, `classic-red`, `hot-pink`, `orange`, `yellow`, `green`, `aqua`, `blue`, `purple`, `white`.
- The preview's emissive lookup (`web/src/preview/materials/gasColors.ts`) keys off **gas-name strings** like `ruby red`, `cobalt blue`, `lemon yellow`, etc. Hyphen vs space — the formats never align.

Result: `gasToEmissiveColor` finds no direct hit, the substring fallback also misses (the editor slug isn't a substring of any gas name and vice versa), and every run resolves to `FALLBACK_COLOR = '#fff0d0'` at intensity `0.75`. Every tube glows pale warm-white regardless of the operator's choice. The only accidental hit is `white` → `white`, which works.

todo.md row 135 (Phase 3 #3) currently claims "Per-run color matches gas/phosphor" as ✅ shipped — but the implementation never actually worked end-to-end against editor-saved data.

"Done" means: every editor-picker color renders in the 3D preview at the matching emissive hue and intensity, and the regression is pinned by a unit test.

## Branch + setup

```sh
git checkout -b task/1-preview-color-bridge origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/materials/gasColors.ts` — add a slug-to-gas-name bridge `EDITOR_COLOR_TO_GAS: Record<string, string>` mapping every entry in `NEON_COLORS` (except `''` / "Unassigned") to the matching `GAS_COLORS` key. Have `gasToEmissiveColor` consult the bridge before the direct + substring lookups.
- `web/src/preview/materials/gasColors.test.ts` — add cases for every editor slug; assert each resolves to a non-fallback emissive (i.e. `intensity === DEFAULT_INTENSITY`, color matches the bridged GAS_COLORS hex). Keep the existing test cases.

**Don't touch:**

- `web/src/lib/neonColors.ts` — the editor's slug vocabulary stays. Migrating editor data to gas names would touch persisted DB rows, which is out of scope for a Tier 1 regression fix.
- `EmissiveTubeMaterial.tsx` — call site is fine; it consults `gasToEmissiveColor` with the run's color string.
- The `GAS_COLORS` table itself — keep it as the gas-name source of truth. The bridge translates editor slugs *into* this vocabulary.

## Deliverables

1. **Bridge map** in `gasColors.ts`. One row per editor slug:
   ```ts
   const EDITOR_COLOR_TO_GAS: Record<string, string> = {
     'classic-red': 'neon (red)',
     'ruby-red':    'ruby red',
     'hot-pink':    'rose pink',
     'orange':      'neon orange',
     'yellow':      'lemon yellow',
     'green':       'lime green',
     'aqua':        'turquoise',
     'blue':        'cobalt blue',
     'purple':      'royal purple',
     'white':       'white',
   };
   ```
   Comment block explaining: editor and GAS_COLORS use different hex approximations (each is uncalibrated); bridging via gas name keeps the GAS_COLORS table as the authoritative emissive source for the 3D preview.
2. **Lookup integration**. In `gasToEmissiveColor`, after normalization, check the bridge: if the slug maps to a gas name present in `GAS_COLORS`, return that entry at `DEFAULT_INTENSITY`. Otherwise fall through to the existing direct + substring + fallback logic.
3. **Test coverage**. For each of the ten editor slugs, assert the resolved color matches the bridged hex and intensity is `DEFAULT_INTENSITY`. Plus a regression test that documents the original failure mode: `gasToEmissiveColor('ruby-red')` must NOT return `FALLBACK_COLOR`.

## Constraints

- **No new dependencies.**
- **No editor / DB changes.** The bridge is one-sided — preview reads editor slugs and translates.
- **Don't change the editor's hex approximations** even where they differ from `GAS_COLORS`. Both tables are uncalibrated; reconciling them is a follow-up tracked in the Phase 3 #58 row.
- **Keep the substring + fallback paths.** Existing free-form gas strings like `"ruby red 8mm"` (whatever a future Hershey-imported sign might produce) must still resolve correctly.

## Tests

- `gasColors.test.ts`: ten new cases (one per editor slug) checking color + intensity. Plus one existing-behavior preservation test (substring match on `"ruby red 8mm"` still hits `ruby red`).
- Manual smoke: open `/projects/9/versions/35/preview` ("OPEN" sign at v35). Tubes must glow in the colors set in the editor (not warm-white). Verify each preset.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Add bridge + lookup integration.
2. Add tests; confirm all green.
3. Rebuild and manual-smoke against project 9 v35.
4. Pre-merge checks.
5. Open PR `Fix 3D preview color bridge for editor slugs (Tier 1 #67)`.
6. Spec stays at `specs/done/` — already in done/ since this PR contains both spec + impl.

## Report back

Under 150 words. Include PR URL, smoke-test confirmation that each editor color renders correctly, any follow-ups (e.g. reconciling the editor's hex approximations with GAS_COLORS — a calibrated palette is presumably worth its own Phase 3 follow-up).
