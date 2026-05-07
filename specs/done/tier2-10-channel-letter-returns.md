# Tier 2 #10 — Channel letter return patterns

> **Status:** active · started 2026-05-07 · branch `task/10-channel-letter-returns`

## Goal

A **channel letter** is a 3D U-channel sheet-metal box forming the letter shape, with neon tube inside (Strattman NT Ch.5; Miller p.88). The shop fabricates two pieces per letter:

1. The **face**: flat sheet-metal cut to the letter's silhouette (already representable today as a closed polyline run).
2. The **return**: a strip of metal that wraps around the perimeter of the face, bent up to form the side walls of the box. Length = perimeter of the face. Width = depth of the box (typical 100 mm = 4 inches).

Today NeonBench prints the face outline at 1:1 on the PDF — the shop cuts that. But the return strip has to be drawn separately as an unfolded rectangle with bend marks at every face-polyline vertex, so the operator knows where to bend the strip to make it follow the letter's corners. NeonWizard ships this as a built-in (NW #106). NeonBench doesn't, and adding it closes the only channel-letter-specific gap in the parity matrix.

V1 scope: per-run "this is a channel letter face" flag + project-level default depth + PDF emits one additional page per face-marked run with the unfolded return strip.

## Branch + setup

```sh
git fetch origin
git checkout -B task/10-channel-letter-returns origin/task/10-channel-letter-returns
./scripts/setup-hooks.sh
```

(The parent will pre-push this branch with the spec already on it. Use `-B` to switch to the existing branch instead of creating a fresh one.)

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/designdoc/types.go` — add `IsChannelLetterFace bool` to `Run` struct (with `json:"is_channel_letter_face,omitempty"` tag — the existing pattern for optional booleans on Run)
- `internal/storage/migrations/0007_channel_letter_depth.sql` — new migration adding `channel_letter_depth_mm REAL` column to `projects` (next unused number is 0007 — verify by `ls internal/storage/migrations/`)
- `internal/storage/projects.go` — add `ChannelLetterDepthMM` field to `Project` model (handle `*float64` empty-as-default the same way `TubeEndGapMM` is handled in PR #19; that's the freshest reference)
- `internal/server/handlers_projects.go` — accept the new field in create/update payloads with validation (`>= 10` and `<= 500` mm; reject malformed with 400)
- `internal/server/handlers_print.go` — pass project's depth into `printpdf.Options` so the renderer can emit return strips
- `internal/server/integration_test.go` — extend with a `TestChannelLetterReturnPattern` that creates a project with a depth, posts a design version with a face-marked run, fetches the PDF, asserts the response is non-empty and contains the strip dimensions in the expected ranges (no need to PDF-parse — body length + presence of "Return strip" footer text via `bytes.Contains` is enough)
- `internal/printpdf/render.go` — main work: a new `emitReturnStrip` function called per face-marked run after the existing tile pages, before the bend-list page. See **Geometry** below for what it draws.
- `internal/printpdf/render_test.go` (or whatever the existing test file is — check first; create new file if absent) — unit-test the geometry helpers in isolation
- `web/src/api.ts` — extend `Run` type with `is_channel_letter_face?: boolean`; extend `Project` type with `channel_letter_depth_mm?: number`
- `web/src/pages/EditorPage.tsx` — sidebar checkbox on the selected run: "Channel letter face". Toggling it commits via `editDoc()` so it goes through undo/redo. Visual: a small "[ch]" badge or different border in the run-list row when the flag is set (low-touch — we just need the user to see which runs will get a return-strip page).
- `web/src/pages/ProjectDetail.tsx` — input for the project-level default depth (pattern matches the Tube End Gap input shipped in PR #19, located in the same metadata block; 100 mm placeholder/default)
- `README.md` — one paragraph on channel-letter workflow (mark face runs in the editor, set depth on project, print emits return-strip page per face).

**Don't touch:**

- `web/src/components/EditorCanvas.tsx` — the editor canvas doesn't need to render anything new for this feature; the checkbox lives in `EditorPage.tsx`'s sidebar
- `web/src/components/VectorizePanel.tsx`, `web/src/components/PrintPanel.tsx`, `web/src/components/HersheyTextDialog.tsx`
- `web/src/pages/ProjectList.tsx`
- `internal/printdxf/`, `internal/vectorize/`, `internal/server/api.go` (no new routes — extending existing handlers/payloads)
- `web/src/lib/shapes/`, `web/src/lib/hershey/`, `web/src/lib/docOps.ts`

## Deliverables

### 1. Schema additions (additive only)

**Run-level:** `IsChannelLetterFace bool`. Default `false`. Stored as part of the design-doc JSON (no DB column — design-doc is opaque blob).

**Project-level:** `ChannelLetterDepthMM *float64`. Default 100 mm at render-time when NULL. Migration `0007_channel_letter_depth.sql`:

```sql
-- +goose Up
ALTER TABLE projects ADD COLUMN channel_letter_depth_mm REAL;

