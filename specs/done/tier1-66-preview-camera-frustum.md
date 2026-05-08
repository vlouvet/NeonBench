# Tier 1 #66 — 3D preview tubes invisible past ~1 m camera distance

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/1-preview-camera-frustum`

## Goal

The Phase 3 preview's `<Canvas>` is mounted with `camera={{ position: [0, 0, 1500], fov: 50 }}` and **no explicit `near` / `far`**. three.js's `PerspectiveCamera` defaults to `near: 0.1, far: 1000`. NeonBench's world units are millimeters, and `cameraPositionForPreset` parks the camera at `bbox.diagonal × 1.5` from the design — so any sign whose 3D diagonal exceeds ~660 mm (≈ 2 ft) ends up with the camera *farther than 1000 mm* from the tubes, and the entire scene is culled by the far plane. Result: a black canvas. The preset-button transitions briefly pass *through* the within-far-plane corridor on the way to the settled position, which produces the user-reported "glimpse of light when changing views, then nothing."

A second-order issue compounds this: `OrbitControls` has `maxDistance={5000}` in `Scene.tsx`. When the preset framing requests a position farther than 5 m from the target, the controls clamp it on the next `update()` tick — fighting the preset animation for very large signs and leaving the camera at the clamp, often still too far for a 1000 mm far-plane to render.

"Done" means:

1. Tubes stay illuminated at every preset position for any sign size up to ~50 m diagonal (every realistic neon sign plus headroom).
2. Preset transitions land where the math says they should — no silent clamp from `OrbitControls.maxDistance`.
3. No depth-buffer artifacts from the wider frustum (the wall plane sits 50 mm behind the tubes; with `near = 1` mm the near/far ratio is 10⁶, well within 24-bit depth precision because there's no near-camera contention).
4. A regression test pins the camera config so this can't silently revert.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-preview-camera-frustum origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/preview/PreviewPage.tsx` — extend the `<Canvas camera={...}>` prop with `near: 1, far: 1_000_000`. Keep `position: [0, 0, 1500]` and `fov: 50`. One short comment on *why* (mm units, preset framing distance scales with bbox diagonal).
- `web/src/preview/Scene.tsx` — bump `OrbitControls maxDistance` from `5000` to `50_000`. One short comment on *why* (preset framing for large signs was being silently clamped).
- `web/src/preview/PreviewPage.test.tsx` — add a small assertion that the rendered Canvas was given a camera config with the new `near` / `far` values. If the existing test mocks `<Canvas>` to capture props, extend that mock; otherwise the smallest possible new test that pins the prop literal is fine.

**Don't touch:**

- `cameraPresets.ts` — the framing math is correct; the bug was downstream camera-config defaults swallowing it.
- `Tube.tsx`, `Electrode.tsx`, `EmissiveTubeMaterial.tsx`, the bloom config — none of these are responsible for the cull. Bloom isn't the problem (the user's symptom is "no light at all," not "flat emissive without halo").
- `Scene.tsx`'s preset animation, `useFrame` lerp, or `cameraPositionForPreset` invocation — those are fine.

## Deliverables

1. **Camera near/far widened.** `near: 1, far: 1_000_000` on the Canvas camera config.
2. **OrbitControls maxDistance bumped.** `50_000` mm gives 50 m of orbit room — the preset framing for any realistic sign lands inside this comfortably, and the cap still prevents wandering into infinite void.
3. **Comment on each change** explaining *why* (mm units; preset framing distance scales with bbox diagonal). Don't restate the math — the spec is the rationale; the inline comment is just a "look at #66 if curious" breadcrumb.
4. **Test pin.** `PreviewPage.test.tsx` (or sibling) asserts the Canvas was constructed with the new near/far. Whatever is least invasive given the existing test scaffold.

## Constraints

- **No new dependencies.**
- **Don't change the orbit `minDistance`** (50 mm is correct — it's the can't-end-up-inside-a-tube guard).
- **Don't bump `maxDistance` to Infinity.** A finite cap is a safety belt against orbit-controls feedback loops on touch devices and against preset math accidentally producing an out-of-frustum position.
- **Don't make `near` zero.** Three.js documents `near > 0` as a hard requirement; `1` (1 mm) is a comfortable floor that won't degrade depth precision for the 1 m–50 m range we actually use.
- **Don't introduce dynamic far-plane recompute** based on bbox. Tempting but premature: the static `1_000_000` is already a 50× margin over `maxDistance`, and dynamic camera mutation interacts subtly with the preset animation's lerp. Defer to a follow-up if a real-world sign ever exceeds the bound.

## Geometry / algorithms

The fix is a constant change, not algorithmic. For context: with `position = [0, 0, 1500]` (initial) and a sign whose `bbox.size.length() = 2000` mm, the front-preset framing puts the camera at `(cx, cy, cz + 3000)`. For `cz ≈ 0` the camera lands at z = 3000 mm, distance-from-design = 3000 mm. The default `far = 1000` clips this; `far = 1_000_000` doesn't. For the largest realistic sign (~10 m diagonal), framing distance = 15 m; well inside the new 50 m orbit cap and the 1000 m far plane.

Depth-buffer math: 24-bit depth with `near = 1, far = 1_000_000` gives ≈ `2²⁴ / log₂(1_000_000 / 1) ≈ 840k` distinguishable depth steps, distributed logarithmically. At 1 m camera distance, neighboring depth steps are ≈ 60 µm apart — finer than the wall plane's 50 mm offset by three orders of magnitude. No z-fighting concerns within Phase 3's geometry inventory.

## Tests

- **Vitest test** in `PreviewPage.test.tsx` (existing file — extend, don't replace) that pins the `near` / `far` literals on the Canvas camera prop. Implementation depends on the existing mock; the assertion target is "the camera config Canvas was constructed with."
- **Manual smoke** on project 21232 (or any project with a sign whose bbox diagonal exceeds 660 mm):
  1. Open `/projects/<id>/versions/<vid>/preview`. Tubes must render emissive + bloomed in the settled state, not just during transitions.
  2. Click each of Front / Iso / Top / Side. Each preset must land with the design framed in the viewport.
  3. Mouse-drag-orbit out as far as it'll go. The orbit must clamp at 50 m without losing render of the tubes.
- **Manual smoke** on a tiny sign (200 mm diagonal):
  1. Tubes still render at all four presets — confirm `minDistance: 50` doesn't fight with the small bbox.
- **`?nobloom` smoke**: appending `?nobloom` to the preview URL must show flat-emissive tubes (no halo) in all preset positions. Confirms the fix is geometric, not bloom-related.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Apply the two source changes.
2. Add / extend the test pin.
3. Rebuild the frontend bundle and Go binary.
4. Run all four manual smoke scenarios above.
5. Pre-merge checks all green.
6. Open PR titled `Fix 3D preview camera frustum culling tubes (Tier 1 #66)`.
7. **Move this spec** from `specs/active/` to `specs/done/` as part of the implementation commit.

## Report back

Under 200 words. Include:

- PR URL
- Confirmation that all four manual smoke scenarios pass
- Whether dynamic far-plane recompute should be promoted from "deferred" to a Tier 3 follow-up given any sign sizes encountered during smoke
- Pre-merge check final state
- Any follow-ups worth tracking (e.g. exposing `maxDistance` / `near` / `far` in `<SceneControls>` for power users, persisting orbit position across route remounts)
