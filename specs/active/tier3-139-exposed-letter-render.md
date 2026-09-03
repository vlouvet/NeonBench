# Tier 3 #139 — Exposed channel letters have no render

> **Status:** active · drafted 2026-09-02 · branch `task/3-exposed-letter-render`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) B4

## Goal

The preview draws every run as glowing tube. For a **face-lit** letter that is
right: the face is the emitter. For an **exposed** letter the pan is unlit metal
and the tube mounted on it is the only thing that emits — so painting the
letterform as the light source **shows the customer a different product from the
one being quoted**.

`Run.IsChannelLetterFace` already marks a face run, and
`web/src/api.ts:400` mirrors it. Verified 2026-09-02: nothing in
`web/src/preview/` reads that flag, so a face run renders as a bright tube today.

**Done** means a doc with face runs renders those runs as unlit extruded pans,
with the tube runs glowing inside them.

## Why this is not just "draw the face darker"

Compositing the pan and the glass as separate objects had to be done **outside
the tool** to produce Chachi's proof. The two halves have different materials,
different depths and different relationships to bloom, and the face run's
polyline is an **outline**, not a centerline — it describes the pan's boundary,
where every other run describes a tube's path. A renderer that forgets that
distinction will extrude the pan along the wrong axis or run a tube around the
letter's edge.

Depth comes from `ChannelLetterDepthMM` (`internal/designdoc/types.go:484`,
`*float64`, optional) falling back to the project default. It is a pointer:
nil means "not set", which is **not** the same as zero, and a zero-depth pan is
a flat sheet rather than a can.

## Sequencing note

This row and Tier 3 #138 both add unlit chrome to `Scene.tsx` under the same
bloom constraints. **They should not run concurrently** — they will collide in
that file and in `materials/`. Ship #138 first: a raceway box is the simpler
geometry, and it establishes the material and Z-ordering conventions this row
then follows.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-exposed-letter-render origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Scene.tsx` — branch on `is_channel_letter_face`.
- `web/src/preview/materials/` — an unlit pan material.
- A new pure module for pan geometry (outline + depth → extrusion), so it is
  unit-testable without a renderer.

**Don't touch:**

- `internal/designdoc/`, `web/src/lib/channelLetter.ts`, or
  `ChannelLetterWizardDialog.tsx`. The model and the authoring flow are correct;
  this is a rendering gap.
- `Tube.tsx`'s emissive path for non-face runs.
- The bloom guard (Tier 3 #137). A pan that trips it has the wrong material.

## Constraints

- **A doc with no face runs must render byte-identically.** Most docs are not
  channel letters.
- **The pan is unlit.** Same reasoning as #138: it must not move
  `fractionAboveLuminance` above the content floor.
- `channelLetter.ts:10` records that `is_channel_letter_face` and `raceway_id`
  are **deliberately reused** rather than given new fields. Read that comment
  before adding a field; the answer is probably that you do not need one.

## Tests

- Pan geometry as a pure function: outline + depth → extrusion, including the
  nil-depth fallback and an explicit assertion that **nil and 0 behave
  differently**.
- A no-face-run doc is unchanged.
- The bloom delta is unmoved by pans.
- Eyeball a real build. "The letter reads as metal with glass on it" is the
  actual acceptance criterion and no number expresses it.

## Report back

PR URL, how you distinguished the outline polyline from a centerline, the
nil-vs-zero depth behaviour, the bloom delta before and after, and whether you
looked at the render.
