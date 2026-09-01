# Tier 3 #78 — Arc ↔ line segment conversion in node-edit

> **Status:** SHIPPED 2026-08-31 · branches `task/3-arc-line-segment-conversion`
> (backend, PR #141) + `task/3-arc-line-editor` (editor) · NW parity
>
> **Shipped as two PRs.** The backend half — schema, geometry and every Go
> consumer — landed first and was inert on its own, so there was never a state
> where arcs existed and an emitter mishandled them. The editor half followed.
>
> **Representation: a circular arc, not a bezier.** The spec asks for a bezier
> with control points at chord/4. A circle through the same endpoints with the
> same sagitta is exact in SVG, PDF and DXF; its length is r·θ in closed form
> (so **deliverable 4's Simpson's rule is not implemented and not needed**);
> and it has a real radius, so a curve too tight for the glass is caught by the
> min-bend-radius rule rather than at the bench. The sagitta/half-chord ratio
> is 0.5 — exactly AutoCAD's bulge — so DXF emits it as a native LWPOLYLINE
> bulge with nothing approximated.
>
> **Deliverable 6 emits a bulge, not an `ARC` entity.** Same geometry, but it
> stays inside the existing LWPOLYLINE instead of adding a second entity kind,
> and the vertex list the bender's CAM reads is unchanged.
>
> **Emitted as cubics in SVG, not an `A` command.** `internal/validate/pathd.go`
> does not implement elliptical arcs — it approximates them as a straight line
> and warns — so an `A` would have had the validator measure every curve as its
> chord.
>
> **Known and deliberate: converting a mid-run segment creates two corners.**
> An arc meets its straight neighbours at a tangent kink of half the included
> angle (~53°), which is a genuine sharp bend, and the validator flags both
> junctions. That is the tool telling the truth, not a defect — but it means
> "convert to arc" on a straight run usually produces two new bend-radius
> errors. Tangent-continuous joins would need a different curve model; that is
> a follow-up, not a fix.
>
> **Not done: the 2D hit test still uses the chord.** Clicking a curved segment
> picks it by its straight span, so the hit region is slightly off for a
> strongly-bowed segment. Rendering, measurement and export all follow the
> curve; only picking does not.
>
> **Split into two PRs.** The backend half (schema, geometry, and every Go
> consumer) ships first and is inert on its own — nothing can create an arc
> yet, so all existing docs behave identically. The editor half (TS types,
> ops, canvas render, context-menu items) follows. The split avoids a state
> where arcs exist but some emitter silently mishandles them.
>
> **Representation: a circular arc, not a bezier.** The spec asks for a bezier
> with control points at chord/4. A circle through the same two points with the
> same sagitta is strictly better here: exact in SVG, PDF and DXF with no
> approximation, an exact arc length (no Simpson's rule needed), and — the one
> that matters — a real radius, so the min-bend-radius rule catches a curve too
> tight for the glass instead of it being found at the bending table. The
> sagitta/half-chord ratio is 0.5, which is exactly AutoCAD's bulge, so DXF
> emits it as a native LWPOLYLINE bulge with nothing lost.
>
> **Deliverable 4 (Simpson's rule) is therefore not implemented** — a circular
> arc's length is r·θ in closed form.

## Goal

NW polylines support both arc (curved) and line (straight) segments. The node-edit menu lets the operator toggle a segment between the two — useful for fine-tuning a Hershey-imported letter where one stroke wants to be curved and another straight.

NeonBench polylines today are line-only (`Run.Polyline.Points: [number, number][]`). The drawing tool shipping for arcs (PR #10 / Tier 1 #3) approximates arcs as polylines at draw time. There's no post-hoc way to mark a segment as a "true arc" — the geometry is committed as N small linear segments.

"Done" means: extend `Run.Polyline` with an optional `SegmentTypes: string[]` array (one entry per segment, parallel to `Points`); values `'line' | 'arc'`. The validator + bend-list + DXF emitters all honor the new field. Node-edit context menu (Tier 3 #76) gains a "Convert to arc" / "Convert to line" toggle. Default = `'line'` for back-compat.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-arc-line-segment-conversion origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — extend `Polyline` with `SegmentTypes []string` (omitempty; nil = all-line). Length must equal `len(Points) - 1` (segment-count) when non-empty. Validate at unmarshal: reject bad lengths.
- `web/src/api.ts` — mirror the field. TypeScript: `segment_types?: ('line' | 'arc')[]`.
- `web/src/lib/docOps.ts` — `convertSegmentToArc(doc, runId, segmentIndex): Doc`; `convertSegmentToLine(doc, runId, segmentIndex): Doc`. Both lazily allocate the `segment_types` array (filling with `'line'`) when first set.
- `web/src/components/EditorCanvas.tsx` — render arc segments as SVG `<path>` cubic-bezier between the two endpoints, with control points placed perpendicular to the chord at distance `chord_length / 4` (forms a gentle arc). Selection ring + hit test extend to the curved path.
- `web/src/lib/runArcs.ts` — `arcLength` walks segments respecting their type (line: Euclidean; arc: bezier arc length via 4-step Simpson). The bend-list and validator already consume `arcLength`.
- `internal/printpdf/render.go` — emit arc segments as bezier curves to the PDF (preserves the curve for the bender pattern). Bend-list per-vertex angle changes account for the arc's tangent at each endpoint.
- `internal/dxf/dxf.go` — emit arc segments as DXF `ARC` entities (R12 supports). Bender CAM consumes them natively. Also include in golden tests.

**Don't touch:**

- The drawing-tool arc primitive (still emits approximate polylines on draw — converting them post-hoc to true arcs is the operator's choice via the node-edit menu).
- 3D preview tube geometry — the existing CatmullRomCurve3 already smooths through line segments; arc segments flow into it the same way.

## Deliverables

1. **Schema extension** — `SegmentTypes []string`, omitempty, length-validated.
2. **`convertSegmentToArc` / `convertSegmentToLine`** with tests (round-trip; back-compat with `nil` array).
3. **2D editor render** — arc segments draw as quadratic bezier with auto-positioned control points (chord-perpendicular, distance = `chord_length / 4`). Hit testing covers the curve.
4. **`arcLength` arc-aware** — Simpson's rule with 4 sub-intervals over the bezier (tight enough for bend-list mm precision).
5. **PDF emission** — arc segments draw as bezier on the page. Bend-list angle change uses the bezier's endpoint tangents.
6. **DXF emission** — arc segments emit as `ARC` entities (R12 supports it natively).
7. **Tests** — TS round-trip; arc-length-vs-line-length differential; DXF golden bytes; PDF golden test for a 1-arc 1-line polyline.

## Constraints

- **Length invariant** — `SegmentTypes` is one shorter than `Points` (segments, not vertices). Reject mismatched arrays at unmarshal.
- **Default = line** — every existing doc loads with `nil` and renders identically.
- **Auto control points** — V1 doesn't expose bezier control points to the operator. Each arc is "the simplest gentle curve through these two endpoints"; explicit control-point editing is a follow-up.
- **No new schema migration** — JSON-blob storage.

## Tests

Manual smoke:

1. Open a Hershey letter. Right-click a segment → "Convert to arc." The straight chord becomes a gentle curve.
2. Print PDF: the curve is drawn. Bend list reports the arc's endpoint angle changes correctly.
3. DXF export: the arc is an `ARC` entity (verify by inspecting the file).
4. Round-trip via bundle: arc segments survive.
5. 3D preview: the tube glides through the arc curve smoothly.

## Pre-merge

Standard four. Plus `go test ./internal/printpdf/... ./internal/dxf/...`.

## Workflow

1. Schema + unmarshal validation + Go round-trip test.
2. `convertSegmentToArc` / `Line` ops + tests.
3. EditorCanvas curved-segment render + hit test.
4. arcLength arc-aware (Simpson's rule).
5. PDF bezier emission + bend-list angle correctness.
6. DXF `ARC` emission + golden test.
7. Pre-merge + smoke.
8. PR titled `Arc ↔ line segment conversion (Tier 3 #78)`.

## Report back

Under 250 words. PR URL, control-point auto-placement formula chosen, Simpson's rule sub-intervals (4 vs more), DXF `ARC` entity geometry chosen (center+radius+start-angle+end-angle from the bezier endpoints), CI state, follow-ups.

## Follow-ups

- Explicit bezier control-point editing (drag handles in node-edit).
- Auto-arc on drawing tools (the pen tool emits arcs by default for curved input strokes).
- Tier 3 #76 NodeContextMenu items "Convert to arc" / "Convert to line."
