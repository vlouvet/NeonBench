# Tier 3 #68 — Jump annotations lift the tube in the 3D preview

> **Status:** active · drafted 2026-05-08 · branch `task/3-jump-offset-3d`

## Goal

`Annotation.kind === 'jump'` is the trade vocabulary for "the tube physically arcs out of plane here so it can pass over another tube without touching it." Today the annotation is informational-only — the editor draws a marker, the print PDF picks it up, and the 3D preview ignores it entirely. Result: two crossing tubes render as flat coplanar geometry that visibly intersects (see screenshot from project 21232 v33). The viewer can't tell which tube is the jumper.

"Done" means: every `kind: 'jump'` annotation on a run causes that run's tube geometry to lift smoothly out of the XY plane (Z+) for a localized span centered on the jump's polyline point. The lift is a "horseshoe" arc — smooth start, peak at the jump point, smooth descent — sized relative to the run's tube diameter. Two crossing tubes now read as one passing *over* the other in 3D.

## Branch + setup

```sh
git checkout -b task/3-jump-offset-3d origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/tube-geom.ts` — extend `polylineToCurve` to accept either `[x, y]` or `[x, y, z]` tuples. Add new constants `JUMP_LIFT_HEIGHT_MULT` (default `1.0` × tube diameter) and `JUMP_LIFT_SPAN_MULT` (default `4.0` × tube diameter). Add a new pure helper `liftPointsAtJumps(points, jumpPolylineIndices, diameterMM): [number, number, number][]` that returns 3D points with Z lifted by a raised-cosine kernel centered on each jump.
- `web/src/preview/segment-split.ts` — extend `RunSegment` with `jumpPolylineIndices: number[]` (the polyline indices for jumps that fall inside this segment, in run-coordinate space). Pass jumps through `splitRunBySegments` by walking `run.annotations`, filtering kind === 'jump', translating each `live_index` → polyline-index via the existing `runArcs(run).live`.
- `web/src/preview/Tube.tsx` — `TubeSegment` reads `segment.jumpPolylineIndices`; calls the new `liftPointsAtJumps` helper to produce 3D points before feeding them to `polylineToCurve`. Pass through `diameterMM` so the lift scales with tube size.
- `web/src/preview/tube-geom.test.ts` (new) — pin the lift function math: zero jumps = unchanged Z, one jump produces peak-at-center smoothly-falling raised-cosine, two jumps far apart produce two independent peaks (max not sum), out-of-range jump indices are silently skipped.

**Don't touch:**

- `Annotation` schema in `web/src/api.ts` or `internal/designdoc/types.go` — V1 reuses the existing `kind: 'jump' / live_index: int` model.
- `Electrode.tsx` — electrode caps stay flat at Z=0. The jump lifts the tube; the electrodes are at endpoints, not jumps.
- The PDF / DXF / validator — those already handle jumps correctly. The bug is preview-only.
- `EditorCanvas.tsx` — 2D editor view stays flat; the lift is a 3D-preview affordance only.

## Deliverables

