# Bug #05 — Cannot rename/relabel an existing design version

> **Status:** active · drafted 2026-06-04 · found via Playwright screen-walk (screen-02 ProjectDetail) · small enhancement · branch (when dispatched) `task/bug-05-version-relabel`

## Goal

A design version's label can only be set **at save time** via the "New version label" input in the editor. Once saved, there is **no way to rename or add a label** to an existing version — which is why a project can accumulate many "(no label)" versions (e.g. project 8 has 15). "Done" means a user can edit an existing version's label from the project-detail version list.

## Root cause (code-verified)

- Label is set only on create: editor input + `api.saveDesignVersion()` POST ([web/src/pages/EditorPage.tsx:1894](../../web/src/pages/EditorPage.tsx#L1894), [api.ts:568](../../web/src/api.ts#L568)).
- The detail version list ([web/src/pages/ProjectDetail.tsx:636–664](../../web/src/pages/ProjectDetail.tsx#L636)) renders `{v.label || '(no label)'}` read-only — only Delete and 3D-preview controls, no edit affordance.
- Backend has **no update route**: [internal/server/api.go:31–44](../../internal/server/api.go#L31) exposes POST (create), GET, DELETE, POST validate — no PATCH/PUT for a version. Storage has `UpdateDesignVersionReport()` but **no** `UpdateDesignVersionLabel()` ([internal/storage/design_versions.go](../../internal/storage/design_versions.go)).
- The `label` column already exists and is mutable (TEXT, nullable) — [migrations/0002_phase1_schema.sql](../../internal/storage/migrations/0002_phase1_schema.sql). **No migration needed.**

## Strict file scope

**Backend — new (additive, line-append friendly):**
- `internal/storage/design_versions.go` — add `UpdateDesignVersionLabel(ctx, db, id, label)` → `UPDATE design_versions SET label = NULLIF(?, '') WHERE id = ?` (empty string clears the label).
- `internal/server/api.go` + the design-version handler file — add `PATCH /api/projects/{id}/design_versions/{vid}` accepting `{ "label": "..." }`. Validate the version belongs to the project. (Adding a route is usually conflict-free.)

**Frontend:**
- `web/src/api.ts` — add `updateDesignVersionLabel(projectId, versionId, label)`.
- `web/src/pages/ProjectDetail.tsx` — inline edit affordance on each version row (small "rename" button → text input, or click-to-edit), mirroring the existing `ProjectMetaField` pattern used for customer/designer.

**Don't touch:**
- The schema (column exists).
- The editor save flow (still the way to set a label on create).

## Constraints

- Additive only — no schema change, no behavior change to create/delete.
- PATCH must be idempotent; empty label clears to NULL (renders "(no label)").
- Keep the API shape consistent with existing handlers (JSON body, same error envelope, project-ownership check).

## Tests

- **Go:** storage test for `UpdateDesignVersionLabel` (set, then clear via empty string); handler test for `PATCH …/design_versions/{vid}` happy path + 404 when the version isn't in the project.
- **Frontend (optional):** a small test that the api client sends the PATCH; or rely on manual.

## Manual smoke test

1. App on :7373, open a project with "(no label)" versions.
2. Rename a version → label updates in the list immediately and after reload.
3. Clear a label → shows "(no label)".
4. Confirm a version from another project can't be relabeled through this project's endpoint (404).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Backend: storage fn + PATCH route + tests.
2. Frontend: api client + inline edit UI.
3. Manual smoke test.
4. Move this spec to `specs/done/`.
5. PR title: `Allow renaming an existing design version (Bug #05)`.

## Report back

Under 150 words: PR URL, the PATCH endpoint shape, test names, confirmation rename + clear work and round-trip a reload, pre-merge state.
