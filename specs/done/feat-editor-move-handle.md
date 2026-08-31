# feat — Editor center grab handle (drag-to-move runs in Select tool)

> **Status:** shipped #127 (319532c) · drafted 2026-06-05 · branch `task/2-move-run-handle` · requested by user

## Goal

With the **Select** tool and one or more runs selected, the operator wants a **grab handle in the
middle of the selection** to drag the run(s) to a new position. Previously Select only offered the 8
resize handles (feat-editor-scale-handles #123) — there was no translate affordance, so moving a run
meant editing every vertex.

## Implementation

`web/src/components/EditorCanvas.tsx` + `web/src/App.css` only. **No EditorPage change** — the move
reuses the existing `onScaleRuns(updates)` prop (it applies arbitrary new point arrays via
`docOps.setRunsPoints`), so a drag coalesces into a single undo entry exactly like a resize.

- `moveDragRef` snapshots the selected runs' points + the press point (world space) on `beginMove`.
- `onMoveDrag` computes the world delta from the press point and translates every snapshot point by it,
  emitting `onScaleRuns`. `endMove` releases the pointer capture.
- The handle renders inside the existing `.resize-overlay` group at the selection-box center: a white
  circle (screen-constant size via `÷ transform.k`) with a 4-way move glyph, `pointerEvents="all"`,
  `cursor: grab` / `:active { grabbing }`. `beginMove` calls `e.stopPropagation()` so the press
  doesn't start a canvas pan (same guard as `beginResize`).

## Verified (Playwright, live build)

Selecting a run shows the center grab handle alongside the resize handles. Dragging it translates
**only** the selected run by exactly `screenDelta / zoom` in world space (other runs untouched), marks
the doc dirty (Save enabled), and is undoable.

## Out of scope

- Keyboard nudge (arrow keys) — could pair with this later.
- Snapping the moved selection to the grid (the existing snap toggle governs new geometry, not drags).
