# Phase 3 #5 — Orbit camera + preset views + fit-to-content

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-5-orbit-camera`

## Goal

Phase 3 #1 ships a fixed `<PerspectiveCamera>` at `[0, 0, 1500]`. Operators need to orbit, pan, and zoom — and to snap to common preset views (front, iso, top, side) to assemble a client preview from a known angle.

This spec adds:
1. `<OrbitControls>` from `@react-three/drei` for mouse-driven camera movement.
2. A preset-view button bar above the canvas: Front / Iso / Top / Side.
3. `fitToContent` — a function that computes the design's bbox and positions the camera so the whole sign is visible with margin.
4. Initial-load behavior: scene auto-fits to content on mount (so the first frame shows the whole design, not a tiny dot in the corner).

"Done" means: operators can rotate the scene with click-drag, zoom with wheel, pan with right-click-drag (or two-finger trackpad gesture). The four preset buttons reposition the camera smoothly. Initial load is correctly framed.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-5-orbit-camera origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Scene.tsx` — add `<OrbitControls>`; pass through camera ref so preset buttons can reposition.
- `web/src/preview/PreviewPage.tsx` — add the preset-view button bar above the `<Canvas>`. Compute initial camera-fit position from `doc.runs` bbox.
- `web/src/preview/preview.css` — button bar styling.

**New:**

- `web/src/preview/cameraPresets.ts` — pure helpers: `bboxOfDoc(doc): {min, max, size, center}`, `cameraPositionForPreset(preset, bbox): {position, target}`. The four presets are computed from the bbox so the framing always fits the design.
- `web/src/preview/cameraPresets.test.ts` — unit tests for the bbox + preset math.

**Don't touch:**

- `Tube.tsx`, `materials/*`, backend, EditorCanvas/EditorPage, App.css.

## Deliverables

### `<OrbitControls>` configuration

```tsx
import { OrbitControls } from '@react-three/drei';

<OrbitControls
  enableDamping={true}
  dampingFactor={0.1}
  minDistance={50}      // can't zoom inside a tube
  maxDistance={5000}    // generous outer limit for big signs
  enablePan={true}
  panSpeed={1.0}
  rotateSpeed={0.7}
  zoomSpeed={1.0}
/>
```

`enableDamping` adds a slight ease to camera movement, makes orbit feel less abrupt. The min/max distances clamp absurd zooms — operator can't accidentally end up inside a tube or 100 km away.

### Preset views

Four buttons in a horizontal bar above the `<Canvas>` (sticky, doesn't scroll with content):

- **Front** — camera at `(center.x, center.y, center.z + zDist)`, looking at center. Standard "as the customer sees it" view.
- **Iso** — `(center.x + d, center.y + d, center.z + d)` where `d = max(size.x, size.y, size.z) * 1.5`. Three-quarter view, classic "marketing render" angle.
- **Top** — `(center.x, center.y + zDist, center.z)`. Bird's-eye, useful for layout review.
- **Side** — `(center.x + zDist, center.y, center.z)`. Profile view, useful for confirming tube depth (when Phase 3 #6 ships return strips).

`zDist = bbox.size.length() * 1.5` — the bbox diagonal × 1.5 is enough margin that the design fits comfortably.

Clicking a preset animates the camera over ~600 ms via the existing `OrbitControls`'s `target` + camera position interpolation (drei's `<OrbitControls>` exposes `controlsRef.current.target.set()`; combine with manual `camera.position.lerpVectors()` per frame in a small `useFrame` for the duration of the animation).

### Initial fit-to-content

On `<Canvas>` mount, compute the doc bbox, set the camera to the **Front** preset, and target the bbox center. Without this, the user gets a glimpse of the default `[0,0,1500]` framing before they reach for the camera.

### Bbox computation

```ts
// cameraPresets.ts
export interface Bbox {
  min: THREE.Vector3;
  max: THREE.Vector3;
  size: THREE.Vector3;
  center: THREE.Vector3;
}

export function bboxOfDoc(doc: DesignDoc): Bbox {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (const run of doc.runs) {
    for (const p of run.polyline.points) {
      min.x = Math.min(min.x, p.x);
      min.y = Math.min(min.y, -p.y);  // Y-flip per Phase 3 #2
      max.x = Math.max(max.x, p.x);
      max.y = Math.max(max.y, -p.y);
    }
  }
  // Z is always 0 in V1 (flat tubes). Add 1 mm padding so size.z > 0.
  min.z = -0.5;
  max.z = 0.5;
  if (!isFinite(min.x)) {
    // Empty doc fallback — don't NaN out
    min.set(-100, -100, -0.5);
    max.set(100, 100, 0.5);
  }
  const size = new THREE.Vector3().subVectors(max, min);
  const center = new THREE.Vector3().addVectors(max, min).multiplyScalar(0.5);
  return { min, max, size, center };
}
```

Empty-doc fallback prevents the camera from defaulting to NaN positions when previewing a brand-new blank design.

## Constraints

- **No new dependencies** — `OrbitControls` is in drei, already bundled.
- **No backend changes.**
- **No animation library** — the 600 ms ease-to-preset animation is a small `useFrame` loop, not framer-motion.
- **No edit affordances.**
- **OrbitControls + presets coexist** — clicking a preset writes the camera position; the orbit controls then take over from there. Don't disable the controls during preset animation; just let the animation finish before user interaction takes over.
- **Pinch-zoom on trackpad** must work (drei's OrbitControls handles this by default; verify on macOS).

## Tests

`cameraPresets.test.ts`:

- `bboxOfDoc` on a 1000×500 mm two-run sign returns the right min/max/size/center (with Y-flipped).
- `bboxOfDoc` on an empty doc returns the fallback bbox with non-zero size.
- `cameraPositionForPreset('front', bbox)` returns a position centered on bbox center, distance = bbox diag × 1.5.
- Same for `iso`, `top`, `side`.
- Negative-coordinate fixtures (a doc whose runs sit in negative X/Y) compute correct bbox.

For the camera animation itself, no automated test — manual smoke covers it.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open preview on a project. Initial load shows whole design centered + correctly sized.
2. Click-drag orbits the camera; wheel zooms; right-click-drag pans.
3. Click each preset button; camera animates to the new view smoothly.
4. After a preset, click-drag continues to work (controls aren't broken by the animation).
5. Zoom out to max distance — camera stops smoothly at the limit.
6. Empty doc (a new blank design) doesn't crash; renders correctly.

## Workflow

1. `cameraPresets.ts` + tests first.
2. `<OrbitControls>` in Scene.tsx.
3. Preset button bar in PreviewPage.tsx.
4. Initial fit-to-content logic on mount.
5. Manual smoke.
6. Pre-merge checks.
7. Open PR titled "Phase 3 orbit camera + preset views (Phase 3 #5)".
8. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, summary, judgment calls (especially the animation duration; the bbox margin factor; whether OrbitControls' damping defaults stuck), file-size deltas, CI state, follow-ups (camera bookmarks per project; saved screenshots tied to specific camera positions; touch-device gesture refinements for tablets).
