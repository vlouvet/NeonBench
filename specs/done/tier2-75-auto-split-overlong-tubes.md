# Tier 2 #75 — Auto-split overlong tubes

> **Status:** SHIPPED 2026-08-31 · branch `task/2-auto-split-overlong-tubes` · NW parity (max-tube-length ergonomics)

> **Correction on merge.** This spec calls the limit `MaxRunLengthMM` and the rule
> a warning. Neither is what the code has: the field is `max_segment_length_mm`
> (`storage.TubeSpec`), the rule is `RuleMaxSegmentLength` in
> `internal/validate/rules.go`, and it emits `SeverityError`, not a warning. The
> deliverable is unchanged — the auto-fix is what was missing — but nothing in
> the shipped code uses the names below.

## Goal

Today NeonBench's max-tube-length validation rule (NW #129 ✅) flags tubes longer than the spec's `MaxRunLengthMM` as a warning at the polyline midpoint. The operator then walks each warning and manually `splitRun()`s. NW has the same rule but also offers a one-click "Split overlong tubes" action that splits each violating tube into segments of at-or-below the limit, choosing the split point at the longest-possible-runs-while-respecting-limits boundary.

"Done" means: a new sidebar action **"Split overlong tubes"** that walks every run violating `MaxRunLengthMM`, computes the optimal split count (`ceil(length / limit)`) and split positions (evenly distributed along arc length), calls `splitRun` at each, and emits an undoable batch.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-auto-split-overlong-tubes origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — `autoSplitOverlongTubes(doc, maxLengthMM): { doc, splitCount }`. Walks every run; for each whose total length exceeds the limit, computes `n = ceil(length / limit)` evenly-spaced split positions (by arc length, not Euclidean) and applies `splitRun` at each via `insertVertex` first. Returns the new doc + count for the toast.
- `web/src/lib/docOps.test.ts` — pin: 1500mm tube vs 1000mm limit → 2 runs each ~750mm; 2500mm tube vs 1000mm limit → 3 runs each ~833mm; closed-loop case (no electrodes) splits into open arcs at the chosen vertices; idempotent re-run (no-op if every run is at-or-below limit).
- `web/src/pages/EditorPage.tsx` — sidebar action "Split overlong tubes" gated on "validation report has at least one max-length violation"; toast: "Split N runs into M pieces · Undo."

**Don't touch:**

- The validator rule itself (`RuleMaxRunLength`) — it stays a warning; this PR adds the auto-fix.
- Backend / schema — pure-frontend op.
- The bend-list PDF — consumes the post-split runs unchanged.

## Deliverables

1. **`autoSplitOverlongTubes(doc, maxLengthMM)`** — pure-function over the doc. For each run:
   - Compute total arc length.
   - If `length <= maxLengthMM`, skip.
   - Else `n = ceil(length / maxLengthMM)`.
   - Pick `n-1` split positions at arc-length fractions `1/n, 2/n, ..., (n-1)/n`.
   - For each position, walk the polyline cumulative arc length to find the segment, compute the exact crossing point, `insertVertex` there, then `splitRun` at the new vertex.
   - All splits inherit the source run's color/diameter/notes. New IDs allocated via `nextRunId`.
2. **Sidebar action** — disabled when no violations exist. Confirmation toast on apply.
3. **Tests** — geometric: 1.5× / 2.5× / 3.5× the limit; closed-loop (electrodeless) case; mixed compliant + violating doc.

## Constraints

- **Arc length, not Euclidean.** A serpentine tube's arc length is what the bend list cares about.
- **Even spacing.** Don't try to be clever about splitting at "natural" points (vertices, electrodes); even spacing is predictable and matches NW's behavior.
- **One undo step.** Whole batch wraps in `editDoc`.
- **Closed loops:** if a run has no electrodes (decorative loop), the auto-split converts it to N open arcs; the operator places electrodes after.

## Tests

Manual smoke:

1. Author a single 2500mm tube on a project with `MaxRunLengthMM = 1000`. Validation flags it. Click "Split overlong tubes." Result: 3 runs, ~833mm each. Validation now passes.
2. Re-run "Split overlong tubes" → 0 splits (idempotent).
3. Undo → 1 long tube returns; redo → 3 short tubes return.

## Pre-merge

Standard four.

## Workflow

1. Arc-length splitting helper + tests (this is the geometry meat).
2. `autoSplitOverlongTubes` + tests.
3. Sidebar UI + gating logic.
4. Pre-merge + smoke.
5. PR titled `Auto-split overlong tubes (Tier 2 #75)`.

## Report back

Under 200 words. PR URL, the splitting strategy (even spacing vs nearest-vertex), how closed-loop runs are handled, idempotency check used, CI state, follow-ups.

## Follow-ups

- "Split at nearest vertex" mode (snap each split position to the closest existing polyline vertex within tolerance).
- "Optimize for fewest splits" mode (only one split if the tube is just barely overlong).
- Per-run override on the auto-split (skip specific runs the operator wants to leave overlong).
