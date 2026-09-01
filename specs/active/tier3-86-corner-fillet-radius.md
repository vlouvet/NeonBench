# Tier 3 #86 — Corner fillet: round a vertex to a chosen radius

> **Status:** active · drafted 2026-08-31 · branch `task/3-corner-fillet-radius` · follow-up from Tier 3 #78

## Goal

Tier 3 #78 bows a **segment** into a circular arc. It works, and it flows correctly through the validator, the bend list, the takeoff, the PDF and the DXF — but an arc meets its straight neighbours at a tangent kink of half the included angle (**~53°** at the fixed bulge of 0.5). Those kinks are real corners, so the validator flags both junctions, and converting a mid-run segment reliably turns the badge red. That is the tool being accurate, not a bug — but it means #78 is useful for shaping a stroke and awkward for smoothing one.

The missing operation is the complementary one, and it is the one a bender actually performs: **round a corner to a radius.** Glass is bent *at* a vertex, on a former, to a radius the min-bend-radius rule already governs. A fillet is tangent-continuous by construction, so it introduces no kink at all.

"Done" means: right-click a vertex in node-edit → **Round corner…**, enter a radius (defaulting to the tube spec's `min_bend_radius_mm`), and the corner is replaced by a circular arc tangent to both adjacent segments. The two neighbouring segments are trimmed back to the tangent points; the arc becomes a `segment_types` arc between the two new vertices.

## Why a fillet rather than "make the arc tangent to its neighbours"

Given a segment's two fixed endpoints AND two required endpoint tangents, a single circular arc is over-constrained — in general no circle satisfies all four. You would have to move the endpoints (which moves the operator's geometry out from under them) or emit two arcs (a biarc, which needs a joint-placement rule and a second radius). A fillet sidesteps this: it *chooses* the tangent points from the radius, so the construction is always exactly determined.

Adjustable per-segment bulge is a different, smaller idea and belongs in Tier 3 #87.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-corner-fillet-radius origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/arcGeom.ts` — `filletAtVertex(prev, at, next, radiusMM)` → `{ tangentIn, tangentOut, radiusMM } | null`. Pure geometry, no doc knowledge. Returns null when the corner is straight (nothing to round), when the requested radius does not fit inside the shorter neighbouring segment, or when the vertices are degenerate.
- `internal/designdoc/arc.go` — the Go mirror, same signature and the same null cases. Both sides already share pinned constants via `arcGeom.test.ts` / `arc_test.go`; extend that pinning to the fillet.
- `web/src/lib/docOps.ts` — `roundCorner(doc, runId, vertexIndex, radiusMM)`. Replaces vertex `i` with two vertices (the tangent points) and marks the segment between them as an arc. **This op DOES change the vertex list**, unlike #78 — so it must shift electrode `point_index`, and blockout / annotation / bend `live_index`, exactly the way `insertVertex` and `insertDoubleback` already do. That index bookkeeping is the actual risk in this task; it is not the geometry.
- `web/src/lib/nodeMenuItems.ts` — a `round-corner` action, offered only at an interior vertex whose turn angle is non-zero.
- `web/src/components/EditorCanvas.tsx` + `web/src/pages/EditorPage.tsx` — menu dispatch and a small radius prompt.

**Don't touch:**

- Tier 3 #78's `setSegmentType` / `convertSegmentToArc`. A fillet is a second, independent operation; the two compose.
- The bulge constant. A fillet's radius is chosen by the operator, so `ArcBulge` does not apply to it — see the constraint below, it is the one thing likeliest to be got wrong.

## Deliverables

1. **`filletAtVertex`** in both languages, with the same pinned numbers.
2. **`roundCorner`** with full index-shift coverage.
3. **Menu item + radius entry**, defaulting to the project tube spec's `min_bend_radius_mm` — the smallest radius the glass tolerates is the most useful default, and it is already on screen in the tube-spec dropdown.
4. **Tests:** tangency (the arc's endpoint tangents must match the trimmed segments' directions to within 1e-9 — this is the whole point of the feature); radius honoured; the fit-check rejecting a radius larger than the neighbours allow; index shifting for electrodes / blockouts / annotations / bends; a validator round-trip proving a filleted corner raises **no** `min_bend_radius` issue at the requested radius, and **does** at one below the spec minimum.

## Constraints

- **A fillet's arc is NOT a bulge-0.5 arc.** `segment_types` currently says only "this segment is an arc", and every consumer derives the radius from the chord via the fixed `ArcBulge`. A fillet has an operator-chosen radius, which that model cannot express. **Resolve this before writing geometry** — the honest options are (a) store a per-segment bulge (`segment_bulges?: number[]`, parallel to `segment_types`, absent = the 0.5 default) or (b) choose the tangent points so the resulting chord makes the fixed bulge produce the requested radius. (b) needs no schema change and is tempting; it also silently changes the radius whenever a neighbouring vertex moves, which is exactly the kind of quiet drift that makes a bend list wrong. **Prefer (a).** If (a) is taken, the length check in `Polyline.UnmarshalJSON` must cover the new array too.
- **Tangency is the acceptance criterion**, not appearance. Assert it numerically.
- **Refuse rather than approximate.** If the radius does not fit, say so in the toast and change nothing.
- **One undo step.**

## Tests

Manual smoke: draw a right-angle corner with the pen tool; round it at the spec minimum; confirm the validator's bend-radius error clears and the bend list reports the requested radius. Then request a radius larger than the shorter leg and confirm a refusal, not a mangled shape.

## Pre-merge

Standard four, plus `go test ./internal/designdoc/... ./internal/printpdf/... ./internal/printdxf/...`.

## Report back

Under 250 words. PR URL, which of the two radius-representation options was taken and why, the fit-check rule, how index shifting was verified, CI state, follow-ups.

## Follow-ups

- Round *every* corner on a run in one action (composes with the Tier 2 #72 batch pattern).
- Variable-radius fillets driven by the bend-list page.
- Biarc joins for the case where the operator wants the endpoints held fixed.
