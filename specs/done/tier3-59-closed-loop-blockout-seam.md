# Tier 3 #59 — Closed-loop seam continuity at blockout boundaries

> **Status:** active · drafted 2026-05-08 · branch `task/3-closed-loop-blockout-seam`

## Goal

When a closed polyline (decorative loop with no electrodes, or a closed loop with electrodes that gives a closed live arc) has a blockout that *straddles index 0*, the `blockoutSegments` helper in `web/src/lib/runArcs.ts` (and its Go mirror in `internal/designdoc/`) emits **two separate blockout segments** — one at the start (`[0..endLiveIdx]`) and one at the end (`[startLiveIdx..n-1]`) — instead of recognizing them as one continuous arc that wraps the seam.

The 3D preview's segment-split (Phase 3 #6) consumes this output, so the user sees two separate dark sleeves with a visible seam between them where there should be one continuous painted-over arc. Same artifact in the 2D editor SVG renderer.

This is a **rare-but-real** edge case — pure decorative loops (think a circle of trim around a logo) with mid-loop blockouts. Production designs usually have electrodes that break the loop, so it doesn't surface daily. But a single trim circle with paint over the entry/exit point is a plausible enough trade design that we should fix it.

"Done" means: a closed live arc with a blockout that wraps index 0 produces ONE blockout segment in `blockoutSegments` output (with the wrapped index list), not two; the 3D preview's `splitRunBySegments` consumes that single segment and renders one continuous dark sleeve; the 2D editor SVG renderer shows one dashed arc, not two.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-closed-loop-blockout-seam origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/runArcs.ts` — at the end of `blockoutSegments`, when `liveClosed === true` AND `out.length >= 2` AND the first and last segment have the same `isBlockout` flag, merge them into one segment (drop the seam-shared duplicate index). The merged `liveIndices` is `[...last.liveIndices, ...first.liveIndices.slice(1)]` so the wrap order matches polyline traversal.
- `web/src/lib/runArcs.test.ts` — add cases pinning the new behavior:
  - Closed live arc, blockout straddles index 0 → exactly 2 segments (one live, one blockout — not 3).
  - Closed live arc, no blockouts → 1 segment (unchanged).
  - Open live arc with blockout near the start (no wrap, no closure) → still 2 segments (no merge — the open-arc case is unchanged).
  - Closed live arc with two non-adjacent blockouts → 4 segments (no false merge).
- Same fix in the Go mirror (`internal/designdoc/blockouts.go` or wherever `splitByBlockouts` lives — find via `grep -rn "splitByBlockouts" internal/`). Backend uses the same logic for PDF/DXF emission.
- Backend test: extend the existing closed-loop blockout test (find via `grep -rn "splitByBlockouts" internal/.../*_test.go`).

**Don't touch:**

- `splitRunBySegments` (the Phase 3 segment-split consumer in `web/src/preview/segment-split.ts`) — it consumes whatever `blockoutSegments` emits unchanged. Fixing the upstream helper fixes both the 2D editor and the 3D preview consumers without further work.
- The seam-share contract — `blockoutSegments` already emits the seam-shared point in both adjacent segments; the merge here drops the duplicate when wrapping the closed loop's seam, but every other seam-share contract is preserved.

## Deliverables

1. **TS fix** in `blockoutSegments`:
   ```ts
   // After the loop, before the return:
   if (liveClosed && out.length >= 2) {
     const first = out[0];
     const last = out[out.length - 1];
     if (first.isBlockout === last.isBlockout) {
       const merged: BlockoutSegment = {
         isBlockout: first.isBlockout,
         liveIndices: [...last.liveIndices, ...first.liveIndices.slice(1)],
       };
       return [merged, ...out.slice(1, -1)];
     }
   }
   return out;
   ```

2. **Go mirror fix** with identical semantics. Find the matching helper, mirror the post-loop merge.

3. **Tests** as enumerated above. Pin the merge produces a single segment with the **wrapped index order** (so a polyline traversed in declaration order can render the segment without re-sorting).

4. **No schema changes, no API changes, no migration.** This is a pure-logic fix in two helpers.

## Constraints

- **Don't change the seam-share contract** for non-wrapping cases. Only the wrapped-merge path changes.
- **Open arcs are untouched.** When `liveClosed === false`, the merge guard short-circuits — open polylines never wrap.
- **Don't merge when the first and last segments differ in `isBlockout`** — they're a real boundary the user marked.
- **Identity invariant.** If a doc rendered correctly before this PR (no wrap-straddle), it must render byte-identically after. The merge only fires on a specific edge case.

## Tests

Unit (vitest):

- `closed live arc [0..9], blockout [8..2]` → 2 segments (live `[2..8]`, blockout `[8,9,0,1,2]`).
- `closed live arc [0..9], no blockouts` → 1 segment, unchanged.
- `closed live arc [0..9], blockout [3..5]` (no wrap) → 3 segments (live, blockout, live), unchanged.
- `closed live arc [0..9], blockouts [8..2] and [4..5]` → 3 segments (live, blockout, live, blockout) merged to 3 because the wrap-straddle blockout merges the start+end → so the result depends; verify by tracing carefully and pin whichever the merge yields.
- `open live arc [0..9], blockout near start [0..2]` → 2 segments unchanged.

Manual smoke (per spec):

1. Author a closed-loop run with no electrodes (decorative trim). Add a blockout that straddles its index 0 (e.g., paint over the visual seam where the loop was authored to start).
2. In the 2D editor SVG, the dashed blockout arc renders as ONE continuous dashed arc, not two.
3. In the 3D preview, the same arc renders as ONE dark sleeve, not two.
4. Print the PDF — the bend list shouldn't double-count the blockout boundary.

If you can't run a browser smoke from your worktree, say so.

## Pre-merge checks

```sh
./scripts/test.sh             # picks up both TS + Go test changes
( cd web && npm run lint )
( cd web && npm run build )
go vet ./...
```

## Workflow

1. Add the failing TS test first (red), then the fix (green).
2. Add the failing Go test, then mirror the fix.
3. Verify the 2D editor + 3D preview both render correctly via local smoke (or document deferral).
4. Pre-merge.
5. PR titled `Merge wrapped blockout segments on closed loops (Tier 3 #59)`.
6. **Move this spec from `specs/active/` to `specs/done/`** in the same PR.

## Report back

Under 200 words. Include: PR URL, where the matching Go helper lives (file path), test cases added (TS + Go), CI state, smoke result (or explicit "no browser"), and any follow-ups (e.g. validator should warn when a blockout's `start_live_index > end_live_index` to make the wrap-intent explicit).
