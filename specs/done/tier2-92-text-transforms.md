# Tier 2 #92 — Text: case, slant, vertical stacking, and text on an arc

> **Status:** done · started 2026-08-31 · branch `task/2-text-transforms` · PR #146

## Goal

Hershey single-stroke text is the second-most-used tool in the editor after the
pen, and it currently emits exactly one thing: horizontal, upright, left-to-
right text. Every neon shop needs the other three layouts — an arched word over
a doorway, a vertically stacked blade sign, and italic script — and today the
only way to get them is to type the text, then hand-drag every vertex.

This slice adds four text transforms to the Hershey dialog:

- **Change case** — UPPER / lower / Title / Sentence, applied to the entry
- **Slant (oblique)** — a shear in degrees, for faux-italic on any face
- **Vertical stacking** — one glyph per line, centered on a common axis
- **Text on an arc** — baseline bent to a circular arc of a chosen radius

Closes four NeonWizard Fonts & Text parity rows.

## Branch + setup

```sh
git checkout -b task/2-text-transforms origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command
```

## Strict file scope

**New:**

- `web/src/lib/hershey/layout.ts` + `layout.test.ts` — the geometric
  transforms, as pure functions over `HersheyRun[]`
- `web/src/lib/hershey/changeCase.ts` + `changeCase.test.ts`

**Modify:**

- `web/src/components/HersheyTextDialog.tsx` — the new controls + live preview
- `web/src/lib/hershey/text.ts` — only if vertical stacking genuinely cannot be
  expressed as a post-pass (see below); prefer leaving it untouched
- `README.md`

**Don't touch:** `EditorCanvas.tsx`, `EditorPage.tsx`, `docOps.ts`,
`internal/**`, `todo.md`. This lane is deliberately self-contained so it can
merge independently of the three other agents in this round.

## Deliverables

1. **`changeCase(text, mode)`** for `'upper'|'lower'|'title'|'sentence'`.
   Operates on the textarea contents; the user can still edit afterwards, so
   this is a one-shot transform button row, not a persistent mode. Title case
   must not lowercase an already-capitalised interior letter of an acronym
   ("NEON BAR" → title → "Neon Bar" is fine; but "McDonald" must survive a
   round-trip through title case unchanged — implement by only uppercasing the
   first letter of each word and leaving the rest alone). Multi-line aware:
   sentence case restarts after `.`, `!`, `?`, and after a newline.

2. **`slantRuns(runs, degrees, baselineY)`** — an x-shear about the baseline:
   `x' = x + (baselineY - y) * tan(θ)`. Positive degrees lean right. Range
   ±45°, default 0. The shear must pivot on the **baseline**, not the bbox
   centre, or the text lifts off its line. For multi-line text each line shears
   about its own baseline.

3. **`stackVertical(runs, opts)`** — re-lay the glyphs one per line down a
   common vertical axis, with a configurable gap (default: 0.25 × cap height)
   and a horizontal alignment of `'center'` (default) | `'left'` | `'right'`
   computed from each glyph's own ink bbox, not its advance width — otherwise
   an `I` sits visibly off-axis from an `M`. Existing newlines in the input
   become extra gaps. Rotation is NOT applied: glyphs stay upright, which is
   how stacked blade signs are actually built.

4. **`arcRuns(runs, opts)`** — bend the baseline onto a circle.
   `opts = { radiusMM, direction: 'up'|'down', ... }`. Map each point by arc
   length along the original baseline: a point at baseline distance `s` from
   the text's horizontal centre lands at angle `φ = s / radiusMM` around the
   circle, and its height above the baseline `h` becomes a radial offset.
   For `'up'` (text arching over a centre below it) the outer edge of the
   glyph is farther from the centre. Guard `radiusMM <= 0`. Warn in the UI
   when the text is long enough to wrap past 360°.

5. **Dialog UI.** A "Transform" section with: the four case buttons, a slant
   slider + numeric box, a vertical-stack checkbox with gap + alignment, and an
   arc control with radius + up/down. **The live preview must show the result** —
   the dialog already renders a preview; feed the transformed runs into it.

6. **Composition order,** which must be fixed and documented in the code:
   case → layout (`stackVertical` OR `arcRuns`, mutually exclusive; disable one
   when the other is on) → slant. Slanting last means the shear applies to the
   already-placed glyphs, which is what "italic" means in every other tool.
   Applying it before an arc would shear the arc itself.

## Constraints

- No new dependencies. No schema change — these emit ordinary runs through the
  existing insertion path.
- All four transforms operate on `HersheyRun[]` **after** `hersheyTextToRuns`,
  as pure functions. Do not fork the glyph-walking code in `text.ts`.
- The cursive face (`joinAdjacentGlyphs`) already stitches adjacent glyphs into
  single strokes. Vertical stacking on a joining face would tear those joins
  apart mid-stroke: when the font joins and stacking is on, either disable the
  combination in the UI with an explanation, or stack the *joined* result per
  line. Pick one, state which in the PR body, and test it.
- Existing per-letter kerning and baseline-shift handles must keep working with
  slant on; they operate before the transforms, so this should fall out — add a
  test that proves it rather than assuming.

## Tests

- `changeCase.test.ts` — all four modes, multi-line, sentence restart after
  `.`/`!`/`?`/newline, the "McDonald" acronym-interior invariant
- `layout.test.ts`:
  - slant 0° is the identity (exact object-value equality of coordinates)
  - slant 45° moves a point one cap-height above the baseline by exactly one
    cap-height in x; points *on* the baseline do not move at all
  - slant is invertible: +θ then −θ returns the original to 1e-9
  - `stackVertical` centres an `I` and an `M` on the same axis (ink bbox
    centres equal, not advance-width centres)
  - `arcRuns` with a huge radius (1e6 mm) approximates the flat original to a
    stated tolerance — this is the test that catches an inverted-sign arc
  - `arcRuns` up vs down are mirror images about the baseline
  - a point on the baseline at distance s lands exactly `radiusMM` from the arc
    centre
  - degenerate guards: empty runs, single glyph, radius 0

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
go vet ./...
```

Browser smoke test: open the Hershey dialog, type a word, try each transform,
confirm the preview matches what lands on the canvas after insert, then save a
new version and confirm the runs validate (a bent baseline can produce tight
corners — a min-bend-radius warning is legitimate output, not a failure; note
it in the PR body if it appears).

## Out of scope (log as follow-ups)

- Text on an arbitrary path (following a user-drawn run)
- Inline on-canvas text editing
- Per-character rotation on the arc (glyphs currently rotate as a whole with
  the baseline tangent — confirm that is what you implemented and say so)
