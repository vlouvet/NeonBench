# Tier 3 #44 — Full-Limits forwarding in handlers

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/44-full-limits-forwarding`

## Goal

PRs #35 (lead-in / sharp-bend rules), #42 (bend-radius derivation), and #43 (face-perimeter rule) added new `Limits` fields — `MinLeadInMM`, `SharpBendAngleDeg`, `WallThicknessMM`, `BendTechnique` — to `internal/validate/types.go`. The validator reads them when present, but the request paths that build a `Limits` struct from a tube spec only forward 4 of the 8 fields.

The new fields are populated on tube specs (via migration 0009 + 0010 backfill, plus PATCH for the lead-in / bend-angle fields), so they're available — but the validators silently fall back to diameter-derived defaults because nothing copies them into the request-scoped `Limits`.

"Done" means: every place that constructs a `validate.Limits` from a `storage.TubeSpec` (or equivalent project record) forwards all eight fields. Existing tests pass unchanged. New tests pin the wiring per call site so a future field addition is caught at review time.

## Branch + setup

```sh
git fetch origin
git checkout -b task/44-full-limits-forwarding origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/server/handlers_vectorize.go` — locate `runValidation` (or whichever helper packages the `validate.Limits` struct from a tube spec). Forward `MinLeadInMM`, `SharpBendAngleDeg`, `WallThicknessMM`, `BendTechnique` alongside the existing `DiameterMM` / `MinBendRadiusMM` / `MaxRunMM` / `MinSpacingMM`. Pull the values from the tube spec the request resolves.
- `internal/server/handlers_designdoc.go` — same forwarding in the doc-validation path (search for `validate.Limits{`).
- `internal/server/handlers_tube_specs.go` — `revalidateAllForTubeSpec` and the `revalidateOne` it calls must use the same fully-populated `Limits`. If `revalidateOne` already builds the struct, no change here; if it delegates to one of the handlers above, this file may be a no-op.
- `internal/server/integration_test.go` — add `TestValidationConsultsAllTubeSpecFields`: create a tube spec with non-default values for each of the four new fields, post a doc that would only fail under those non-default values (e.g. a 4 mm lead-in vs a 6 mm `MinLeadInMM`), expect the report to flag the issue. Without the forwarding fix the test fails because the validator falls back to defaults.

**Don't touch:**

- `internal/validate/*` — rule logic is correct; this is wiring.
- `internal/storage/*` — reading the tube spec already returns all columns.
- `internal/designdoc/types.go` — schema unchanged.
- Frontend — no API contract change.

**New:** none.

## Deliverables

1. Audit every site that constructs `validate.Limits{...}` from a tube spec. Document the list in your PR body so a future maintainer can re-audit at a glance.
2. Forward all eight fields at every site:
   - `DiameterMM`, `MinBendRadiusMM`, `MaxRunMM`, `MinSpacingMM` (existing)
   - `MinLeadInMM`, `SharpBendAngleDeg`, `WallThicknessMM`, `BendTechnique` (new)
3. The `Limits` struct's zero values for the new fields must continue to mean "use derived default" — don't change that contract; just don't *force* zero when the tube spec has a real value.
4. New integration test pinning the wiring (see Tests).
5. Document the audit pattern in a header comment on `runValidation` so the next field addition triggers a comment-driven checklist update.

## Constraints

- **No new third-party deps.**
- **No `Limits` struct field changes** — the struct already has the fields; this PR only wires existing fields through.
- **No API contract changes** — request and response shapes are byte-identical for any tube spec where the new fields are zero.
- **No schema changes.**
- **No silent fallback regressions** — if a tube spec has `MinLeadInMM = 0` (interpreted as "derive from diameter"), the post-fix behavior must match the pre-fix behavior for that case. The fix only changes behavior when the tube spec has a non-zero value that previously got dropped.

## Geometry / algorithms

None. This is plumbing. The interesting question is *where* to forward the fields, not *how*.

The audit pattern is essentially:

```sh
grep -rn 'validate.Limits{' internal/server/
```

For each match:
- Confirm it's reading from a `storage.TubeSpec` (not synthetic test fixture).
- Add the four missing field assignments.
- If the tube spec is fetched a layer up and only `DiameterMM` etc. is passed down, lift the fetch or pass the full spec through.

Watch for paths that bypass tube spec resolution entirely (e.g. an endpoint that takes raw `Limits` from a request body) — those don't need the change because they're explicitly using whatever the caller sent.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestValidationConsultsAllTubeSpecFields`**:
  1. Create a tube spec with `min_lead_in_mm = 6.0`, `sharp_bend_angle_deg = 30`, `wall_thickness_mm = 1.0`, `bend_technique = "ribbon"`.
  2. Create a project with that spec.
  3. POST a design doc whose first segment is exactly 4 mm long (under the 6 mm lead-in limit) but where every other rule passes.
  4. Assert the validation report contains a `min_lead_in` issue.
  5. Without the forwarding fix, the test fails — the validator's diameter-derived fallback for `MinLeadInMM` would let the 4 mm lead-in pass.
- **`TestValidationDerivedBendRadiusFromTubeSpec`**:
  1. Create a tube spec with `wall_thickness_mm = 0.8`, `bend_technique = "hand_torch"`, `min_bend_radius_mm = 0` (forcing derivation).
  2. POST a doc with a bend whose radius is below `derivedMinBendRadius(D, 0.8, "hand_torch")` but above the diameter-only fallback.
  3. Assert the bend-radius issue surfaces. Pin the post-fix behavior so a regression to the diameter-only fallback would fail this test.

Existing tests must pass unchanged — every other case has the new fields at zero values, which now correctly mean "use derived default" same as before.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # hard-gate — must be zero errors
```

## Workflow

1. Audit `grep -rn 'validate.Limits{' internal/server/` and write the list into the PR description.
2. For each site, add the four missing field assignments. Run the existing test suite after each — it should stay green throughout because the existing tests use zero values for the new fields.
3. Add the two new integration tests. Confirm they fail against `origin/main` (capture the failure output for the PR body) and pass on your branch.
4. Add the audit-pattern header comment to `runValidation`.
5. Run all four pre-merge checks.
6. Open PR titled "Forward all Limits fields from tube spec to validator (Tier 3 #44)". Body links to `todo.md` Appendix B row 44.
7. **Move this spec** from `specs/active/tier3-44-full-limits-forwarding.md` to `specs/done/tier3-44-full-limits-forwarding.md` as part of your final commit.

## Report back

Under 250 words. Include:

- PR URL
- The audit list (every site that constructs `validate.Limits{...}` from a tube spec)
- File-size deltas
- CI final state
- Any judgment calls — particularly around paths that *intentionally* skip a field (if any)
- Tier 3 follow-ups worth tracking (e.g. a struct-builder helper `tubeSpecToLimits(spec) validate.Limits` to centralize the mapping)