-- +goose Down
ALTER TABLE projects DROP COLUMN channel_letter_depth_mm;
```

Mirror the PATCH semantics PR #19 used for `tube_end_gap_mm`: empty-string-on-PATCH means "clear back to default", numeric value means "explicit override".

### 2. Editor UI

In `EditorPage.tsx`'s run-detail sidebar (the area that already has color picker, diameter override, notes), add a checkbox row:

```tsx
<label>
  <input type="checkbox" checked={run.is_channel_letter_face ?? false} onChange={...} />
  Channel letter face
</label>
```

Toggling commits via `editDoc()`. In the run list, runs with the flag set show a small "[ch]" prefix or muted badge — low-touch, just enough for the user to see at a glance.

### 3. Project default depth

In `ProjectDetail.tsx`'s metadata block (same area that has tube spec, units, customer, designer, due date, job number, tube end gap), add:

```
Channel letter depth (mm): [____]   (default 100)
```

Inline-edit pattern, click to edit, Enter/Escape/blur to commit, identical to the Tube End Gap input.

### 4. PDF rendering

For each `Run` where `IsChannelLetterFace == true`, after the existing tile pages and before the bend-list page, emit a **return-strip page**:

- Page setup: same paper size as tile pages, portrait (or landscape if perimeter is large enough that landscape fits more strip without scaling).
- Page header: "Return strip — Run {id}" plus letter cap height in mm if computable (bbox height of the polyline) and total perimeter in mm.
- The strip is a rectangle: width = perimeter of the run's polyline, height = depth (project default or, eventually, per-run override — V1 uses project default only). Drawn at 1:1 if it fits the page; otherwise at the largest scale that fits, with a "scale 1:N" callout in the header.
- **Bend marks:** at each polyline vertex along the strip, draw a vertical tick from one long edge to the other, label with the **cumulative arc length from the start vertex** (in mm) and the **interior turn angle** at that vertex (degrees, signed: positive = bend inward, negative = bend outward). For closed polylines, the start vertex is `polyline.points[0]`; the strip "wraps" at total perimeter back to 0.
- **Operator note** at the bottom of the page: "Bend at each tick. Total length: {perimeter} mm. Add overlap allowance per shop convention."

If a face-marked run's polyline is open (not closed), still emit the strip but add a warning footer: "Note: face polyline is open — return strip will not close. Verify intent."

### 5. README

Add one paragraph in the editor walkthrough or a new "Channel letter workflow" subsection: how to mark a run as face, set project depth, print PDF includes return strips. Keep it tight — one paragraph is enough.

## Constraints

- **No new third-party deps** (Go modules or npm packages). The existing `gofpdf` library handles all PDF needs.
- **No new endpoints** — extending existing payloads.
- **Tube End Gap rendering (PR #19) already added a footer field** — *don't refactor the footer* to accommodate the depth value; just thread `channel_letter_depth_mm` into `printpdf.Options` alongside `TubeEndGapMM` using the same pattern.
- **Don't fix unrelated lint diagnostics** — Tier 3 #25 tracks them.
- **No validation rule** in this PR. The "warn if a face's perimeter exceeds tube blank length" rule belongs to a future Tier 3 row that ties channel-letter physics into the validator.
- This task does NOT touch `EditorCanvas.tsx`. The flag is set via the sidebar, not by clicking on the canvas.

## Geometry / algorithms

### Perimeter

```go
func perimeter(p []Point) float64 {
    total := 0.0
    for i := 0; i < len(p)-1; i++ {
        total += dist(p[i], p[i+1])
    }
    if closed { total += dist(p[len(p)-1], p[0]) }
    return total
}
```

### Cumulative arc length at vertex i

Walk forward summing edge lengths.

### Interior turn angle at vertex i

Vector from `p[i-1]` to `p[i]` (incoming) and `p[i]` to `p[i+1]` (outgoing). Signed angle between them. **Positive = the strip bends "inward"** (toward the face's interior, the typical bend direction for a return). **Negative = "outward"** (concave corners on the silhouette, e.g., the inner corners of an "M").

For closed polylines, vertex 0 also has incoming = `p[n-1] → p[0]` and outgoing = `p[0] → p[1]`.

For the start of an open polyline, no bend mark on `p[0]` (it's the strip's left edge — operator starts there). Same for the end.

### Strip layout

Page-relative origin at top-left of the strip's bounding box. Strip extends to the right by `perimeter` mm and down by `depth` mm. At each cumulative-arc-length offset `s`, draw:

- A vertical tick from y=0 to y=depth on the strip
- Above the tick (centered on x=s, y above the strip): "{s:.1f} mm | {angle:+.0f}°"

If the perimeter exceeds the page's content width at 1:1, scale the strip uniformly to fit. **Always print the actual mm value next to each tick regardless of scale**, so the operator can measure with a ruler against the printed labels rather than relying on the scaled drawing.

## Tests

In `internal/printpdf/render_test.go` (extend or create):

1. **`TestPerimeter`**: a 100×50 closed rectangle has perimeter 300; a 5-vertex zigzag has the expected sum.
2. **`TestInteriorAngles`**: a square's four interior angles are all +90°. A "checkmark" V-shape produces the expected signed angles (one positive, one negative).
3. **`TestEmitReturnStripDimensions`**: emit a return strip for a 100×50 face at 100 mm depth — strip width should be 300 mm, strip height 100 mm; assert by parsing back the gofpdf page size or a deterministic landmark.
4. **`TestEmitReturnStripBendCount`**: a 5-point closed polyline produces 5 ticks. A 5-point open polyline produces 3 ticks (interior vertices only).

In `internal/server/integration_test.go`:

5. **`TestChannelLetterReturnPattern`**: end-to-end. Create a project with `channel_letter_depth_mm = 75`, create a design version where one run has `is_channel_letter_face: true` and another doesn't, fetch the PDF, assert the response body is plausibly larger than a no-face baseline (the additional page adds bytes), and contains "Return strip" via `bytes.Contains`.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )  # advisory; no NEW diagnostics
```

