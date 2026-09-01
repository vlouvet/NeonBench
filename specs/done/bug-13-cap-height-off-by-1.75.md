# Bug #13 — `capHeightMM` produces letters 1.75× the requested height

> **Status:** done · PR #153 · found 2026-08-31

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

---

## Resolution (PR #153)

`capHeightUnits: 21` on all four faces — `cursive` measures the same 21 units
for its capitals (`H`/`E`/`X`/`I`/`T`/`L`/`F` all span JHF y −12..+9), so it
needed no special case. Its *lowercase* metrics do differ (x-height 9 vs 14)
but nothing here depends on those.

Two premises in this spec needed adjusting:

- **"± 1e-6 for every bundled face"** is not achievable for `cursive`. Bug #07
  smoothing splines its curved capitals and bows ~1.3 mm past the cap-line
  vertex (0 mm for the three straight-stroke faces). The suite instead brackets
  the residual at 2.5% *and* asserts it scales linearly with size, which
  separates a spline artefact from the 75% metric error by an order of
  magnitude.
- **"Don't touch `text.ts` geometry"** was honoured, but the fix could not stop
  at `fonts.ts`. `HersheyTextDialog.computeHandlePositions` derived its cap line
  as `baselineY - capHeightMM`, an identity that held *only while the declared
  cap height was wrong*. Corrected, that shortcut puts the kerning drag-handle
  row outside the preview viewBox and the handles disappear. Hence the new
  `baselineUnits` field: the cap line is now derived from declared metrics
  rather than reconstructed by callers.

`Z` is not a flat capital in the cursive face — it has a descending swash tail
to y=+21. Found by the guard test that checks every member of the flat-capital
set measures the same span.

### `lineHeight` was NOT tuned against the wrong cap height

Item 3 of the Fix section asked whether 1.2 had been set by eye at 1.75×. It had
not. At 1.75× a pitch of `1.2 × capHeightMM` was 14.4 JHF units against a
21-unit capital, so consecutive lines of plain capitals **overlapped by 55 mm**
at cap 100 — not something anyone approved visually. It is the generic
typographic 1.2 applied to a knob that was never font size.

Measured after the fix at `capHeightMM: 100`:

```
caps only            clearance = +20.00 mm
descender over cap   clearance = -14.07 mm   (overlap)
cap over descender   clearance = +52.59 mm
```

Still tight: a Hershey face spans 28 units ascender-to-descender ≈ 1.33 cap
heights, so a correct default is nearer 1.4–1.5. The tests in this spec do not
demand it, so the default is unchanged and the clearances are pinned in
`capHeight.test.ts`. Tracked as a follow-up.

### stackVertical (PR #146) acquired no compensating error

Ink-to-ink placement is metric-independent by construction. Measured at cap 100:
`OPEN` default gap → 25.000000 / 25.000000 / 25.000000 mm; `gAgA` (descenders)
→ identical; explicit `gapMM: 25` → identical. Every stackVertical test passed
unchanged except the one asserting `inkH > CAP * 1.5`, which asserted the bug;
it was rewritten around a descender, the case that still distinguishes
ink-to-ink from a baseline pitch now that the two agree for plain capitals.

The default gap (`0.25 × capHeightMM`) was ~14% of real letter height before and
is now a true 25%, so stacked signs get visibly more air. That is the documented
intent of the knob.

### Blast radius confirmed by grep

`capHeight` / `hershey` / `font` in `internal/designdoc/` and `web/src/api.ts`:
no matches. Saved designs hold baked coordinates and are unaffected, as this
spec claimed.

### Verified end-to-end from the API

Real browser against the built binary, `HEX` at cap height 100, saved, then read
back from `GET /api/projects/{id}/design_versions/latest`:

```
server-side bounding_box_mm = [371.428571, 200.000000, 628.571429, 300.000000]
HEIGHT from Go validator     = 100.000000 mm
HEIGHT from saved SVG paths  = 100.000000 mm
```

### Follow-ups

- `lineHeight` default 1.2 leaves descenders colliding with the next line's
  capitals; 1.4–1.5 matches the face metrics.
- `channelLetter.ts:166` sets `capTopY: baselineY - capHeightMM` — same broken
  shortcut, but the field is dead (written, never read). Delete or derive.
- Operator-facing note: anyone who calibrated to the 1.75× behaviour has been
  compensating and should be told the number now means what it says.
