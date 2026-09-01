# Tier 3 #89 — Run ids should not shuffle after a batch split

> **Status:** active · drafted 2026-08-31 · branch `task/3-run-id-allocation` · follow-up from Tier 2 #75

## Goal

`nextRunId` returns the lowest unused `r<n>` on the doc. That is correct and collision-free, and it was a deliberate improvement over the old `<id>-a` / `<id>-b` nesting (Tier 3 #25). But ids freed *mid-batch* get reused, so a run split four ways comes out **`r1, r3, r2, r5`** in physical order along the glass: the first cut mints `r1`/`r2`, splitting `r2` frees it and mints `r3`/`r4`, splitting `r4` frees *that* and re-mints `r2`.

It is cosmetic — no duplicates, no collisions, and the manual split tool has always behaved this way. It is worth fixing anyway because the operations that produce the most pieces at once are the new ones (Tier 2 #74's raceway split, Tier 2 #75's overlong split), and the run list is how the operator identifies a piece on the bench. Handing them a list that reads out of order on exactly the action that produced it is a small, repeated confusion.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-run-id-allocation origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — `splitRun` currently calls `nextRunId` twice, threading a synthetic doc through the second call. The fix is to allocate against a **high-water mark** rather than the lowest free slot: track the maximum `r<n>` ever seen on the doc and mint above it. That makes ids monotonic within a batch without any caller changes.
- `web/src/lib/docOps.test.ts` — pin the ordering for a 4-way split.

**Don't touch:**

- `renameLegacyRunIds`. That is a separate, opt-in migration for pre-#25 docs and has nothing to do with allocation order.
- The id *format*. `r<n>` stays; only which `n` is chosen changes.

## Deliverables

1. **Monotonic allocation** — ids increase along the run list after a batch split.
2. **Tests:** a 4-way `autoSplitOverlongTubes` yields ids in ascending order matching physical order; a raceway split of several runs does too; a single manual `splitRun` on a doc with gaps in its numbering still produces two fresh, non-colliding ids; existing ids are never renamed.

## Constraints

- **Never rename an existing run.** An id is what the operator wrote on the bench tag; allocation order is a nicety, and renaming to achieve it would be worse than the problem.
- **Ids stay unique across the doc**, including against runs whose ids do not match `r<n>` at all (`text-1`, `circle-2`) — `nextRunId` already ignores those and must continue to.
- **A high-water mark grows monotonically.** On a long-lived doc with many splits and deletes the numbers will get large. That is the intended trade: gaps are cheaper than shuffles. Say so in the code comment so a future reader does not "fix" it back.

## Tests

Manual smoke: draw one long tube, run "Split overlong tubes", and read the run list top to bottom — the ids should ascend.

## Pre-merge

Standard four.

## Report back

Under 150 words. PR URL, the allocation rule, what happens to ids on a doc that already has gaps, CI state.

## Follow-ups

- Operator-editable run ids (bench tags rarely match `r7`).
