# Tier 3 #19 — Hershey text: kerning, multi-line, additional faces

> **Status:** active · started 2026-05-07 · branch `task/19-hershey-polish`

## Goal

PR #8 shipped Hershey Roman Simplex text insertion as a single-line, uniform-tracking modal. Three follow-ups remain from `todo.md` Appendix B row 19:

1. **Per-letter custom kerning** — drag handles in the modal's SVG preview let the user nudge the gap between adjacent letters; the offsets ride through to the inserted runs.
2. **Multi-line input with line-height control** — the text field becomes a `<textarea>`, newlines start a new baseline, and the user can set line-height (default 1.2× cap height).
3. **Additional Hershey faces** — bundle Roman Duplex (thicker channel-letter look) and Sans Simplex / Futural (geometric sans) alongside Simplex. Add a font picker in the dialog.

"Done" means: the dialog is still self-contained, EditorPage's `insertHersheyText` is unchanged, every existing test still passes, and the new features each have at least one regression test. The build script stays the canonical way to add more faces later.

## Branch + setup

```sh
git fetch origin
git checkout -b task/19-hershey-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/lib/hershey/text.ts` — extend the converter for multi-line, per-letter kerning, and font selection. Switch the public signature to an options object (existing positional callers don't exist outside `HersheyTextDialog.tsx`, which you also own).
- `web/src/lib/hershey/text.test.ts` — add tests for the three new behaviors; keep all existing assertions.
- `web/src/components/HersheyTextDialog.tsx` — textarea, line-height input, font picker, draggable kerning handles in the preview SVG.
- `scripts/build-hershey-font.mjs` — accept a `--font <name>` arg (or iterate a known list) so the same script can produce `rowmans.json`, `rowmand.json`, `futural.json`. Default behavior with no flag = build all three. Keep the existing JHF cache logic.
- `web/src/index.css` (or whichever existing stylesheet `.hershey-modal` rules live in — grep first) — minor styles for the new controls and the kerning-handle hover/drag affordance.

**New:**

- `web/src/lib/hershey/fonts.ts` — small font registry: a typed map from font key (`'rowmans' | 'rowmand' | 'futural'`) to its imported JSON + display name + cap-height units. The text converter picks the active font through this registry; the dialog reads it for the picker.
- `web/src/lib/hershey/rowmand.json` — produced by the build script; check it in.
- `web/src/lib/hershey/futural.json` — produced by the build script; check it in.

**Don't touch:**

- `web/src/components/EditorCanvas.tsx`, `web/src/pages/EditorPage.tsx` — high-coupling files. The dialog's `onInsert` contract still emits `HersheyRun[]` plus `capHeightMM`; do not change that signature, or this becomes a multi-file refactor.
- `web/src/lib/docOps.ts` — runs are appended exactly as today.
- Any backend file. This is a frontend-only change.
- `web/src/lib/hershey/rowmans.json` — leave the existing artifact untouched unless the build script's output is byte-identical to what's checked in. (It should be, since the parser logic isn't changing.)

## Deliverables

1. **Multi-line text input.** `<input type="text">` becomes `<textarea rows={3}>` with a max length of 256. Splitting on `\n` produces one baseline per line, advancing `originY` by `capHeightMM * lineHeight` for each subsequent line. A new "Line height" numeric field defaults to `1.2`, range `0.8`–`3.0`, step `0.1`. Empty lines are valid (they advance the baseline without emitting strokes).
2. **Per-letter kerning handles.** For an N-character input there are N−1 kerning slots between adjacent characters (newlines reset; whitespace counts as a character with its own slots). Each slot starts at `0 mm`. In the preview SVG, render a small triangular handle (▾) at each slot's current X position, on a row above the baseline. Mouse-down on a handle then mouse-move horizontally adjusts that slot's kerning value (1 px in screen space = 1 mm in design space at the preview's current scale; live recompute the strokes on each move). Display the active handle's value as a small text label that follows the cursor. Reset button clears all kerning to 0.
3. **Font picker.** Add a `<select>` listing the three faces: "Roman Simplex (default)", "Roman Duplex (thicker)", "Sans Simplex (Futural)". Switching the font recomputes the preview but does NOT clear the user's kerning array (the slots are positional, font-agnostic).
4. **Build script multi-font.** `node scripts/build-hershey-font.mjs` with no args produces all three JSON files. With `--font rowmand` (or `rowmans`, `futural`), it produces only that one. Source URLs follow the same `kamalmostafa/hershey-fonts` path pattern (`{name}.jhf`). Output JSON shape is identical to the existing `rowmans.json`.
5. **Updated converter API.**
   ```ts
   export function hersheyTextToRuns(opts: {
     text: string;
     font?: 'rowmans' | 'rowmand' | 'futural';     // default 'rowmans'
     capHeightMM: number;
     originX: number;
     originY: number;
     letterSpacingMM?: number;                     // default 0 — applies uniformly
     perPairKerningMM?: number[];                  // length text.length - 1; entries beyond array length default to 0
     lineHeight?: number;                          // default 1.2 (multiplied by capHeightMM)
   }): HersheyRun[];
   ```
   The existing positional 5-arg signature is replaced. `HersheyTextDialog.tsx` is the only consumer; update it in the same commit.

## Constraints

- **No new third-party deps** (Go modules or npm packages). Drag math is plain `onPointerDown/Move/Up`; no DnD libraries.
- **Do not change the `onInsert(runs, capHeightMM)` shape.** If you find yourself wanting to also pass kerning/lineHeight up to EditorPage, stop — those are baked into the emitted `HersheyRun[]` geometry already.
- **Preserve the existing `rowmans.json` byte content.** The parser logic isn't changing; the diff for that file should be zero. If it isn't, investigate before regenerating.
- **No schema changes** anywhere — DesignRun shape doesn't move.
- **No backend changes** — this is purely frontend + a build-time script.
- The new JSON files must stay small (rowmans.json is currently ~30 KB; rowmand will be ~2× that, futural similar to rowmans). Don't pretty-print — `JSON.stringify(out)` with no indent matches the existing artifact.

## Geometry / algorithms

**Multi-line baselines.** Iterate `text.split('\n')`; for line index `i`, the baseline is `originY + i * capHeightMM * lineHeight`. Each line's cursor restarts at `originX`. Per-pair kerning is consumed across the whole input (so a newline does NOT consume a kerning slot — the slot at index `lineEndChar` is between the last char of the line and the `\n`, and we conventionally treat it as no-op).

**Per-pair kerning.** After advancing the cursor for a glyph (existing `cursorX += (glyph.right - glyph.left) * scale`), add `perPairKerningMM[charIndex] ?? 0` BEFORE drawing the next glyph. `letterSpacingMM` is added on top, uniformly. Negative kerning values are allowed (lets the user tighten); clamp to a reasonable floor like `-capHeightMM` so users can't fully overlap glyphs into garbage.

**Drag-handle hit math.** In screen space the preview SVG has an explicit `viewBox`. Compute the screen-to-mm scale once on `pointerdown` from `svg.getBoundingClientRect().width / viewBox.width` and reuse it through the drag (don't recompute per move — the box doesn't change while the user holds the mouse). `dx_screen / scale = delta_mm` is what gets added to that slot's kerning value.

**Font cap-height units.** Roman Simplex has a working cap height of ~12 JHF units (the existing `CAP_HEIGHT_JHF_UNITS` constant). Roman Duplex matches; Futural also ~12. Confirm empirically per font when generating the JSON — store the value in the registry so the converter scales correctly per font instead of hard-coding 12.

## Tests

Add to `text.test.ts`:

- **Multi-line.** `hersheyTextToRuns({ text: 'A\nB', capHeightMM: 100, originX: 0, originY: 0 })` returns runs whose first-line points all have `y < 100` (above the second baseline) and second-line points have `y >= 100` (the second baseline is at 100 × lineHeight=1.2 → 120, so first line caps end around y≈0 and second line caps start around y≈108). Assert any second-line point's `y > 100`.
- **Line height.** Same input with `lineHeight: 2.0` produces a Y-gap roughly 2/1.2 × the default — assert second-line min-Y is at `originY + capHeightMM * 2.0` (with a small tolerance).
- **Per-pair kerning.** `text: 'AB'` with `perPairKerningMM: [50]` shifts every B-stroke point's X by +50 mm vs the default; assert `min(B.x) - max(A.x)` increases by ~50.
- **Empty kerning array.** Passing `perPairKerningMM: []` (or undefined) is identical to today's output. This is the regression guard.
- **Font selection.** `text: 'A'` with `font: 'rowmand'` produces strictly more strokes than `font: 'rowmans'` (Duplex doubles each line). Don't snapshot exact stroke counts — they're font-data-dependent — just assert `rowmand.length > rowmans.length`.
- **Newline doesn't consume a kerning slot.** `text: 'AB\nCD'` with `perPairKerningMM: [10, 999, 30]` (slot 1 = position between B and \n) — assert the C/D pair's offset is +30, not +999, so the array indices are consistent with `text.length - 1` ignoring newlines for sanity. (If you decide newlines DO consume a slot, that's also fine — just pick one and document it; the test should match the choice.)

For the dialog, no unit test (we don't have RTL set up); the manual smoke test covers the UI.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # advisory; no NEW diagnostics
```

Then a manual smoke test in a browser:

```sh
( cd web && npm run dev )
# Open the dev URL, load any project, hit the editor, click "Add text"
```

Verify:

1. Multi-line "OPEN\n2026" inserts as 2 lines of strokes.
2. Drag a kerning handle right; the letters spread, value display follows the cursor.
3. Switch font to "Roman Duplex"; the preview thickens visibly.
4. Reset button zeroes all kerning slots.
5. Click Insert; the runs land in the design at the expected position.
6. Edge: 1-character input has no handles and inserts cleanly.
7. Edge: empty input keeps Insert disabled.

## Workflow

1. Generate the two new JSON files first via the updated build script. Commit them in their own commit so the diff is reviewable.
2. Land the converter API change + tests in the next commit; verify all existing tests still pass before touching the dialog.
3. Update the dialog (textarea → kerning handles → font picker), one feature per commit if it stays clean.
4. Run all four pre-merge checks; do the manual smoke test.
5. Open PR titled "Hershey polish: kerning, multi-line, +Duplex/Futural (Tier 3 #19)". Body links to `todo.md` Appendix B row 19.
6. **Move this spec** from `specs/active/tier3-19-hershey-polish.md` to `specs/done/tier3-19-hershey-polish.md` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary (what shipped, what was deferred)
- Judgment calls (especially the newline-kerning-slot semantics)
- File sizes for the new JSON artifacts
- CI final state
- Any Tier 3 follow-ups worth tracking (kerning presets, automatic optical kerning, font preview thumbnails, etc.)
