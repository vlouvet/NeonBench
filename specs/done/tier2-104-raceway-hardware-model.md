# Tier 2 #104 — Raceway as a modelled hardware object (NW #133)

> **Status:** active · drafted 2026-08-31 · branch `task/2-raceway-model`

## Goal

NW **#133 Raceway Support** has sat ❌ since the parity audit with the note
*"NW's intent is ambiguous (validation rule vs. hardware spec model)."* The
research in `docs/neon-rules/raceway.md` (2026-08-31) settles it: a raceway is
a **hardware spec model** — a rectangular aluminium box, mounted to the
building, that the letters mount to and that houses the transformers, wiring
and disconnect.

NeonBench models the letters and their returns. It does not model the box they
hang on, so the one component the installer bolts to the wall is absent from
the pattern set, the print output, and the takeoff.

**Read `docs/neon-rules/raceway.md` before starting.** It carries every number
below with its citation, and — importantly — its own warning that it is
web-sourced rather than book-sourced, so these defaults are *current commercial
practice*, not codified trade law. Every one must be operator-overridable.

## The identity decision (get this right first)

There are already two raceway-ish things in the codebase, and adding a third
identity would fragment the model. Don't.

- `Guideline{Kind: "raceway", YMM}` — the horizontal line where tubes are cut
  because below it they pass into the raceway.
- `Run.RacewayID` — stamped by `splitTubesAtRaceway`, and **already equal to
  that guideline's ID**. `types.go` says why: *"it means 'these tubes share a
  raceway' has exactly one source of truth rather than a guideline and a
  separately-typed group that can drift."*

