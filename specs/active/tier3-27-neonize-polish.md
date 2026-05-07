# Tier 3 #27 — Neonize polish

> **Status:** active · started 2026-05-07 · branch `task/27-neonize-polish`

## Goal

PR #26 shipped Neonize for closed polylines (angle-bisector polygon offset with miter clamping). Four follow-ups carry forward as Tier 3 #27:

1. **Open-polyline neonize.** Today the `neonize` op rejects open inputs. Extend to handle them: emit two parallel offsets with butt caps at the endpoints (no closing geometry).
2. **Self-intersection cleanup.** Sharp concave corners on small input shapes can produce offset loops where the inner offset crosses itself. Detect and trim these auto-overlaps so the user doesn't have to node-edit them out.
3. **End-stitching via U-bends.** A "true" double-stroke fabrication uses one continuous tube that walks the outer offset, hairpins at one end, returns along the inner offset, and hairpins back. Stitch the two parallel runs into a single continuous run via U-bends at the ends.
4. **Per-corner cap-style override.** Today the only cap control is global miter limit. Add per-corner styles: round, bevel, miter — selectable on each vertex of the source polyline before neonize runs.

"Done" means: open polylines neonize correctly with butt caps; self-intersections in the inner offset are auto-trimmed; an opt-in "stitch ends" toggle on the Neonize button produces one continuous run; corner-style overrides round-trip through the source polyline's metadata.

## Branch + setup

```sh
git fetch origin
git checkout -b task/27-neonize-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/shapes/offset.ts` — add an `offsetOpenPolyline(points, distance)` helper, extend `offsetPolygon` to detect and prune self-intersection loops, add per-vertex cap-style support.
- `web/src/lib/shapes/offset.test.ts` — new tests.
- `web/src/lib/docOps.ts` — `neonize` accepts open polylines, an optional `stitch: boolean` parameter (default false → keep current two-run output), and a `cornerStyles?: ('miter'|'round'|'bevel')[]` array sized to the source polyline's vertex count.
- `web/src/lib/docOps.test.ts` — extend.
- `web/src/pages/EditorPage.tsx` — Neonize button gains a small popover or set of options: "Stitch ends (single tube)" toggle. Per-corner cap styles edit through a vertex-detail panel — out of scope for this PR if it bloats; flag in the report.

**Don't touch:**

- `EditorCanvas.tsx` — no canvas changes (the cap-style UI lives in a sidebar/popover, not the canvas itself).
- Backend.

**New:** none.

## Deliverables

### 1. Open-polyline neonize

`offsetOpenPolyline(points, distance)`:
- Walk each segment; compute the perpendicular offset.
- At interior vertices, use the angle-bisector miter from `offsetPolygon` (with the existing miter limit + bevel clamp).
- At endpoints, emit a butt cap — no closing arc, no extension. The two parallel runs are open polylines that share endpoint X-coordinates with the source's first/last points (offset perpendicular to the source's first/last segment direction).

