# Tier 3 #18 — Fan tube-spec change to revalidate every design version

> **Status:** active · started 2026-05-07 · branch `task/18-fan-revalidate`

## Goal

PR #6 added auto-revalidate-on-tube-spec-change for the **currently-loaded** design version. Older versions in the project's history list keep their stale `validation_report_json` until someone manually clicks Re-validate on each one.

When a user edits a tube spec (diameter, min bend radius, max segment, min spacing), every design version that uses that spec should have its validation report refreshed server-side, not just the active one. The backend already exposes `handleRevalidate` and `storage.UpdateDesignVersionReport`; this is fan-out + UI signaling, not a new validation rule.

"Done" means: editing any tube-spec field re-runs validation across every affected design version atomically; the editor surfaces a transient "revalidating N versions…" hint while the fan-out is in flight; older versions in the version history reflect new errors/warnings without requiring a manual click; everything is reversible (the tube spec edit and the report writes are one tx, or each version is updated independently with progress reporting on partial failure — pick one and document why).

## Branch + setup

```sh
git fetch origin
git checkout -b task/18-fan-revalidate origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/server/handlers_tube_specs.go` — after a successful tube-spec UPDATE, call a new helper `revalidateAllForTubeSpec(ctx, db, tubeSpecID)` that finds every design version belonging to a project that uses this tube spec, re-runs validation on each, and updates `validation_report_json`. Return a summary in the response body so the frontend can show progress: `{ tube_spec: ..., revalidated: { project_count: N, version_count: M } }`.
- `internal/server/handlers_vectorize.go` — extract the per-version validation logic from `handleRevalidate` into a reusable function (e.g. `revalidateOne(ctx, db, designVersionID) error`) so the tube-spec fan-out can call it without duplicating the marshal/unmarshal dance. `handleRevalidate` itself becomes a thin wrapper.
- `internal/server/integration_test.go` — add a test that creates two projects sharing a tube spec, each with multiple design versions, mutates the spec, and asserts every version's `validation_report_json` was rewritten with a fresher `generated_at` timestamp.
- `web/src/api.ts` — extend the `updateTubeSpec` return type to include the new `revalidated` summary block.
- `web/src/pages/ProjectDetail.tsx` (or wherever the tube-spec dropdown's onChange lives — search for `updateTubeSpec` callers) — when the response includes a `revalidated.version_count > 0`, show a transient toast/banner ("Re-validated 12 versions across 3 projects"). Auto-dismiss after 4s.

**Don't touch:**

- `internal/validate/` — no rule changes.
- `internal/storage/` — no schema changes.
- `EditorCanvas.tsx`, `EditorPage.tsx` — high-coupling files; this fan-out is server-side, no editor changes needed.
- Migrations — none.

**New:**

- None — keep the helpers in their existing handler files.

## Deliverables

1. **Server-side fan-out helper** `revalidateAllForTubeSpec(ctx, db, tubeSpecID)`:
   - Query: `SELECT id FROM design_versions WHERE project_id IN (SELECT id FROM projects WHERE tube_spec_id = ?)`.
   - For each version id, call `revalidateOne`.
   - Return `(projectCount int, versionCount int, err error)`. On a per-version error, log + continue (don't fail the entire fan-out for one bad version — partial success is better than total revert here, since the user's primary action was the tube-spec edit).
2. **`revalidateOne(ctx, db, vid)` helper** — extract from `handleRevalidate`. Loads the version, parses the doc/SVG, runs validate, writes the report. Returns `error`.
3. **Updated `handleUpdateTubeSpec`** (or whatever the existing handler is named) — after the spec UPDATE commits, call the fan-out and include `{ revalidated: { project_count, version_count } }` in the response.
4. **Frontend toast** — when the user changes a tube-spec field and the response carries `revalidated.version_count > 0`, surface a transient banner. Use the existing toast/error pattern if there is one; otherwise a `<p className="meta">` that auto-clears with a `setTimeout`.
5. **Integration test** in `internal/server/integration_test.go` covering the multi-project / multi-version fan-out.

## Constraints

- **Per-version errors don't roll back the spec change.** The tube-spec edit is the user's primary intent; partial validation failure is logged and surfaced in the response (consider adding `failed_count` if you want; otherwise just count successes).
- **No new endpoint.** Reuse `PUT /api/tube_specs/{id}` (or whatever the existing route is); change is internal.
- **No goroutine fan-out to workers.** Synchronous loop in the request handler is fine — neon shops have tens of design versions per project, and validation is millisecond-scale. If a project ever balloons past 10k versions, fix that then.
- **Idempotent** — calling the fan-out twice produces the same result.
- **Don't change the validation rule set.** This is plumbing, not a rule change.

## Geometry / algorithms

None — this is fan-out + UI signaling.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestUpdateTubeSpecFansOutRevalidation`**:
  1. Seed: tube spec X, two projects P1/P2 both using X.
  2. Each project has 2 design versions (use the existing test helper to create them via the vectorize endpoint).
  3. Capture each version's `validation_report_json.generated_at`.
  4. PATCH the tube spec (e.g. tighten `min_bend_radius_mm`).
  5. Assert response body `revalidated.project_count == 2` and `revalidated.version_count == 4`.
  6. Re-fetch each version; assert each `generated_at` is strictly newer than what was captured.
- **`TestUpdateTubeSpecPartialFailureLogsButContinues`**: deliberately corrupt one version's `design_doc` (or SVG) so its revalidation errors. Assert the spec UPDATE still succeeds, the fan-out still completes for the other versions, and the response either carries a `failed_count` or simply reports the lower `version_count`.

Existing `handleRevalidate` tests must keep passing.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open a project with 3+ design versions; note each version's report (errors/warnings count).
2. Edit the project's tube spec to a tighter min_bend_radius. Save.
3. Toast appears: "Re-validated N versions across M projects."
4. Switch to an older version in the history list — confirm its validation badges reflect the new spec, no manual Re-validate click required.

## Workflow

1. Backend: extract `revalidateOne`, add `revalidateAllForTubeSpec`, wire into the tube-spec update handler. Land tests.
2. Frontend: extend the API client type and surface the toast.
3. Run all four pre-merge checks + the manual smoke.
4. Open PR titled "Fan tube-spec change to revalidate all versions (Tier 3 #18)".
5. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Include: PR URL, partial-failure decision (silent log vs. `failed_count` in response), measured fan-out latency on a project with 10+ versions, CI state, follow-ups (websocket-style live progress for huge projects, background queue if needed).
