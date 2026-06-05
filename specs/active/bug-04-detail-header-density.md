# Bug #04 — Project-detail header crams tube-spec + gap controls into dense inline rows

> **Status:** active · drafted 2026-06-04 · found via Playwright screen-walk (screen-02 ProjectDetail) · **needs product/design judgment** · branch (when dispatched) `task/bug-04-detail-header-layout`

## Goal

The project-detail header packs a lot of controls onto tight inline rows separated by `·` dots: the tube-spec `<select>`, **+ New tube spec**, **Delete spec**, **Edit spec**, then **Tube end gap (mm)**, **Channel letter depth (mm)**, **Strip overlap (mm)**, the **Strict mode** checkbox, plus `Units · Created …`, and below that Customer / Designer / Due date / Job number. It reads as a dense wall of controls and is hard to scan. This spec is a **readability/layout polish**, not a functional bug — nothing is broken.

"Done" means the header groups related controls so the page is scannable, without removing any control or changing behavior.

## Why this is judgment-gated

There's no single correct layout, and the dot-separated inline style is a deliberate compact choice. **Before implementing, get the user's preferred direction** — don't auto-pick. Options to present:
- **A — group into labeled sections:** "Tube spec" (select + new/delete/edit), "Defaults" (end gap, channel depth, strip overlap, strict mode), "Job info" (customer/designer/due/job#). Stacked, each with a small heading.
- **B — collapse advanced controls:** keep the spec select + job info visible; tuck end-gap / channel-depth / strip-overlap / strict-mode behind a "Production defaults ▸" disclosure that's collapsed by default.
- **C — minimal:** just add spacing/visual grouping (whitespace, subtle dividers) to the existing inline layout without restructuring.

Recommend **B** (most controls are rarely-touched defaults) but defer to the user.

## Strict file scope

**Modify (CSS-first; minimal TSX only if a disclosure is added):**
- `web/src/pages/ProjectDetail.tsx` — the header JSX (the block rendering tube-spec controls + the `ProjectMetaField` buttons). ⚠️ Coordinate; this page is moderately trafficked.
- The associated CSS (App.css or a ProjectDetail-scoped block).

**Don't touch:**
- The underlying handlers / API calls — purely presentational.
- The tube-spec / metadata edit semantics.

## Constraints

- No control may be removed or made harder to reach than ~1 extra click (if a disclosure is used, the user OK'd it).
- No schema or API changes.
- Keep it responsive — the header already wraps; don't introduce horizontal scroll.

## Tests

No automated layout tests in this project. Manual only.

## Manual smoke test

1. App on :7373, open a project with a tube spec and some metadata set.
2. Header reads as grouped/scannable; every prior control is still present and functional (change tube spec, edit a gap value, toggle strict mode, edit customer/job#).
3. Check 1280px and 1920px widths — no overflow, no horizontal scroll.
4. `@media print` still hides chrome correctly.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. **Confirm direction (A/B/C) with the user first.**
2. Implement; manual smoke test at two widths.
3. Move this spec to `specs/done/`.
4. PR title: `Tidy project-detail header layout (Bug #04)`.

## Report back

Under 150 words: PR URL, which option was chosen, before/after screenshot, confirmation all controls remain reachable, pre-merge state.
