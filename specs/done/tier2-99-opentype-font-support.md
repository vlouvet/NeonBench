# Tier 2 #99 — TrueType / OpenType font support

> **Status:** done · PR #NNN · drafted 2026-08-31 · branch `task/2-opentype-fonts`

## Goal

A channel-letter shop works from the customer's **brand typeface**. NeonBench
offers four bundled Hershey faces and nothing else, so any job with a specified
font has to be drawn somewhere else and imported. This is the single largest
gap between NeonBench and the channel-letter workflow it is otherwise built
for.

Closes NeonWizard Design Tools **#20 Type1/OpenType font support**, and makes
NW **#5 WYSIWYG font picker** reachable.

## Why this is different from Hershey text

Hershey faces are **single-stroke**: each glyph is a centreline, which is
already a tube path. OpenType glyphs are **filled outlines**. The two feed
different halves of the pipeline:

- Hershey → strokes → tube path directly (today's `hersheyTextToRuns`)
- OpenType → outline → **Neonize** → inside/outside tube paths, or → channel
  letter face

So this is not "another font backend". It produces closed outline runs that
then go through the existing offset machinery. Say this in the UI, or an
operator will type in Helvetica and wonder why they got two tubes per stroke.

## The dependency question — RESOLVED

The spec originally said to stop and ask. That happened, and the user approved
**`opentype.js`** — npm, MIT, pinned at exactly `2.0.0` (no caret), actively
maintained, ~2M downloads/week. It is a **frontend** dependency.

Why this over the alternatives the spec listed:

1. **Browser-native was never viable.** `FontFace` loads a font but exposes no
   glyph outlines, and `TextMetrics` returns numbers, not paths. There is no
   outline-extraction API in the platform. Confirmed, not assumed — do not
   burn time looking again.
2. **`golang.org/x/image/font/sfnt`** would have put the parser on the backend.
   That means the operator's font file has to travel to the server to render a
   preview, which contradicts the licensing posture below (nothing about the
   font should leave the machine or reach the project store) and adds a round
   trip to every keystroke in the dialog. Text is a frontend concern here
   because the preview has to be live.
3. `opentype.js` is the boring option: one dependency, no transitive deps
   (`npm ls` shows a leaf), MIT, and it hands back `glyph.path.commands` in
   font units, which is exactly the input the flattener wants.

**Cost, measured:** the parser is 250.83 kB raw / 73.16 kB gzipped. It is
loaded through `React.lazy()` so it lands in its own chunk, fetched the first
time the operator opens the dialog. The editor's main chunk went from
576.18 kB to 576.81 kB — +0.6 kB. Imported eagerly it would have pushed the
main chunk to 827.82 kB. `App.tsx` already makes the same trade for the
three.js preview.

`@types/opentype.js` was NOT added: it tracks the 1.x API and would be a second
dependency to justify. opentype.js 2.0.0 ships no types, so
`web/src/lib/fonts/opentype-js.d.ts` declares by hand the dozen members we
actually use, read off `node_modules/opentype.js/dist/opentype.mjs` at 2.0.0.

## Licensing — a real constraint, not a footnote

**Bundle nothing.** Font files are licensed, and shipping one inside a binary
is redistribution. The user supplies their own file, it is parsed **in the
browser**, and the UI states that outlines derived from a licensed font are the
operator's responsibility. Do not add a "font library" of downloaded faces.

Shipped that way: no font file is committed to the repo (the test suite builds
a synthetic one — see Tests), nothing is uploaded, and nothing about the face
is written to the project except the outlines the operator chose to insert.
`describeLicence()` in `face.ts` is the sentence the dialog shows.

*Deviation from the original spec:* the spec floated storing the font "per
project under the existing `assets/` path". That was dropped. Storing the
customer's font file inside a project bundle that gets exported and emailed is
a worse redistribution problem than bundling one, and it buys nothing — the
outlines are baked to geometry at insert time, so nothing downstream needs the
font again. `handlers_assets.go` was therefore not touched and no new MIME type
was needed.

## Strict file scope — as built

**New:**

- `web/src/lib/fonts/flatten.ts` (+ test) — bezier flattening to a chord
  tolerance in **millimetres**
- `web/src/lib/fonts/metrics.ts` (+ test) — cap height from the font's tables
- `web/src/lib/fonts/outline.ts` (+ test) — path commands → classified closed
  contours
- `web/src/lib/fonts/face.ts` (+ test) — loading, naming, missing glyphs,
  licence text
- `web/src/lib/fonts/text.ts` (+ test) — layout, kerning, the mm/font-unit
  scale
- `web/src/lib/fonts/synthFont.ts` — the test font, built at test time
- `web/src/lib/fonts/opentype-js.d.ts` — hand-written ambient types
- `web/src/components/OutlineTextDialog.tsx`

**Modified:** `web/package.json` + lockfile, `web/src/pages/EditorPage.tsx`
(toolbar button, lazy import, one insert handler), `README.md`.

**Sibling dialog, not a tab in `HersheyTextDialog`** — the spec left this open.
Reasons, in the file header too: the output is a different kind of thing (open
centrelines vs closed contours, needing different insert paths);
`HersheyTextDialog` is already ~1000 lines of single-stroke-specific machinery
(per-pair kerning handles, optical kerning, slant, stacking, text-on-an-arc),
none of which applies; and two separately-named buttons with separate
explanations teach the distinction, where one dialog with a hidden mode hides
it.

**Not touched:** `web/src/lib/hershey/**`, `web/src/lib/docOps.ts`,
`arcGeom.ts`, `arrange.ts`, `EditorCanvas.tsx`, `internal/**`.

## Deliverables — as built

1. ✅ Load a user-supplied `.ttf` / `.otf` / `.woff`, report family, style,
   glyph count, units/em and cap-height provenance, render a live preview.
   `.ttc` / `.otc` collections get their own message, because macOS ships most
   of its system faces that way and opentype.js just throws
   "Unsupported OpenType signature ttcf".
2. ✅ **Outline → polyline.** Quadratic and cubic beziers flattened to a chord
   tolerance the operator sets (default 0.25 mm). Closed runs with
   `closed: true` and first === last, the `rectToPoints` / `circleToPoints`
   convention. **The transform runs before the flattener**, because the
   tolerance is in millimetres and a 2048-unit em would otherwise over-sample
   ~20x.
3. ✅ **Counters are holes.** Contours keep the font's own winding through the
   y-flip, so an `o`'s counter has the opposite `signedArea` sign from its
   outer. `role` (outer / counter) is computed independently, by even-odd
   nesting depth, so a face that winds its counters wrongly still gets them
   labelled right — and `windingAgreesWithNesting` reports the disagreement
   rather than hiding it.
4. ✅ **Cap height from the font, not a constant.** Resolution order:
   **measure the `H` ink** → declared OS/2 `sCapHeight` → 0.7 × em. Measuring
   beats the declaration because the declaration is a number a foundry typed
   in and the ink is what a tape measures; on this machine Arial declares 1467
   against an `H` that measures 1466, and Apple Symbols declares 1119 against
   an `H` of 1102 (1.5% — the dialog warns). `source` and `disagreementRatio`
   are surfaced to the operator.
5. ✅ Composability: emitted runs feed `neonize` and the
   `is_channel_letter_face` flag with no special-casing. Verified end to end in
   a browser.

## Tests — as built

`web/src/lib/fonts/*.test.ts`, 65 cases, all in the normal `vitest` run.

- ✅ Flattening: no point of the true curve is further from the emitted
  polyline than the tolerance, measured against 2001 densely-sampled curve
  points and to the polyline's **segments** (a vertex-only measure calls a
  chord across a half-circle a perfect fit). Quadratic and cubic, four
  tolerances each, plus cusp and degenerate cases.
