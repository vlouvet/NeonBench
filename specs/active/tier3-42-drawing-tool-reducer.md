# Tier 3 #42 — Drawing-tool state consolidation refactor

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/42-drawing-tool-reducer`

## Goal

`EditorCanvas.tsx` carries six pieces of drawing-tool state — `pen` vertices in progress, `rect` first-corner, `circle` center, `arc` first/second click, plus the `prevTool` watcher that resets all six on tool change. Per PR #37's report, the resets are a sign that drawing-tool state should live under one `useReducer` over a discriminated union of `currentTool`, eliminating tool-change cleanup entirely.

PR #44 also flagged a vestigial `shapeDragRef` that's only ever written. Delete it.

"Done" means: a single `drawingState` reducer governs every in-progress drawing-tool operation; switching tools is a `dispatch({type: 'switchTool', tool})` that the reducer handles by resetting to that tool's initial state; the existing six pieces of state are gone; `shapeDragRef` is deleted; every existing UX behavior is preserved (vitest covers the docOps; manual smoke covers the canvas).

This is **a real refactor of `EditorCanvas.tsx`** — the highest-coupling file in the repo. It must run solo (no parallel agents), the test surface is mostly manual, and the spec author must read the file end-to-end before writing the diff. Treat this as a multi-day spec, not a one-shot.

## Branch + setup

```sh
git fetch origin
git checkout -b task/42-drawing-tool-reducer origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/components/EditorCanvas.tsx` — replace six `useState` hooks for in-progress drawing state with a single `useReducer` over a `DrawingState` discriminated union (`{tool: 'pen', vertices: [...]}` | `{tool: 'rect', firstCorner: ...}` | etc.). Move all `setX` callsites to `dispatch({...})`. Delete `prevTool` watcher and `shapeDragRef`. The pen/rect/circle/arc rendering logic that reads the state must read it through the reducer's current state.
- `web/src/components/EditorCanvas.test.tsx` (new IF the project has component tests; otherwise skip) — pin the reducer's transitions in isolation.
- `web/src/lib/drawingState.ts` (new) — extract the reducer + types as a pure function so it's vitest-friendly without RTL setup.
- `web/src/lib/drawingState.test.ts` (new) — exhaustive transition tests.

**Don't touch:**

- `web/src/pages/EditorPage.tsx` — props-up stays as-is.
- `web/src/lib/docOps.ts` — finalization (when a draw commits to a run) still goes through existing helpers.
- Backend.

**New:**

- `web/src/lib/drawingState.ts`
- `web/src/lib/drawingState.test.ts`

## Deliverables

1. **`DrawingState` type:**
   ```ts
   type DrawingState =
     | { tool: 'select' | 'electrode' | 'blockout' | 'jump' | 'support' | 'doubleback' | 'addBend' | 'label' | 'dimension' | 'node' | 'insertDB' }
     | { tool: 'pen'; vertices: Point[] }
     | { tool: 'rect'; firstCorner: Point | null }
     | { tool: 'circle'; center: Point | null }
     | { tool: 'arc'; firstClick: Point | null; secondClick: Point | null };
   ```
2. **Reducer actions**:
   - `{ type: 'switchTool'; tool }` — reset to initial state for the new tool.
   - `{ type: 'penVertex'; point }` — append to vertices (only valid when `tool === 'pen'`).
   - `{ type: 'penCommit' }` — clear vertices (the run is added externally to docOps).
   - `{ type: 'penCancel' }` — same, but no run added.
   - `{ type: 'rectFirstCorner'; point }`, `{ type: 'rectCommit' }`.
   - `{ type: 'circleCenter'; point }`, `{ type: 'circleCommit' }`.
   - `{ type: 'arcFirstClick' }`, `{ type: 'arcSecondClick' }`, `{ type: 'arcCommit' }`.
   - All actions that don't apply to the current tool are silently ignored (the reducer is total — it never panics).
3. **Initial state per tool**: `pen` → `{vertices: []}`; `rect` → `{firstCorner: null}`; `circle` → `{center: null}`; `arc` → `{firstClick: null, secondClick: null}`; everything else → `{}`.
4. **Delete `shapeDragRef`** entirely (`useRef` declaration + the two write sites).
5. **Preserve every existing UX behavior**: pen still commits on Enter / double-click; rect/circle still on pointerup; arc still on third click; Esc still cancels and switches back to select tool. The reducer just tidies state plumbing.

## Constraints

- **No new third-party deps.** Use native `useReducer`.
- **No behavior changes** — every keystroke, click, and drag must produce identical canvas output to today. The PR is a structural refactor, not a feature add.
- **No new features sneaking in** — multi-vertex select (#33), snap-to-geometry (#34), etc. are explicitly out of scope.
- **No test-coverage regressions** — every existing vitest test must pass unchanged. The new reducer tests are additional coverage.
- **No file-size explosion in EditorCanvas.tsx** — the goal is fewer lines + fewer hooks, not more. If your diff has more lines added than removed, stop and audit; the abstraction probably isn't earning its keep.

## Geometry / algorithms

None — this is structural. The drawing math itself doesn't move; only the state plumbing does.

## Tests

Add to `drawingState.test.ts`:

- Every action × every tool combination — assert post-state matches expectation.
- `switchTool` from any state to any tool resets to that tool's initial state.
- `penVertex` accumulates points in order; `penCommit` clears them.
- `arcFirstClick` then `arcSecondClick` populate both fields; a third "commit" event clears both.
- Invalid-for-current-tool actions are no-ops (e.g. `penVertex` while `tool === 'rect'` returns the same state).

For `EditorCanvas.tsx` itself, no automated test (no RTL); manual smoke covers the canvas behaviors.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke (every tool, twice — once committing, once Esc-cancelling):

1. Pen: drop 3 vertices, double-click → run added. Drop 3 vertices, Esc → no run, state cleared.
2. Rect: pointerdown → drag → pointerup → run added.
3. Circle: same.
4. Arc: 3 clicks, run added. 2 clicks then Esc, no run.
5. Switch tools mid-draw (e.g. start pen, switch to rect mid-vertex-drop) — verify no stale state from the abandoned pen drawing leaks into the rect tool's behavior.
6. Run every existing manual smoke test from the README walkthrough — no regressions.

## Workflow

1. Read `EditorCanvas.tsx` end-to-end (~1700 lines after PR #44). Catalog every read/write of the six state hooks. Build a transition table on paper.
2. Build `drawingState.ts` + tests as a pure function. Land tests; verify all transitions pass.
3. Replace the six `useState`s with one `useReducer`. Mechanical mapping per the transition table. Delete `prevTool` and `shapeDragRef` last.
4. Run vitest; all green.
5. Manual smoke through every scenario above.
6. Run all four pre-merge checks.
7. Open PR titled "Drawing-tool state consolidation: useReducer + delete shapeDragRef (Tier 3 #42)".
8. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include:

- PR URL
- File-size delta on `EditorCanvas.tsx` (must be a NET reduction)
- Implementation summary (transition table, action shape)
- Judgment calls — especially around the discriminated-union shape; what got pruned beyond the six hooks (if anything)
- CI state
- Manual smoke results
- Tier 3 follow-ups (e.g. extending the reducer pattern to selection state for #33; lifting the snap state into the reducer for #34)
