# Tier 3 #22 — Bundle import: drag-drop + schema-versioned branching

> **Status:** active · started 2026-05-07 · branch `task/22-bundle-import-polish`

## Goal

PR #13 shipped `POST /api/projects/import` behind a hidden file input on the project list. Two follow-ups remain from `todo.md` Appendix B row 22:

1. **Drag-drop import on the project list page** — drop a `.neonbench` file anywhere on `ProjectList` and the existing import flow runs.
2. **Schema-versioned bundle branching** — split the import handler into a dispatcher + a `v1` importer, so when `manifest.schema` eventually bumps past 1 we have a clear place to add a forward-migration. Reject bundles whose schema is newer than this server supports.

"Done" means: dropping a valid bundle works end-to-end (visible drag highlight, success → navigate into the imported project), the existing `Import .neonbench` button keeps working unchanged, future-schema bundles are rejected with a clear error, all existing import tests still pass, and the schema dispatcher is structured so adding a `v2` importer is a one-function change.

This task overlaps with Tier 3 #30 (drag-drop file upload + multi-select). Stay narrow: this PR adds drag-drop **only** for `.neonbench` bundles on `ProjectList`, not for raw images on `ProjectDetail` or any multi-file/multi-select behaviour.

## Branch + setup

```sh
git fetch origin
git checkout -b task/22-bundle-import-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/server/handlers_export.go` — split the existing `handleImportBundle` into:
  - a thin dispatcher that parses the zip + manifest, validates `Bundle == "neonbench"`, and switches on `manifest.Schema`;
  - `importBundleV1(...)` containing every post-validation step that exists today (resolve tube spec, name collision, transaction, version inserts, response).
  Add a `currentBundleSchema = 1` constant. Add an explicit branch for `schema > currentBundleSchema` returning HTTP 422 with an upgrade message. Treat `schema == 0` (missing field) as legacy v1.
- `internal/server/integration_test.go` — add three tests (see Tests). Keep every existing import test untouched.
- `web/src/pages/ProjectList.tsx` — add drag-drop handlers on the top-level `<section>`, a `dragActive` overlay, and a small refactor: extract the import-by-File logic so both the file picker and drop path call it.
- `web/src/index.css` — styles for the new drag-active overlay (a dashed border + dim background tint over the section).

**Don't touch:**

- `internal/server/api.go` — the route registration `POST /api/projects/import` stays as-is. The dispatcher keeps the same handler entry point.
- `internal/server/handlers_projects.go`, `handlers_designdoc.go`, etc. — unrelated handlers.
- `internal/storage/` — no schema or query changes.
- `internal/designdoc/types.go` — schema unchanged.
- `web/src/api.ts` — `api.importBundle(file: File)` already accepts a File; no API client change.
- `web/src/pages/ProjectDetail.tsx`, `EditorPage.tsx`, `EditorCanvas.tsx` — out of scope.
- `web/src/components/` — modal lives elsewhere; do not refactor the New Project modal.
- Migrations — no schema change.

**New:**

- None. The v1 importer stays in `handlers_export.go` as an unexported method on `*apiServer`; the file is ~370 lines today and gains ~30 from the dispatcher split.

## Deliverables

### Backend — schema-versioned dispatcher

1. Define `const currentBundleSchema = 1` at the top of `handlers_export.go` next to the manifest types. Update the export path to reference it (`Schema: currentBundleSchema`) so the constant is the single source of truth.
2. Refactor `handleImportBundle` into a dispatcher that:
   - parses the multipart upload and zip exactly as today;
   - reads the manifest, validates `Bundle == "neonbench"`, and validates the basic non-empty-name + non-empty-versions invariants currently in the handler;
   - decides which importer to call:
     - `manifest.Schema == 0` → treat as `1` (missing-field tolerance; document why in a comment — bundles in the wild always set `schema: 1`, but a hand-crafted manifest without it should still import as legacy v1).
     - `manifest.Schema == 1` → call `importBundleV1(w, r, manifest, files)`.
     - `manifest.Schema > currentBundleSchema` → respond `422 Unprocessable Entity` with `bundle schema N is newer than this NeonBench supports (max M); upgrade to import.`
     - Anything else (negative, weird) → `400 Bad Request` with `invalid bundle schema: N`.
3. `importBundleV1` is a new unexported method on `*apiServer` with signature:
   ```go
   func (s *apiServer) importBundleV1(w http.ResponseWriter, r *http.Request, manifest bundleManifest, files map[string][]byte)
   ```
   Move the existing per-version resolution + transaction + insert loop + response into this method verbatim. The dispatcher does not write any response on the v1 happy path; the importer writes the JSON response itself, mirroring today's behavior.

### Frontend — drag-drop import

4. On `ProjectList`, wrap (or annotate) the top-level `<section>` with `onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop`. Track a counter ref (`dragDepthRef`) — increment on `dragenter`, decrement on `dragleave`, set `dragActive = true` when depth > 0 — so crossing onto a child element doesn't flicker the overlay off. Reset depth to 0 on drop.
5. When `dragActive`, render a positioned overlay inside the section with a dashed border and a centered hint ("Drop a .neonbench bundle to import"). The overlay is `pointer-events: none` so the underlying buttons/links remain clickable when the drag is canceled.
6. On drop:
   - `e.preventDefault()` (otherwise the browser navigates away);
   - take `e.dataTransfer.files[0]`; ignore any additional files with a console hint;
   - validate filename ends in `.neonbench` (case-insensitive) OR mime type is `application/zip`. On mismatch, set the same `error` state used by the existing button path with a clear message ("Drop a .neonbench file. That looked like a .png.").
   - call the new shared `runImport(file)` helper, which contains the existing `setImporting/setError/api.importBundle/listProjects/navigate` flow currently inside `handleImport`.
