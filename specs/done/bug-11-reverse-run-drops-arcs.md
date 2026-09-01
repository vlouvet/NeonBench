# Bug #11 — `reverseRun` corrupts runs that contain arc segments

> **Status:** done · found 2026-08-31 · PR #149 · branch `task/bug-11-reverse-run-arcs`
>
> **Outcome:** deliverables 1, 3 and 4 shipped. Deliverable 2 (arc geometry
> preserved) is **not achievable without a schema change** and did not ship:
> `segment_types` has only `line` and `arc`, and `arcFor` always bows left of
> travel, so reversing a chord necessarily mirrors the bow about it. Arcs now
> stay on the chords the operator curved, and reversing twice is an exact
> identity, but a single reverse still flips the bow. Preserving it needs a
> signed bulge (or `arc-cw`/`arc-ccw`) in `internal/designdoc` plus its
> TypeScript twin — tracked as a follow-up.

## Symptom

Select a run that has at least one arc segment, press the editor's **Reverse**
button (`EditorPage.tsx:1281` → `ops.reverseRun`), and the run's curvature
silently changes: arcs land on the wrong segments and bow to the wrong side.
The vertices are all still in the right places, so nothing looks obviously
broken until the pattern is printed or the DXF is cut.

## Root cause

`reverseRun` (`web/src/lib/docOps.ts:842`) predates arc segments (Tier 3 #78,
PRs #141/#142). It reverses `polyline.points` and remaps
`electrodes[].point_index`, and stops there. Two things it does not do:

1. **`polyline.segment_types` is left untouched.** Index *i* is the segment
   *leaving* vertex *i*. After reversal, segment *i* of the new run is a
   different pair of vertices than segment *i* of the old one, so every arc
   flag now points at the wrong segment. For an open *n*-point run the correct
   mapping is new *j* = old `n-2-j`; for a closed run it is
   new *j* = old `(n-2-j) mod n`.
2. **Arc handedness is not accounted for.** `arcFor(p0,p1)` bows toward
   `(-dy, dx)`. Reversing a segment's direction flips that normal, so even a
   correctly-shifted arc flag produces a mirror-image bow. (Note: this second
   effect is what makes reversal the *right* tool inside a mirror operation —
   see `web/src/lib/arrange.ts`, where the two handedness flips deliberately
   cancel. Standalone reversal has no second flip to cancel against, so the
   geometry must be preserved some other way.)

Also unmapped: the live-arc positions behind `blockouts`, `annotations`, and
`bends`, which `reverseRun` ignores entirely even for line-only runs.

## Required behaviour

Reversing a run changes only the **direction of travel**. The drawn shape must
be identical before and after — that is the whole contract, and it is what the
test must assert.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts` (the `reverseRun` function only),
`web/src/lib/docOps.test.ts` (append tests).

**Don't touch:** anything else. `EditorPage.tsx`, `EditorCanvas.tsx`,
`internal/**`, `web/src/lib/arrange.ts` and `todo.md` are all owned by other
agents in this round. The call site needs no change — fix it at the source.

## Deliverables

1. `reverseRun` correctly remaps `segment_types` for both open and closed runs.
2. Arc geometry is preserved: the reversed run draws the same shape.
3. `blockouts`, `annotations` and `bends` positions are remapped, consistent
   with how `splitRun` / `breakOpen` handle live-arc-relative indices — read
   those first and match the existing convention rather than inventing one.
4. `direction` on a closed two-electrode run is flipped, since reversing the
   walk order inverts which arc of the loop is live.

## Tests (append to `docOps.test.ts`)

- **The invariant:** `flatRunPoints(reverseRun(run))` equals
  `flatRunPoints(run)` reversed, to 1e-9 — for an open arc run AND a closed
  arc run. This is the test that actually pins the fix; write it first and
  watch it fail against the current implementation.
- `reverseRun` twice returns the original run (coordinates, `segment_types`,
  and child indices all identical).
- A line-only run reverses exactly as it does today (no behaviour change).
- Electrode, blockout, annotation and bend positions land on the same
  geometric points after reversal.
- A closed two-electrode run's `direction` flips.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
```

Browser smoke test: draw a run, convert a segment to an arc via the node
context menu, press Reverse, and confirm the curve does not move. Then save and
reload.
