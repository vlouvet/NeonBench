# Tier 1 #132 — Vectorize should return the frame it used

> **Status:** active · drafted 2026-09-02 · branch `task/1-vectorize-source-frame`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) C1

## Goal

`POST /api/vectorize` takes `target_width_mm` and maps the **raster** to that
width. Callers who have artwork of a known size reasonably pass the artwork's
width — and that is wrong whenever the raster carries padding, which it must,
or the trace clips at the edge. Every returned coordinate then comes back scaled
by the padding ratio. On Chachi's job that ratio was **0.986**: enough to walk
the tube visibly off the letterforms, and nothing in the response says so.

**Done** means the vectorize response carries the frame it actually used, so a
caller can register the returned centerline against its source exactly, without
inferring anything.

## Why this is Tier 1 and not a footnote

Because the obvious repair is also wrong, and it is wrong in a way that looks
right. Fitting the returned centerline's bbox onto the artwork's bbox
**overshoots**: a skeleton's bounding box is inset from its outline's by about
half a stroke width on every side, so the fit scales the centerline up by
roughly `1 + strokeWidth/extent`. It produces a plausible picture and is wrong
everywhere the strokes are thick — which is everywhere that matters, since thick
strokes are what channel letters are.

A caller cannot get this right from the outside. Only the server knows the
frame, so only the server can hand it over.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-vectorize-source-frame origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/server/handlers_vectorize.go` — add the frame to the response
  struct and populate it from the values the handler already computes. It knows
  the raster's pixel dimensions and the mm-per-pixel scale it derived from
  `target_width_mm`; the frame is those two facts, named.
- `web/src/api.ts` — mirror the new response fields. Additive and optional, so
  an older server's response still parses.
- `internal/server/integration_test.go` — round-trip assertion (below).

**Don't touch:**

- `internal/vectorize/` — the tracer's geometry is correct; this is a reporting
  gap, not a math one. If a change looks necessary in there, stop and say why.
- The request shape. `target_width_mm` keeps its current meaning. Redefining it
  to mean "artwork width" would silently move every existing caller's geometry,
  which is the bug this row exists to prevent, inverted.

## Response shape

Emit both the human-readable pair and the affine, because they serve different
callers and disagreeing about them later would be its own trap:

```json
"source_frame": {
  "raster_px": [w, h],
  "mm_per_px": 0.2400,
  "origin_mm": [x0, y0],
  "affine": [a, b, c, d, e, f]
}
```

`affine` maps raster pixel space to the mm space of the returned coordinates,
in the same order an SVG `matrix(...)` takes. `origin_mm` is where raster pixel
(0,0) lands. A caller that rendered its artwork into a padded raster can invert
this exactly; a caller that just wants to know the scale reads `mm_per_px`.

**Derive the affine from the same variables the coordinates were emitted with.**
Recomputing it from `target_width_mm` would let the two drift, which is the
whole failure mode being closed.

## Deliverables

1. `source_frame` on the vectorize response, populated from the handler's
   existing scale variables.
2. The TS type, additive and optional.
3. A round-trip test (below).
4. One paragraph in the endpoint's doc comment stating that `target_width_mm`
   describes the **raster**, not the artwork, and pointing at `source_frame` as
   the way to register the result. The trap is easy to re-enter; say so in the
   place someone reads first.

## Tests

- **Round-trip**: vectorize a synthetic raster with known padding, then map a
  known raster-pixel landmark through `affine` and assert it lands on the same
  landmark in the returned mm coordinates, to within a tolerance tighter than
  the padding ratio this row exists to catch (0.986 → assert well under 1%).
- **Padding invariance**: the same artwork rendered into two rasters with
  *different* padding must produce centerlines that, after being mapped through
  their own `source_frame`, agree in mm. This is the assertion whose absence let
  the 0.986 error through — it is the point of the whole row.
- **`mm_per_px` agrees with `affine`**: the scale terms must match, or a caller
  reading one gets a different answer than a caller reading the other.
- Existing vectorize tests must pass unchanged — the geometry does not move.

## Constraints

- Purely additive to the response. No geometry changes, no request changes, no
  migration.
- The bbox-fitting repair described above must not appear anywhere in the
  codebase as a convenience helper. If it is worth a warning, put it in the doc
  comment; do not ship a function that does it.
- No new third-party dependencies.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Write the padding-invariance test first; it should fail before the change is
   usable and pass after.
2. Implement, mirror the type, document the trap.
3. **Move this spec** to `specs/done/` in the final commit.

## Report back

Include the measured registration error before and after on a padded raster,
and confirm which caller in the repo (if any) is passing the artwork width today
and therefore currently misregistering.
