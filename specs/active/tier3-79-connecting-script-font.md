# Tier 3 #79 — Connecting (cursive script) Hershey font

> **Status:** active · drafted 2026-05-09 · branch `task/3-connecting-script-font` · NW parity (connecting script font)

## Goal

NW ships a connecting cursive font where adjacent letters join at their endpoints, producing a single continuous tube path per word. NeonBench's three Hershey faces (Roman Simplex, Roman Duplex, Sans Simplex) are all isolated-glyph — each letter renders independently with no joining.

"Done" means: a fourth bundled face with cursive joining, and a `joinAdjacent` boolean on the Hershey emit pipeline that, when true, walks adjacent glyph endpoints and stitches them together with a small tangent-matched bridge segment so the operator gets one continuous tube per word.

The underlying Hershey corpus has a usable cursive face — `cursive` from the original Allen V. Hershey set (1976). It's public-domain and ~12 KB JSON-encoded. The joining logic is the meat of the work.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-connecting-script-font origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**New:**

- `web/src/lib/hershey/cursive.json` — the Hershey cursive face encoded in the existing JSON format (per `lib/hershey/rowmans.json`). Generated via `web/scripts/build-hershey-font.ts --font cursive` (the build script that already exists per Tier 3 #19).
- `web/src/lib/hershey/joinAdjacentGlyphs.ts` — pure helper. Given two adjacent rendered glyphs (each is a list of strokes in the post-`hersheyTextToRuns` shape), compute whether their tangent endpoints are "join-eligible" (within a configurable tolerance, similar tangent angle) and emit a small bridging stroke connecting them. Returns the joined run list with the join inserted.
- `web/src/lib/hershey/joinAdjacentGlyphs.test.ts` — table tests: A→B (joinable), o→t (not joinable, gap too wide), end-of-word (no join — explicit space).

**Modify:**

- `web/src/lib/hershey/fonts.ts` — register the cursive face. Mark it as `joinAdjacent: true` in the metadata (existing faces stay `joinAdjacent: false`).
- `web/src/lib/hershey/text.ts` — in `hersheyTextToRuns`, after emitting per-glyph runs, if the current font's `joinAdjacent === true`, walk consecutive glyphs and apply `joinAdjacentGlyphs`. Spaces (literal " " characters) interrupt joining.
- `web/src/components/HersheyTextDialog.tsx` — font picker shows the new cursive face. Preview thumbnail (PR #98) renders correctly.

**Don't touch:**

- Other faces — they stay isolated-glyph.
- The Channel-letter wizard (Tier 2 #71) — cursive joining is a property of the Hershey face, so the wizard inherits joining automatically when the user picks the cursive face.

## Deliverables

1. **`cursive.json`** — the 96-glyph Hershey cursive set, in the existing JSON encoding. Include source attribution (Hershey 1976; public domain).
2. **`joinAdjacentGlyphs(prevGlyph, nextGlyph, opts)`** — pure helper. Inputs: two glyph stroke-lists (in the post-`hersheyTextToRuns` shape). Output: `{joined: boolean; joinedStrokes: HersheyRun[]}`. Joining algorithm:
   - Find prevGlyph's last stroke's endpoint (rightmost end-of-stroke point).
   - Find nextGlyph's first stroke's start point (leftmost start-of-stroke).
   - If their X distance is within `opts.maxJoinDistance` (default 1.5 × stroke height) AND their Y distance is within `opts.maxJoinDrop` (default 0.5 × stroke height), emit a single line segment connecting them and merge the two glyphs' strokes into one continuous run.
   - Otherwise return `{joined: false}` and leave them separate.
3. **`hersheyTextToRuns` integration** — when `font.joinAdjacent === true`, walk pairs of adjacent rendered glyphs and apply the join. A literal space character resets the join walk.
4. **HersheyTextDialog** — cursive face appears in the picker; preview thumbnail renders the font's "OPEN 2026" preview correctly with joining applied.
5. **Tests** — joining geometry; join skipping on space; thumbnail render; round-trip through `hersheyTextToRuns`.

## Constraints

- **No new third-party dependencies.** The Hershey JSON is just static data.
- **Public domain attribution.** Honor the Hershey corpus license note in the JSON metadata.
- **Other faces unchanged.** Existing tests for Roman Simplex / Duplex / Sans Simplex stay green.
- **Don't introduce TrueType / OpenType.** This is Hershey single-stroke only (matches the rest of the Hershey pipeline).

## Tests

Manual smoke:

1. Open the Hershey text dialog. Pick "Cursive." Type "open." Preview shows joined cursive.
2. Add a space + "for me." Preview: "open" joined; "for me" joined as 2 separate words; explicit gap between them.
3. Insert into editor. Each word becomes a single continuous run. Bend list emits one set of bend marks per word.
4. 3D preview: each word's tube reads as one continuous glow.

## Pre-merge

Standard four. Plus `( cd web && npm run build )` — the new JSON should not bloat the bundle excessively (target +12-15 KB minified).

## Workflow

1. Generate `cursive.json` via the existing build script.
2. `joinAdjacentGlyphs` + tests.
3. `hersheyTextToRuns` integration with join walk.
4. Font picker + thumbnail.
5. Pre-merge + smoke.
6. PR titled `Connecting cursive Hershey font (Tier 3 #79)`.

## Report back

Under 250 words. PR URL, the join-distance tolerances chosen (maxJoinDistance, maxJoinDrop) and what visual evidence drove them, what the worst-case joining looks like (e.g. "i" with a dot doesn't join — the dot is its own stroke), CI state, follow-ups.

## Follow-ups

- More cursive fonts (Hershey has several).
- Operator-tunable join tolerance per text insertion.
- Smart break on punctuation (current behavior: punctuation is its own glyph; doesn't join — confirm).
- Per-pair join offset (similar to the kerning offsets from PR #31).
