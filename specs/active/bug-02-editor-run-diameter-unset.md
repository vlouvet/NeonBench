# Bug #02 — Drawing-tool runs show "ø ?mm"; per-run diameter not seeded from the project tube spec

> **Status:** active · drafted 2026-06-04 · found via Playwright editor screen-walk · branch (when dispatched) `task/bug-02-run-diameter-default`

## Goal

In the editor's right-sidebar **Runs** list, runs created with the drawing tools render their tube diameter as `ø ?mm` (e.g. "pen-1 … ø ?mm", "arc-1 … ø ?mm") even though the project has a tube spec selected (15mm clear → Ø15mm). The `?` is confusing and the persisted design doc carries no diameter for these runs.

"Done" means a run created by a drawing tool shows the project's diameter (e.g. `ø 15mm`) instead of `?`, and the saved doc reflects that diameter.

## Root cause (code-verified)

- The sidebar prints `ø {run.tube_diameter_mm ?? '?'}mm` at [`web/src/pages/EditorPage.tsx:1630`](../../web/src/pages/EditorPage.tsx#L1630) — `?` shows when the field is absent.
- Drawing tools create runs **without** `tube_diameter_mm`: `commitShape()` ([EditorPage.tsx:1080–1092](../../web/src/pages/EditorPage.tsx#L1080)) and `insertHersheyText()` ([EditorPage.tsx:1098–1115](../../web/src/pages/EditorPage.tsx#L1098)) build the `DesignRun` with no diameter; `ops.appendRuns` ([docOps.ts](../../web/src/lib/docOps.ts)) doesn't default it either.
- Contrast: the SVG-import / vectorize path **does** seed it — `FromSVG(svgData, spec.DiameterMM)` sets `TubeDiameterMM` on every run ([internal/designdoc/convert.go:20–40](../../internal/designdoc/convert.go#L20)). The drawing-tool path was never given the same defaulting.

## Impact (important — keep scope honest)

Validation is **not** broken: the bend-radius validator treats a 0/absent per-run diameter as "use the project tube spec," so warnings are still computed against the project diameter (see [internal/validate/geometry.go](../../internal/validate/geometry.go)). The visible problems are: (1) the confusing `?` in the UI, (2) the persisted doc is inconsistent (some runs carry a diameter, drawing-tool runs don't), and (3) the SVG thumbnail / `data-tube-diameter-mm` attr is omitted for these runs. So this is a **cosmetic + data-consistency** fix, not a validation correctness fix — don't overclaim it in the PR.

## The model: per-run override vs project default

`Run.TubeDiameterMM` ([internal/designdoc/types.go:87](../../internal/designdoc/types.go#L87)) is an **override**; absent means "inherit the project tube spec." Two valid designs:
- **Option A (recommended): seed at creation.** In `commitShape()` and `insertHersheyText()`, set `tube_diameter_mm: tubeSpec?.diameter_mm` on each new run. The doc becomes explicit and the `?` never appears. Risk: if the user later changes the project tube spec, these runs keep the old explicit value (they're now overrides) — acceptable, and the existing per-run diameter editor lets them change it.
- **Option B: default at render only.** Change the display to `run.tube_diameter_mm ?? tubeSpec?.diameter_mm ?? '?'`. Hides the `?` but leaves the doc inconsistent and the SVG attr still omitted. Weaker.

Confirm A vs B with the user if the "override freezes on spec change" behavior matters; otherwise implement A.

## Strict file scope

**Modify:**
- `web/src/pages/EditorPage.tsx` — seed `tube_diameter_mm` from the active tube spec in `commitShape()` and `insertHersheyText()`. ⚠️ EditorPage.tsx is a file-coupling hazard (755 lines); keep the change minimal and coordinate with any open `task/*` branch touching it.

**Don't touch:**
- The vectorize/import path (`convert.go FromSVG`) — already correct.
- The validator — its project-spec fallback is correct and intended.
- The per-run diameter editor ([EditorPage.tsx:1675–1688](../../web/src/pages/EditorPage.tsx#L1675)) — still the way to override.

## Tests

- vitest on the doc-op / shape-commit path: assert a run created via the drawing-tool helper carries `tube_diameter_mm` equal to the active tube spec's diameter (not undefined).
- Guard: a run created with an explicit override is left untouched.

## Manual smoke test

1. App on :7373, open a project's editor. Draw a pen run and an arc.
2. The Runs sidebar must show `ø 15mm` (the project diameter), not `ø ?mm`.
3. Save a version; reload — the diameter persists.
4. Insert Hershey text; its runs also show the project diameter.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Confirm Option A vs B if needed; implement in EditorPage.tsx; add the vitest.
2. Manual smoke test.
3. Move this spec to `specs/done/`.
4. PR title: `Seed per-run tube diameter from project spec on drawing-tool runs (Bug #02)`.

## Report back

Under 150 words: PR URL, option chosen, test name, confirmation the sidebar shows the project diameter, pre-merge state.
