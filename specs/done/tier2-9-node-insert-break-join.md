# Tier 2 #9 — Node insert / break / join

> **Status:** active · started 2026-05-07 · branch `task/9-node-insert-break-join`

## Goal

The `node` editor tool currently supports drag-vertex (move) and shift-click-vertex (delete). To make the editor a real polyline-shaping tool — and to round out the parity with NeonWizard's Node Edit Tools (NW #78) — three more operations are needed:

1. **Insert vertex on segment** — click an empty point on a polyline segment, a new vertex appears there, becomes draggable.
2. **Break (split run at vertex)** — modifier-click a vertex; the polyline splits into two new runs at that vertex. Closed runs become two open runs.
3. **Join two endpoints** — pick two polyline endpoints (same run or different runs); they merge into one continuous polyline. Reverses one side if needed so directions align.

Without these, users who shape polylines beyond what the vectorizer produced (or beyond what the pen tool drew in one go) hit a wall.

## Branch + setup

```sh
git fetch origin
git checkout -b task/9-node-insert-break-join origin/main
./scripts/setup-hooks.sh
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/components/EditorCanvas.tsx` — the existing `node` tool dispatch is at lines ~881–895 (drag + shift-click). Extend with: click-on-segment to insert a vertex, alt-click on a vertex to split, click-an-endpoint-then-another-endpoint to join. Pick a UX that doesn't collide with the existing drag-vs-shift-click semantics (e.g., alt for split is unused; segment-click anywhere outside an existing vertex's hit zone naturally distinguishes from vertex-click; for join, a small "Join" sidebar action that arms a two-click selector is cleaner than overloading the modifier set further).
- `web/src/pages/EditorPage.tsx` — add the new callbacks (`onInsertVertex`, `onSplitRun`, `onJoinRuns`) routed through `editDoc()` so they go through the existing undo/redo stack. If you add a "Join" sidebar action, this is also where the two-click pairing state lives.
- `web/src/lib/docOps.ts` — add three exported functions: `insertVertex`, `splitRun`, `joinRuns`. See the **Algorithms** section.
- `web/src/lib/docOps.test.ts` — add tests covering each new helper, including the index-shifting cases that previous Node-related work has been bug-prone in (see test 4 in `insertDoubleback`'s coverage — same shape of coverage required here).
- `README.md` — one or two sentences in the editor walkthrough describing the new operations.

**Don't touch:**

- `web/src/components/VectorizePanel.tsx`, `web/src/components/HersheyTextDialog.tsx`, `web/src/components/PrintPanel.tsx`
- `web/src/pages/ProjectList.tsx`, `web/src/pages/ProjectDetail.tsx`
- `internal/storage/`, `internal/server/`, `internal/printpdf/`, `internal/printdxf/`, `internal/vectorize/`, `internal/designdoc/`
- `web/src/lib/shapes/`, `web/src/lib/hershey/`

No backend changes — the design-doc shape supports everything needed.

## Deliverables

### 1. `insertVertex(doc, runId, segmentIndex, t)` in `docOps.ts`

Splice one new vertex into a polyline at the chosen segment.

- `segmentIndex` is the index of the segment to operate on (segment `i` runs from `points[i]` to `points[i+1]`).
- `t ∈ [0, 1]` is the parametric position along that segment (0 = at `points[segmentIndex]`, 1 = at `points[segmentIndex+1]`).
- Inserts the new point at index `segmentIndex+1`, shifting every subsequent vertex by +1.
- Index-shifting: any electrode / blockout-endpoint / annotation / bend whose anchor is `≥ segmentIndex+1` shifts by +1.
- The new vertex is the natural drag target after insert. The simplest UX: after `editDoc(insertVertex(...))`, the user can immediately drag the new vertex (no special "selected vertex" state needed if the existing `NodeHandle` still works).

### 2. `splitRun(doc, runId, pointIndex)` in `docOps.ts`

Split one polyline into two new runs at a vertex.

- The vertex at `pointIndex` becomes both the **last vertex of the first new run** and the **first vertex of the second new run**. (Duplicating the vertex preserves continuity if the user later joins them back; see #3.)
- Closed runs become two open runs.
- The first new run keeps the original run's id and gets a `(a)` suffix on its name (or matches whatever convention the existing `splitTube` / similar ops use, if any). The second new run gets a fresh id and `(b)` suffix. If no name suffix convention exists, use `<original>-a` and `<original>-b`.
- **Metadata duplication:** color, diameter override, notes — both new runs inherit the same values.
- **Electrode partitioning:** electrodes whose `point_index < pointIndex` go to the first run, electrodes with `point_index > pointIndex` go to the second run (with their indices shifted to `index - pointIndex`). An electrode exactly at `pointIndex` is ambiguous — for V1, drop it and add a console warning. Realistically this is rare and the user can replace it.
- **Blockout partitioning:** blockouts entirely on one side go to that side's run; blockouts that straddle the split are dropped with a console warning (V1; a follow-up could split them too).
- **Annotation partitioning:** by `live_index` against the live arc — see how `insertDoubleback` handles annotations for the pattern.
- **Bend partitioning:** by `live_index` similarly.

### 3. `joinRuns(doc, runIdA, endpointA, runIdB, endpointB)` in `docOps.ts`

Merge two polylines into one. `endpointA` and `endpointB` are each `'head'` or `'tail'` — which end of each run to join.

- All four `(end, end)` combinations are valid; the implementation reverses one or both polylines as needed so the join is `tail-to-head`.
- The resulting polyline is `runA.points + runB.points` after any reversals, with the duplicate vertex at the join (if the two endpoints are at the same position, drop one — within 0.01mm).
- Result inherits `runA`'s metadata (color, diameter, notes). If `runA` was closed, opening it via reverse-then-join is fine; the result is open. If the user joined the head and tail of a single run with itself, the result is closed.
- **Self-join** (same run, head joined to its own tail) is supported and produces a closed run.
- **Annotations / electrodes / blockouts / bends:** transform each anchor through the reverse + concat operation. This is the bug-prone bit — write helper math, test it.
- The original two runs are removed from `doc.runs` and replaced by the single joined run, which gets `runA.id` (preserves selection state).

## Constraints

- **No new third-party deps** (Go modules or npm packages).
- **No backend changes** — design-doc shape supports everything.
- **No new validation rules** — geometry changes flow through the existing validator.
- **Don't fix unrelated lint diagnostics** — Tier 3 #25 tracks them.
- **Coordination:** no other agents are in flight right now, but stay scoped anyway in case Round C goes parallel later.

## Tests (must all pass before PR is mergeable)

In `web/src/lib/docOps.test.ts`, add at least:

**`insertVertex`:**
1. Inserts at midpoint of a 2-vertex segment → polyline has 3 vertices, middle one is the average
2. Custom `t = 0.25` produces the expected interpolated point
3. Existing electrode at `pointIndex+2` shifts to `pointIndex+3` after insert at `segmentIndex = pointIndex`

**`splitRun`:**
4. Splitting a 5-vertex open run at `pointIndex = 2` produces two open runs of 3 vertices each (with the middle vertex duplicated)
5. Splitting a closed run produces two open runs (closed → open)
6. Electrodes / blockouts / annotations partition correctly: an electrode at `point_index = 1` ends up on the first run with `point_index = 1`; an electrode at `point_index = 4` ends up on the second run with `point_index = 4 - 2 = 2`
7. A blockout straddling the split point is dropped (no crash, console.warn called)

**`joinRuns`:**
8. `tail`-to-`head` join with no reversal: `[A,B,C] + [C,D,E] → [A,B,C,D,E]` (duplicate vertex at the join is dropped)
9. `tail`-to-`tail` join: second run's polyline is reversed
10. `head`-to-`head`: first run reversed, then concatenated normally
11. Self-join (same run, head + tail) on a 4-vertex polyline produces a 4-vertex closed run
12. Electrodes from both runs end up on the result with correctly transformed indices

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )  # advisory; no NEW diagnostics
```

## Workflow

1. Read the existing `node` tool dispatch in `EditorCanvas.tsx` (lines ~881–895) and the existing `insertDoubleback` (`docOps.ts:483+`) for the index-shifting pattern.
2. Implement the three helpers in `docOps.ts` with full unit-test coverage. Get the math right *before* wiring the UI.
3. Wire the three operations into `EditorCanvas.tsx` + `EditorPage.tsx`. Verify in `cd web && npm run dev` + `./bin/neonbench --dev`.
4. Update README's editor walkthrough — one or two sentences alongside the existing node-tool description.
5. Run all four pre-merge checks.
6. Commit logically (suggested: docOps + tests, then UI wiring, then README + spec move).
7. **Move this spec from `specs/active/` to `specs/done/`** as part of the final commit.
8. `git push -u origin task/9-node-insert-break-join`.
9. PR. Title: `Node insert / break / join (Tier 2 #9)`. Body: WHY (NW #78 parity, completes the polyline-shaping toolkit), the three operations, the index-shifting trap, pre-merge checklist.
10. Watch CI; iterate if red.

## Report back (under 300 words)

- PR URL
- Implementation summary (the three helpers + how each commits through `editDoc()`)
- UX choices (sub-mode vs modifier vs sidebar action — and why)
- File sizes for each helper + test coverage
- CI final state for both `test` and `windows-smoke`
- Judgment calls (e.g., "blockouts straddling the split are dropped with a warn; splitting them feels like a follow-up since the user can re-mark trivially")
- Follow-ups worth tracking as Tier 3 rows (e.g., "split a blockout that straddles the split point into two valid blockouts on each side", "auto-position the second run's name suffix to use the run-numbering convention rather than `-a` / `-b`")
