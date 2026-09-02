# Tier 2 #133 — Emit centerlines as curves, not polylines

> **Status:** active · drafted 2026-09-02 · branch `task/2-curve-centerlines`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) A2

## Goal

`vectorize` emits pure polylines — measured on Chachi's job, **2115 `L` commands
and zero curve segments**, and `grep` finds no bezier or spline emission
anywhere in `internal/vectorize/`. That is exactly right for a bend list and
wrong for any picture: at proof scale every vertex reads as a facet on the
glass, and the sign looks faceted in a way a customer rejects.

**Done** means a caller can ask vectorize for a smooth rendering of the same
centerline, while the polyline it already returns stays the geometry the bender
works from.

## The workaround that does not work

Raising `smoothing_mm` until the faceting disappears **also walks the centerline
off the letterform it is supposed to run down**. You trade a visible defect for
an invisible one, which is worse: the faceted version is obviously wrong and the
over-smoothed version is quietly wrong. Do not implement this row by widening
the existing knob or by changing its default.

## What worked outside the tool

Fitting **centripetal Catmull-Rom** cubics, α = 0.5, converted to Bézier.

Centripetal specifically. Uniform Catmull-Rom (α = 0) overshoots into a cusp
wherever two samples sit close together — which is precisely what happens at the
tight turns in a script, i.e. the places this feature exists to improve. Pin
α = 0.5 as a named constant with that sentence next to it, or someone will
"simplify" it to the uniform form and the regression will look like a rendering
glitch rather than a parameterization error.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-curve-centerlines origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/vectorize/` — a new file for the fit. Pure function: `[]Point` in,
  cubic segments out. It must not modify the polyline it was handed.
- `internal/server/handlers_vectorize.go` — a `curves` boolean on the request,
  default **false**, and the smoothed output on the response.

**Don't touch:**

- The existing polyline path or `smoothing_mm`. Both keep their current
  behaviour and their current defaults byte-for-byte; a caller that does not ask
  for curves must get exactly what it gets today.
- `internal/designdoc` and `segment_types`. **This is not an arc feature.** The
  doc's arc segments carry a fixed bulge and exist to describe bendable glass;
  these cubics are a rendering artifact and must never enter a `Doc`.

## Emit cubics, not arcs — and this is load-bearing

The validator sees SVG (`ToSVG` → `ValidateSVG`) and **its parser does not
implement `A`**: it approximates an elliptical arc as a straight line and warns.
Emitting arcs here would make any downstream validation of the smoothed output
silently wrong. Cubic `C` commands are understood everywhere in this codebase.

## Deliverables

1. Centripetal Catmull-Rom → Bézier fit, with α pinned and justified in a
   comment.
2. `curves` request option (default false) and the smoothed geometry on the
   response, alongside — not instead of — the polyline.
3. A comment at the emission point stating in one sentence that the polyline is
   the fabrication source of truth and the curves are for pictures.
4. Tests below.

## Tests

- **Interpolation**: every input sample lies on the emitted curve (Catmull-Rom
  interpolates; a fit that merely approximates would let the tube drift off the
  letterform, which is the failure mode of the smoothing workaround).
- **No cusp on close samples**: construct the pathological case — two samples
  much closer than their neighbours, at a tight turn — and assert the centripetal
  fit stays within a tolerance band that the uniform (α = 0) fit provably
  exceeds. Assert both, so the test documents *why* α = 0.5.
- **Length is not materially changed**: total arc length of the smoothed path
  within a small percentage of the polyline's. A fit that shortcuts corners
  would under-report glass if anyone ever measured it.
- **Default is unchanged**: without `curves`, the response is byte-identical to
  today's for a fixed input. Golden test.
- **No curve reaches a `Doc`**: assert the smoothed output is absent from any
  design-doc round trip.

## Constraints

- No new third-party dependencies — the fit is about forty lines of arithmetic.
- Degenerate inputs must not panic: fewer than three samples, coincident
  samples, and a closed loop all need defined behaviour. A two-point polyline
  smooths to itself.
- Closed polylines wrap; open ones need an end condition. State which was chosen
  and why in a comment.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Fit and tests first, in isolation from the handler.
2. Wire the option; confirm the default path is byte-identical.
3. **Move this spec** to `specs/done/` in the final commit.

## Report back

Include the `L`-vs-`C` command counts for the same input before and after, and
the measured length delta.
