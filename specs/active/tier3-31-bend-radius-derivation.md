# Tier 3 #31 — Tighten bend-radius defaults to wall-thinning derivation

> **Status:** active · started 2026-05-07 · branch `task/31-bend-radius-derivation`

## Goal

Today's tube_specs hold a hand-input `min_bend_radius_mm` value (the seed for 12 mm clear glass = 27 mm). The 27 mm number is shop folklore — empirically derived but not formally tied to any glass-physics rule.

Saving Neon Ch.3 + Strattman NT documents a wall-thinning relationship: the bend radius required to keep wall strain below the working budget scales linearly with tube diameter for a given wall thickness and bend technique. The existing `runBendLimitMM` helper in `internal/validate/rules.go` already exploits this for **per-run diameter overrides** (scales `MinBendRadiusMM * pl.DiameterMM / limits.DiameterMM`). What's missing is making the **project default itself** derive from a physical formula rather than being a free-form input.

"Done" means: `tube_specs` carries enough information (wall thickness + a "bend technique" tag) for a small derivation function to compute `min_bend_radius_mm` at validation time; the existing free-form column stays for shops that want to override; the seed list updates to pre-derived values; the editor surfaces both "auto" and "manual" modes.

## Branch + setup

```sh
git fetch origin
git checkout -b task/31-bend-radius-derivation origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/storage/migrations/0010_tube_spec_wall_thickness.sql` — new migration: add `wall_thickness_mm REAL` (nullable) and `bend_technique TEXT` (nullable; "ribbon" / "crossfire" / "hand_torch") to `tube_specs`. Reversible Down.
- `internal/storage/tube_specs.go` + `models.go` — read/write the new columns.
- `internal/storage/seed.go` (or wherever the seed tube specs live) — populate the new columns for the existing seed entries.
- `internal/validate/rules.go` — add `derivedMinBendRadius(diameterMM, wallThicknessMM, technique string) float64`. `runBendLimitMM` consults the derived value when the project's stored `MinBendRadiusMM` is zero/null; uses the explicit value otherwise.
- `internal/validate/rules_test.go` — tests for the derivation formula and the override behavior.
- `web/src/api.ts` — surface the new fields on `TubeSpec`.
- `web/src/components/TubeSpecEditor.tsx` (or wherever the tube-spec form lives — search for `min_bend_radius_mm` in `web/src`) — add wall-thickness + technique inputs; show the derived radius next to the manual-override field with a "use derived" toggle.

**Don't touch:**

- `EditorCanvas.tsx`, `EditorPage.tsx` — no editor changes.
- Other validation rules.

**New:**

- None — keep the helper in `rules.go`.

## Deliverables

1. **Schema additions.** Two new tube_spec columns; reversible migration.
2. **Derivation formula.** Sketch (cite Saving Neon Ch.3 §X.Y in the doc-comment):

   ```
   r_min = K * D^2 / t
   ```

   where `D` is tube outer diameter, `t` is wall thickness, and `K` is a technique constant (smaller K = tighter bend possible because the technique heats more uniformly and reduces strain concentration). Suggested defaults from Saving Neon's tabulated values:

   | Technique | K |
   |---|---|
   | `ribbon`     | ≈ 0.8 |
   | `crossfire`  | ≈ 1.0 |
   | `hand_torch` | ≈ 1.4 |

   Confirm constants against `docs/neon-rules/bend-radius.md` before locking. If the doc disagrees, follow the doc and update the table here.

3. **Behavior.** When `tube_specs.min_bend_radius_mm` is non-null, use it (existing behavior). When null AND `wall_thickness_mm` + `bend_technique` are both set, compute and use the derived value. When all three are null, fall back to the current 27 mm-for-12 mm-tube heuristic (preserves backward compat for hand-rolled specs).

4. **Editor UI.** Two new inputs on the tube-spec form, plus a read-only "Derived: 25.6 mm" indicator that updates as the user changes diameter / wall thickness / technique. A "use derived" toggle clears the manual override.

5. **Seed update.** The seeded tube specs (12 mm clear, etc.) get realistic wall thicknesses (1.0–1.2 mm typical for 12 mm clear) and `bend_technique = 'ribbon'`, so the derived value matches the existing 27 mm folklore within ~5%. Document the chosen wall thickness in the seed comment.

## Constraints

- **Don't break existing projects.** Specs without the new fields still validate exactly as today.
- **Don't change `runBendLimitMM`'s diameter-ratio scaling.** That stays for per-run overrides; the derivation only affects how the *project default* is computed when the user opts in.
- **No new third-party deps.**
- **Document the formula's lineage.** The doc-comment on `derivedMinBendRadius` MUST cite the Saving Neon section that backs the K-table. Future maintainers should never guess.
- **No editor canvas changes.**

## Geometry / algorithms

The formula is empirical, not derived from glass-physics first principles in this codebase. Treat it as a curve-fit to Saving Neon's published tables. The doc-comment should make this provenance clear: this is "what shops do" formalized, not "what physics says".

## Tests

Add to `rules_test.go`:

- **`TestDerivedMinBendRadius`** — `derivedMinBendRadius(12, 1.0, "ribbon")` returns ≈ 25 mm (verify within ±2 mm of the published table).
- **`TestRunBendLimitFallsBackToDerivedWhenSpecMissing`** — Limits with `MinBendRadiusMM = 0`, `WallThicknessMM = 1.2`, `Technique = "crossfire"`; assert the limit is the derived value.
- **`TestRunBendLimitPrefersExplicitOverride`** — Limits with `MinBendRadiusMM = 30`, but the derivation would give 25; assert the limit is 30.
- **`TestRunBendLimitFallsBackToHeuristicWhenAllNull`** — None of the new fields set; assert behavior matches today's output for the existing seed specs.

## Pre-merge checks

Standard four. Manual smoke:

1. Open the tube-spec editor. Enter wall thickness + technique. Confirm the derived radius matches the expected value.
2. Toggle "use derived"; manual override field clears.
3. Re-validate a project; markers reflect the new limit.
4. Old project with no wall-thickness data still validates without changes.

## Workflow

1. Migration + storage layer.
2. Derivation function + tests.
3. `runBendLimitMM` fall-through logic.
4. Frontend tube-spec form.
5. Seed update.
6. Pre-merge + smoke.
7. PR titled "Bend-radius wall-thinning derivation (Tier 3 #31)".
8. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Include: PR URL, exact K constants chosen + citation, derived vs. seeded-folklore radius numbers (do they match?), CI state, follow-ups (per-glass-type wall thickness varies — borosilicate vs lead, double-walled tubes, automated scrub of legacy specs to populate the new columns).
