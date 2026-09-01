# Tier 3 #87 — Arc polish: flip the bow, and hit-test the curve

> **Status:** active · drafted 2026-08-31 · branch `task/3-arc-polish` · follow-up from Tier 3 #78

> **Priority raised 2026-08-31.** This is no longer polish. Bug #11 established
> that a boolean arc flag **cannot survive a reversal**: `arcFor` always bows
> left of travel, so reversing a chord moves the arc centre to the other side
> (probed: forward `(50, -37.5)`, reversed `(50, +37.5)`). Three ops reverse
> point order — `reverseRun`, `joinRuns.reversedRun`, and the mirror in
> `arrange.ts` — and until the side is storable, two of them silently deform
> arc runs. The user approved the schema change on 2026-08-31. Deliverable 5
> below is the reason this ships.

## Goal

Two known, deliberately-deferred gaps from Tier 3 #78. Both are small, independent, and each is separately shippable — take them together only because they touch the same two files.

**1. An arc always bows the same way.** `ArcFor` fixes the side to the chord direction rotated to `(-dy, dx)`. That was the right V1 call — it keeps "convert to arc" a pure toggle, so converting the same segment twice cannot walk the curve across its chord — but an operator who wants the other side currently has no way to ask, short of reversing the run.

**2. The 2D hit test picks a curved segment by its chord.** Rendering, measurement, validation and export all follow the curve; only *clicking* does not. On a strongly-bowed segment the click target sits up to a quarter of the chord away from the glass the operator is aiming at, which is worst on exactly the segments that are most obviously curved.

"Done" means: a **Flip arc** menu item on any arc segment, and a hit test that measures distance to the arc.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-arc-polish origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — the side has to be storable. `segment_types` currently carries `"line" | "arc"`; the minimal honest extension is a third value `"arc_r"` (bows the other way), which keeps the existing length invariant and the existing unmarshal validation with a one-line change. A parallel `segment_sides` array would also work and is worse: two arrays to keep in step, for one bit.
- `internal/designdoc/arc.go` + `web/src/lib/arcGeom.ts` — `ArcFor` / `arcFor` take the side. Everything downstream already derives from them, so this is the only geometry change; `SegmentTangents`, `ArcCubics`, `FlattenSegment` and the bulge sign in DXF all follow. **The DXF bulge must go negative for a flipped arc** — that is how the format encodes direction, and getting it wrong sends the bender a mirror-image curve.
- `web/src/lib/nodeMenuItems.ts` — a `flip-arc` action, offered only on a segment that is already an arc.
- `web/src/components/EditorCanvas.tsx` — `nearestRunId` / the run-path hit test consult the flattened curve (`flatRunPoints`) rather than `polyline.points` when a run has arcs. `runHasArcs` already exists precisely so the no-arc fast path stays free.

**Don't touch:**

- The bulge magnitude. Adjustable radius is Tier 3 #86's problem.
- The vertex list. Flipping changes which side the curve bows to, nothing else.

## Deliverables

1. **Side stored, round-tripped and validated** — including the Go unmarshal check accepting the new value and rejecting anything else, and an old blob with no array still loading as all-line.
2. **`flip-arc` menu item** with the geometry following in all six emitters (2D canvas, 3D preview, print SVG/EPS/PDF, DXF).
3. **Curve-aware hit testing.**
4. **Tests:** a flipped arc's apex is the mirror of the unflipped one about the chord; the DXF bulge is `-0.5`; the validator measures the same arc *length* either way (the glass is the same, only its side changed); a click 20 mm from the apex of a bowed segment selects that run, and the same click on the unbowed version does not.
5. **Every point-order-reversing op preserves arc geometry.** This is the
   deliverable that turns three latent bugs into non-bugs, and it is the one to
   get right:
   - `reverseRun` (`docOps.ts`) — Bug #11 / PR #149 fixed the index remapping
     but explicitly could not fix the bow, and left a test marked to be
     replaced when this schema lands. Replace it.
   - `joinRuns.reversedRun` (`docOps.ts`) — same fix; see Bug #14, which may
     already have landed the index half.
   - `mirrorRuns` (`web/src/lib/arrange.ts`) — **read this one before
     changing it.** Mirroring today reverses vertex order *on purpose*, so the
     two handedness flips cancel and the shape is preserved. Once the side is
     storable, that trick is no longer needed and may become a double-flip bug.
     Either keep the reversal and leave the side flag alone, or drop the
     reversal and flip the flag — not both. Its existing invariant test
     (`flatRunPoints(mirrored)` equals the mirrored `flatRunPoints(original)`)
     must still pass either way; if it doesn't, you have double-flipped.

   The invariant for reversal is the mirror image of the one Bug #11 could not
   meet: `flatRunPoints(reverseRun(r))` must equal `flatRunPoints(r)` reversed,
   to 1e-9, for both open and closed arc runs.

## Constraints

- **A flipped arc is the same length.** If any measurement changes when the side flips, the geometry is wrong.
- **Reversal becomes shape-preserving, not shape-changing.** After this lands,
  reversing an arc run must leave the drawn curve exactly where it was; only
  the direction of travel changes. That is what "reverse" has always claimed.
- **Back-compat:** an existing `"arc"` keeps meaning today's side. No migration, no re-interpretation of stored docs.
- **The no-arc path must stay free.** Guard the hit test on `runHasArcs`.

## Tests

Manual smoke: convert a segment, flip it, confirm the 2D canvas, the 3D preview and the printed PDF all bow the same way; export the DXF and confirm the bulge sign. Then click just inside the bow of a strongly-curved segment and confirm it selects.

## Pre-merge

Standard four, plus `go test ./internal/designdoc/... ./internal/printdxf/...`.

## Report back

Under 200 words. PR URL, how the side is stored and why, the DXF bulge sign check, what the hit test measures against, CI state, follow-ups.

## Follow-ups

- Drag the apex to set both side and bulge in one gesture (subsumes the flip item, and overlaps Tier 3 #86's radius question — sequence them).
- Hit-test the 3D preview against the curve too; it currently picks nothing, so this is additive rather than a fix.
