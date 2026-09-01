# Tier 3 #88 — Raceway guideline follow-ups: vertical lines, snapping, auto-electrodes

> **Status:** active · drafted 2026-08-31 · branch `task/3-raceway-followups` · follow-up from Tier 2 #74

## Goal

Three deferred items from Tier 2 #74, in descending order of value. They are independent; ship them as separate commits, or drop any one without affecting the others.

**1. Vertical guidelines.** V1 is horizontal-only. `Guideline.Kind` was made an enum specifically so this could land without a breaking change. Stacked-letter signs and multi-column marquees want a vertical break.

**2. Snap the drag to nearby vertex Y.** The operator drags the guideline to "where the raceway sits", which in practice means "level with the bottom of the letters". Snapping to nearby vertex coordinates while dragging makes that exact instead of approximate — and an exact hit is materially better than a near miss, because a crossing that lands *on* a vertex splits there cleanly rather than a millimetre away from it.

**3. Auto-place electrodes at every raceway termination.** After a split, each piece terminates at the line with no electrode. The operator places them by hand — which is precisely the sweep Tier 2 #72 already generalised for doublebacks and housings.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-raceway-followups origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — `Guideline` grows an axis. The existing field is `YMM`; the least confusing extension is `Kind: "raceway" | "raceway_vertical"` plus renaming the field's *meaning* to "position along the axis the kind names" rather than adding an `XMM` that is null half the time. Decide and write it down; do not leave two nullable coordinates.
- `web/src/api.ts` — mirror it. The Go decoder runs with `DisallowUnknownFields`, so these two move together or every save 400s.
- `web/src/lib/docOps.ts` — `racewayCrossings` takes an axis; the vertical case is the same walk with the coordinates swapped. `splitTubesAtRaceway` needs no other change: the crossing list is all it consumes.
- `web/src/components/EditorCanvas.tsx` — render and drag a vertical line; snap the drag.
- `web/src/pages/EditorPage.tsx` — an "Add vertical guideline" action, and an "Place electrodes at raceway ends" action.

**Don't touch:**

- The idempotency contract. Splitting leaves every piece ending on the line, and `racewayCrossings` excludes an open run's endpoints — that is what makes re-running a no-op, and it must hold for the vertical case identically.
- `internal/printpdf/raceway.go`. Guidelines are editor construction; the strip page consumes `RacewayID` and neither knows nor cares which axis produced it.

## Deliverables

1. **Vertical guidelines** — schema, render, drag, split, round-trip, and the same idempotency tests the horizontal case has.
2. **Snap-to-vertex-coordinate on drag**, using the editor's existing snap toggle and radius rather than a new setting.
3. **Auto-electrode sweep** over runs carrying a `raceway_id`, placing one at each end that terminates on the line and skipping ends that already have one — idempotent, like its Tier 2 #72 siblings.
4. **Tests:** a vertical guideline splits a horizontal tube (and does not split a vertical one); the two axes are independently idempotent; a run split by both a horizontal and a vertical guideline is tagged by whichever ran last, and the test says so explicitly rather than leaving it to be discovered.

## Constraints

- **No migration.** Guidelines are a JSON-blob field.
- **`raceway_id` stays one string per run.** A run cut by two guidelines belongs to one raceway group as far as the PDF is concerned; if that turns out to be wrong, it is a schema question and a separate spec, not something to solve by concatenating ids.
- **Auto-electrode respects the two-electrode ceiling.** `placeElectrode` relocates the nearer of two rather than refusing a third — so the sweep must check the count itself, or it will silently drag existing electrodes around.

## Tests

Manual smoke: a two-row marquee. Drop a horizontal guideline under each row and a vertical one between the columns; split; confirm the run list and the combined strip pages group as expected. Save, reload, confirm both guidelines persist.

## Pre-merge

Standard four.

## Report back

Under 200 words. PR URL, how the axis is stored, what the drag snaps to, the two-electrode rule in the sweep, CI state, follow-ups.

## Follow-ups

- Multiple raceways per design driving multiple strip pages (needs the `raceway_id`-per-run question above answered first).
- Guidelines as a print layer, so the pattern shows where the raceway sits.
