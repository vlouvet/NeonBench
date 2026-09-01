# Tier 2 #74 — Raceway guideline as a geometric break point

> **Status:** SHIPPED 2026-08-31 · branch `task/2-raceway-guideline-geometric` · NW parity (auto-tube-layout behavior)

> **Decisions the spec left open, and one it did not anticipate.**
> 1. **Idempotency: no-op, not revert-then-reapply.** Splitting leaves every
>    piece with an endpoint exactly on the line, and the crossing finder
>    excludes the endpoints of an open run — so a second pass finds nothing.
>    Nothing has to remember what was already cut. Moving the line and
>    splitting again therefore ADDS a cut rather than undoing the old one;
>    undo is the way back, and it is one step.
> 2. **Vertex-on-line tolerance: 1e-6 mm.** Far below any real geometry,
>    comfortably above the float noise in an interpolated crossing (~1e-13 mm).
> 3. **A second guideline is allowed.** Each gets its own id and its own
>    raceway group. The slice supported it for free; forbidding it would have
>    been the extra code.
> 4. **Closed runs are handled, not skipped.** A letter's face outline is a
>    loop, so the loop is opened at its first crossing and cut at the rest. A
>    closed run carrying electrodes is skipped and reported — opening it
>    destroys the live arc with no non-arbitrary answer for which piece keeps
>    which electrode.
> 5. **`splitRun` had to be fixed first.** It carried only colour, diameter
>    and notes onto the pieces, dropping `is_channel_letter_face`,
>    `channel_letter_depth_mm`, `raceway_id`, `group_id` and `kind`. Since
>    `groupByRaceway` buckets only runs that are BOTH a face and
>    raceway-tagged, every piece this feature cut would have been invisible to
>    the combined strip page. Measured: 1 strip page with the fix, 0 without.

## Goal

NW lets the operator drop a horizontal **raceway guideline** anywhere in the design. During Auto Tube Layout, every tube that crosses the guideline gets split at the crossing, so all tubes pass through (and terminate at) a single horizontal raceway housing. This is the canonical channel-letter-with-raceway construction.

NeonBench has **raceway grouping** (PR #43): a per-run `RacewayID` field that groups face runs into combined PDF strip pages. But the actual tube-splitting at the raceway position is manual — the operator drops a horizontal line annotation, then walks every tube and `splitRun()`s at the crossing.

"Done" means: a new `Doc.Guidelines []Guideline` field with `kind: 'raceway'` + a Y-position; a draggable horizontal-line affordance in the editor canvas; a "Split tubes at raceway" sidebar action that walks every run, computes intersections with the guideline, splits at each, and tags both halves with the same `RacewayID`.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-raceway-guideline-geometric origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — add `Doc.Guidelines []Guideline` (JSON-blob, no migration); `type Guideline { ID string; Kind string; YMM float64 }` for V1 (only `kind: "raceway"` and Y-position; vertical guidelines deferred).
- `web/src/api.ts` — mirror the type addition.
- `web/src/lib/docOps.ts` — `addRacewayGuideline(doc, yMM): Doc`; `removeGuideline(doc, id): Doc`; `splitTubesAtRaceway(doc, guidelineId): Doc` — walks every run, computes the polyline-vs-Y intersection points, calls `splitRun` at each, tags both halves with the same `RacewayID = guideline.id`.
- `web/src/lib/docOps.test.ts` — pin: 1-tube-crosses-guideline → 2 runs both with same `RacewayID`; 1-tube-doesn't-cross → unchanged; 1-tube-crosses-twice → 3 runs all sharing `RacewayID`; idempotent re-run (skip already-split-at-Y).
- `web/src/components/EditorCanvas.tsx` — render guidelines as draggable horizontal dashed lines (full width of bbox); drag to reposition; click to select; Delete key removes.
- `web/src/pages/EditorPage.tsx` — sidebar "Add raceway guideline" button (drops a guideline at bbox-center-Y); "Split tubes at raceway" action when a guideline is selected.

**Don't touch:**

- The existing `RacewayID`-based PDF aggregation (PR #43 / Tier 3 #46) — it consumes the field; this PR just generates it geometrically.
- Backend / schema — JSON-blob storage absorbs the new field.

## Deliverables

1. **Schema additions** (no migration). `Guideline` is a small struct; `Doc.Guidelines` is omitempty.
2. **Polyline-vs-horizontal-line intersection** — pure function. Walks every segment of a polyline; for each segment crossing Y, computes the X coordinate. Returns sorted X values (multiple crossings supported for serpentine tubes).
3. **`splitTubesAtRaceway`** — for each crossing, calls `splitRun` (PR #23) and tags both halves with the same `RacewayID`. The crossing vertex is inserted via `insertVertex` first so the split happens cleanly at the line.
4. **Canvas render.** Horizontal dashed line, full-bbox-width, at the guideline's Y. Click to select; selected = highlight + drag handle. Drag to reposition (live update). Esc deselects.
5. **Tests** — geometric: single-crossing, double-crossing, no-crossing, vertex-on-line edge case (treat as crossing).
6. **Persistence** — guidelines round-trip through `Doc` JSON; existing-doc back-compat (no `guidelines` field defaults to empty).

## Constraints

- **No new schema migrations** (JSON-blob field).
- **Don't touch the 3D preview** — guidelines are 2D editor chrome only.
- **Vertical guidelines deferred.** V1 is horizontal-only. The schema's `Kind: "raceway"` enum lets a future PR add `"vertical"` without a breaking change.
- **No auto-electrode on guideline split.** Tubes split into pieces; the operator places electrodes manually (or via Tier 2 #72's auto-batch).

## Tests

Manual smoke:

1. Editor on a channel-letter design (4 letters, 8 tubes). Click "Add raceway guideline." Drag the dashed line to where the raceway will sit (e.g. 100mm above baseline).
2. Click "Split tubes at raceway." Each tube that crosses the guideline becomes 2 runs sharing a `RacewayID`. PDF strip pages now group raceway-aligned pieces (PR #43 takes over).
3. Reposition the guideline → re-run "Split" → previous split is undone (idempotency) and new split applies. Or: explicit "Re-split" reverts then re-applies.
4. Save + reload → guidelines persist.

## Pre-merge

Standard four.

## Workflow

1. Schema + Go round-trip test.
2. Polyline-Y intersection helper + tests.
3. `addRacewayGuideline` + `splitTubesAtRaceway` + tests.
4. EditorCanvas guideline render + drag.
5. Sidebar UI.
6. Pre-merge + smoke.
7. PR titled `Raceway guideline as geometric break point (Tier 2 #74)`.

## Report back

Under 250 words. PR URL, idempotency strategy on re-split (revert-then-reapply vs no-op), Vertex-on-line tolerance chosen, what happens when the user drops a second raceway guideline, CI state, follow-ups (vertical guidelines, snap-to-vertex when dragging).

## Follow-ups

- Vertical guidelines (for stacked-letter signs).
- Multiple raceway guidelines per design (multi-row marquees).
- Auto-electrode placement at every raceway-split termination (composes with #72).
- Snap the dragged guideline to nearby vertex Y values.
