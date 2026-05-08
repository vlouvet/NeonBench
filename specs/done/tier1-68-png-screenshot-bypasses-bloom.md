# Tier 1 #68 — PNG screenshot bypasses bloom

> **Status:** done · drafted 2026-05-08 · branch `task/1-png-screenshot-bypasses-bloom`

## Goal

The Phase 3 preview's "Save PNG" button (PR #62, scene chrome + screenshot export) calls `gl.render(scene, camera)` directly inside `captureCanvasToPNG`. That routes through the bare `WebGLRenderer` pipeline and **skips the `EffectComposer`** that owns bloom (Phase 3 #4 / PR #63). Result: the on-screen view shows the full bloom halo around emissive tubes, but the downloaded PNG is a flat-emissive render with no bloom — the file looks like the user had `?nobloom` in the URL even when they didn't.

The user flagged this against project 9 v35 ("the outputted PNG doesn't have a glow"). It's a Tier 1 fix because PNG export is a primary shop deliverable — operators send the PNG to the customer for sign-off, and a flat render misrepresents the design.

"Done" means: clicking "Save PNG" downloads a PNG that contains the bloom halos, identical to what the user sees on screen. The `?nobloom` debug path keeps working — when bloom is off in the URL, the PNG also has no bloom (consistent with the on-screen state).

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-png-screenshot-bypasses-bloom origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Scene.tsx` — capture the live `EffectComposer` instance from inside `<EffectComposer>` and pipe it back up through the existing `onCaptureReady` callback as a new `composer?: EffectComposer | null` field on `CaptureContext`. When `?nobloom` short-circuits the composer wrap, the field is `null` (or absent) — the screenshot helper falls back to the bare-renderer path.
- `web/src/preview/screenshot.ts` — `captureCanvasToPNG` accepts an optional `composer?: { render(): void } | null`. When provided, call `composer.render()` instead of `gl.render(scene, camera)` so the PNG comes from the post-process pipeline. When absent (or null), keep the current bare-render fallback so `?nobloom` users still get a PNG.
- `web/src/preview/PreviewPage.tsx` (or wherever `onCaptureReady` is consumed) — store the `composer` from the bridge alongside the existing `gl/scene/camera`, and pass it to `captureCanvasToPNG`.
- `web/src/preview/screenshot.test.ts` (extend or new) — pin the new behavior: with a composer, `captureCanvasToPNG` calls `composer.render()` and not `gl.render()`; without one, it still calls `gl.render()` (back-compat).

**Don't touch:**

- The `EffectComposer` config itself (intensity, threshold, radius — those live as `BLOOM_*` constants in Scene; row 55 in todo.md tracks surfacing them).
- `?nobloom` URL-param handling — that's a debug path; preserve current behavior.
- `internal/...` — backend doesn't render PNGs.
- The `<EffectComposer>` MSAA / multisampling settings.

## Deliverables

1. **Composer bridge.** Inside Scene's `<EffectComposer>` subtree, render a sibling helper (analogous to `ScreenshotBridge`) that calls a new prop on `onCaptureReady` to expose the composer's `render()` method. Two natural ways:
   - A `composerRef` on `<EffectComposer ref={...}>` if `@react-three/postprocessing` exports a typed ref. Verify with `node_modules/@react-three/postprocessing/dist/index.d.ts`.
   - A child component using `useThree`'s render-target hooks plus `useEffect` to grab the composer instance. The package's source uses an internal `EffectComposerContext` that may be importable.
   
   Pick whichever lands cleanly without forking the dep. The bridge MUST handle composer churn: on a context-loss event the composer is rebuilt, so the same `useEffect`-cleanup-passes-null pattern as `ScreenshotBridge` applies.

2. **`captureCanvasToPNG` accepts a composer.** Signature change:
   ```ts
   export function captureCanvasToPNG(
     gl: THREE.WebGLRenderer,
     scene: THREE.Scene,
     camera: THREE.Camera,
     filename: string,
     env?: DownloadEnv,
     composer?: { render(): void } | null,
   ): void
   ```
   The composer is optional / nullable so the existing test fixtures keep working.
   
   When `composer` is truthy, call `composer.render()` (forces one frame through bloom + writes to backbuffer).
   
   When `composer` is null/undefined, keep the existing `gl.render(scene, camera)` line for the `?nobloom` and degraded-fallback cases.

3. **PreviewPage wires it up.** The existing `onCaptureReady` callback now receives `{ gl, scene, camera, composer }`. Pass `composer` through to `captureCanvasToPNG` on the screenshot button click.

4. **Type updates.** Extend `CaptureContext` in `Scene.tsx`:
   ```ts
   export interface CaptureContext {
     gl: THREE.WebGLRenderer;
     scene: THREE.Scene;
     camera: THREE.Camera;
     composer?: { render(): void } | null;
   }
   ```

5. **Unit tests.** In `screenshot.test.ts`:
   - `captureCanvasToPNG(gl, scene, camera, fname, env, composer)` invokes `composer.render()` exactly once and does NOT invoke `gl.render`.
   - `captureCanvasToPNG(gl, scene, camera, fname, env)` (no composer arg) calls `gl.render(scene, camera)` (back-compat).
   - `captureCanvasToPNG(..., env, null)` falls back to `gl.render` (`?nobloom` case).

## Constraints

- **No new third-party deps.** `@react-three/postprocessing` is already in the bundle.
- **Don't add `preserveDrawingBuffer: true` to the Canvas** — the existing render-on-demand approach is the correct fix; flipping the flag has a measurable perf hit (documented in screenshot.ts comments).
- **Don't break `?nobloom`.** The debug path must still produce a PNG (just one without bloom).
- **Pure-CPU composer call.** `composer.render()` is the correct way to drive a post-process render; do NOT manually re-implement the pass chain.
- **Keep the helper jsdom-safe.** The unit tests pass mock objects; don't introduce browser-only globals into screenshot.ts.

## Geometry / algorithms

```ts
// In screenshot.ts
export function captureCanvasToPNG(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  filename: string,
  env: DownloadEnv = (typeof document !== 'undefined' ? (document as any) : (undefined as any)),
  composer?: { render(): void } | null,
): void {
  if (composer) {
    composer.render();
  } else {
    gl.render(scene, camera);
  }
  const dataURL = gl.domElement.toDataURL('image/png');
  // ... existing download logic unchanged
}
```

```tsx
// In Scene.tsx — sketch only; verify the actual @react-three/postprocessing
// API for grabbing the composer ref (may be EffectComposerContext, may be
// a `ref` prop on <EffectComposer>).
function ComposerBridge({ onComposer }: { onComposer: (c: EffectComposer | null) => void }) {
  const ctx = useContext(EffectComposerContext); // verify import
  useEffect(() => {
    onComposer(ctx?.composer ?? null);
    return () => onComposer(null);
  }, [ctx, onComposer]);
  return null;
}
```

## Tests

Unit (vitest):

- `composer provided → composer.render() called, gl.render not called`
- `composer null → gl.render(scene, camera) called` (existing test stays green)
- `composer absent → gl.render(scene, camera) called` (no-arg back-compat)

Manual smoke (per spec convention):

1. Open `/projects/9/versions/35/preview` (OPEN sign).
2. Click Save PNG. Open the downloaded file. **It must show the bloom halo around the lit tubes** (matches what's on screen).
3. Append `?nobloom` to the URL, reload. Click Save PNG. The PNG should be a flat-emissive render (no halo — same as the on-screen state with bloom disabled).
4. Open project 21232 v33 (the crossings + jumps project). Save PNG. Verify the lifted jump tubes render correctly + bloom is present.

If you cannot run a browser smoke from your worktree, say so explicitly in the report rather than claiming success.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Verify `@react-three/postprocessing` exposes the composer (read its `.d.ts` and source). Identify the cleanest grab point.
2. Add `ComposerBridge` to Scene; extend `CaptureContext`.
3. Extend `captureCanvasToPNG` signature + add unit tests.
4. Wire the composer into PreviewPage's `onCaptureReady` consumer.
5. Pre-merge + smoke (or document why smoke wasn't possible).
6. PR titled `Fix PNG screenshot bypassing bloom (Tier 1 #68)`.
7. **Move this spec from `specs/active/` to `specs/done/`** in the same PR.

## Report back

Under 200 words. Include: PR URL, the exact API surface used to grab the composer (which import / which ref type), unit test list, smoke result (or explicit "no browser available"), CI state, follow-ups (per-pass control like "save PNG without bloom" toggle in scene controls — useful for marketing renders without flipping URL params).
