# Tier 2 #71 — Channel-letter-from-text wizard

> **Status:** active · drafted 2026-05-09 · branch `task/2-channel-letter-wizard` · NW parity (#1 + #123 workflow)

## Goal

NW's headline workflow: type text → pick a font → set clearance from tube to return → "Auto Tube Layout" → done. One dialog, one click, fully populated channel-letter pattern (two parallel tubes per letter, broken at raceway, ready to plot).

NeonBench today requires the operator to compose the same result manually:

1. Open HersheyTextDialog → emit single-stroke runs.
2. Enter editor.
3. Select all runs.
4. Open Neonize sidebar → set offset → emit parallel tubes.
5. Manually mark each run as a channel-letter face (`Run.IsChannelLetterFace`).
6. (For raceway designs) Manually split each tube where it crosses the raceway.

Three to six steps where NW has one. **This is THE primary use case of every channel-letter shop** per the trade-tool transcript; closing this gap is the highest-leverage parity win remaining.

"Done" means: a single "Channel letter wizard" dialog that takes (a) the text, (b) the font, (c) the cap-height in mm, (d) the tube-to-return clearance, (e) optional raceway Y position, and emits a populated design with each glyph's outline + two parallel tubes (face + outer return) + face-flag set + raceway-grouped + tubes split at the raceway line if specified.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-channel-letter-wizard origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**New:**

- `web/src/components/ChannelLetterWizardDialog.tsx` — modal dialog with text input + font select + cap-height + clearance + raceway-Y inputs + live SVG preview + "Insert" / "Cancel" buttons. Mirrors HersheyTextDialog shape.
- `web/src/lib/channelLetter.ts` — pure function `channelLetterFromText(opts) → DesignRun[]`. Takes the dialog's input shape, internally calls `hersheyTextToRuns` (for the single-stroke skeleton) + a new helper `glyphOutlineFromHersheyRun` that bounds-boxes each glyph to a rectangular face outline, then runs the existing `offsetPolygon` (from `lib/neonize.ts`) at the user's clearance to produce inner+outer tubes per face.
- `web/src/lib/channelLetter.test.ts` — pin the geometry: 1-letter input → 2 face runs (inner + outer) + 1 face flag set; 3-letter input with raceway → 6 face runs + 3 raceway-split pieces.

**Modify:**

- `web/src/pages/EditorPage.tsx` — toolbar button "Channel letter wizard" next to the existing "Add text" button. Opens the new dialog. On insert, the emitted runs flow through `editDoc()` so undo/redo work.
- `web/src/lib/docOps.ts` — small `insertChannelLetterRuns(doc, runs, racewayId?)` op that appends + tags each run with `IsChannelLetterFace: true` + the optional `RacewayID`.

**Don't touch:**

- `lib/hershey/*` (the underlying single-stroke generator stays unchanged; the wizard composes on top).
- `lib/neonize.ts` (we call its existing `offsetPolygon` helper).
- Backend / schema (everything fits in `Doc` + `Run` fields that already exist).

## Deliverables

1. **Dialog UX** matching HersheyTextDialog conventions:
   - Text input with multi-line support (each line is a separate channel-letter row).
   - Font picker reusing `lib/hershey/fonts.ts`.
   - Cap-height input (mm), default 100.
   - Clearance input (mm), default `tubeDiameter * 1.5` so the inner tube hugs the face.
   - "Add raceway" toggle + Y-position input (mm from baseline).
   - Live SVG preview (1px = 1mm).
2. **Face-outline derivation.** For each glyph in the Hershey skeleton, compute a tight bounding rectangle (or convex hull if any of the three bundled faces have non-rectangular advance widths — verify with `glyphMetrics`). The face polyline is closed; the next neonize pass runs against this closed polyline.
3. **Two-tube emission per face** via `offsetPolygon` at `+clearance/2` and `-clearance/2`. Each face emits two runs: `<glyphId>-inner` and `<glyphId>-outer`. Color inherits from a "Tube color" picker in the dialog (default warm white).
4. **Auto-raceway split** when the user specifies a raceway Y. Each tube run that crosses Y gets `splitRun()`'d at the crossing X; the two resulting runs share the same `RacewayID`. PR #43 already handles the PDF strip aggregation downstream.
5. **Undo/redo** via `editDoc()` so the whole insertion is one undo step.
6. **Tests** — geometry for 1, 2, 3 glyphs; raceway-split case; cap-height scaling.

## Constraints

- **No new fonts.** Reuse the three bundled Hershey faces.
- **No backend changes.**
- **Don't introduce a separate "channel letter" run kind.** Reuse `IsChannelLetterFace: true` plus the `RacewayID` field; downstream PDF + DXF emitters already honor those.
- **Don't auto-electrode.** The wizard emits geometry; the user places electrodes manually. (A "place electrode at every face termination" batch op is Tier 2 #72.)

## Tests

Manual smoke:

1. Open editor on a fresh doc → click "Channel letter wizard".
2. Type `OPEN`, font Roman Duplex, cap-height 200mm, clearance 18mm, raceway Y 100.
3. Insert. Editor shows 4 letter outlines + 8 tube runs (2 per letter, split at raceway = 16 effective tube pieces). Bend list PDF emits 1 strip-page per letter (raceway-grouped).
4. Undo restores blank doc.

If browser smoke unavailable, document.

## Pre-merge

Standard four. Plus `( cd web && npm run lint )`.

## Workflow

1. `glyphOutlineFromHersheyRun` + tests first.
2. `channelLetterFromText` composing Hershey + offsetPolygon + raceway split.
3. Dialog UI matching HersheyTextDialog.
4. Toolbar button + insertion via `editDoc`.
5. Pre-merge + smoke.
6. PR titled `Channel-letter-from-text wizard (Tier 2 #71)`.

## Report back

Under 250 words. PR URL, glyph-outline strategy used (bounding rect vs convex hull vs other), how cap-height scaling composes through Hershey + offsetPolygon, raceway-split correctness on edge cases (tube crosses Y twice), CI state, follow-ups.

## Follow-ups

- "Auto-electrode every face termination" (combines with Tier 2 #72).
- Per-letter color pickers in the wizard (multi-color signs).
- Glyph-outline editing post-insert (drag the bounding rect corners to tighten).