1. **`liftPointsAtJumps` helper** in `tube-geom.ts`. Pure function, jsdom-safe (no THREE.js mesh dependency — just math on tuples). For each polyline point, compute Z = max over jumps of `liftFn(arcDistanceToJump)`. Use a raised-cosine kernel:
   ```ts
   function liftKernel(d: number, span: number, height: number): number {
     if (d >= span / 2) return 0;
     const k = (d / (span / 2)) * (Math.PI / 2);
     const c = Math.cos(k); // 1 at center, 0 at edge
     return height * c * c;  // squared for smoother shoulders
   }
   ```
   Distance is **arc length** along the polyline (sum of segment lengths from the point to the jump's polyline point), NOT Euclidean — so the lift follows the tube's path even around tight corners.
2. **`polylineToCurve` 2D/3D overload.** Existing call sites passing `[x, y]` tuples must keep working unchanged (Z=0). New call sites pass `[x, y, z]` tuples and the Z is honored. Internally normalize to 3D Vector3 with `Y` always flipped (`y_three = -y_doc`) — same convention as today.
3. **Segment-split pass-through.** Each `RunSegment` carries a `jumpPolylineIndices: number[]` field. The split walks the run's annotations once, translates each jump's `live_index` to a polyline index via `runArcs(run).live[liveIndex]`, then per-segment includes only those jumps whose polyline index falls inside the segment's slice. Jumps inside a blockout segment are still applied (a jumper can be painted-out — the geometry still lifts).
4. **Tube renders the lift.** `TubeSegment` calls `liftPointsAtJumps(segment.points, segment.jumpPolylineIndices, diameterMM)` before feeding to `polylineToCurve`. Memoize keyed by segment + jump indices so unrelated re-renders don't rebuild geometry.
5. **Constants tuned for trade reality.** `JUMP_LIFT_HEIGHT_MULT = 1.0` (lift = 1 × tube diameter, ≈ 12 mm for the 12 mm spec) and `JUMP_LIFT_SPAN_MULT = 4.0` (lift span = 4 × diameter, ≈ 48 mm). These match how shop benders draw a "small u-bend over" on a hand-drawn pattern. Tunable per-project is a follow-up.
6. **Unit tests** in `tube-geom.test.ts`:
   - Empty `jumpPolylineIndices` → all Z = 0.
   - Single jump at index `i` → Z[i] = `JUMP_LIFT_HEIGHT_MULT * diameter`; Z falls smoothly to 0 at distance `JUMP_LIFT_SPAN_MULT * diameter / 2`; Z = 0 outside the span.
   - Two jumps far apart → two independent peaks, Z between them = 0.
   - Two jumps closer than span → max (not sum) at the overlap so the lift doesn't double.
   - Jump index out of range (< 0 or ≥ points.length) → silently skipped, no NaN.
   - Y-flip preserved: existing 2D-input tests in any consumer keep passing.

## Constraints

- **No new dependencies.**
- **No backend / schema changes.** Annotations stay as-is.
- **Don't recompute lifts inside `useFrame`.** The geometry rebuild belongs in a `useMemo` keyed by segment points + jump indices + diameter, same pattern as the existing TubeGeometry memo.
- **Pure-CPU compute.** No GLSL, no shader displacement. The 5 mm-per-segment density already gives us a smooth Catmull-Rom; lifting the existing control points is the right knob.
- **Don't touch the editor's 2D view.** Some shops use top-down 2D for layout review; the lift would distort that read.
- **Don't lift jumpers in print PDF / DXF.** Bender pattern stays flat — the operator forms the lift by hand at fab time.

## Geometry / algorithms

```ts
// Per-point Z lift = max over jumps of raised-cosine(arc-distance, span, height).
// `points` is the segment's 2D polyline slice; `jumpIndicesInSegment` is the
// subset of jumps whose polyline index falls inside this segment.
export function liftPointsAtJumps(
  points: ReadonlyArray<readonly [number, number]>,
  jumpIndicesInSegment: ReadonlyArray<number>,
  diameterMM: number,
): [number, number, number][] {
  const span = JUMP_LIFT_SPAN_MULT * diameterMM;
  const height = JUMP_LIFT_HEIGHT_MULT * diameterMM;
  if (jumpIndicesInSegment.length === 0 || diameterMM <= 0) {
    return points.map(([x, y]) => [x, y, 0]);
  }
  // Pre-compute cumulative arc lengths along the segment.
  const arcAt: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    arcAt.push(arcAt[i - 1] + Math.hypot(x2 - x1, y2 - y1));
  }
  // Filter jumps to in-range, compute their arc positions.
  const jumpArcs = jumpIndicesInSegment
    .filter((j) => j >= 0 && j < points.length)
    .map((j) => arcAt[j]);
  return points.map(([x, y], i) => {
    let z = 0;
    for (const ja of jumpArcs) {
      const d = Math.abs(arcAt[i] - ja);
      if (d >= span / 2) continue;
      const k = (d / (span / 2)) * (Math.PI / 2);
      const c = Math.cos(k);
      const lift = height * c * c;
      if (lift > z) z = lift;
    }
    return [x, y, z];
  });
}
```

## Tests

Required cases enumerated above. Plus manual smoke on project 21232 v33:

1. Open `/projects/8/versions/33/preview` (the project with two crossing tubes the user flagged).
2. Click Iso preset. The crossing should now read as one tube arching over the other, not two coplanar lines.
3. Toggle wall backing on; the lifted tube should still cast its bloom on the wall (no Z-fight artifacts at the lift apex).
4. Project 9 v35 (OPEN sign) — must render unchanged because it has no jump annotations.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Add `liftPointsAtJumps` + tube-geom test cases. Verify all green in isolation.
2. Extend `polylineToCurve` for 3D input.
3. Plumb `jumpPolylineIndices` through `splitRunBySegments`.
4. Wire into `Tube.tsx`'s `TubeSegment` memo.
5. Rebuild bundle + binary; manual smoke on 21232 v33 + 9 v35.
6. Pre-merge checks.
7. Open PR `Lift jump-annotated tubes out of plane in 3D preview (Tier 3 #68)`.

## Report back

Under 200 words. Include PR URL, screenshots of the before/after on the test project, whether `JUMP_LIFT_HEIGHT_MULT = 1.0` reads right at typical preview zoom (or wants tuning to 0.75 / 1.5), follow-ups (per-project lift-height override, animated jump assembly when arming the editor's Mark-jump tool, lift on `kind: 'doubleback'` annotations too — the trade convention is similar).
