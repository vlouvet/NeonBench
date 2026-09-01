# Tier 2 #99 — TrueType / OpenType font support

> **Status:** active · drafted 2026-08-31 · branch `task/2-opentype-fonts`

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

## The dependency question — resolve before implementing

Nothing in the tree parses fonts. Options:

1. **`opentype.js`** (npm, MIT) — parses TTF/OTF, returns glyph paths as
   quadratic/cubic beziers. The boring, well-trodden choice.
2. **Browser-native.** `FontFace` can *load* a font but gives no access to
   glyph outlines. `canvas` + `TextMetrics` cannot produce a path either.
   There is no outline-extraction path in the platform — do not burn time
   looking for one.
3. **A Go parser** (`golang.org/x/image/font/sfnt`) — already in the
   `golang.org/x` family. Viable if the backend should own it.

CLAUDE.md requires asking before adding a dependency. **Stop and ask**, with a
recommendation. Option 1 is the likely answer if text stays a frontend concern.

## Licensing — a real constraint, not a footnote

**Bundle nothing.** Font files are licensed, and shipping one inside a binary
is redistribution. The user supplies their own file (upload or OS font
directory pick), it is stored per-project under the existing `assets/` path,
and the UI states that outlines derived from a licensed font are the operator's
responsibility. Do not add a "font library" of downloaded faces.

## Strict file scope

**New:** `web/src/lib/fonts/opentype.ts` + tests (glyph → polyline), a font
upload/pick control, and the outline-to-runs conversion.

**Modify:** `HersheyTextDialog.tsx` (or a sibling dialog — decide and justify),
`internal/server/handlers_assets.go` if a new MIME is needed, `README.md`.

**Don't touch:** `web/src/lib/hershey/**` beyond reading it. The Hershey path
ships and works; this is a parallel backend, not a replacement.

## Deliverables

1. Load a user-supplied `.ttf` / `.otf`, list its glyphs, render a preview.
2. **Outline → polyline.** Flatten quadratic and cubic beziers to a chord
   tolerance the operator can see (default ≤0.25 mm, well under printer
   resolution). Emit closed runs with `closed: true` and first === last, the
   convention `rectToPoints` / `circleToPoints` already use.
3. **Counters are holes.** An `o` has two contours with opposite winding. Emit
   both, and preserve winding so the offset code can tell outer from inner —
   `signedArea` in `shapes/offset.ts` is how the rest of the codebase decides
   this.
4. **Cap height from the font, not a constant.** Read the OS/2 `sCapHeight`
   (falling back to the measured height of `H`) and scale so a requested
   `capHeightMM` is the height the operator gets. **Bug #13 was exactly this
   mistake** on the Hershey side — a declared metric that did not match the
   data made every letter 1.75× too tall. Assert the round-trip in a test.
5. Composability: the emitted runs go straight into Neonize and into the
   channel-letter face flag with no special-casing.

## Tests

- A known glyph's flattened contour count and winding directions
- Bezier flattening honours the chord tolerance (no segment deviates more)
- `capHeightMM = 100` yields a 100 mm `H`, derived from the font's own tables
- A glyph with counters (`o`, `B`, `8`) emits the right number of contours
- Kerning pairs from the font's `kern` / GPOS, or an explicit statement that
  V1 uses advance widths only
- Emitted runs save without a 400 and survive reload

## Out of scope

Variable fonts, OpenType feature selection (ligatures, alternates), vertical
writing modes, and font subsetting. V1 is "set the brand name in the brand
face and get outlines".
