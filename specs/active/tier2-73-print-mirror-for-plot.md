# Tier 2 #73 — Mirrored print output for back-side bending

> **Status:** active · drafted 2026-05-09 · branch `task/2-print-mirror-for-plot` · NW parity (default plot behavior)

## Goal

The trade convention: the bender works against the **back** of the glass tube while looking at the pattern, so the printed pattern must be horizontally mirrored relative to the front-facing design. NW does this automatically when sending to the plotter ("the layout is reversed automatically when it comes in" — operator quote from the NW Pro 6.5 transcript).

NeonBench's print PDF is rendered front-facing today. Operators integrating with existing benders either flip mentally, print on translucent paper and use the back, or scrap NeonBench output. None is acceptable for daily use.

"Done" means: the print PDF emits a horizontally-mirrored pattern by default, with text labels (run IDs, dimensions, bend annotations) re-flipped so they read normally. A `?mirror=0` query param + a "Print front-facing" checkbox in the print popover (PR #93) lets the user opt out for marketing renders or front-side review.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-print-mirror-for-plot origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/printpdf/render.go` — accept a new `Mirror bool` field on `RenderOptions`; when true (the default), apply a horizontal flip to the pattern coordinate space before rendering. Text labels (TEXT entities, dimensions, bend numbers) re-flip on emission so they remain readable. Default = `true` (mirrored is the trade default).
- `internal/printpdf/render_test.go` — golden test pinning that mirror=true produces a mirrored polyline + un-mirrored text labels; mirror=false matches today's output byte-identically.
- `internal/server/handlers_print.go` — accept `?mirror=0` to set `Mirror=false` in the request; default mirrored. Also accept on the strips-only path (PR #51).
- `web/src/api.ts` — extend `printPDFURL(opts)` with `mirror?: boolean` (default true; URL omits the param when default).
- `web/src/components/PrintPopover.tsx` — add "Print front-facing (un-mirrored)" checkbox; default off (so default URL is mirrored = trade default).
- `web/src/api.test.ts` — pin the URL output across `mirror=undefined` (no param), `mirror=true` (no param), `mirror=false` (`?mirror=0`).

**Don't touch:**

- DXF export (consumers handle their own mirror — bender CAM already knows about back-side bending).
- The 3D preview (always front-facing — that's the *visual* render).
- The 2D editor canvas (always front-facing — that's the *design* surface).

## Deliverables

1. **Mirror transform.** In the PDF coordinate space, multiply X by -1 and translate by `bbox.MaxX` so geometry stays in the page's positive quadrant. Apply once before any draw call.
2. **Text re-flip.** Every TEXT-style emitter (run labels, dimensions, bend annotations, page footer) re-applies a horizontal flip on its own draw call so the rendered character glyphs read left-to-right.
3. **`Mirror` defaults to `true`.** Unspecified `Mirror` field zero-value-checks against `true` via a small `WithDefault` helper or by switching to a `*bool`. Pick whichever lands cleanest in Go (pointer-bool is the spec's pattern from #33c).
4. **`?mirror=0` opts out.** Front-end "Print front-facing" checkbox flips the URL.
5. **Default print stays "ready to give to the bender"** — mirrored, text readable.
6. **Tests** — golden bytes for mirrored vs front-facing on a 3-run fixture. Existing tests update to assert mirrored is now the default; un-mirrored becomes the alternate.

## Constraints

- **No DXF mirroring.** DXF is for CAM importers; CAM tools handle bend-side semantics.
- **No bundle / vector export changes.** Bundles round-trip the front-facing design; mirror is a print-time render choice.
- **No editor-canvas mirror.** The on-screen design stays front-facing (operators draw what they see).

## Tests

Manual smoke:

1. Print any project. PDF opens horizontally mirrored — text reads normal, polylines reversed. Confirm with a known asymmetric design (the letter "F" — should look like a backwards F).
2. In the print popover, check "Print front-facing." Re-print. Now the F looks normal.
3. Strips-only mode (PR #51) inherits the same mirror behavior.

## Pre-merge

Standard four. Plus `go test ./internal/printpdf/...`.

## Workflow

1. Mirror transform helper + golden tests against a fixture.
2. Text re-flip on every TEXT emitter.
3. `?mirror=0` route + popover checkbox + URL builder + URL tests.
4. Update existing print test goldens to reflect new default.
5. Pre-merge + smoke.
6. PR titled `Mirror print output for back-side bending (Tier 2 #73)`.

## Report back

Under 250 words. PR URL, the pointer-bool-vs-WithDefault decision for `Mirror` field, how the text re-flip composes with multi-line text (does each line re-flip individually?), what fixtures' goldens needed updating, CI state, follow-ups.

## Follow-ups

- Per-project "default mirror" toggle (e.g. some shops may want unmirrored output as default for design review).
- Vertical mirror for unusual cabinet orientations (rare).
- "Auto-mirror" annotation in the PDF footer so the operator sees confirmation: "MIRRORED FOR BACK-SIDE BENDING."