So: **a `Raceway` record shares the guideline's ID.** The guideline supplies
the Y (the box's top edge); the new record adds the rest of the box. No new id
space, no new foreign key, and every run already points at the right raceway.

A `Raceway` whose ID matches no guideline is invalid — reject it at unmarshal.

## Schema (additive only)

```go
// Raceway is the physical enclosure the letters mount to. Its ID is the
// ID of the "raceway" Guideline that supplies its top edge.
type Raceway struct {
    ID       string  `json:"id"`
    XMM      float64 `json:"x_mm"`                 // left edge, world mm
    LengthMM float64 `json:"length_mm"`
    HeightMM float64 `json:"height_mm,omitempty"`  // 0 = project/shop default
    DepthMM  float64 `json:"depth_mm,omitempty"`   // 0 = project/shop default
}
```

plus `Doc.Raceways []Raceway \`json:"raceways,omitempty"\``.

`omitempty` throughout is load-bearing, not cosmetic — it keeps every existing
doc's JSON byte-identical, the same back-compat invariant `Groups`,
`Guidelines` and `SegmentTypes` rely on. `internal/server/json.go` sets
`DisallowUnknownFields()`, so the Go struct and `web/src/api.ts` must land in
the same PR or every save returns 400.

**No migration** — raceways live inside the design-doc JSON blob.

## Defaults, and where they come from

| Constant | Value | Source |
|---|---|---|
| `RACEWAY_DEPTH_MM` | **203.2** (8″) | The historic standard for **neon** letters. The 4–5″ figures that dominate the web are LED-era — an LED driver is small; a neon transformer is not |
| `RACEWAY_HEIGHT_MM` | **203.2** (8″) | Same 8″×8″ figure |
| `RACEWAY_SPLICE_MM` | **3048** (10 ft) | Shipping sections; longer runs are butt-spliced |
| `TRANSFORMER_LEN_MM` | **159** (6¼″) | Measured 10 kV / 30 mA electronic transformer |

The corroboration for 8″ is worth keeping in a comment because it is checkable
rather than folkloric: a **159 mm** transformer cannot sit *across* a 127 mm
(5″) raceway; it has to lie along the run. The neon-era box was bigger because
of what had to fit in it.

## Strict file scope

**Modify:** `internal/designdoc/types.go` (+ its test), `web/src/api.ts`,
`web/src/lib/docOps.ts` (raceway CRUD + auto-fit), `web/src/components/EditorCanvas.tsx`
(render + drag), `web/src/pages/EditorPage.tsx` (minimal — a panel section),
`internal/printpdf/raceway.go` (**the rename**, see below), `internal/printpdf/render.go`
(the new page), `internal/validate/rules.go` (two rules), `README.md`.

**Don't touch:** `internal/takeoff/**` and `internal/estimate/**` — reading
them is fine, changing them is Tier 3 #83's scope.

## Deliverable 1 — fix the name we already got wrong

`emitRacewayStrip` **does not emit a raceway.** It concatenates the unfolded
*letter perimeter* return bands of several faces onto one piece of coil stock:
width = sum of perimeters, height = max letter depth. That is return-strip
nesting. A raceway is one box sized to the sign's overall extent and follows no
letter's perimeter.

Rename `emitRacewayStrip` → `emitNestedReturnStrip`, and retitle its page from
`"Raceway strip — {gid}"` to `"Nested return strip — raceway {gid}"`.

**Keep the grouping as-is.** Nesting the returns of letters that share a
raceway is correct and useful; only the name misleads. Do not rename
`Run.RacewayID` — it means exactly what it says.

## Deliverable 2 — create, size, and place

1. Creating a raceway guideline offers to create its `Raceway` record.
2. **Auto-fit**: `X` and `LengthMM` from the bbox of runs carrying that
   `RacewayID`, via `selectionBBoxMM` in `arrange.ts` (arc-aware — a bbox from
   raw `polyline.points` clips arc bow and under-sizes the box).
3. Manual override by dragging the box's ends on canvas, and by numeric entry.
4. Render behind the runs, visually distinct from guidelines and grid, with its
   length dimensioned.

### ⚠️ The end-margin assumption — flagged, not hidden

Every source says the raceway *"spans the entire length of the letters"*. **No
source found states whether it stops flush with the outermost letters or
overhangs**, and `raceway.md` records this as an open question needing a shop.

V1 assumes **flush** — `RACEWAY_END_MARGIN_MM = 0` — because zero is the only
number not invented. Put it in **one named constant** with a comment pointing
at `docs/neon-rules/raceway.md`'s open question, so changing it later is a
one-line edit rather than an archaeology exercise. Surface it as a project
setting too. Do **not** bake a margin into the auto-fit arithmetic.

## Deliverable 3 — a dimensioned raceway page in the PDF

Plan view of the box: overall length, height and depth called out; each member
letter's position marked along it; splice lines every `RACEWAY_SPLICE_MM`.
This is what the fabricator cuts and the installer positions from — the same
role the return strip already plays for the letter walls.

Gate it on the design actually having a raceway, and honour `StripsOnly` the
way the other strip pages do.

## Deliverable 4 — two validation rules

1. **The raceway must span its runs.** If any run tagged with a `RacewayID`
   extends beyond that raceway's X extent, flag it. This is the rule that
   catches an auto-fit that was never re-run after letters moved.
2. **Transformers must fit along the length.** The design's electrode pairs
   imply a transformer count (`internal/takeoff` already derives electrode
   pairs — read it, don't duplicate it). `count × TRANSFORMER_LEN_MM` must fit
   within `LengthMM` with clearance. A four-letter sign with four transformers
   in a 900 mm raceway does not go together, and that is discovered on a lift
   today.

Severity: both **warnings**, not errors. These are commercial-practice numbers
from a weaker source class, and a shop with a different transformer or a
different box should not be blocked by our defaults.

## Tests

Go:
- Round-trip a doc with raceways; a doc **without** them is byte-identical to
  today's JSON (the `omitempty` invariant)
- A `Raceway` whose ID matches no guideline is rejected at unmarshal
- Both validation rules fire and clear at their boundaries; both are warnings
- The renamed emitter still produces the nested return strip page for a
  raceway-grouped design — this is the regression that matters, since the
  rename touches a working feature

TS:
- Auto-fit spans the member runs exactly at margin 0
- Auto-fit is **arc-aware**: a run whose arc bows past its vertices widens the
  box (use `flatRunPoints`)
- Runs not on this raceway don't affect the fit
- Raceway CRUD round-trips through save without a 400

## Pre-merge

Standard four checks. Then a real browser and a **real PDF**: place letters,
add a raceway guideline, auto-fit, print, and open the PDF — confirm the
raceway page dimensions match the on-screen box and that the nested return
strip page still appears under its new title.

## Out of scope

3D preview of the raceway; wireway mode (2″, wiring only, no supplies — a
different object, see `raceway.md`); hanger-bar placement; wind-load
engineering; and transformer *sizing* from footage, which is Tier 3 #83.
