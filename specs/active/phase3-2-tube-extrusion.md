# Phase 3 #2 — Tube extrusion: Run.Polyline → THREE.TubeGeometry

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-2-tube-extrusion`

## Goal

Phase 3 #1 established the scene scaffold with a placeholder cube. This spec replaces that cube with real geometry: every `Run.Polyline` in the design doc gets extruded into a 3D tube along its 2D path with the correct diameter pulled from the run's tube spec or override.

"Done" means: opening the preview on any saved project shows every run rendered as a glass-tube-shaped 3D object at the right scale, on a flat XY plane (Z=0). Closed runs close their tubes; open runs leave end-caps. The material is still placeholder (`MeshBasicMaterial` colored white-ish) — emissive glass + per-gas color come in Phase 3 #3.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-2-tube-extrusion origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/preview/Scene.tsx` — replace the placeholder cube with a `<group>` mapping over `doc.runs` and rendering one `<Tube run={run} project={project} />` per run.

**New:**

- `web/src/preview/Tube.tsx` — single-run tube component. Takes `{run, project}` props, builds a `THREE.CatmullRomCurve3` from the run's polyline points (Z=0), computes the tube radius from `run.diameter_mm_override ?? project.tube_spec.diameter_mm` halved, returns `<mesh><tubeGeometry args={[curve, segments, radius, radialSegments, closed]} /><meshBasicMaterial color="#dddddd" /></mesh>`.
- `web/src/preview/tube-geom.ts` — pure helpers: `polylineToCurve(points: Point[]): THREE.CatmullRomCurve3`, `tubeSegmentCount(points: Point[]): number` (heuristic: roughly 1 segment per 5 mm of path length, clamped to [16, 256]).
- `web/src/preview/tube-geom.test.ts` — test the helpers without instantiating three.js geometry directly (just verify curve point count, segment count clamps, etc.).

**Don't touch:**

- `PreviewPage.tsx` — already loads the doc; no changes needed.
- Any backend file.
- `EditorCanvas.tsx`, `EditorPage.tsx`, `App.css`.
- `materials/` (will be created in Phase 3 #3).

## Deliverables

### Curve construction

Convert `Run.Polyline.Points` (an array of `{x, y}` in mm) into a `THREE.CatmullRomCurve3`. Each 2D point becomes `new THREE.Vector3(x, -y, 0)` — note the **Y-flip**: the design doc uses screen-Y (down-positive) per the existing editor convention; three.js convention is Y-up, so flip on conversion. Document the flip in a comment.

For closed polylines (`Run.Polyline.Closed === true`), pass `closed: true` to the curve constructor and `closed: true` to `tubeGeometry`. For open, leave both false.

### Segment count

Higher segment counts → smoother tubes but more polys. Target: ~1 segment per 5 mm of total polyline length, clamped to `[16, 256]`. A typical 1000-mm-long letter run gets 200 segments; a tiny 30-mm electrode pin would get the floor of 16. `radialSegments` is `8` (eight-sided cross-section is plenty at typical viewing distances; matches the visual feel of glass tube).

### Diameter

`radius = (run.diameter_mm_override ?? project.tube_spec.diameter_mm) / 2`. Default to `12 / 2 = 6 mm` if both are missing (defensive — should never happen on a valid doc).

### Position + orientation

Tubes lay flat on the XY plane (Z=0). The scene camera in Phase 3 #1 sits at `[0, 0, 1500]` looking at origin, so a typical 1000×500 mm design fills the view. Phase 3 #5 (camera) will tighten this with `fitToContent`.

### Material (placeholder)

`<meshBasicMaterial color="#dddddd" />` — flat white-ish, no lighting response. Phase 3 #3 swaps this for the emissive glass shader.

### Closed-tube edge case

A closed run's tube has no end caps, which is correct (it's a closed loop). An open run's tube has open end caps from `tubeGeometry` — the geometry library doesn't auto-cap. For V1 leave open ends visibly open; Phase 3 #5 (electrodes) will draw `SphereGeometry` caps on top of electrode positions which incidentally hide the open ends most of the time.