## Workflow

1. **Schema first.** Migration + storage struct + handlers + the round-trip integration test for the new project field. Verify via `goose down` + `goose up` against a fresh DB.
2. **Design-doc field next.** Type addition + JSON round-trip test if there's a designdoc test suite (check first).
3. **PDF rendering.** Geometry helpers + their unit tests, then the new page emission, then the integration test.
4. **Editor UI** + project detail UI.
5. **README** + manual smoke test (`cd web && npm run dev` + `./bin/neonbench --dev` — create a project with depth, mark a run as face, print PDF, verify return strip page renders).
6. **Pre-merge checks** (all four).
7. **Logical commits** (suggested: schema + storage; PDF helpers + tests; PDF page emission + integration test; frontend; README + spec move).
8. **Move the spec** from `specs/active/` to `specs/done/` in your final commit.
9. `git push origin task/10-channel-letter-returns`.
10. Open PR. Title: `Channel letter return patterns (Tier 2 #10)`. Body: WHY (NW #106 parity, only channel-letter-specific gap in the matrix), the V1 scope (face-flag + project-depth + extra PDF page), what's deferred to Tier 3 (per-run depth override, perimeter > blank-length validation), pre-merge checklist.
11. Watch CI; iterate until both `test` and `windows-smoke` are green.

## Report back

Use the format the spec specifies. Under 350 words. Include:

- PR URL
- Implementation summary by area (schema → PDF → editor → project page)
- Geometry helper file sizes + which test cases caught early bugs
- CI final state for both checks
- Judgment calls (e.g., "open polyline gets the strip + warning vs erroring out")
- Tier 3 follow-ups: per-run depth override, perimeter-exceeds-blank-length validation rule, draggable strip-overlap setting, multi-letter raceway groupings, etc.
