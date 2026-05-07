# Phase 3 #4 — Bloom post-processing

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-4-bloom`

## Goal

Phase 3 #3 ships emissive tubes. Without bloom, they look "lit from within" but not glowy — there's no spillage of light into the surrounding pixels, which is what sells the neon effect visually.

This spec adds a `UnrealBloomPass`-equivalent (via `@react-three/postprocessing`'s `<Bloom>`) to the render pipeline. Tuned so emissive tubes show a soft halo without washing out detail or flickering at low frame rates.

"Done" means: the preview shows a believable neon-glow effect — colored halos around tubes, gradient light spillage onto the (still empty) background. Performance stays at 60 fps on a typical macOS dev machine for a complex saved project.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-4-bloom origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/preview/Scene.tsx` — wrap the scene in `<EffectComposer>` from `@react-three/postprocessing`; add `<Bloom>` with tuned defaults.

**New:**

- `web/src/preview/effects/BloomEffect.tsx` (optional — only if `<Bloom>` configuration grows past 5 lines inline; otherwise inline in `Scene.tsx`).

**Don't touch:**

- `Tube.tsx`, `materials/*` — the emission already drives bloom; no material changes.
- `PreviewPage.tsx`, backend, anything else.

## Deliverables

### Bloom configuration

```tsx
import { EffectComposer, Bloom } from '@react-three/postprocessing';

<EffectComposer>
  <Bloom
    intensity={1.2}
    luminanceThreshold={0.4}    // emissive >0.4 brightness contributes to bloom
    luminanceSmoothing={0.2}
    mipmapBlur={true}
    radius={0.7}
  />
</EffectComposer>
```

Tuning rationale:

- **`intensity={1.2}`** — strong enough to read as glow, not so strong it washes out fine line work. Iterate during smoke testing.
- **`luminanceThreshold={0.4}`** — only emissive surfaces bloom. The dark scene background and dark non-emissive surfaces (Phase 3 #5's eventual scene chrome) don't pick up halos.
- **`mipmapBlur={true}`** — large soft halos cheaper than convolution-based blur; matches the neon look better than tight tight halos.
- **`radius={0.7}`** — halo extent. Larger feels more cinematic; smaller stays closer to the tube.

These values are starting points. The agent implementing this spec should manually tune based on a few test projects and document the final values + rationale in the PR.

### Performance guard

Bloom is the expensive pass. On weak devices (the windows-smoke CI runner is weak) the post-processing might tank the frame rate. Two mitigations:

1. **Default-off via toggle** in dev / CI. Add a small `?nobloom` query param check on PreviewPage that skips wrapping in `<EffectComposer>` if set. Useful for performance debugging and CI smoke tests that just want to confirm the route renders.
2. **Adaptive resolution** — `<EffectComposer multisampling={0}>` and `<Bloom mipmapBlur>` together keep the cost down on lower-DPR setups. Don't add per-pixel-ratio degradation logic in V1.

## Constraints

- **No new dependencies** — `@react-three/postprocessing` was bundled in Phase 3 #1.
- **No backend changes.**
- **No edit affordances.**
- **No frame-rate regressions on the existing test corpus** — a project with ~20 runs must still render at 60 fps on a typical dev machine. Document the worst-case fps observed.
- **No bloom-affects-non-emissive-surfaces side effects** — the luminance threshold MUST be high enough that dark surfaces stay dark. Smoke test with the project background to confirm.
- **No browser-specific bloom hacks** — modern Chrome/Safari/Firefox all handle WebGL post-processing correctly. If a browser doesn't, document; don't add fallbacks in V1.

## Geometry / algorithms

None — this is shader pipeline configuration. The math lives inside `@react-three/postprocessing`.

## Tests

No automated tests — bloom output is purely visual. Manual smoke covers it.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open preview on a project with multiple gases. Confirm bright halos around each tube; halo color matches tube color.
2. Compare with `?nobloom` query param: same scene without bloom should look "lit from within"; same scene with bloom should look unmistakably neon.
3. Frame rate on the most complex saved project (DevTools performance panel) ≥ 60 fps.
4. No halos on the dark background.
5. Halos around dim/desaturated tubes (e.g. powder blue) are softer than around bright tubes (e.g. ruby red) — that's the luminance-threshold + smoothing working.

## Workflow

1. Add `<EffectComposer>` + `<Bloom>` to `Scene.tsx` with the starting values above.
2. Manual smoke; iterate the four parameters until the look feels right. Document final values.
3. Add `?nobloom` query param skip.
4. Pre-merge checks.
5. Open PR titled "Phase 3 bloom post-processing (Phase 3 #4)". Body includes screenshots (with and without bloom).
6. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, the final tuned bloom parameters + reasoning, frame rate on most-complex-tested project, file-size deltas, CI state, follow-ups (e.g. per-project bloom intensity slider in the scene controls; SSR-friendly fallback for headless smoke; chromatic aberration / vignette for a more cinematic look — both stayed deferred for V1).
