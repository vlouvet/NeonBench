# Tier 3 #41 — Tube-spec edit modal: lead-in / sharp-bend fields

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/41-tube-spec-leadin-fields`

## Goal

PR #35 added `min_lead_in_mm` and `sharp_bend_angle_deg` columns to `tube_specs` (migration 0009) and the validator consults them when set. The values are editable via direct SQL only — there's no UI.

PR #40 + #43 establish the `<TubeSpecEditor>` + PATCH route as the canonical path for tube-spec edits. This row adds the lead-in and sharp-bend fields to that same editor with the same auto-save / dirty-tracking pattern, plus extends the PATCH body to accept them.

"Done" means: the editor renders a "Min lead-in (mm)" number input + a "Sharp bend angle (°)" number input next to the existing fields; both show their derived defaults inline as "(default: NN)" hints when null; saving persists; PR #18's fan-out re-validates dependent design versions.

This spec is intentionally narrow — it's the same shape as #43 (which handles wall_thickness/technique) but for two different columns. If #43 has merged first, mirror its structure exactly.

## Branch + setup

```sh
git fetch origin
git checkout -b task/41-tube-spec-leadin-fields origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/server/handlers_tube_specs.go` — extend `handleUpdateTubeSpec`'s PATCH parser to accept `min_lead_in_mm` (`*float64`) and `sharp_bend_angle_deg` (`*float64`) with the same three-state semantics as `min_bend_radius_mm`. Validate `min_lead_in_mm` in `[0, 50]` mm; `sharp_bend_angle_deg` in `[0, 90]` degrees.
- `internal/server/integration_test.go` — three new tests (omitted preserves; null clears; bounds validation rejects). Existing tests untouched.
- `web/src/api.ts` — extend the `updateTubeSpec` request type. The `TubeSpec` response type already has the fields (added in PR #35).
- `web/src/pages/ProjectDetail.tsx` — add two inputs to `<TubeSpecEditor>`. Show derived defaults as inline hints when null:
  - Lead-in default: `1.5 × diameter_mm`
  - Sharp-bend default: 30° (per `internal/validate/types.go`)
  Wire to the existing auto-save pattern.

**Don't touch:**

- `internal/validate/*` — rule logic stays.
- `internal/storage/*` — read/write already plumbed.
- `EditorCanvas.tsx`, `EditorPage.tsx`, `ProjectList.tsx` — unrelated.
- Migration files.

**New:** none.

## Deliverables

1. PATCH body accepts both new fields with three-state semantics.
2. Validation:
   - `min_lead_in_mm`: numeric, `[0, 50]` mm. Negative or >50 → 422.
   - `sharp_bend_angle_deg`: numeric, `[0, 90]` degrees. Outside → 422.
3. Frontend inputs:
   - Min lead-in: `<input type="number" step="0.5" min="0" max="50">`.
   - Sharp bend angle: `<input type="number" step="1" min="0" max="90">`.
   - Inline hint when the field is empty: `(default: 18.0 mm)` or `(default: 30°)` — recompute the lead-in default from the current diameter input so the hint stays accurate as the user edits.
   - "Clear" button per field (or a placeholder-vs-value pattern) so the user can revert to derived default.
4. Auto-save through PATCH; toast confirms fan-out count via PR #40's existing pattern.

## Constraints

- **No new third-party deps.**
- **Three-state PATCH preserved.**
- **No schema changes.**
- **No new validation rule logic** — the rules already exist in PR #35.
- **No editor-canvas changes** — markers from PR #41 already render lead-in / sharp-bend issues.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestPatchTubeSpecLeadInOmitted`**: PATCH unrelated field; assert lead-in unchanged.
- **`TestPatchTubeSpecLeadInClears`**: pre-seed lead-in=10; PATCH null; assert NULL.
- **`TestPatchTubeSpecSharpBendBoundsValidate`**: try `-5` and `95`; assert 422 + no row mutation.
- **`TestPatchTubeSpecLeadInFanoutRevalidates`**: change lead-in on a spec with dependent versions; assert at least one version's report flags a previously-clean run as `min_lead_in`.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Set min_lead_in to 10 mm on the seeded 12 mm tube spec.
2. Open a project that uses that spec with a doc whose first segment is 8 mm long.
3. Verify the editor shows a `min_lead_in` issue on canvas (marker overlay) + sidebar.
4. Clear the lead-in (null); verify the issue clears (derived default 18 mm fires anyway, but the original 8 mm < 18 mm fails too — pick fixture lengths that prove the override-vs-default behavior cleanly).

## Workflow

1. Backend PATCH extension + tests first.
2. Frontend inputs + derived-default hints next.
3. Pre-merge checks; manual smoke.
4. Open PR titled "PATCH tube_specs supports min_lead_in_mm + sharp_bend_angle_deg (Tier 3 #41)".
5. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, implementation summary, judgment calls (especially the inline-hint formatting choice), file-size deltas, CI state, follow-ups worth tracking.
