# Tier 3 #100 — Rounded rectangle, regular polygon, and star tools

> **Status:** active · drafted 2026-08-31 · branch `task/3-shape-primitives`

## Goal

The shape toolbox stops at rectangle, circle and arc (PR #10). Rounded
rectangles are the most common sign-blank outline there is, and polygons and
stars are standard trade shapes. All three are pure geometry over the existing
`web/src/lib/shapes/` pattern.

Closes NW Design Tools **rounded rect** and **polygon/star**, and promotes
**#32 Common Shapes** 🟡 → ✅ (its remaining gap is named as "rounded-rect
still missing").

## Premise, verified

`web/src/lib/shapes/` holds `rect.ts`, `circle.ts`, `arc.ts`, `offset.ts`, each
with its own test file. `rectToPoints` and `circleToPoints` both close the loop
with an exact copy of the first point so `first === last`. Follow that
convention exactly — `runArcs` and `ToSVG` depend on it.

## ⚠️ The corner-radius trap

It is tempting to build rounded corners from the new arc segments. **They
cannot express a rounded rectangle.** `segment_types` carries one fixed bulge
of 0.5, an included angle of ~106.26°, and a rounded-rect corner is 90°. Using
an arc segment would give a corner that is visibly wrong and whose radius the
operator cannot set.

So V1 **flattens corners to polylines** at a chord tolerance (default ≤0.2 mm).
Note in the code that a variable-bulge schema — Tier 3 #86's open question —
would let this become exact later, and that this is a deliberate wait rather
than an oversight.

## Strict file scope

**New:** `web/src/lib/shapes/roundedRect.ts`, `polygon.ts`, plus tests.

**Modify:** `web/src/components/EditorCanvas.tsx` (three new tools following
the existing rect/circle/arc pattern), `web/src/pages/EditorPage.tsx` (toolbar
entries + the `EditorTool` union), `README.md`.

**Don't touch:** `docOps.ts`, `internal/**`.

## Deliverables

1. `roundedRectToPoints(x1, y1, x2, y2, radiusMM, opts)` — radius clamped to
   half the shorter side; radius 0 must produce **exactly** `rectToPoints`'s
   output (assert this, it is the cheapest correctness anchor available).
2. `regularPolygonToPoints(cx, cy, radiusMM, sides, rotationDeg)` — 3 sides
   minimum. `rotationDeg` defaults to point-up, which is what an operator
   expects from a triangle or pentagon.
3. `starToPoints(cx, cy, outerR, innerR, points, rotationDeg)` — `innerR`
   defaults to a golden-ratio-ish 0.382 × outer, which is the classic 5-point
   star; the operator can override.
4. Canvas tools: drag to size, live preview, `Shift` constrains to
   square/regular via the existing `snap.ts` composition. Wire radius / sides /
   inner-ratio as tool options in the sidebar, not modal prompts.
5. All three emit ordinary closed runs that Neonize, the validator, and the
   PDF/DXF emitters accept with no special-casing.

## Tests

- `roundedRectToPoints(..., 0)` is byte-identical to `rectToPoints`
- Radius clamps at half the shorter side; an over-large radius yields a stadium
  shape, not a self-intersecting one
- Corner flattening honours the chord tolerance
- Polygon with `sides = 3, 4, 6` has the right vertex count and equal edge
  lengths to 1e-9; `sides < 3` is rejected
- Star vertex count is `2 × points`; alternating radii; `points < 3` rejected
- Every emitted shape satisfies `first === last` and `closed: true`
- Signed area is consistent in sign across all three (Neonize's inside/outside
  decision depends on winding)

## Pre-merge

Standard four checks, plus a browser smoke test: draw each shape, Neonize one,
and confirm the offset lands on the correct side. Known trap: validation
markers intercept canvas clicks — turn the error/warning overlays off first.
