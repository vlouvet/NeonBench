# Tier 3 #80 — AI / EPS / SVG vector-graphics export

> **Status:** active · drafted 2026-05-09 · branch `task/3-vector-graphics-export` · NW parity (export-as: AI / EPS / DXF)

## Goal

NW exports the layout in three vector formats: AI, EPS, DXF. NeonBench has DXF (PR #12 + #94 with annotation layers) and PDF (full pattern with bend list). It does NOT have:

- **SVG** export of the design (the source SVG is preserved if the project started from one, but a freshly drawn-from-scratch design has no SVG roundtrip).
- **EPS** (encapsulated PostScript) export.
- **AI** (Adobe Illustrator native) export.

Most shop integrations want SVG (web-friendly, every modern editor opens it). EPS is legacy graphic-design-suite. AI is Illustrator's native binary format and historically requires a closed-format library.

"Done" means: the most useful format (SVG) ships fully; EPS ships as a thin PostScript-emitting layer over the same path data; AI export is a no-op stub that emits the same content as the EPS file with an `.ai` extension (modern Illustrator opens .ai files that are actually EPS — the format converged).

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-vector-graphics-export origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**New:**

- `internal/printsvg/svg.go` — SVG emitter. One `<svg>` root with mm units (`viewBox` matches the design bbox in mm; `width` + `height` in `mm`). Per-run `<g>` with class `run-<id>` for filterable selection. Polylines as `<polyline>` (or `<path>` if arc segments land via Tier 3 #78). Annotations rendered as small SVG marker elements. Layer naming mirrors the DXF convention from PR #94.
- `internal/printsvg/svg_test.go` — golden-byte tests across electrodeless / electrode / annotation / blockout cases.
- `internal/printeps/eps.go` — EPS emitter wrapping the same path data. Standard EPS header + bounding box + PostScript drawing commands. Less rich than SVG (no per-run grouping; PS is procedural). Sufficient for round-trip into Illustrator/CorelDraw.
- `internal/printeps/eps_test.go` — golden bytes.
- `internal/server/handlers_export.go` — three new endpoints: `GET /export.svg?project_id=N&version_id=M&mirror=0`, `/export.eps?...`, `/export.ai?...` (.ai is the EPS bytes with the .ai extension and content-type `application/postscript`).

**Modify:**

- `web/src/api.ts` — `exportSVGURL(projectId, versionId, opts?)`, `exportEPSURL(...)`, `exportAIURL(...)`.
- `web/src/pages/ProjectDetail.tsx` — extend the existing export buttons row (next to "Export bundle") with a small "Export as…" dropdown listing DXF, SVG, EPS, AI. Each is a `<a download>` link.
- `web/src/api.test.ts` — pin URL output across the new helpers.

**Don't touch:**

- DXF export (already shipped; this PR only adds the new formats).
- The print-PDF path (PDF stays the human-readable pattern; the new exports are CAM-importable formats).
- Bundles (.neonbench archive is unchanged).

## Deliverables

1. **SVG export** — full design, mm-units, per-run grouping, annotations + blockouts emitted on dedicated layers via SVG `<g class="...">` (CSS-stylable downstream). Honor the `?mirror=0` param from Tier 2 #73 for symmetry with PDF.
2. **EPS export** — PostScript emitter over the same path data. Single drawing context; less rich than SVG but standard EPS that Illustrator opens.
3. **AI export** — emit the EPS bytes with `.ai` extension and the right content-type. A 1-line wrapper over the EPS handler. Modern Illustrator (CS+) opens this without complaint.
4. **Frontend** — single "Export as…" dropdown next to "Export bundle." Each option produces a download.
5. **Tests** — golden bytes for each format on the same 3-run fixture.

## Constraints

- **No third-party Go dependencies.** EPS is plain text; SVG is plain text; we don't need a PDF/PS library.
- **No real AI native format.** AI's true binary format is closed; our `.ai` is EPS-with-different-extension. Document the limitation in the format-picker dropdown's tooltip ("AI: EPS-compatible export").
- **No layered EPS.** PostScript doesn't have native layers (you can simulate via separations but it's not portable). Operators wanting layers use SVG.
- **No raster fallback.** All three formats are vector-only.

## Tests

Manual smoke:

1. Click "Export as…" → SVG. Open the file in a browser → renders correctly. Open in Inkscape → opens, layers visible.
2. Same for EPS — open in Illustrator (or `gs` from command line) → renders correctly.
3. Same for AI — open in Illustrator → renders correctly.
4. Round-trip a complex design (3-letter sign with electrodes + blockouts + jumps) through each format; verify nothing visually disappears.

## Pre-merge

Standard four. Plus `go test ./internal/printsvg/... ./internal/printeps/...`.

## Workflow

1. SVG emitter + golden tests (richest format; drives the design).
2. EPS emitter + golden tests.
3. AI handler (tiny wrapper).
4. Server endpoints + URL helpers + URL tests.
5. ProjectDetail dropdown.
6. Pre-merge + smoke.
7. PR titled `SVG / EPS / AI export (Tier 3 #80)`.

## Report back

Under 250 words. PR URL, the SVG layer-naming convention chosen (per-run vs per-kind), EPS bounding-box derivation (bbox or per-page), the .ai content-type tradeoff, CI state, follow-ups.

## Follow-ups

- True AI native format (would require a real PDF+streams library; very low value).
- SVG with embedded bitmap thumbnail for design review.
- Per-kind SVG layer flag (export only blockouts, only annotations, etc. — symmetric with the DXF strict-mode toggle from PR #94).
- PostScript Level 3 EPS for higher-fidelity gradient/transparency support (low value for line-art neon patterns).
