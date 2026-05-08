# Tier 1 #64 — Validation report `issues: null` crashes the editor

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/1-validate-null-issues`

## Goal

`validate.ValidateSVG` builds the `Issues` slice with `issues := append([]Issue(nil), parseIssues...)`. When `parseIssues` is empty (the common case — a blank design or any design with zero rule violations), `append([]Issue(nil), …)` returns `nil`. Each subsequent `append(issues, check…(...)...)` of an empty slice preserves nil-ness. Go's `encoding/json` marshals a nil slice as JSON `null`, so the API returns `{"issues": null, …}`.

The frontend's `ValidationReport` type promises `issues: ValidationIssue[]`, and every consumer (`ValidationBadge`, `ValidationReportView`, `EditorPage`'s `visibleIssueIndices` useMemo, the canvas marker overlay) reads `.length` / `.filter(...)` unconditionally. Result: clicking **New blank design** instantly throws `TypeError: A.issues is null` and the editor never renders. Worse, any design version persisted while the bug was live has the bad JSON written into `appdata/<...>/neonbench.db` (`design_versions.validation_report_json`), so reopening those projects also crashes — even after the source fix.

"Done" means:

1. Fresh validations (live `POST /api/projects/{id}/validate_doc` and version-create) always return `issues: []` for empty results, never `null`.
2. The frontend recovers gracefully when reading a persisted report whose `issues` field is `null` (legacy DB rows from before the fix). No DB migration — the normalization happens at the JSON-parse boundary, the row stays as-is.
3. A regression test pins the JSON shape so this can't silently slip back.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-validate-null-issues origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/validate/validate.go` — change the `issues` initialization on line ~16 so it starts as a non-nil empty slice. The simplest form: `issues := make([]Issue, 0, len(parseIssues)); issues = append(issues, parseIssues...)`. All downstream `append(issues, ...)` calls then preserve non-nil-ness automatically. Add a one-line comment explaining *why* (the JSON-shape contract with the frontend), not *what*.
- `web/src/api.ts` — add a private `normalizeReport(r)` helper near the existing `parseReport` definition. The helper coerces `r.issues == null` → `[]` and returns `r`. Apply it in two spots:
  - Inside `parseReport`'s try-block, wrap the `JSON.parse(...) as ValidationReport`.
  - On the `api.validateDoc(...)` chain, append `.then(normalizeReport)` to the returned promise.
- `internal/validate/validate_test.go` (new file IF this package has no existing test for the JSON shape — check first; if there's already a `*_test.go` with marshal coverage, add to it instead) — pin the empty-result shape.

**Don't touch:**

- Any consumer of `ValidationReport` (EditorPage, ValidationReportView, EditorCanvas, PrintPanel, etc.) — the contract becomes "issues is always an array" so consumers don't need defensive checks.
- The DB schema or any migration. Persisted rows with `null` get rewritten lazily on next save; the frontend normalizer covers them in the meantime.
- `internal/validate/types.go` — the struct tag stays `json:"issues"`. We're not switching to `json:"issues,omitempty"` (that would emit no field at all for empty results, which the frontend would also have to handle).
- `internal/server/handlers_designdoc.go` / `handlers_vectorize.go` — the bug is upstream of these handlers; they call `validate.ValidateSVG` and forward the report.

**New:**

- `internal/validate/validate_test.go` (only if no equivalent test file exists yet)

## Deliverables

1. **Source fix.** Replace the `append([]Issue(nil), parseIssues...)` line so `issues` is non-nil on the empty path.
2. **Boundary defense.** `web/src/api.ts` normalizes `issues == null` → `[]` at both reader sites so any legacy DB row also loads without crashing.
3. **Go regression test.** Marshal an empty-input result and assert the JSON contains `"issues":[]`, NOT `"issues":null`. Suggested form:
   ```go
   func TestValidateSVGEmptyIssuesMarshalAsArray(t *testing.T) {
       blankSVG := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500" viewBox="0 0 1000 500"></svg>`)
       report, err := validate.ValidateSVG(blankSVG, validate.Limits{DiameterMM: 12, MinBendRadiusMM: 27})
       if err != nil { t.Fatal(err) }
       data, err := json.Marshal(report)
       if err != nil { t.Fatal(err) }
       if !bytes.Contains(data, []byte(`"issues":[]`)) {
           t.Fatalf("empty report must marshal issues as []; got %s", data)
       }
   }
   ```
4. **(Optional) Frontend test for `normalizeReport`.** If `web/src/api.test.ts` already exists, add a two-case test (null → []; existing array → unchanged). Skip if no test file exists — don't bring in a new test harness for one helper.

## Constraints

- **No DB migration.** Touching `appdata/*.db` is out of bounds per CLAUDE.md.
- **No new dependencies** (Go or npm).
- **Don't change the JSON tag** on `Issues` to `omitempty` — the contract stays "always present, always an array".
- **Don't add defensive null checks at every consumer site.** That hides the contract; the boundary normalization in `api.ts` is the single defense point.
- **Don't widen the fix.** Other slices on `Report` (none today, but if any get added) are out of scope — only `Issues` is the documented bug.

## Tests

- Go: the new `TestValidateSVGEmptyIssuesMarshalAsArray` above. Existing `internal/validate/rules_test.go` should keep passing without changes.
- Manual smoke: with a *fresh* `dist/neonbench-darwin-arm64`, click **New blank design** on a project with no source file. The editor must mount cleanly, the validation badge must read `All rules pass · 0 runs · 0.00m total tube`, and the sidebar must show `No validation issues. Send to printer when ready.`
- Manual smoke (legacy data path): with a DB containing a design version whose `validation_report_json` has `"issues": null` (you can fabricate one with `sqlite3 appdata/.../neonbench.db "UPDATE design_versions SET validation_report_json = json_set(validation_report_json, '\$.issues', null) WHERE id = …"`), reopen that version. Editor mounts cleanly with zero issues; saving from there rewrites the row with `"issues": []`.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Add the Go regression test first; confirm it fails on the current `validate.go` (proves the bug is captured).
2. Apply the `validate.go` source fix; rerun the Go tests until green.
3. Apply the `api.ts` normalizer; rebuild the frontend bundle; rebuild the binary (`scripts/build.sh` or a single-target `go build`).
4. Both manual smoke tests above.
5. Pre-merge checks all green.
6. Open PR titled `Fix validation report null issues regression (Tier 1 #64)`.
7. **Move this spec** from `specs/active/` to `specs/done/` as part of the implementation commit.

## Report back

Under 200 words. Include:

- PR URL
- Whether the new Go test was added to a fresh file or an existing one
- Confirmation both manual smoke paths render cleanly
- Whether any other consumers of `ValidationReport` were found that would also benefit from the contract guarantee (the spec says don't add per-site checks, but if a consumer was *already* doing a defensive `?.issues ?? []`, flag it as a Tier 3 cleanup follow-up — those guards become dead code under the new contract)
- Pre-merge check final state
