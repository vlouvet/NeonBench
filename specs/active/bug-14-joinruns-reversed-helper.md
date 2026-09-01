# Bug #14 — `joinRuns.reversedRun` corrupts arcs and inverts blockout ranges

> **Status:** active · found 2026-08-31 · blocked on PR #149 merging first

## Symptom

Joining two runs end-to-end, when either has to be flipped to make the ends
meet, corrupts the flipped run: its arcs land on the wrong segments, and any
blockout on it comes back as an inverted range.

This is the **third** instance of the carry-and-remap bug class documented in
`CLAUDE.md` (after `splitRun` in PR #140 and `reverseRun` in Bug #11). It was
found by grepping for other places that reverse point order while fixing #11 —
which is exactly the check the playbook now asks for.

## Root cause

`joinRuns` has its own local `reversedRun` helper (`web/src/lib/docOps.ts`,
~line 1475), separate from the exported `reverseRun`. It:

1. **Never touches `polyline.segment_types`.** Same omission Bug #11 fixed in
   the exported function. Index *i* is the segment leaving vertex *i*, so
   reversal must map new *j* → old `n-2-j` (mod n when closed).
2. **Flips blockout range endpoints without swapping them:**
   ```ts
   blockouts: r.blockouts.map((b) => ({
     start_live_index: flipPt(b.start_live_index),
     end_live_index:   flipPt(b.end_live_index),
   }))
   ```
   With `flipPt` monotonically decreasing, a range that ran start→end now runs
   end→start. The two fields must be swapped as well as flipped.
3. **Uses `flipPt(i) = n-1-i` on live indices**, where `n` is the *point*
   count. Live indices are live-arc-relative, not vertex indices. PR #149
   established the correct approach — map each live position through its
   polyline vertex — read that fix and reuse it rather than re-deriving.

## Fix

Delete the local helper and reuse the corrected exported `reverseRun`, if the
semantics allow it. That is the outcome to aim for: one reversal implementation
in the codebase, not two that drift. If `joinRuns` genuinely needs different
behaviour (e.g. it must not flip `direction`), extract the shared remapping
into one helper both call, and say in the PR body why the split is necessary.

## Scope limit — the arc bow

Like Bug #11, the **handedness half cannot be fixed here.** `arcFor` always
bows left of travel, so a reversed arc mirrors about its chord no matter how
the flags are remapped. Fixing the indices is still worth doing on its own (it
removes the arcs-on-wrong-segments corruption), but do **not** claim the shape
is preserved. The signed arc side lands in Tier 3 #87, which is approved and
carries the deliverable that closes this properly.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts` (`joinRuns` and its helper only),
`web/src/lib/docOps.test.ts` (append). Nothing else.

## Tests

- Join two open arc runs where B must be flipped; assert `segment_types` on the
  result places arcs on the same geometric segments as before the join.
- A blockout on the flipped run comes out with `start_live_index <
  end_live_index` and covering the same physical stretch of glass.
- Electrodes, annotations and bends land on the same geometric points.
- Joining two line-only runs is unchanged (pin the current behaviour).
- All four endpoint combinations (head/tail × head/tail) plus the self-join
  close-the-loop path.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
```

Browser: draw two runs, arc a segment on each, join them at various endpoints,
confirm the curve doesn't move; save and reload.
