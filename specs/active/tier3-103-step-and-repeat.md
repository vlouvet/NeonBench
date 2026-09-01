# Tier 3 #103 — Step and repeat (array duplication)

> **Status:** active · drafted 2026-08-31 · branch `task/3-step-and-repeat`

## Goal

Borders, repeated letters, and multi-unit signs are built by duplicating a run
at a fixed pitch. Today that is copy-paste-nudge, repeated by hand. This adds a
grid/linear array over the selection.

Closes NW Design Tools **step-and-repeat**. Distinct from PR #145's print-time
`copies`, which repeats **pages**; this repeats **geometry in the design**.

## Premise, verified

PR #144 landed `web/src/lib/arrange.ts` with `runBBoxMM` and
`selectionBBoxMM`, both arc-aware via `flatRunPoints`. Reuse them — do not
recompute a bbox from `polyline.points`, which ignores arc bow.

## Strict file scope

**New:** `web/src/lib/stepRepeat.ts` + tests.
**Modify:** `web/src/components/ArrangePanel.tsx` (a new section — this is the
same family of operation), `web/src/pages/EditorPage.tsx` (one handler),
`README.md`.
**Don't touch:** `arrange.ts` itself beyond importing from it, `EditorCanvas.tsx`.

## Deliverables

1. `stepRepeat(doc, runIds, opts)` where `opts` is
   `{ countX, countY, pitchXMM, pitchYMM, pitchMode: 'gap' | 'centre' }`.
   `'gap'` measures edge-to-edge from the selection bbox, `'centre'`
   centre-to-centre — operators think in both, and guessing wrong silently
   halves or doubles the spacing.
2. Counts of 1×1 are a no-op returning the same doc object.
3. **New run ids from `nextRunId`.** Note the interaction with Tier 3 #89:
   `nextRunId` returns the lowest unused slot, so a large array will produce
   shuffled ids. #89's high-water-mark fix makes this coherent; until it lands,
   say in the PR body what the ids look like for a 5×5 array.
4. **Carry the classification** per CLAUDE.md's carry-and-remap table:
   `is_channel_letter_face`, `channel_letter_depth_mm`, `kind`. **Do not carry
   `raceway_id`** — a copy 500 mm to the right is not on the same raceway, and
   silently tagging it would put it on a strip page it does not belong to.
   `group_id`: put each copy in its own new group if the source was grouped, or
   leave ungrouped; decide and justify.
5. Electrodes, blockouts, bends and annotations **are** carried — indices are
   relative to the run's own points, which are translated, not renumbered.
   Assert this rather than assuming it.
6. Preview the array before committing (count and total extent shown), and
   guard against a runaway: refuse above ~400 total copies with a clear
   message.

## Tests

- 3×1 linear array at a known pitch; positions hand-computed
- `'gap'` vs `'centre'` differ by exactly the bbox dimension
- 1×1 is a no-op with object identity preserved
- Arc runs array correctly — `flatRunPoints` of each copy equals the source's,
  translated (this is the arc-aware bbox check in disguise)
- Classification carried; `raceway_id` explicitly **not** carried
- Child indices land on the same relative geometry in each copy
- Ids are unique across the whole doc afterwards