- ✅ Contour count, roles and winding for an `o`-shape, an `i` (two outers),
  and an `8`/`%` (two counters).
- ✅ **`capHeightMM = 100` yields a 100 mm `H`**, and 1 / 25.4 / 250 / 1200 mm
  likewise. The synthetic face's `H` is deliberately 660/1000 em so that a
  scale derived from `0.7 × em` — the Bug #13 shape — produces a *different*
  number and the test can tell the two apart.
- ✅ Kerning: V1 uses the face's own pairs via `getKerningValue` (GPOS, then
  the legacy `kern` table); Arial ships 909 of them. Pinned with a face whose
  kern value the test controls, plus "no kerning across a line break".
- ✅ Emitted runs save without a 400 and survive reload — asserted on the doc
  read back out of `GET /design_versions/latest`, not on the render layer.

**Test font: built at test time, never committed.** `synthFont.ts` uses
opentype.js's own `Font` / `Glyph` / `Path` writers and `toArrayBuffer()`; the
~1.5 KB of bytes go back through the real `parse()`, so the load path (cmap,
CFF charstrings, OS/2) is genuinely exercised on data we authored and can
assert exact numbers against. Reading `/System/Library/Fonts` was rejected:
CI runs on Linux, and a test that passes here and skips there is worse than no
test. The one gap is stated rather than papered over — opentype.js writes CFF,
so the synthetic face returns **cubic** commands, while real TrueType faces
return **quadratic** (measured: Arial, Georgia, Times New Roman, Verdana,
SFNS, Geneva). The quadratic branch is covered by `flatten.test.ts` directly
and by hand-written `Q` command arrays in `outline.test.ts`.

