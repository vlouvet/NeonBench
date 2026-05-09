# Tier 3 #78 — Arc ↔ line segment conversion in node-edit

> **Status:** active · drafted 2026-05-09 · branch `task/3-arc-line-segment-conversion` · NW parity (node-edit menu item)

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
