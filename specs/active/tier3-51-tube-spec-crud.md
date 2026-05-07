# Tier 3 #51 — Tube-spec CRUD: POST + DELETE + storage helper extraction

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/51-tube-spec-crud`

## Goal

PR #40 added `PATCH /api/tube_specs/{id}`. Operators still can't create a new tube spec or delete an obsolete one without manual SQL — tube specs are seeded at first launch (8/10/12/15 mm soft soda-lime ribbon) and that's the universe. New shops with a custom diameter or different glass have to fork the binary.

This row adds:
1. `POST /api/tube_specs` — create a new spec
2. `DELETE /api/tube_specs/{id}` — delete an unused spec (refuse if any project references it; status 409)
3. `storage.UpdateTubeSpec` — extract the inline UPDATE SQL from #40's handler into a proper storage method, matching the existing `UpdateProject` shape. (PR #40 deliberately inlined the SQL to keep scope tight; it's time to lift it.)
4. Frontend: a small "+ New tube spec" button next to the dropdown on `ProjectDetail`, and a delete-with-confirm action on each spec row in a (new) tube-spec management view OR inline next to the existing dropdown.

"Done" means: a shop can manage its tube spec library entirely from the UI; the storage layer matches the project-CRUD pattern; deletion is safe (referencing-project guard); existing PATCH callers and seeded specs work unchanged.

## Branch + setup

```sh
git fetch origin
git checkout -b task/51-tube-spec-crud origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/storage/tube_specs.go` — extract `UpdateTubeSpec(ctx, db, spec) error` (currently inline in `handlers_tube_specs.go`); add `CreateTubeSpec(ctx, db, spec) (id string, err error)` and `DeleteTubeSpec(ctx, db, id) error`. Match the existing `UpdateProject` / `CreateProject` shape.
- `internal/server/handlers_tube_specs.go` — add `handleCreateTubeSpec` and `handleDeleteTubeSpec`; refactor `handleUpdateTubeSpec` to call `storage.UpdateTubeSpec` instead of inline SQL.
- `internal/server/api.go` — register `POST /api/tube_specs` and `DELETE /api/tube_specs/{id}` routes (line-append, no conflict with parallel work).
- `internal/server/integration_test.go` — tests for create, delete-while-unused, delete-while-referenced (409), full CRUD round-trip.
- `web/src/api.ts` — add `createTubeSpec(spec)` and `deleteTubeSpec(id)` clients.
- `web/src/pages/ProjectDetail.tsx` — "+ New" button next to the spec dropdown opens a small inline form; "Delete" button on the editor when no projects (other than the current one's `prevID` save state) reference the spec; otherwise disabled with tooltip "in use by N projects".

**Don't touch:**

- `internal/storage/migrations/` — no schema changes.
- `internal/validate/*` — unrelated.
- `EditorCanvas.tsx`, `EditorPage.tsx`, `ProjectList.tsx` — unrelated.
- Other handlers.

**New:** none.

## Deliverables

1. **Create**: validate name uniqueness (case-insensitive) within tube specs; validate diameter > 0; require `name`, `diameter_mm`, `dimensions_in`. Other fields optional (default to NULL or to derivation defaults at validate time). Return the created spec with its server-assigned ID.
2. **Delete**: 409 if any project references the spec; otherwise 204. Refusing with a project-count-and-names list in the response body lets the UI tell the user which projects to migrate first.
3. **Storage extraction**: `UpdateTubeSpec(ctx, db, spec) error` mirrors `UpdateProject`. The handler becomes a thin parser + delegate.
4. **Frontend create form**: tiny inline form (name + dimensions_in + diameter_mm + min_bend_radius_mm). Submit calls `createTubeSpec`; on success the spec dropdown re-fetches and selects the new one.
5. **Frontend delete**: visible only on tube specs not referenced by other projects. The current project's reference doesn't count if the user is about to switch the project to a different spec — but for V1, just match the backend's strict "any-reference blocks" rule and let the user do the switch first.

## Constraints

- **No new third-party deps.**
- **Schema unchanged** — both new endpoints just CRUD against the existing `tube_specs` table.
- **Seeded-spec deletion** is allowed if no project uses it. We don't pin the seeds. The seeding code re-creates them on a fresh DB anyway.
- **No fan-out on create** — newly created specs have no design versions to revalidate.
- **No fan-out on delete** — by definition there are no dependent projects.
- **Keep the existing dropdown behavior** — switching the project's tube spec via the dropdown still uses the existing handler.

## Geometry / algorithms

None — pure CRUD plumbing.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestCreateTubeSpec`**: POST a valid body → 201 + ID. GET the dropdown list → contains the new spec.
- **`TestCreateTubeSpecRejectsDuplicateName`**: POST a body with the same name as a seeded spec (case-insensitive) → 409 + clear message.
- **`TestDeleteTubeSpecUnused`**: create a fresh spec; DELETE it → 204; subsequent GET → 404.
- **`TestDeleteTubeSpecReferencedReturns409`**: create a project referencing a seeded spec; DELETE that spec → 409 + body lists the project name(s).
- **`TestUpdateTubeSpecUsesStorageMethod`**: existing PATCH test must still pass after the storage extraction. Add a small assertion that the new `storage.UpdateTubeSpec` is called (e.g. via a test seam OR by inspecting the SQL — but cleanest: just confirm the existing tests are green; trust the structural refactor).
- **`TestTubeSpecCRUDRoundTrip`**: create → patch → delete → re-create same name (now allowed since the prior was deleted). Confirms the delete actually removed the row.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open ProjectDetail. Click "+ New tube spec"; fill the inline form.
2. Save; the dropdown gains the new entry; the project switches to it.
3. Try to delete a seeded spec via API directly with at least one project referencing it → 409.
4. Switch the project off that spec; delete should succeed.

## Workflow

1. Storage extraction first: `UpdateTubeSpec` extraction + `CreateTubeSpec` + `DeleteTubeSpec`. Tests at the storage layer are nice-to-have; the integration tests will cover the path.
2. Handlers: refactor `handleUpdateTubeSpec`; add `handleCreateTubeSpec` and `handleDeleteTubeSpec`. Wire routes in `api.go`.
3. Integration tests; verify all six pass.
4. Frontend: API clients + inline form + delete button.
5. Pre-merge checks; manual smoke.
6. Open PR titled "Tube-spec CRUD: POST + DELETE + storage extraction (Tier 3 #51)".
7. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially the case-insensitive uniqueness rule and the in-use-blocks-delete rule), file-size deltas, CI state, follow-ups (e.g. allowing seeded specs to be re-created from a "Reset to defaults" button if the user accidentally deletes them all; bulk import of tube specs from a CSV).