## Browser smoke test (the part unit tests cannot do)

Driven with Playwright against the built binary: load `Arial.ttf` (a real
licensed face on the developer's machine, never committed), set `OHo` at
250 mm, insert, Neonize one contour at 30 mm spacing, save a version, then
assert on `GET /api/projects/{id}/design_versions/latest`:

```
otf-1-outer  closed=true pts=104  area= +62296.8 mm2  bbox=269.1x288.7   O · outer
otf-1-inner  closed=true pts=104  area= +38543.2 mm2  bbox=209.1x228.7   O · outer
otf-2        closed=true pts=80   area= -27991.4 mm2  bbox=170.9x201.9   O · counter
otf-3        closed=true pts=13   area= +20375.3 mm2  bbox=196.1x250.0   H · outer
otf-4        closed=true pts=79   area= +26160.8 mm2  bbox=169.7x189.3   o · outer
otf-5        closed=true pts=65   area= -12037.3 mm2  bbox=106.6x138.6   o · counter

CAP-HEIGHT ASSERTION: capital H in the SAVED doc measures 250.0000 mm  -> exact.
```

Counters carry the opposite sign. Neonize turned one contour into a valid
outer/inner pair. The `O`'s 288.7 mm is the neonized outer: 258.7 mm of glyph
plus 2 × 15 mm offset, and 258.7 mm is exactly what Arial's own `O` bbox
(y1 = −25, y2 = 1492 against a 1466 cap) predicts — round-letter overshoot,
not an error.

**Two real bugs this caught that no unit test could have:**

1. The dialog is taller than its siblings and `.modal` in `App.css` sets no
   height bound, so the Insert button rendered below the fold and could not be
   clicked. Fixed with `maxHeight: 90vh` / `overflowY: auto` and sticky
   actions, inline so the shared stylesheet other tasks own stays untouched.
2. The curve-tolerance field was `min={0.01} step={0.05}` with a default of
   `0.25`. `min` is a **lattice base**, so 0.25 was not a valid value and the
   browser silently swallowed every form submit — the exact failure CLAUDE.md
   lists under "unit tests green, feature unusable". Both float fields now use
   `step="any"`.

## Out of scope (unchanged)

Variable fonts, OpenType feature selection (ligatures, alternates), vertical
writing modes, and font subsetting. V1 is "set the brand name in the brand
face and get outlines".

## Follow-ups worth tracking (Tier 3)

- **Font outlines trip the validator.** "OHo" at 250 mm with a 10 mm tube
  produced 8 `min_bend_radius` and 2 `min_spacing` issues. That is honest —
  a typeface's corners really are tighter than a 22 mm glass bend — but the
  operator gets a wall of red with no guidance. A "letters need a corner
  radius / a bigger cap height" hint, or an automatic fillet pass over an
  inserted outline, would make the tool usable without trade knowledge.
- **No per-glyph fit control.** Outlines land as one block, centred on the
  view box. Selecting a single letter's contours (outer + its counters
  together) is manual. A `group_id` per glyph at insert time would make
  Arrange work on letters instead of contours.
- **Contours that genuinely overlap are not merged.** Script faces with
  connecting strokes, and any face with overlapping components, need boolean
  union — which is Tier 2 #98 (Weld). Outline text is the feature that makes
  that gap visible.
- **Quadratic coverage relies on hand-built command arrays**, because
  opentype.js can only write CFF. A tiny hand-assembled `glyf` table in
  `synthFont.ts` would close the last gap between the test font and the fonts
  operators actually load.
