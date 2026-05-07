# Tier 3 #32 — Send to printer via OS print dialog

> **Status:** active · started 2026-05-07 · branch `task/32-os-print-dialog`

## Goal

Today the only path to paper is `GET /api/projects/{id}/design_versions/{vid}/print.pdf` — the user downloads the PDF and prints it themselves. The Tier 3 task is to add a one-click "Print to OS" button that opens the browser's native print dialog with the design pre-rendered at 1:1 scale, so a user can pick a printer + paper size + driver options without leaving the app.

"Done" means: the editor has a "Print" button next to the existing PDF / DXF download buttons; clicking it opens `window.print()` over a print stylesheet that hides the app chrome and renders the design (or its pre-built print-PDF preview) at 1:1; print-only CSS (`@media print`) keeps the rest of the app from appearing on the printed page; preview-quality matches what the user gets on paper.

## Branch + setup

```sh
git fetch origin
git checkout -b task/32-os-print-dialog origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/pages/EditorPage.tsx` — add a "Print" button in the toolbar near the existing download buttons; on click, render a hidden `<iframe>` (or use a route-based print-mode page) that loads the print PDF and triggers `window.print()` against it.
- `web/src/App.css` — add `@media print` rules: hide every UI element except the print-target container; ensure the design renders at 1:1 (no zoom/scale transforms, page-break aware).
- `web/src/pages/EditorPage.tsx` (or a small new `web/src/components/PrintHost.tsx`) — the hidden iframe + onload handler that calls `iframe.contentWindow.print()`. PDF embeds vary by browser; document Chrome / Safari / Firefox behavior.

**Don't touch:**

- Backend (PDF emission unchanged).
- `EditorCanvas.tsx` — no canvas changes.
- Other pages.

**New:**

- Optionally `web/src/components/PrintHost.tsx` if the iframe + lifecycle logic exceeds ~50 lines inline.

## Deliverables

1. **Print button.** Visible next to existing PDF/DXF download buttons. Disabled when there's no committed design version (same condition as the PDF button).
2. **Print flow.**
   - On click, fetch (or directly link) the existing `print.pdf` URL into a hidden `<iframe>`.
   - Once the iframe load completes, call `iframe.contentWindow.print()` (with a small `setTimeout` if needed for browsers that aren't ready immediately on `onload`).
   - When the print dialog closes (focus returns), remove the iframe.
3. **Print stylesheet.** A `@media print` block that:
   - `display: none`-s every navigation chrome / sidebar / toolbar.
   - Ensures the print-target container fills the page (no margins/padding from app shell).
   - Uses `page-break-inside: avoid` on the design container.
   - Sets `@page { size: auto; margin: 0; }` so the browser delegates page sizing to the user's dialog.

   Note: if the print path uses an iframe with the browser-native PDF viewer, the parent page's `@media print` rules don't apply — the PDF is the print payload. Confirm the chosen path early; both work but the CSS layer is only relevant for the non-iframe variant.

## Constraints

- **No new third-party deps.** Native `window.print()` only.
- **Don't lose fidelity vs the PDF.** The existing PDF generator is the source of truth; printing it via iframe gives identical output. **Recommended path:** iframe with the existing PDF endpoint.
- **Cross-browser.** Test in Chrome, Safari, Firefox. Documented quirks:
  - Chrome: `iframe.contentWindow.print()` works after `onload`.
  - Safari: needs `setTimeout(..., 0)` after onload.
  - Firefox: works similar to Chrome but requires `pointer-events: none` on the iframe to avoid stealing focus from the print dialog button.
- **No browser-print-CSS hackery for the non-PDF path** unless the implementing agent has a strong reason to avoid the iframe-PDF approach. Stylesheet path is the fallback only.

## Geometry / algorithms

None — this is wiring + a small CSS stylesheet.

## Tests

No unit tests (browser print is hard to test). Manual smoke covers it:

1. Open a project with a committed design version; click Print. Native print dialog opens with the design preview.
2. Pick "Save as PDF"; saved file is identical (visually) to the existing `print.pdf` download.
3. Cancel the print dialog; iframe is removed; app continues to work.
4. Resize the editor; chrome doesn't bleed into the print preview (the @media print block holds).
5. Verify in all three browsers (Chrome, Safari, Firefox).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke per the four-browser test above.

## Workflow

1. Add the iframe-based print host (preferred path).
2. Wire the toolbar button.
3. Add minimal `@media print` rules as a safety net for any DOM that does end up in the print stream.
4. Cross-browser smoke.
5. PR titled "Print via OS dialog (Tier 3 #32)".
6. **Move this spec** to `specs/done/`.

## Report back

Under 200 words. Include: PR URL, chosen path (iframe vs CSS-print of the SVG), per-browser quirks observed, CI state, follow-ups (printer-paper-size hints, multi-page browser pagination matching PDF page boundaries, "print return strip page only" filter for channel-letter shops).
