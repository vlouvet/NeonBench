# Tier 3 #43 — PATCH /api/tube_specs/{id} for wall thickness + bend technique

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/43-patch-wall-thickness`

## Goal

PR #42 added `wall_thickness_mm` and `bend_technique` columns to `tube_specs` (migration 0010) and surfaced them as **read-only** values in the editor with a "Use derived" copy-out button. The values are settable only via migration today — operators can't edit a wall thickness or switch a tube from "ribbon" to "hand_torch" without a SQL hand-edit.

PR #40 already established the `PATCH /api/tube_specs/{id}` route + `<TubeSpecEditor>` component. This row extends both: the route accepts the two new fields with the same three-state PATCH semantics already used for `min_bend_radius_mm` (omitted → no change, null → clear, value → set), and the editor renders editable inputs for them.

"Done" means: the editor has a wall-thickness number input + a bend-technique dropdown next to the existing bend-radius field; the live "derived NN.N mm" indicator updates as you edit; saving persists to SQLite; PR #18's fan-out re-validates every dependent design version against the new derivation. Existing PATCH callers that don't send the new fields keep working unchanged.

## Branch + setup

```sh
git fetch origin
git checkout -b task/43-patch-wall-thickness origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/server/handlers_tube_specs.go` — extend `handleUpdateTubeSpec`'s PATCH body parser to accept `wall_thickness_mm` (`*float64` via `json.RawMessage` for null vs omitted) and `bend_technique` (`*string`, valid values: `"ribbon"`, `"crossfire"`, `"hand_torch"`, `""` to clear). Validate range `[0.1, 10.0]` mm for wall thickness; reject unknown technique strings with 422.
- `internal/server/integration_test.go` — three new tests (omitted-field PATCH preserves value; null clears; explicit value sets + flows through fan-out revalidation). Keep existing PATCH tests untouched.
- `web/src/api.ts` — extend the `updateTubeSpec` request type. The existing `TubeSpec` type from PR #42 already carries the fields.
- `web/src/pages/ProjectDetail.tsx` — promote the two read-only display lines in `<TubeSpecEditor>` to editable inputs. Wire to the same auto-save/dirty pattern the existing `min_bend_radius_mm` field uses.

**Don't touch:**

- `internal/validate/rules.go` — derivation formula stays as-is.
- `internal/storage/*` — read/write already plumbed in PR #42.
- Migration files — schema unchanged.
- `EditorCanvas.tsx`, `EditorPage.tsx`, `ProjectList.tsx` — unrelated.
- `web/src/lib/*` — no derivation moves to the frontend.

**New:** none.

## Deliverables

1. **PATCH body extension.** Three-state semantics matching `min_bend_radius_mm`:
   - Field omitted → preserve current value.
   - Field set to `null` → clear (database NULL).
   - Field set to a value → update.
2. **Validation:**
   - `wall_thickness_mm` must be a number in `[0.1, 10.0]` (range covers soft soda-lime through borosilicate).
   - `bend_technique` must be one of `"ribbon"`, `"crossfire"`, `"hand_torch"`, or empty string (clear).
   - Reject other values with `422 Unprocessable Entity` and a clear message.
3. **Frontend inputs:**
   - Wall thickness: `<input type="number" step="0.05" min="0.1" max="10.0">` next to a "mm" suffix.
   - Bend technique: `<select>` with three named options + a blank "(none)" entry that maps to clearing the field.
   - Both auto-save with the existing dirty-tracking pattern; the live "derived NN.N mm" indicator must recompute when either field changes (it already reads from the same component-local state per PR #42).
4. **Fan-out integration.** PR #18's `revalidateAllForTubeSpec` already runs on every PATCH; the new fields flowing through to derivation just work because PR #44 (or this PR's downstream) wires the full `Limits`. **Note**: if PR #44 hasn't merged yet, the derivation will run via the diameter-only fallback. That's correct behavior — flag in your PR body.

## Constraints

- **No new third-party deps.**
- **Three-state PATCH preserves prior contract** — sites that send only `{name, dimensions_in, min_bend_radius_mm}` must still work without changes.
- **No schema changes** — columns already exist (migration 0010).
- **No derivation logic changes** — the K constants and formula stay where PR #42 put them.
- **Don't refactor `<TubeSpecEditor>`** beyond the two field additions. The PR #40/#42 layout is settled.

## Geometry / algorithms

None — pure plumbing on top of an existing pattern. Mirror the `min_bend_radius_mm` implementation in `handleUpdateTubeSpec`.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestPatchTubeSpecWallThicknessOmitted`**: PATCH a body with only `name` set; assert wall_thickness_mm and bend_technique are unchanged. (Pins three-state preserve.)
- **`TestPatchTubeSpecWallThicknessClears`**: pre-seed wall=1.2; PATCH `{wall_thickness_mm: null}`; assert column is NULL afterward.
- **`TestPatchTubeSpecBendTechniqueValidates`**: PATCH `{bend_technique: "torch"}` (typo); assert 422; assert no row mutation.
- **`TestPatchTubeSpecFanoutRevalidatesAfterWallChange`**: project with multiple versions, change wall_thickness; assert response's `revalidated.version_count > 0` and at least one version's report changed.
- **`TestPatchTubeSpecAcceptsAllValidTechniques`**: parametric over `[]string{"ribbon", "crossfire", "hand_torch", ""}`. All four return 200.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke test:

```sh
( cd web && npm run dev )
```

1. Open a project; expand the tube-spec editor.
2. Edit wall thickness from 1.07 → 0.95 mm; observe the live "derived NN.N mm" indicator drop.
3. Switch technique from `ribbon` → `hand_torch`; observe the derived radius jump (factor 1.375× per PR #42's K table).
4. Save; observe the toast "Re-validated N versions" from PR #40's fan-out.
5. Reload the page; the new values persist.
6. Try entering `0.05` (below range) → input should reject (HTML5 `min` attr) or save attempt should 422 with a friendly error.

## Workflow

1. Backend first: extend `handleUpdateTubeSpec`. Land its tests; verify all five new cases pass and existing tests stay green.
2. Frontend: promote the two read-only fields to editable. Wire the auto-save dirty pattern.
3. Run all four pre-merge checks + manual smoke.
4. Open PR titled "PATCH tube_specs supports wall_thickness + bend_technique (Tier 3 #43)". Body links to `todo.md` Appendix B row 43.
5. **Move this spec** from `specs/active/tier3-43-patch-tube-spec-wall-technique.md` to `specs/done/tier3-43-patch-tube-spec-wall-technique.md`.

## Report back

Under 250 words. Include:

- PR URL
- Implementation summary
- Judgment calls — particularly the technique-validation strategy (whitelist vs free-form-with-warning) and the wall-thickness range bounds
- File-size deltas
- CI final state
- Tier 3 follow-ups worth tracking (e.g. per-glass-type technique presets, a "preferred technique" field on Project so the editor pre-selects it)
