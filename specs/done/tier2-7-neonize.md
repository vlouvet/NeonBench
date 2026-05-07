# Tier 2 #7 — Neonize / Parallel-tube layout / Auto Double-Stroke

> **Status:** done · shipped 2026-05-07 · branch `task/7-neonize`

## Goal

The single biggest neon-specific gap in the parity matrix (NW #123 Auto Tube Layout, #131 Neonize, #141 Parallel Tube Layout). All three NeonWizard rows describe the same primitive: take a closed polygon outline and emit **two parallel tube paths** offset to either side of it, so the original stroke is fabricated as a "double-stroke" / "powdered unit" that channel-letter shops use for bold, bright letters.

Today the user can vectorize a centerline (single tube), draw a closed shape with the pen tool, or import an SVG — but cannot ask the editor to "make this letter into a thick double-stroke". They have to draw both offset polylines manually with the pen tool, which is brittle and slow. NeonWizard ships this as a one-click operation.

V1 scope: polygon offset for closed polylines using miter joins with a clamp-to-bevel limit. Open polylines and self-intersecting offsets are scoped out (warned and refused).

## Branch + setup

```sh
git fetch origin
git checkout -B task/7-neonize origin/task/7-neonize
./scripts/setup-hooks.sh
```

(The parent will pre-push this branch with the spec already on it.)

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**New:**

- `web/src/lib/shapes/offset.ts` — pure geometry helper: `offsetPolygon(points, distanceMM, miterLimit?)` returns a new closed polyline offset by `distanceMM` (positive = outward, negative = inward; outward direction is determined by polygon winding)
- `web/src/lib/shapes/offset.test.ts` — vitest unit tests for the geometry

**Modify:**

- `web/src/lib/docOps.ts` — add `neonize(doc, runId, spacingMM): { doc: DesignDoc, warning?: string }` that takes the source closed run, computes inside + outside offset polylines, returns a new doc with TWO new runs replacing the source (or alongside — see deliverable 3 for the choice). Returns `warning` (non-null) when geometry produced self-intersection, acute miter clamping, or other quality issues.
- `web/src/lib/docOps.test.ts` — extend with tests for `neonize`
- `web/src/pages/EditorPage.tsx` — add a "Neonize" sidebar action on the selected run (matches the existing `simplifySelected` / `reverseSelected` pattern at lines ~404–411). Prompts for spacing in mm, calls `neonize`, surfaces the optional warning.
- `web/src/api.ts` — only if you need to extend a type. Probably not needed.
- `README.md` — one paragraph in the editor walkthrough on the Neonize operation.

**Don't touch:**

- `web/src/components/EditorCanvas.tsx` — Neonize doesn't add a canvas tool; it's a sidebar action. No editor-canvas changes needed.
- `web/src/components/VectorizePanel.tsx`, `web/src/components/PrintPanel.tsx`, `web/src/components/HersheyTextDialog.tsx`
- `web/src/pages/ProjectList.tsx`, `web/src/pages/ProjectDetail.tsx`
- `internal/storage/`, `internal/server/`, `internal/printpdf/`, `internal/printdxf/`, `internal/vectorize/`, `internal/designdoc/`
- `web/src/lib/shapes/rect.ts` / `circle.ts` / `arc.ts` / `hershey/*` — leave existing shape primitives alone

No backend changes — pure frontend geometry + UI plumbing.

## Deliverables

### 1. `offsetPolygon(points, distanceMM, miterLimit)` in `web/src/lib/shapes/offset.ts`

Pure function. Closed-polygon offset using the **angle bisector** method with miter clamping:

For each vertex `i` of the closed polygon (indices 0..n-1, with neighbors wrapping):

1. Let `d_in = unit(p[i] - p[i-1])` (incoming edge direction).
2. Let `d_out = unit(p[i+1] - p[i])` (outgoing edge direction).
3. Compute the **outward normal** of each edge — perpendicular rotated 90° clockwise relative to the polygon's winding direction. Use the winding to pick the correct sign (positive area → CCW → outward = right of forward direction; flip for CW).
4. The **vertex bisector** is the unit-length vector pointing into the offset side, between `n_in` and `n_out`. Compute as `bisector = normalize(n_in + n_out)`.
5. The **miter length** is `distanceMM / max(|cos(half_angle)|, epsilon)` where `half_angle = angle between bisector and either edge normal`.
6. If `miter_length > miterLimit * |distanceMM|`, **clamp**: instead of moving the vertex by `bisector × miter_length`, emit two vertices at the bevel — one along `n_in` and one along `n_out`, each at distance `distanceMM`. (This is the standard "miter clamp to bevel" pattern.)
7. Otherwise, the new vertex is at `p[i] + bisector * miter_length`.

Default `miterLimit = 4.0` (matches SVG's default and produces clean output for typical letter shapes; sharper than 4 starts looking spiky, more relaxed swallows real geometry).

**Winding detection** — sign of the shoelace formula over `points`. Positive = CCW (standard), negative = CW. Offset direction sign flips accordingly.

**Self-intersection check** — after computing the offset polyline, walk pairs of non-adjacent edges and test for intersection. If any are found, return the polyline anyway but flag with a `warning` field (the caller — `neonize` — surfaces this to the user).

The function signature:

```ts
export function offsetPolygon(
  points: [number, number][],
  distanceMM: number,
  miterLimit?: number,  // default 4.0
): {
  points: [number, number][];
  selfIntersected: boolean;
  miterClampedCount: number;
};
```

### 2. `neonize(doc, runId, spacingMM)` in `docOps.ts`

For the run identified by `runId`:

- **Reject if the polyline is open** — return the original doc unchanged with `warning: "Neonize requires a closed polyline (head and tail must coincide)."`. Open polylines need different geometry (parallel offset with butt-caps); deferred to Tier 3.
- **Reject if the run is shorter than 3 vertices** — return original doc + warning "Polyline is degenerate."
- Compute `outerOffset = offsetPolygon(points, spacingMM / 2, ...)`, `innerOffset = offsetPolygon(points, -spacingMM / 2, ...)`.
- Replace the source run with two new runs:
  - **`<id>-outer`**: closed polyline = `outerOffset.points`, color/diameter/notes inherited from source, no electrodes/blockouts/annotations/bends (the user re-places these on the offset runs as needed)
  - **`<id>-inner`**: closed polyline = `innerOffset.points`, same metadata inheritance
- The original run is removed from `doc.runs`. (Alternative considered: keep the original as a guide layer. Rejected for V1 — adds UI complexity for "is this run a guide?". User can simplify→neonize→delete-original via existing tools if they want a guide preview.)
- `warning` is the **concatenation of any non-empty warnings from the two offset calls** (self-intersection on either, miter clamping count if it's high). Empty string if everything was clean.

```ts
export function neonize(
  doc: DesignDoc,
  runId: string,
  spacingMM: number,
): { doc: DesignDoc; warning?: string };
```

### 3. `EditorPage.tsx` sidebar action

Add a "Neonize" button next to the existing `Simplify` and `Reverse` buttons (find them around lines 404–411). On click:

```tsx
const spacingStr = window.prompt(
  "Spacing between the two parallel tubes (mm). Tip: stroke width = 2 × tube diameter + spacing.",
  String(2 * (selectedRun.tube_diameter_mm ?? projectDiameterMM))
);
if (spacingStr === null) return;  // cancel
const spacing = Number(spacingStr);
if (!Number.isFinite(spacing) || spacing <= 0) return;

const result = ops.neonize(doc, selected, spacing);
if (result.warning) {
  setError(result.warning);  // or the existing error-surfacing channel — match the pattern simplifySelected uses
}
editDoc(() => result.doc);
```

If the run is open (failure case 1) or degenerate (failure case 2), `result.doc === doc` (no-op) and `result.warning` is surfaced to the user. The button SHOULD still be enabled for open polylines so the user gets the explanatory error rather than wondering why the button is greyed out — but a follow-up could disable it.

**Default spacing** = `2 × tube diameter` (gives roughly square cross-section between the two tubes — a decent shop default for double-stroke channel letters per Strattman NT Ch.7). User can override.

### 4. README

One paragraph in the editor walkthrough alongside the existing tool descriptions, e.g. between "Simplify" and "Reverse":

> **Neonize** — for double-stroke channel letters: select a closed run (e.g. a face outline drawn with the pen tool or imported from an SVG), click Neonize, set the spacing in mm. The single closed run is replaced with two parallel offset runs that follow the inside and outside of the original outline — that's the tube path the bender will fabricate. Tip: stroke width = 2 × tube diameter + spacing. If the geometry has acute corners or self-intersections after offset, you'll get a warning; the runs are still emitted and you can clean up with the node editor.

## Constraints

- **No new third-party deps**. Polygon offset is a couple hundred lines of pure math.
- **No backend changes** — geometry happens client-side, results flow through the existing design-doc save path.
- **Don't fix unrelated lint diagnostics** — Tier 3 #25 covers the ESLint sweep.
- **Don't refactor `simplifyRun` / `reverseRun`** — match their style for the new `neonize` op, but leave them untouched.
- This task does NOT touch `EditorCanvas.tsx`. Sidebar action only.

## Geometry / algorithm details

### Winding (shoelace formula)

```ts
function signedArea(points: [number, number][]): number {
  let a = 0;
  for (let i = 0; i < points.length - 1; i++) {
    a += points[i][0] * points[i + 1][1] - points[i + 1][0] * points[i][1];
  }
  // Close the loop
  const last = points[points.length - 1];
  const first = points[0];
  a += last[0] * first[1] - first[0] * last[1];
  return a / 2;
}
```

Positive area = CCW, negative = CW. `offsetPolygon` should normalize to one convention internally.

### Edge normals

For an edge from `p[i]` to `p[i+1]` with unit direction `d = (dx, dy)`:

- CCW polygon: outward normal = `(dy, -dx)` (right of forward)
- CW polygon: outward normal = `(-dy, dx)` (left of forward)

`offsetPolygon` should detect winding and use the consistent outward direction so positive `distanceMM` always means "expand the polygon".

### Bisector computation

```ts
const bisector = normalize([n_in[0] + n_out[0], n_in[1] + n_out[1]]);
const halfAngleCos = dot(bisector, n_in);  // = dot with n_out by symmetry
const miterLength = distanceMM / Math.max(Math.abs(halfAngleCos), 1e-6);
```

When `n_in` and `n_out` are nearly anti-parallel (180° turn = the polyline doubles back on itself, which shouldn't happen in a valid polygon but can occur in degenerate input), the bisector magnitude is near zero before normalization. Detect (`|n_in + n_out| < epsilon`) and treat as a 180° vertex — use the perpendicular direction with `miterLength = distanceMM`, OR clamp via the existing miter-clamp branch.

### Miter clamp to bevel

When `miterLength > miterLimit * |distanceMM|`:

- Emit two output vertices instead of one
- First: `p[i] + n_in * distanceMM`
- Second: `p[i] + n_out * distanceMM`
- This produces a "beveled" corner (chamfered) instead of a sharp miter spike

Track `miterClampedCount` so the caller can decide if it's worth surfacing as a warning ("3 acute corners were beveled — visually verify").

### Self-intersection check

After producing the offset polyline, walk every pair of non-adjacent edges and run a segment-segment intersection test. If any pair intersects, the offset is self-overlapping (typical at deeply concave vertices in inset offsets). Set `selfIntersected = true` and let the caller surface the warning. Don't try to repair in V1 — the user can node-edit the result.

## Tests

In `web/src/lib/shapes/offset.test.ts`:

1. **`offsetPolygon` of a 100×100 square outward by 10mm** produces a 120×120 square (4 vertices, miter=1, no clamping)
2. **`offsetPolygon` of the same square inward by 10mm** produces an 80×80 square
3. **`offsetPolygon` of a triangle with a 30° apex angle, miterLimit=4, outward by 10mm** triggers miter clamping at the apex (verify `miterClampedCount === 1`)
4. **Inset offset of a 100×100 square inward by 60mm** produces a "negative size" square: the two long sides cross — `selfIntersected === true`
5. **Winding test**: same square as input #1 but with reversed point order (CW) and the same positive `distanceMM` should still expand outward (function should be winding-agnostic for the API, normalizing internally)

In `web/src/lib/docOps.test.ts`:

6. **`neonize` on a closed square run** with `spacingMM = 20` produces 2 new runs (outer + inner), original run removed; outer is 120×120, inner is 80×80
7. **`neonize` on an open polyline** returns `{ doc: original, warning: "..." }` — no mutation
8. **`neonize` preserves color and notes** from the source run on both new runs
9. **`neonize` with a non-existent runId** returns `{ doc: original }` — no-op, no crash

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )  # advisory; no NEW diagnostics
```

## Workflow

1. **Geometry first.** Implement `offsetPolygon` + 5 unit tests in `web/src/lib/shapes/`. Get the math right against simple shapes (square, triangle) before integration.
2. **`neonize`** in `docOps.ts` + 4 tests. Run `cd web && npm test`.
3. **EditorPage button**. Manually exercise: open a project with a closed run, click Neonize, verify two parallel runs replace it.
4. **README** paragraph.
5. **Move spec** from `specs/active/` to `specs/done/` in your final commit.
6. Run all four pre-merge checks.
7. `git push origin task/7-neonize` (branch already exists on origin).
8. Open PR. Title: `Neonize / Auto Double-Stroke (Tier 2 #7)`. Body: WHY (NW #123/131/141 parity, biggest neon-specific gap), the V1 scope (closed polylines + miter offset, open polylines and self-intersection cleanup deferred), pre-merge checklist.
9. Watch CI; iterate until both `test` and `windows-smoke` are green.

## Report back

Use the format the spec specifies. Under 350 words. Include:

- PR URL
- Implementation summary (geometry helper + docOps + UI)
- Default values you settled on (miter limit, default spacing)
- File sizes for each helper
- CI final state for both checks
- Judgment calls (especially around the "destroy original run vs keep as guide" decision)
- Tier 3 follow-ups: open-polyline neonize, self-intersection cleanup pass, "join the two parallel runs into one continuous tube via U-bends at the ends" (= true single-tube double-stroke for fabrication), per-corner cap style override.