7. The existing button + hidden file input must keep working. The change is additive: refactor `handleImport` to a thin wrapper around `runImport` so both code paths share the same body.

## Constraints

- **No new third-party deps** — no react-dropzone, no zod, no schema-validation libraries. Plain DOM events + a hand-written switch.
- **Idempotent dispatcher** — the dispatcher must produce byte-identical responses for any valid v1 bundle that imports today. The split is purely structural.
- **No new endpoint, no new route.** `POST /api/projects/import` stays the only ingress.
- **No multipart parser changes.** The existing `r.ParseMultipartForm(maxUploadBytes)` + `FormFile("file")` path is correct; do not touch it.
- **No global document-level drag handlers.** Bind on the section element only. Catching drag events on `window`/`document` will fight with future drag-drop work in the editor.
- **`pointer-events: none` on the overlay is non-negotiable** — without it, releasing the mouse on the overlay's text won't fire `drop` on the section.
- **Don't merge this with Tier 3 #30** (raw-image drag-drop). If you find yourself generalizing into a `<DropZone>` component, stop — keep this scoped to `ProjectList`. The generalization belongs in #30's PR.

## Geometry / algorithms

**Drag-depth counter.** Browsers fire `dragenter` on the parent, then again on each child as the cursor crosses it; without a counter, `dragleave` from the parent fires when the cursor moves onto a child, hiding the overlay mid-drag. Pseudocode:

```ts
const depth = useRef(0);
const [dragActive, setDragActive] = useState(false);

function onDragEnter(e: React.DragEvent) {
  e.preventDefault();
  depth.current += 1;
  if (depth.current === 1) setDragActive(true);
}
function onDragLeave(e: React.DragEvent) {
  depth.current -= 1;
  if (depth.current <= 0) {
    depth.current = 0;
    setDragActive(false);
  }
}
function onDragOver(e: React.DragEvent) {
  e.preventDefault();          // mandatory; otherwise drop is suppressed
  e.dataTransfer.dropEffect = 'copy';
}
function onDrop(e: React.DragEvent) {
  e.preventDefault();
  depth.current = 0;
  setDragActive(false);
  const file = e.dataTransfer.files[0];
  if (!file) return;
  if (!isBundle(file)) {
    setError(`Drop a .neonbench file (got ${file.name}).`);
    return;
  }
  runImport(file);
}
```

**Filename validation.** `name.toLowerCase().endsWith('.neonbench')` is sufficient. Mime-type fallback (`file.type === 'application/zip'`) catches users who renamed `.neonbench` to `.zip`. Don't try to peek the magic bytes — the server already validates the zip.

**Schema dispatcher.** Single `switch`. Use `>` rather than `!= 1` for the upgrade branch so a v3 bundle on a v1 server still gets the upgrade message rather than a generic 400.

## Tests

Add to `internal/server/integration_test.go`. Reuse the existing helper(s) that build a manifest + zip in memory (search for the helper used by `TestImportBundleRejectsMalformed` and pattern-match).

- **`TestImportBundleRejectsFutureSchema`**: build a valid bundle but with `manifest.Schema = 2`. POST → expect `422` with body containing both `"schema"` and `"upgrade"`. The project table must contain zero new rows after the call.
- **`TestImportBundleAcceptsLegacyMissingSchema`**: build a manifest by marshaling a struct that omits the `Schema` field (or set it to 0 via a custom map-based builder). POST → expect `201 Created`. This pins the missing-field tolerance.
- **`TestImportBundleRejectsNegativeSchema`**: `manifest.Schema = -1`. POST → expect `400 Bad Request`.
- Verify all existing import tests (`TestExportImportRoundtrip`, `TestImportBundleCreatesNewTubeSpec`, `TestImportBundleRejectsMalformed`) still pass without modification. The structural refactor must not change observable behavior.

No frontend unit tests (no RTL setup). Manual smoke test below covers the drop-zone.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # advisory; no NEW diagnostics
```

Manual smoke test in a browser:

```sh
( cd web && npm run dev )
```

1. Export a project as `.neonbench` from another project on the same install.
2. Navigate to the project list. Drag the file onto the page — the overlay appears with the dashed border and hint.
3. Drop. The overlay clears, "Importing…" briefly shows on the button, you land on the imported project page.
4. Drag a non-bundle file (any `.png` from disk). Drop. An inline error appears; no import attempt; no navigation.
5. Drag the bundle, then drag back outside the section without dropping. Overlay clears.
6. Click the existing `Import .neonbench` button — must still work identically to today.
7. Round-trip a malformed bundle (manually edit a manifest's schema to `99`, re-zip, drop). Expect a clear inline error mentioning the schema mismatch.

## Workflow

1. Land the backend refactor first: dispatcher + `importBundleV1` + the three new tests. Confirm all existing tests still pass before touching the frontend.
2. Frontend: extract `runImport(file: File)`, then add drop handlers + overlay + CSS. Smoke-test all six manual scenarios.
3. Run all four pre-merge checks.
4. Open PR titled "Bundle import polish: drag-drop + schema dispatch (Tier 3 #22)". Body links to `todo.md` Appendix B row 22.
5. **Move this spec** from `specs/active/tier3-22-bundle-import-polish.md` to `specs/done/tier3-22-bundle-import-polish.md` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary
- Judgment calls — particularly the schema-zero (legacy) handling, and any drop-zone UX choices (overlay placement, where the validation error surfaces, button-vs-drop visual hierarchy).
- File-size deltas on `handlers_export.go` and `ProjectList.tsx`
- CI final state
- Tier 3 follow-ups worth tracking (e.g. drag-drop for raw images on ProjectDetail — that's #30; preview of bundle contents before commit; bundle schema v2 design notes).
