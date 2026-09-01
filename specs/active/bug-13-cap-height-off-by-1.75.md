# Bug #13 — `capHeightMM` produces letters 1.75× the requested height

> **Status:** active · found 2026-08-31

## Symptom

Ask the Hershey text dialog for a 100 mm cap height and you get letters
175 mm tall. Every piece of single-stroke text ever inserted is 75% larger
than the operator asked for.

This matters more here than in a general drawing tool: sign copy has to fit a
specified space, and NeonBench quotes by tube length, so the error propagates
into both the fit and the price.

## Evidence

`web/src/lib/hershey/fonts.ts` declares `capHeightUnits: 12` for all four
bundled faces, and the comment says "one cap-height in source coordinates".
Measuring the actual glyph data:

```
rowmans   H: 21 units (y -12..9)   E: 21 units (y -12..9)   x: 14 units
rowmand   H: 21 units (y -12..9)   E: 21 units (y -12..9)   x: 14 units
futural   H: 21 units (y -12..9)   E: 21 units (y -12..9)   x: 14 units
cursive   H: 21 units (y -12..9)   E: 21 units (y -12..9)   x:  9 units
```

Cap height is 21 units (baseline at y=+9, cap top at y=−12) — the standard
Hershey Roman metric. Declared 12, actual 21, so every glyph is scaled by
21/12 = **1.75×** the requested millimetres.

## Blast radius — smaller than it looks

The Tier 2 #92 agent left this alone on the grounds that "changing it resizes
every saved design." **That reasoning is wrong**, and it should not be carried
forward into the fix decision:

- Nothing in `internal/designdoc` or `web/src/api.ts` persists `capHeightMM`,
  a font key, or any other text parameter — `grep` for `capHeight` / `hershey`
  in both comes back empty.
- `hersheyTextToRuns` bakes text to polyline geometry at insert time, and
  `appendRuns` stores plain runs.

So existing saved designs hold baked coordinates and are **unaffected** by a
change to `capHeightUnits`. Only future insertions change.

The real consideration is different and smaller: operators who have been using
this dialog have unknowingly calibrated to the 1.75× behaviour (typing 57 to
get 100 mm). Fixing it silently changes what a familiar number produces.

## Fix

1. Set `capHeightUnits: 21` for `rowmans`, `rowmand`, `futural`. Verify
   `cursive` separately — its lowercase metrics differ (x-height 9 vs 14) and
   its capitals should be measured rather than assumed.
2. Derive the value from the glyph data in a test rather than hard-coding a
   second magic number: assert that a rendered `H` at `capHeightMM = 100`
   measures 100 mm tall, for every bundled face. That test is the deliverable —
   it fails today and cannot silently rot later.
3. Check whether `lineHeight` (default 1.2) was tuned against the wrong cap
   height. If line spacing was set by eye to look right at 1.75× scale, it
   needs re-checking against corrected metrics.
4. Say so in the UI or the release notes. An operator whose muscle memory says
   "57" deserves to know why their text got bigger.

## Interaction with PR #146

PR #146 (Tier 2 #92) added `stackVertical`, which works around this bug by
measuring **ink-to-ink** rather than trusting `capHeightMM`. Once the metric is
correct, re-check that stacking spacing is still right and did not acquire a
compensating error. Do this **after** #146 merges; branch from `origin/main`.

## Strict file scope

**Modify:** `web/src/lib/hershey/fonts.ts`, plus a new or extended test file
under `web/src/lib/hershey/`. Fix the misleading comment on `capHeightUnits`.

**Don't touch:** the `.json` font data (it is correct), `text.ts` geometry.

## Tests

- For each bundled face: `hersheyTextToRuns({text:'H', capHeightMM:100, ...})`
  produces a glyph whose measured y-extent is 100 mm ± 1e-6.
- Same for a multi-glyph string; the tallest capital sets the height.
- Multi-line: two lines at `lineHeight: 1.2` sit exactly 120 mm apart at
  `capHeightMM: 100`.
- A descender ('g') extends below the baseline, i.e. total ink height exceeds
  cap height — guards against "fix" by rescaling to the whole ink box.
