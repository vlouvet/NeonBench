# Bug #16 — Neonize offsets an arc run's chords, not its curve

> **Status:** done · PR #161 · found 2026-09-01

## Symptom

Neonize a run that contains arc segments and the generated parallel tube paths
cut straight across every bow. The source curve is ignored; the offset follows
the polygon through the run's raw vertices.

An arc's sagitta is a **quarter of its chord**, so this is not a subtle
tolerance issue — on a 200 mm arc the offset path misses the glass by 50 mm.
The result looks plausible on screen (it is a clean parallel outline of
*something*) and is wrong at the bending table.

## Root cause

`neonize` in `web/src/lib/docOps.ts` passes raw vertices straight to the offset
primitives and never consults `polyline.segment_types`:

```ts
outer = offsetPolygon(src.polyline.points, +half, offsetOpts);
inner = offsetPolygon(src.polyline.points, -half, offsetOpts);
// ... and the open-polyline pair below it
```

Four call sites, all the same mistake. `grep -c flatRunPoints web/src/lib/docOps.ts`
returns **0**.

This is the mirror image of the rule in `CLAUDE.md` → Recurring bug classes → 1.
That rule says *never flatten when you are indexing*. The other half is equally
load-bearing: **always flatten when you need the true shape.** A bbox, a length,
a hit test, or an offset that reads `polyline.points` on a run with arcs is
wrong. PR #144 got this right for bounding boxes; Neonize never did.

## Why it is newly urgent

Neonize was written before arc segments existed, so for a long time the bug was
unreachable. Two changes in the last round made it reachable:

- **Tier 2 #99** (PR #158) feeds OpenType glyph outlines into the same
  pipeline, and those are curve-heavy by nature.
- **Tier 3 #87** (PR #159) added a flip-arc menu item, making arcs easy to
  create and edit deliberately.

Three ✅ parity rows rest on this operation — NW #131 Neonize, #141 Parallel
Tube Layout, and #123 Auto Tube Layout.

## Fix

Flatten the source with `flatRunPoints(src)` from `web/src/lib/arcGeom.ts`
before offsetting.

Two things to decide and state, rather than assume:

1. **The emitted runs carry no `segment_types`.** An offset of a circular arc
   is a circular arc of a different radius, but our `segment_types` can only
   express the fixed bulge implied by a chord — so the offset curve is not
   representable and must ship as a flattened polyline. Say so in the toast or
   the docs; the operator is trading curve fidelity for a correct path.
2. **Flattening density.** `flatRunPoints` samples at whatever resolution
   `arcGeom` uses. Confirm that resolution is fine enough that the *offset*
   polyline stays within a sane chord error, and that it does not explode the
   vertex count on a glyph with many curves — check the count on a real
   OpenType `S` before and after.

## Check the neighbours while you are there

Audit, and report on each in the PR body even if unchanged:

- `simplifyRun` — Douglas–Peucker over raw points. What does it do to a run
  with `segment_types`? Dropping a vertex renumbers segments.
- `polylineLengthMM(points, closed)` — chord-based on the TS side. The Go
  `Polyline.LengthMM()` is arc-aware. If they disagree, `autoSplitOverlongTubes`
  can believe it fixed a run the validator still flags — the exact failure mode
  Tier 2 #75's spec warned about.
- `insertDoubleback`, `connectTubes` — do they assume straight segments?

Fix only what is clearly broken; file the rest.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts` (`neonize` and any neighbour you find
genuinely broken), `web/src/lib/docOps.test.ts`.

**Don't touch:** `web/src/lib/shapes/offset.ts` — the offset primitives are
correct, they are just being fed the wrong points.

## Tests

- **The invariant:** Neonize a run with one arc segment; every emitted vertex
  must sit within `spacing/2 ± tolerance` of the *true* curve, not of the
  chord. Sampling `flatRunPoints(src)` and taking the minimum distance from
  each emitted point is the honest check.
- A line-only run Neonizes **byte-identically** to today (pin this first — it
  is the regression that would hurt most).
- An `arc_r` (flipped) run offsets to the correct side.
- A closed arc run yields inner and outer paths that do not cross the source.
- Vertex-count sanity on a curve-heavy input.

## Pre-merge

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
```

Browser: draw a shape, arc a segment, Neonize, and confirm the parallel paths
follow the bow. Then load an OpenType face (PR #158), insert a curved glyph,
Neonize it, and look at the result — that is the workflow this bug breaks.
