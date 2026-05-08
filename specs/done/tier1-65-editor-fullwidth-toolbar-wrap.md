# Tier 1 #65 — Editor wastes horizontal space; toolbar overflows the viewport

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/1-editor-fullwidth-toolbar-wrap`

## Goal

The global `.app` wrapper in `web/src/App.css` caps every page at `max-width: 960px`. That's right for the project list and project detail page (forms + lists read better as a centered column). It's wrong for the editor: the toolbar + canvas + sidebar grid (`grid-template-columns: 1fr 240px`) is squeezed into a 960px column on a 1080p+ screen, leaving 30%+ of the viewport as dead space on either side. Worse, the editor toolbar (`.editor-toolbar`) is a non-wrapping flex row with ~20 buttons; when squeezed below the buttons' natural width, the toolbar overflows the right edge and forces *the entire page* to scroll horizontally, instead of wrapping to a second row.

"Done" means:

1. The editor route uses the full viewport width (with the existing `1.5rem` padding from `.app`); list and detail pages stay capped at 960px.
2. The toolbar wraps to additional rows when its buttons exceed the available width, instead of overflowing.
3. The fix is CSS-only — no React refactor, no new components.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-editor-fullwidth-toolbar-wrap origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/App.css` — two additions:
  1. After the existing `.app { max-width: 960px; … }` block, add `.app:has(.editor-section) { max-width: none; }` with a comment explaining the rationale (forms/lists read better narrow; editor needs every pixel).
  2. On the existing `.editor-toolbar` rule (~line 618), add `flex-wrap: wrap;` so toolbar buttons drop to a new row instead of overflowing.

**Don't touch:**

- `Layout.tsx` — no per-route wrapper switching. The `:has()` selector keeps the layout component agnostic.
- `EditorPage.tsx`, `EditorCanvas.tsx` — no React changes. The bug is purely CSS.
- The grid template on `.editor-layout` — its `1fr 240px` is correct; widening the parent gives the canvas the room it needs.
- Other pages' styles (`.project-list`, `.asset-list`, etc.) — they should stay column-width.

## Deliverables

1. **Editor escapes the column cap** via `.app:has(.editor-section) { max-width: none; }`.
2. **Toolbar wraps** via `flex-wrap: wrap` on `.editor-toolbar`.
3. **Comments** explaining *why* the editor needs full width (and why list/detail pages don't) — one short comment per change.

## Constraints

- **Pure CSS.** No JS, no React, no new components.
- **Don't widen the project list / detail pages.** Those should stay at 960px — they're forms + lists, not canvases.
- **Don't change `.app`'s padding** — `1.5rem` is correct for both narrow and wide use.
- **Don't add a horizontal-scroll fallback.** If the toolbar wraps correctly there's no need to scroll horizontally; `overflow-x` rules would mask future regressions instead of fixing them.
- **`:has()` is fine.** Browser support: Chrome ≥105, Safari ≥15.4, Firefox ≥121 — all evergreen targets the project already runs on (Vite 8 + React 19). No fallback needed.

## Tests

There's no automated test for layout in this project. Manual smoke tests on a 1920×1080 viewport at 100% zoom:

1. Navigate to a project's editor view. The toolbar + canvas + sidebar must span the full viewport width with the standard 1.5rem padding. No dead space on either side.
2. Navigate back to the project list and the project-detail page. Both must stay capped at 960px (centered, with white-space margins on both sides as before).
3. Resize the viewport down to 1280×720 and 1024×768. The toolbar buttons must wrap to a second (and possibly third) row instead of pushing the page off-screen. The horizontal scrollbar must NOT appear on the document.
4. The print-mode `@media print` block still hides the toolbar and chrome correctly (verify with browser print preview on the editor page).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Apply the two CSS edits.
2. Rebuild the frontend bundle (`cd web && npm run build`) and the Go binary (`scripts/build.sh` or single-target).
3. Run the four manual smoke tests above.
4. Pre-merge checks all green.
5. Open PR titled `Fix editor full-width layout + toolbar wrap (Tier 1 #65)`.
6. **Move this spec** from `specs/active/` to `specs/done/` as part of the implementation commit.

## Report back

Under 150 words. Include:

- PR URL
- Confirmation that all four manual smoke tests pass on a 1920×1080 viewport
- Whether the toolbar wraps cleanly at 1280×720 or wants more whitespace tuning between wrapped rows (defer to follow-up if so)
- Pre-merge check final state
