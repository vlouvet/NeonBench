# Tier 2 #93 — Plot options: rotate-to-fit, step-and-repeat, quick plot

> **Status:** active · started 2026-08-31 · branch `task/2-plot-options`

## Goal

Printing a full-size pattern is the moment NeonBench's output meets the bench,
and three ordinary conveniences are missing. A tall sign printed portrait wastes
a column of paper and an extra row of tiles. A shop bending six identical
letters prints the pattern six times by hand. And every print is four clicks
through a popover even when the settings never change.

This slice adds:

- **Rotate to fit** — rotate the pattern 90° when that yields fewer tiles
- **Copies / step-and-repeat** — N copies of the pattern in one PDF
- **Quick plot** — one-click print using the last-used settings

Closes three NeonWizard Cutting/Plotting/Printing parity rows.

## Branch + setup

```sh
git checkout -b task/2-plot-options origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command
```

## Premises already verified — do not re-derive

- **Mirror at plot already ships** (Tier 2 #73, `Options.Mirror`, `?mirror=0`).
  The parity row that mentions "Mirror/Scale/Rotate at plot" is therefore only
  missing rotate. **Do not reimplement mirroring.** Read `MirrorOn()` and copy
  its pointer-bool convention for any new tri-state option.
- Print options travel as **query parameters** on
  `GET /api/projects/{id}/design_versions/{vid}/print.pdf`, parsed in
  `internal/server/handlers_print.go`, into `printpdf.Options` (`render.go:24`).
  That is the whole plumbing pattern; follow it exactly.
- The frontend holds them in `PrintPopoverValues`
  (`web/src/components/PrintPopover.tsx`) and the print goes through a hidden
  iframe + `window.print()` (`PrintHost.tsx`, shipped in PR #38).
- Tiling/paneling for oversize patterns already exists (`OverlapMM`, the
  tile pages). Rotate-to-fit must go through that same tiling code, not
  around it.

## Strict file scope

**Modify:**

- `internal/printpdf/render.go` — three new `Options` fields + the rotation and
  copies logic
- `internal/printpdf/paper.go` — if the tile-count computation lives there
- `internal/printpdf/render_test.go` — new tests
- `internal/server/handlers_print.go` — parse `rotate`, `copies`
- `internal/server/integration_test.go` — **append only**; if you hit a merge
  conflict here it is the known parallel-agent hotspot, keep both functions
- `web/src/components/PrintPopover.tsx` — new controls
- `web/src/components/PrintPanel.tsx` / `PrintHost.tsx` — quick-plot button
- `web/src/pages/EditorPage.tsx` — **minimal**: the `printOpts` state shape and
  the quick-plot button wiring only. Two other agents are editing this file
  this round; keep your diff under ~30 lines and nowhere near the sidebar.
- `README.md`

**Don't touch:** `EditorCanvas.tsx`, `docOps.ts`, `internal/designdoc/**`,
`internal/validate/**`, `todo.md`.

## Deliverables

1. **`Options.RotateToFit bool`** (query `rotate=fit`) and
   **`Options.Rotate90 bool`** (query `rotate=90`), or a single
   `Options.Rotate string` with values `""|"90"|"fit"` — pick one shape and be
   consistent. `"fit"` computes the tile count both ways and picks the smaller;
   ties keep the un-rotated orientation, so the default is stable and a user who
   sees no change is not looking at a coin flip. Rotation is about the pattern's
   bbox centre and applies to the **main pattern and bend-list pages only** —
   the same scope rule `Mirror` already documents. Return-strip and
   raceway-strip pages are unfolded 1D patterns in their own coordinate space;
   leave them alone, and say so in a comment.

   **Order matters and must be tested:** mirror is a reflection, rotation is a
   rotation, and they do not commute. Fix the order as *mirror, then rotate*
   (mirror is a property of how the bender reads the glass; rotation is a
   property of how the paper is fed) and pin it with a test that renders both
   flags on and asserts a known point's final position.

2. **`Options.Copies int`** (query `copies=N`, default 1, clamp 1..50, reject
   non-numeric with a 400 like the `paper` param does). N copies of the full
   page set, each labelled "copy k of N" in the existing footer so a stack of
   paper on the bench is not ambiguous. Copies multiply *pages*, not geometry —
   do not tile N patterns onto one sheet; a 1:1 production pattern must stay
   1:1, and two letters sharing a sheet cannot both be cut out.

   Guard the interaction with `strips_only=1` (copies of strips is meaningful
   and should work) and with the `ErrNoStripsToRender` 422 path.

3. **Quick plot.** Persist the last-used `PrintPopoverValues` per project in
   `localStorage` and add a one-click "Quick plot" button next to the existing
   print button that skips the popover entirely. Show the settings it will use
   in the button's `title` so it is never a mystery print. First use with no
   stored value falls back to the current defaults.

4. **Footer honesty.** When rotation or copies are active, the page footer must
   say so. A pattern that is rotated relative to the design, printed and then
   found on a bench a week later with nothing indicating that, is a real
   fabrication hazard.

## Constraints

- No new dependencies. No schema/migration change — these are per-request
  options, not stored project settings.
- Every new query parameter must be **absent-safe**: a request with none of
  them must produce a byte-identical PDF to today's output. Add a test that
  pins this (render with no params before/after your change is not possible in
  one test run, so instead assert page count and a few known landmarks the way
  `returnstrip_test.go` does with `SetCompression(false)` + string search).
- Clamp and validate in the handler, not in the renderer, so bad input is a
  400 rather than a 200 with a surprising PDF.

## Tests

Go:

- rotate=90 on a wide pattern reduces tile count vs. portrait; assert the count
- rotate=fit picks the smaller count; a tie keeps un-rotated (assert explicitly)
- mirror+rotate ordering: a known point lands where the fixed order says
- copies=3 yields exactly 3× the page count of copies=1
- copies bounds: 0, -1, 51, "abc" → 400
- copies=3 with strips_only=1 works; with a doc that has no faces → 422
- no-params render still has the expected page count and footer landmarks
- rotation does NOT affect return-strip page geometry

Frontend:

- quick-plot URL builder emits exactly the stored settings
- stored settings round-trip through localStorage; a corrupt/absent value falls
  back to defaults without throwing

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
go vet ./...
```

Smoke test with a real PDF, not just the test suite: run the binary, open a
design, print with rotate=fit and copies=2, and **actually open the resulting
PDF** and look at it. Confirm page count, that the pattern is not clipped at
the rotated margins, and that the footer states the rotation.

## Out of scope (log as follow-ups)

- Scale-at-plot (a 1:1 tool printing at 87% needs a design conversation first —
  raise it, do not build it)
- Step-and-repeat that *arrays geometry in the design* (that is a Design Tools
  feature and belongs with the arrange ops, not the print path)
- Saving print presets server-side per project
