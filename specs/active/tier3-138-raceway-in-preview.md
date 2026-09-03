# Tier 3 #138 — The 3D preview does not draw raceways

> **Status:** active · drafted 2026-09-02 · branch `task/3-raceway-in-preview`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) B3

## Goal

`Doc.Raceways` has been real modelled data since Tier 2 #104, and the print PDF
dimensions it. **`grep -ril raceway web/src/preview/` returns nothing** —
verified again 2026-09-02 against `origin/main`. So the ISO view — the angle
`cameraPresets.ts` itself calls the marketing-render angle — shows glass
floating in front of a grey plane, with the mounting box that the customer is
buying simply absent.

**Done** means a design with a raceway renders that raceway, in the preview and
therefore in the PNG that `scripts/render-preview.mjs` produces.

## Why this is small work with a large output

The geometry is already in the doc: a raceway is a rectangular extrusion with
`length_mm`, `height_mm` and `depth_mm`. There is no calculation to get wrong —
this is a mesh and a material. What makes it worth a spec is that it lands in
the middle of a lighting setup with strong opinions, and getting the material
wrong is worse than drawing nothing.

## The lighting constraint — read this before writing the mesh

The preview is a bloom scene. `Scene.tsx` documents the split: **the tubes are
emissive and the scene chrome is ambient-lit**, and `bloomMetric.ts` (Tier 3
#137) now *measures* the post-processing delta and will **refuse a capture** if
the bloom pass changed nothing.

A raceway is chrome, not glass. It must not be emissive and must not bloom. Two
specific failure modes to avoid:

- **A bright or white raceway blows the bloom threshold** and halos the box as
  though it were lit. Neon on an unlit metal box is the product; a glowing box
  is a different product.
- **The wall plane sits 50 mm behind the design in −Z** (`Scene.tsx`, the
  constant is documented there with the reason). A raceway is *in front of* the
  wall and *behind* the glass. Pick its Z explicitly and write down the ordering,
  or it will z-fight with the wall on some machines and not others.

Check what `fractionAboveLuminance` reports before and after your change. If the
raceway moves it, the material is wrong.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-raceway-in-preview origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Scene.tsx` — the mesh, its material and its placement.
- `web/src/preview/materials/` — a raceway material beside the existing ones.
- Optionally `web/src/preview/renderParams.ts` — only if you add a URL flag to
  toggle the raceway. If you do, follow the existing contract: URL beats the
  persisted scene preference, absent falls through.

**Don't touch:**

- `internal/designdoc/`. The raceway model is correct and complete; this row
  consumes it.
- `screenshot.ts` / `bloomMetric.ts` / `autocapture.ts`. Tier 3 #137 shipped
  hours before this row. If the raceway breaks the bloom guard, the raceway's
  material is wrong — do not relax the guard.
- The wall plane's 50 mm offset. Place relative to it; do not move it.

## Deliverables

1. Raceways render as unlit extruded boxes at the doc's dimensions.
2. A design with no raceways renders **exactly** as before.
3. Tests below.

## Tests

`web/` has no DOM test environment and this row must not add one — that is a
deliberate repo decision. Test the parts that are pure:

- Geometry: doc raceway → box dimensions and placement, as a pure function,
  unit-tested without a renderer.
- **A no-raceway doc is unchanged.** Easiest as a structural assertion over what
  the scene builds.
- **The bloom delta is unmoved by the raceway.** `bloomMetric.ts` gives you the
  measurement; a raceway-only doc must not push `fractionAboveLuminance` above
  the content floor. This is the assertion that keeps the box from glowing.

For anything interactive, drive a real build with Playwright from a scratch dir
(not a repo dependency) as #135 and #137 did, and **look at the render**. A
raceway that is subtly wrong will pass every numeric test.

## Report back

PR URL, the bloom delta before and after on a raceway-bearing doc, how you
ordered the raceway against the wall plane in Z, and a note on whether the
render was eyeballed or only asserted.