`neonize` for open inputs: produce two output runs `<id>-outer` / `<id>-inner` (numeric IDs per Tier 3 #25 convention if it ships first; otherwise keep the existing suffix style).

### 2. Self-intersection cleanup

When the inner offset of a small concave corner crosses itself, it forms a loop. Detection:
- After `offsetPolygon`, scan adjacent segments for crossings (segment-segment intersection test).
- When a crossing is found between segments `[i, i+1]` and `[j, j+1]` where `j > i+1`, splice the polyline: keep `points[0..i]`, insert the intersection point, then `points[j+1..end]`. This trims the loop.
- Repeat until no crossings remain or a max-iteration guard (e.g. 32) prevents pathological input from infinite-looping.

This is a heuristic. Document its limitations (figure-8 self-intersections aren't handled; that's still a manual node-edit job).

### 3. End-stitching

When the user clicks Neonize with `stitch: true`:
1. Produce outer + inner offsets as today.
2. Concatenate: outer + reverse(inner).
3. At each end, splice in a hairpin U-bend (depth = 1.5 × tube ø, gap = spacingMM — same convention as PR #18 Insert Doubleback). The hairpin connects the last point of outer to the first point of reversed-inner (and the same on the other end).
4. Emit ONE run `<id>-stitched` instead of two; mark it closed = false (the source's openness flag is irrelevant — the stitched output is always one continuous open path with electrodes presumably at the seam).

When `stitch: false` (default), keep current two-run output.

### 4. Per-corner cap styles

Add `cornerStyles?: ('miter'|'round'|'bevel')[]` to `neonize`. Length must equal the source polyline's vertex count. Default (when omitted) = `'miter'` everywhere with the existing global miter-limit fallback.

For each interior vertex:
- `miter` → existing angle-bisector with miter limit.
- `bevel` → straight chamfer between the two offset edges (skip the miter point).
- `round` → an arc (sampled to ~5–10 polyline points) between the two offset edges.

The cap-style array lives in `neonize`'s parameters only for V1 — it isn't persisted in the design doc. The implementing UI is left for a follow-up; this PR ships the geometry.

## Constraints

- **Backwards compatible:** calling `neonize(doc, runId, spacingMM)` with no new args produces identical output to today.
- **No new third-party deps.**
- **No editor canvas refactor** for the cap-style UI; sidebar/popover only. If you can't fit it into existing patterns within the spec scope, ship the geometry + the stitch toggle, defer per-corner UI to a future row.

## Geometry / algorithms

**Segment-segment intersection.** For two segments `(a, b)` and `(c, d)`:

```
denom = (b.x-a.x)*(d.y-c.y) - (b.y-a.y)*(d.x-c.x)
if abs(denom) < eps: return null   // parallel
t = ((c.x-a.x)*(d.y-c.y) - (c.y-a.y)*(d.x-c.x)) / denom
u = ((c.x-a.x)*(b.y-a.y) - (c.y-a.y)*(b.x-a.x)) / denom
if 0 ≤ t ≤ 1 and 0 ≤ u ≤ 1:
   return (a.x + t*(b.x-a.x), a.y + t*(b.y-a.y))
return null
```

**Round-cap arc** at vertex `v` between offset endpoints `p` and `q`: center = `v`, radius = `|distance|`, sample N points on the arc swept from `p` to `q` in the shorter direction. N proportional to the swept angle (e.g. one point per 10° of arc).

## Tests

Add to `offset.test.ts`:

- **`offsetOpenPolyline at 90° corner`** produces a clean L-shape with butt caps at both ends.
- **`offsetPolygon trims self-intersection`** — small concave triangle whose inner offset would loop produces a polyline with no segment-pair intersections.
- **`offsetPolygon cap styles`** — same input with `cornerStyle = 'bevel'` has a chamfered corner; with `'round'` has multiple polyline points along the arc.

Add to `docOps.test.ts`:

- **`neonize stitch produces one continuous run`** — input closed polygon, `stitch=true`, output has 1 run not 2, length ≈ sum of outer + inner + 2 hairpins.

## Pre-merge checks

Standard four. Manual smoke:

1. Draw an open zig-zag polyline; click Neonize. Expect two parallel runs with butt caps.
2. Draw a tight zigzag (small inner radii); click Neonize. Expect no self-intersection in the result.
3. Toggle Stitch ends; click Neonize. Expect one run. Validation reports no broken-tube errors.
4. (Stretch — only if cap-style UI lands) Right-click a vertex, change to "round", re-neonize. Confirm the rounded corner.

## Workflow

1. Open-polyline offset + tests.
2. Self-intersection trim + tests.
3. Stitch via U-bends.
4. Cap-style geometry (UI optional).
5. Pre-merge + smoke.
6. PR titled "Neonize polish: open polylines, self-intersection trim, stitch, cap styles (Tier 3 #27)".
7. **Move this spec** to `specs/done/`.

## Report back

Under 300 words. Include: PR URL, hairpin defaults reused from PR #18 (yes/no), cap-style UI shipped or deferred, perf measurement on a large polyline (e.g. 200 vertices), CI state, follow-ups (figure-8 self-intersection handling, persistent cap-style metadata in DesignDoc).
