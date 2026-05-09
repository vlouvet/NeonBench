# Tier 3 #77 — Drop-bend annotation kind

> **Status:** active · drafted 2026-05-09 · branch `task/3-drop-bend-annotation` · NW parity (special-bend toggle)

## Goal

NW distinguishes between **flat bends** (the default in-plane bend) and **drop bends** (a localized out-of-plane offset where the tube briefly drops away from the substrate). The operator double-clicks a node to toggle. NW chooses the default by angle: shallow angles render as flat, sharp angles as drops.

NeonBench's annotation kinds today: `'jump'`, `'support'`, `'doubleback'`. A jump's geometry is "tube arcs out of plane to pass over another tube" — close to a drop bend but not the same. A drop bend is the trade convention for "this bend goes down behind the substrate at an angle the bender flames specifically." It's distinct vocabulary that affects bend-list emission and 3D rendering.

"Done" means: a fourth annotation kind `'drop_bend'` with its own geometry, sidebar count, marker overlay style, and bend-list line-item; 3D preview lifts the tube at a drop-bend annotation by `0.5 × diameter` (vs 2.5× for jumps — drops are subtler).

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-drop-bend-annotation origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — extend the `Annotation.Kind` enum with `"drop_bend"`. Existing kinds + JSON shape unchanged. (Pure additive.)
- `web/src/api.ts` — mirror the kind union (`'jump' | 'support' | 'doubleback' | 'drop_bend'`).
- `web/src/components/EditorCanvas.tsx` — render drop_bend annotations with a distinct marker (small downward chevron) at the polyline vertex; clickable via the existing annotation-marker pattern.
- `web/src/preview/tube-geom.ts` — extend `liftPointsAtJumps` to also lift at drop-bend annotations, but with `JUMP_LIFT_HEIGHT_MULT = 0.5` (vs 2.5 for jumps). Different MULT so the visual reads as "small drop" not "big horseshoe."
- `web/src/preview/segment-split.ts` — pass-through `dropBendPolylineIndices` alongside the existing `jumpPolylineIndices`.
- `internal/printpdf/render.go` — emit a "DROP" line-item in the bend list at each drop-bend annotation, distinct from jump's "JUMP" line.
- `internal/dxf/dxf.go` — emit drop-bend markers on the MARKERS layer (CIRCLE, radius 4mm, DASHED linetype, label "Drop").
- `internal/dxf/dxf_test.go` — golden bytes for a drop-bend doc.

**Don't touch:**

- Existing jump / support / doubleback render paths (additive only).
- 3D preview's existing jump-cluster logic — drop-bends don't cluster with jumps (different geometric semantic).

## Deliverables

1. **`Annotation.Kind = "drop_bend"`** as a fourth kind. JSON-blob storage; no migration.
2. **2D editor render** — small downward-chevron marker at the vertex; tooltip "Drop bend"; clickable like other annotations.
3. **3D preview lift** — `liftPointsAtJumps` extended to receive a separate `dropBendPolylineIndices` array; lifts at half the jump height (`0.5 × diameter`) with the same raised-cosine kernel. Composes with jump lifts (max-of, not sum-of) when both kinds appear on the same run.
4. **Bend list PDF** — drop-bend annotations contribute "DROP" entries to the per-run bend list, ordered by arc length.
5. **DXF MARKERS** — drop-bend annotations emit on the MARKERS layer with their own linetype + label per the PR #94 convention.
6. **Tests** — annotation round-trip; 3D-preview lift kernel composition; PDF bend-list ordering; DXF golden bytes.

## Constraints

- **Additive only** — existing kinds unchanged byte-for-byte.
- **No schema migration** — JSON-blob.
- **Lift geometry small** — drop-bends are subtle; 0.5× diameter reads as "tube drops slightly" rather than "tube horseshoes."
- **Don't add UI for special-bend angle-based default toggle** — V1 is operator marks the kind explicitly. NW's auto-default-by-angle is a follow-up.

## Tests

Manual smoke:

1. Mark a drop-bend at a tube vertex via the existing annotation tool (extended with a "Drop bend" option). Marker appears.
2. 3D preview shows the tube dipping slightly at that vertex (vs the bigger horseshoe at jump annotations).
3. Print PDF bend list: the run's bend list includes a "DROP" line at the right arc-length offset.
4. DXF export: MARKERS layer has a CIRCLE+TEXT pair labeled "Drop" at the vertex.

## Pre-merge

Standard four. Plus `go test ./internal/dxf/...`.

## Workflow

1. Schema enum extension + Go round-trip.
2. 3D preview lift composition + test.
3. 2D editor marker render.
4. PDF bend-list emission.
5. DXF MARKERS emission + golden test.
6. Pre-merge + smoke.
7. PR titled `Drop-bend annotation kind (Tier 3 #77)`.

## Report back

Under 200 words. PR URL, lift-height multiplier chosen for drop-bends (0.5× vs other), how the kernel composes with jump lifts on the same run, marker glyph design choice, CI state, follow-ups.

## Follow-ups

- Auto-default-by-angle (NW's behavior): when the operator double-clicks a vertex with no annotation, suggest `drop_bend` if the bend angle exceeds a threshold (e.g. 60°), otherwise no annotation.
- Per-project override on the lift multiplier (some shops want subtler drops).
- "Toggle special bend" context menu item via Tier 3 #76's NodeContextMenu.
