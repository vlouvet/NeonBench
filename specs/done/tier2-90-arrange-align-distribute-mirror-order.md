# Tier 2 #90 — Arrange: align, distribute, mirror, depth order

> **Status:** done 2026-08-31 · branch `task/2-arrange-ops` · PR #TBD

## Goal

NeonBench can select many runs but can do almost nothing to them as a set. A
layout artist laying out a word in channel letters currently nudges each letter
by hand. This slice adds the four arrangement primitives every drawing program
has, operating on the existing multi-selection (`selectedRunIds`):

- **Align** — left / horizontal-center / right / top / vertical-center / bottom
- **Distribute** — even horizontal or vertical spacing
- **Mirror** — flip the selection horizontally or vertically about its own bbox
- **Depth order** — bring to front / forward / backward / send to back

Closes four NeonWizard Design Tools parity rows (alignment, distribute, mirror,
stack/depth order).

## Branch + setup

```sh
git checkout -b task/2-arrange-ops origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command
```

## Strict file scope

**New:**

- `web/src/lib/arrange.ts` — every op, pure functions over `DesignDoc`
- `web/src/lib/arrange.test.ts`
- `web/src/components/ArrangePanel.tsx` — the sidebar UI

**Modify:**

- `web/src/pages/EditorPage.tsx` — ONE new `<PanelSection>` rendering
  `<ArrangePanel>`, plus the handlers that call into `arrange.ts`. Route every
  mutation through the existing `applyOp` helper, not a bare `editDoc`.
- `README.md` — a short paragraph in the editor walkthrough.

**Don't touch:** `EditorCanvas.tsx` (a parallel agent owns it this round),
`web/src/lib/docOps.ts`, `internal/**`, `todo.md` (checkmarks ship in the
round's cleanup PR, per CLAUDE.md).

## Deliverables

1. `runBBoxMM(run)` — the **arc-aware** bounding box. A run with arc segments
   bows outside the hull of its vertices, so a bbox built from
   `run.polyline.points` is wrong. Use `flatRunPoints(run)` from
   `web/src/lib/arcGeom.ts`.
2. `selectionBBoxMM(doc, runIds)` — union of the per-run boxes.
3. `alignRuns(doc, runIds, edge)` where edge is
   `'left'|'hcenter'|'right'|'top'|'vcenter'|'bottom'`. Translates each run so
   the named edge of its own bbox meets that edge of the selection bbox.
   Fewer than 2 runs is a no-op returning the same doc object.
4. `distributeRuns(doc, runIds, axis)` for `'h'|'v'`. Sorts by bbox center on
   that axis, pins the two extremes, and spaces the interior **centers**
   evenly. Fewer than 3 runs is a no-op.
5. `mirrorRuns(doc, runIds, axis)` for `'h'|'v'`, about the selection bbox
   center. See the trap below — this one is not a coordinate negation.
6. `reorderRuns(doc, runIds, move)` for
   `'front'|'forward'|'backward'|'back'`. Draw order is `doc.runs` array order
   (`EditorCanvas.tsx:2108`), so this is an array permutation. Preserve the
   relative order of the moved runs among themselves and of everything else.
7. `ArrangePanel` — a compact icon/label grid, disabled with a reason when the
   selection is too small for the op. Show the selection count.

## The mirror trap (read this before writing `mirrorRuns`)

`arcFor(p0, p1)` in `web/src/lib/arcGeom.ts` bows the arc toward the chord
normal `(-dy, dx)` — a **handedness-dependent** side. A mirror reverses
handedness. So negating x on a run that has an arc segment produces a shape
whose arcs bow the *opposite* way: the on-screen curve, the printed pattern and
the DXF bulge all silently become wrong, while every point-based test passes.

Reversing the run's point order flips the chord direction and restores the
side, but then `polyline.segment_types` must be reversed too (index i is the
segment *leaving* vertex i, so a reversed n-point run's types are the old array
reversed and shifted), and every index-referencing child — `electrodes[].point_index`,
`bends[]`, `blockouts[]`, `annotations[]` — must be remapped. `reverseRun` in
`docOps.ts` already does exactly this remapping; read it and reuse the approach
(you may import it; do not edit it).

**The acceptance test, which is what actually pins this:** build a run with at
least one `'arc'` segment, mirror it, and assert that
`flatRunPoints(mirrored)` equals the coordinate-mirrored
`flatRunPoints(original)` as a point set, to 1e-9. Do the same for a run with
no arcs. If your implementation only satisfies the no-arc case, it is wrong.

## Constraints

- No new dependencies. No schema change — every op rewrites
  `polyline.points` / reorders `doc.runs` within the existing types.
- Ops must be pure: same input doc object returned when nothing changes, so
  `applyOp`'s identity check and the undo coalescing keep working.
- Locked groups: a run whose group has `locked: true` must be excluded from
  arrangement, matching the canvas's existing lock semantics. Hidden runs stay
  included (hidden ≠ deleted).
- Mirroring and aligning must leave `run.id`, `group_id`, `raceway_id`,
  `kind`, `is_channel_letter_face` and all per-run overrides untouched.

## Tests

`web/src/lib/arrange.test.ts` must cover:

- bbox of a run whose arc bows outside its vertex hull (arc-aware, not hull)
- each of the six align edges on a 3-run selection, hand-computed
- distribute h and v on 4 runs with uneven spacing; extremes must not move
- **mirror of an arc run — the flattened-points invariant above** (h and v)
- mirror twice = identity (to 1e-9)
- all four reorder moves, including front-of-front and back-of-back no-ops
- multi-run reorder preserving relative order
- no-op guards: 1 run for align, 2 for distribute; same object identity back
- a locked-group run is excluded while its unlocked neighbours move

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
go vet ./...
```

Then smoke test in a real browser (`cd web && npm run dev`, plus
`./bin/neonbench --dev`): select three runs, align, distribute, mirror, and
reorder; confirm the canvas updates, one Cmd+Z reverts each action as a single
step, and "Save as new version" round-trips (a 400 from the save endpoint means
you emitted a field the Go structs reject — `DisallowUnknownFields` is on).

## Out of scope (log as follow-ups, don't build)

- Aligning to the page/viewBox rather than the selection
- Rotate-by-angle and numeric-entry transforms
- Align to a "key object" (last-clicked) rather than the bbox
