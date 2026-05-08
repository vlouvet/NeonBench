# Tier 3 #50 — OS print polish: paper-size + landscape + return-strip filter

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/50-os-print-polish`

## Goal

PR #38 shipped the toolbar Print button — a hidden iframe + `window.print()` against the existing `print.pdf` URL. The button uses server defaults; the user has no in-toolbar control over paper size or orientation. The existing `<PrintPanel>` on the project detail page already exposes those selectors and ships them to the backend via query params; this row lifts the same controls into a small popover next to the toolbar Print button so the operator can pick paper before printing.

Additionally: a "return strip page only" toggle for channel-letter shops. Today's PDF emits the main pattern AND any face-flagged runs' return-strip pages. Operators sometimes only want the strip pages (post-fabrication, when the face glass is already bent and they need to bend the metal strip). A query param on `/print.pdf` filters to just those pages.

"Done" means: clicking Print opens a small popover offering paper size + landscape toggle + "Strip pages only" checkbox; "Print" inside the popover opens the OS print dialog with those options applied. The original Print button's quick-print behavior is preserved as the popover's default state.

## Branch + setup

```sh
git fetch origin
git checkout -b task/50-os-print-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/pages/EditorPage.tsx` — replace the bare Print button with a button that toggles a small inline popover. Move the existing iframe-mounting + print logic into the popover's submit handler.
- `web/src/components/PrintHost.tsx` — accept paper-size + landscape + strip-only props; build the URL with appropriate query params; same iframe lifecycle.
- `web/src/api.ts` — extend the `printPDFURL(p, v, opts?)` helper to accept `{paper?: 'A4'|'Letter'|'A3'|'Tabloid', landscape?: boolean, stripsOnly?: boolean}`. Keep the no-args call signature backwards-compatible (used by `<PrintPanel>` on the project page; that one stays unchanged).
- `web/src/App.css` — popover positioning + small-card styles. Add to the existing Tier 3 #32 block at the bottom.
- `internal/printpdf/render.go` — accept a `StripsOnly bool` option. When true, omit the main pattern pages and emit only the per-run return-strip pages (and the raceway-grouped pages). When false (default), behavior is byte-identical to today.
- `internal/server/handlers_print.go` — parse a `strips_only=1` query param and forward to render. Existing query params (paper, landscape) are unchanged.

**Don't touch:**

- `EditorCanvas.tsx` — no canvas changes.
- `ProjectDetail.tsx` — `<PrintPanel>` already has its own controls; leave it alone.
- `internal/designdoc/types.go` — schema unchanged.
- Migrations — none.

**New:** none. Keep the popover inline in `EditorPage.tsx` (it's small).

## Deliverables

1. **Popover UI**: paper-size `<select>` (default `Letter` or whatever the server's default is — read from a small new `/api/server_defaults` endpoint OR hard-code the same default both client and server use, document the duplication), landscape `<input type="checkbox">`, "Strip pages only" `<input type="checkbox">`. A "Print" submit button + a "Cancel" button.
2. **Backend strip-only filter**: when `strips_only=1`, skip emitting the main pattern pages but keep all face-flagged runs' return-strip pages and raceway-grouped pages. The bend-list page is also skipped (it's about the main runs, not the strips). Cover with an integration test that asserts page count differs predictably.
3. **Backwards compatibility**: any caller hitting `/print.pdf` without the new param gets identical output to today.
4. **Toolbar layout**: the popover anchors below-right of the Print button; clicking outside the popover dismisses it without printing. Esc dismisses it. Pressing Enter inside the popover triggers the submit (`onSubmit` on a form element).
5. **Small refactor opportunity**: the `<PrintHost>` component already accepts a URL — pass the new URL pre-built (with query params) rather than threading the option types deeper.

## Constraints

- **No new third-party deps.**
- **Backend default-paper-size constant** must stay in one place (today it's a hard-coded `"Letter"` somewhere in `handlers_print.go`). The popover's default value must read from the same source — either via the server endpoint above or via a shared TS constant the build copies from a single source-of-truth.
- **No bundle-size regression** — the popover is plain JSX + CSS, no new component library.
- **Keep the iframe lifecycle from PR #38 intact** — that's the load-then-print-then-cleanup-on-focus pattern. Don't split it across components.
- **No PrintPanel changes** on `ProjectDetail.tsx` — that's a separate UI surface.

## Geometry / algorithms

None. The strip-only filter is a small `if !opts.StripsOnly` guard around the existing main-pattern emission loop in `render.go`.

## Tests

Add to `internal/server/integration_test.go`:

- **`TestPrintStripsOnlyOmitsMainPages`**: a doc with one face-flagged run + one regular run. Default print returns N pages; `strips_only=1` returns N − (mainPageCount + bendListPageCount) pages, with all return-strip pages preserved.
- **`TestPrintStripsOnlyZeroFacesEmpty`**: a doc with NO face-flagged runs + `strips_only=1`. Response is a valid PDF with zero pages OR a 4xx with a clear "no return strips in this design" message — pick one and document the rationale (zero-page PDF is technically invalid; a 4xx with HTML error makes the toolbar's iframe show an error message, which is a fine fail-loud).
- **`TestPrintBackwardsCompat`**: a request without `strips_only=1` produces byte-identical output to a frozen golden — pin the no-regression guarantee.

For the toolbar popover, no automated UI tests (no RTL); manual smoke.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open editor; click Print → popover appears.
2. Change paper to A3, toggle landscape, click Print → OS dialog opens with the right preview.
3. Re-open Print, check Strip pages only on a project with channel-letter face flags → printed PDF has only the strip pages.
4. Click Print on a project with no face flags + Strip pages only → see the documented zero-strips behavior.
5. Click outside popover → dismiss.
6. Esc inside popover → dismiss.
7. The original `<PrintPanel>` on `ProjectDetail.tsx` still works identically.

## Workflow

1. Backend: add the `StripsOnly` option + handler param. Land tests first.
2. Frontend: extend `printPDFURL`, build the popover, wire Print button.
3. CSS for popover positioning.
4. Pre-merge checks; manual smoke.
5. Open PR titled "OS print: paper-size + landscape + strips-only popover (Tier 3 #50)".
6. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, summary, judgment calls (especially the no-strips zero-page-vs-error choice; whether you read defaults from a server endpoint or duplicate constants), file-size deltas, CI state, follow-ups worth tracking (e.g. PrintPanel + toolbar popover state synchronization; per-paper-size scale-bar adjustment in the PDF; a "print to N copies" option).