## Constraints

- **No new dependencies** beyond Phase 3 #1's set.
- **No backend changes.**
- **No edit affordances** — preview stays read-only.
- **No optimization for very long polylines** — a 10k-point polyline at 1 segment / 5 mm would produce 2000 segments, hit the clamp, and stay performant. Don't add LOD or culling in V1.
- **No animation in V1** — the tubes are static. Animation (warm-up flicker, etc.) is a far-future follow-up.
- **Y-flip is non-negotiable** — neon designs are conventionally upright; the document's `+y down` convention must invert on the way to three.js's `+y up` so neon signs aren't displayed upside-down.

## Geometry / algorithms

```ts
// tube-geom.ts
import * as THREE from 'three';

export function polylineToCurve(points: Array<{x: number; y: number}>, closed: boolean): THREE.CatmullRomCurve3 {
  // Y-flip: design doc uses +y down; three.js uses +y up.
  const v3 = points.map(p => new THREE.Vector3(p.x, -p.y, 0));
  if (v3.length < 2) {
    // Defensive: a 1-point run shouldn't render as a tube. Phase 3 #2 punts on this.
    // Caller filters; this helper trusts the input.
    return new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0), new THREE.Vector3(1,0,0)]);
  }
  return new THREE.CatmullRomCurve3(v3, closed, 'catmullrom', 0.5);
}

export function tubeSegmentCount(points: Array<{x: number; y: number}>): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y);
  }
  const segs = Math.round(len / 5);
  return Math.max(16, Math.min(segs, 256));
}
```

`CatmullRomCurve3` smooths between control points — the rendered tube has gentle curves where the polyline has sharp angles. This is the right look for neon (glass tube can't bend on a dime). If a future version wants polylines rendered as polylines (faceted), swap to `LineCurve3` segments and concatenate via `CurvePath`. Document the choice.

## Tests

`tube-geom.test.ts`:

- `polylineToCurve([{x:0,y:0}, {x:100,y:0}], false)` returns a curve with `points.length === 2` after Y-flip → `[(0,0,0), (100,0,0)]`.
- `polylineToCurve([{x:0,y:0}, {x:0,y:100}], false)` Y-flips → `[(0,0,0), (0,-100,0)]`.
- `polylineToCurve(closed=true, ...)` returns `closed === true`.
- `tubeSegmentCount([{x:0,y:0}, {x:1000,y:0}])` returns 200 (1000 mm / 5).
- `tubeSegmentCount([{x:0,y:0}, {x:30,y:0}])` returns 16 (clamped).
- `tubeSegmentCount` of a 5000 mm polyline returns 256 (clamped at top end).

No three.js render tests — the visual is the spec.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open the OPEN sign demo project (or any saved project with multiple runs).
2. Navigate to the preview route.
3. Each run renders as a 3D tube; the design as a whole is recognizable (e.g. "OPEN" reads correctly — not mirrored from the Y-flip bug).
4. Open + closed runs both render correctly (closed runs form rings; open runs have open ends).
5. DevTools confirms 60 fps with the most complex saved project you have.
6. Larger-diameter runs are visibly thicker than smaller-diameter ones (test with a project that has a per-run diameter override).

## Workflow

1. Build `tube-geom.ts` + tests first; verify all six cases.
2. Build `Tube.tsx` consuming the helpers.
3. Update `Scene.tsx` to map over `doc.runs`; remove the placeholder cube.
4. Manual smoke through every saved project's preview.
5. Pre-merge checks.
6. Open PR titled "Phase 3 tube extrusion: Run.Polyline → TubeGeometry (Phase 3 #2)".
7. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially Catmull-Rom smoothing vs faceted; segment-count heuristic), file-size deltas, CI state, frame rate on the most complex project tested, follow-ups (faceted-tube fallback for sharp-corner geometries; LOD for very long signs; per-run animated paths showing tube fill order).
