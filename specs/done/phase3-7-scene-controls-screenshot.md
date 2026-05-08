# Phase 3 #7 — Scene chrome: background, wall backing, ambient + screenshot export

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-7-scene-controls`

## Goal

Phase 3 #1–#6 ship the rendered scene proper. To produce client-mockup-quality renders, operators need to control:

1. **Background color** — black (default), dark grey, neutral grey, white. White is critical for daytime mockups.
2. **Wall backing** — toggle a flat plane behind the tubes simulating the sign's substrate (channel-letter back-pan, raceway, blank, etc.). Configurable color (white / steel grey / black / wood-tone). When on, casts a subtle ambient shadow under the tubes.
3. **Ambient light intensity** — 0.0 (pitch black, only emission visible) to 1.0 (fully lit, every surface visible). Slider.
4. **Screenshot export** — single button, captures the current canvas to a PNG download.

"Done" means: a small floating sidebar (collapsible) on the preview page exposes the four controls; changes are live; the screenshot button downloads `<projectName>-preview-<timestamp>.png` at the canvas's display resolution.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-7-scene-controls origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Scene.tsx` — read scene-control props (background color, wall on/off + color, ambient intensity); apply via scene `<color attach="background">`, optional `<mesh>` plane behind the design, and `<ambientLight>` intensity from props.
- `web/src/preview/PreviewPage.tsx` — own the scene-control state; render the sidebar; handle screenshot capture via the existing `<Canvas>`'s `gl` accessor (drei or fiber pattern).
- `web/src/preview/preview.css` — sidebar styling.

**New:**

- `web/src/preview/SceneControls.tsx` — the floating sidebar component. Plain inputs, no fancy widgets.
- `web/src/preview/screenshot.ts` — pure helper: `captureCanvasToPNG(gl: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera, filename: string): void`. Renders one frame, reads back via `gl.domElement.toDataURL()`, triggers a download via a temporary `<a>` element.

**Don't touch:**

- `Tube.tsx`, `Electrode.tsx`, `materials/*` — unrelated.
- Backend.
- `EditorCanvas.tsx`, `EditorPage.tsx`.

## Deliverables

### Scene controls UI

Floating panel, top-right of the preview viewport. Collapsible (default expanded on first visit, persisted via component-local state — not localStorage in V1).

Controls:
- **Background**: `<select>` with options `Black (#000)`, `Dark grey (#1a1a1a — default)`, `Neutral grey (#888)`, `White (#fff)`.
- **Wall**: `<input type="checkbox">` "Show wall backing" + `<select>` for wall color (`White`, `Steel grey`, `Black`, `Wood`) — the select is disabled when wall is off.
- **Ambient light**: `<input type="range" min="0" max="1" step="0.05">` with a numeric display.
- **Screenshot**: `<button>Save PNG</button>`.

Layout: stack vertically, ~280 px wide. Each control gets a label.

### Wall backing geometry

A simple `<mesh>` plane:

```tsx
<mesh position={[bbox.center.x, bbox.center.y, -50]} rotation={[0, 0, 0]}>
  <planeGeometry args={[bbox.size.x * 1.5, bbox.size.y * 1.5]} />
  <meshStandardMaterial color={wallColor} roughness={0.7} side={THREE.DoubleSide} />
</mesh>
```

Position 50 mm behind the tubes (in -Z direction) so it's clearly a backing, not co-planar. Size 1.5× the design bbox so the design looks "mounted" on a panel that extends past it. `roughness=0.7` gives it a slightly diffuse look that catches the bloom from emissive tubes.

Wall colors:
- `White` → `#f0f0f0`
- `Steel grey` → `#888888`
- `Black` → `#222222`
- `Wood` → `#8a6a3a` (no texture map in V1; just a color)

### Screenshot capture

```ts
// screenshot.ts
import * as THREE from 'three';

export function captureCanvasToPNG(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  filename: string,
): void {
  // Force one render so the canvas has a fresh frame
  gl.render(scene, camera);
  const dataURL = gl.domElement.toDataURL('image/png');
  const a = document.createElement('a');
  a.href = dataURL;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
```

In `PreviewPage`, `useThree()` (or `useThree(state => state)`) inside a child component gets access to `gl/scene/camera` for the capture handler. Filename: `{project.name}-preview-{Date.now()}.png` with the project name URL-safe-encoded.

**Note**: `toDataURL` works because `<Canvas preserveDrawingBuffer>` is set OR the `gl.render(scene, camera)` call right before captures the latest frame. Default fiber `<Canvas>` doesn't preserve, so the explicit render is non-negotiable.

### Defaults

- Background: `#1a1a1a` (matches the existing dark scene).
- Wall: off.
- Ambient: 0.3 (matches existing).

These three together produce the same visual as Phase 3 #4 ships, so this PR is a strict superset (no regressions).

## Constraints

- **No new dependencies.**
- **No backend changes** (screenshot is pure client-side).
- **No edit affordances** beyond these controls.
- **State is component-local** — no URL params, no localStorage. Persistence is a follow-up.
- **Wall plane MUST NOT z-fight with the tubes** — keep the 50 mm Z offset; if a future spec adds tube-back-rim "spillage" closer to the wall, revisit.
- **Screenshot at display resolution** — V1 doesn't offer 2× / 4× export. That's a follow-up.
- **No video export in V1** — the original Phase 3 deliverable list mentions screenshot AND video; video is hard (frame timing, encoding) and deferred.

## Tests

For `screenshot.ts`, a vitest test that confirms calling `captureCanvasToPNG` with a stub `gl` (mock `domElement.toDataURL` returning `'data:image/png;base64,FAKE'`) triggers an anchor click + download attribute. Verify filename formatting.

For the controls themselves — manual smoke.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open preview. Sidebar appears top-right.
2. Background → White. Scene background changes; emission still visible (might need a higher bloom intensity to read against white — flag as follow-up if too dim).
3. Ambient → 1.0. Tube glass becomes visible (no longer dark base color).
4. Wall on, color = Steel grey. A grey panel appears behind the design; tubes look "mounted" on it.
5. Click "Save PNG". A PNG downloads with the right filename. Open it; the image matches the on-screen view.
6. Sidebar collapses cleanly.

## Workflow

1. Build `screenshot.ts` + tests.
2. Build `SceneControls.tsx` (plain inputs, no widgets).
3. Wire scene-control state through PreviewPage → Scene → child components.
4. Add wall plane geometry to Scene.
5. Manual smoke through every control change.
6. Pre-merge checks.
7. Open PR titled "Phase 3 scene chrome + screenshot (Phase 3 #7)".
8. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially the bloom-vs-light-background trade-off; whether you needed to tune the bloom luminance threshold from #4 when on a white background; the wall plane Z offset value), file-size deltas, CI state, screenshot of the preview at every control extreme (white-bg + ambient 1.0 vs black-bg + ambient 0.0), follow-ups (URL-state persistence, 2×/4× screenshot, video export, wood-grain texture map for the wall, per-design HDRI environment maps).
