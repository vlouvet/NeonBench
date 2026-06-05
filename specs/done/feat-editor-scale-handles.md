# Feature — Drag-to-resize handles for the editor selection

> **Status:** active · drafted 2026-06-04 · user-requested (editor has no scale/resize today) · branch `task/feat-editor-scale-handles`

## Goal

The editor can place and move geometry but cannot **scale** it — e.g. text inserted at 100mm cap height can't be resized afterward; you'd delete and re-add. Add a standard design-tool affordance: when runs are selected with the **Select** tool, draw a bounding-box with **8 drag handles** (4 corners + 4 edge midpoints) and let the user drag them to resize the whole selection.

"Done" means: select one or more runs → handles appear around their bbox → drag a corner/edge to scale the selection live → release to commit (one undo step) → validation re-runs against the new geometry.

## Interaction design (conventional, matches Illustrator/Figma)

- **Visible when:** the **Select** tool is active AND `selectedRunIds.length >= 1`. Hidden during other tools, node-edit vertex selection, or active draw/pan.
- **Handles:** 8 small squares at the selection's axis-aligned world bbox — 4 corners + 4 edge midpoints — drawn inside the existing `<g transform>` at size `HANDLE_PX / transform.k` so they stay a constant ~8px on screen at any zoom. Each has its own resize cursor (nwse / nesw / ns / ew).
- **Anchor:** the handle **opposite** the dragged one stays fixed (drag bottom-right → top-left is the anchor). Corner = both axes scale; edge = the perpendicular axis only.
- **Aspect ratio:** corner handles scale **freely** (independent X/Y) by default; hold **Shift** to lock aspect (uniform). Edge handles are always 1-axis.
- **Min size guard:** clamp so the bbox can't collapse below ~2mm on either axis (avoids divide-by-zero and degenerate runs). No negative/flip scaling in v1 (clamp factor ≥ small ε).
- **No rotation** in v1 — resize only.

## Architecture (from investigation)

- Selection is `selectedRunIds: string[]` (prop into EditorCanvas). World↔screen via `transform {k,tx,ty}`; geometry renders inside `<g transform="translate(tx,ty) scale(k)">` ([EditorCanvas.tsx:1635](../../web/src/components/EditorCanvas.tsx#L1635)). A `screenToWorld` exists (~line 773).
- The existing multi-drag (`multiDragRef` + `onMoveVertices`) only moves vertices **within one run**, so a multi-run scale needs a new op + callback.
- `editDoc` **coalesces** rapid edits (`COALESCE_MS`) into one undo entry ([EditorPage.tsx:254](../../web/src/pages/EditorPage.tsx#L254)) — so calling the scale op on every pointermove collapses to a single undo.
- Scaling polyline points carries electrodes/bends/blockouts for free (they reference point **indices**, not absolute coords). Verify there are no absolute-coord per-run fields that need scaling too.

## Implementation

**Drag-from-snapshot (avoids compounding):** on pointer-down, snapshot each selected run's original points + the start bbox + the anchor + which handle. On each pointer-move compute the **absolute** new points from the snapshot (scale about the anchor) and commit them — never scale the live (already-scaled) doc.

**`web/src/lib/docOps.ts`** (new, pure + tested):
- `scalePoints(points, sx, sy, ax, ay)` → new points (`p' = anchor + (p - anchor) * s`). Exported for unit tests.
- `setRunsPoints(doc, updates: { runId, points }[])` → replaces each run's `polyline.points` in one pass (single new doc object). Index-based electrodes/bends are untouched and so follow.

**`web/src/pages/EditorPage.tsx`:**
- `onScaleRuns(updates)` → `editDoc((prev) => ops.setRunsPoints(prev, updates))`. Pass as a prop to EditorCanvas.

**`web/src/components/EditorCanvas.tsx`** (hazard file — keep the change self-contained):
- Compute `selectionBBox` (memo) = union bbox over `selectedRunIds` polylines (mirror the existing group-bbox code ~lines 263–294).
- Render a `<g>` of the bbox outline + 8 `<rect>` handles when Select tool + selection non-empty. Size `÷k`; per-handle `cursor`.
- Handle pointer events: `onPointerDown` on a handle captures the resize gesture (snapshot all selected runs' points, store anchor world-point + axis flags + start bbox), `stopPropagation` so it doesn't start a pan/rubber-band. On `pointermove` (window-level during the gesture, like the existing drag refs) compute `sx/sy` from the cursor world pos vs anchor and start bbox (Shift → uniform), clamp to min size, `scalePoints` each snapshot, call `onScaleRuns`. On `pointerup` end the gesture.
- Keep it isolated from `multiDragRef` / node-edit drag (separate ref, e.g. `resizeDragRef`).

## Tests

- **vitest** on `scalePoints` (scale about anchor; sx≠sy; anchor stays fixed) and `setRunsPoints` (only named runs change; points replaced; other runs/electrodes untouched).
- No automated canvas-interaction test (none in repo); cover the drag via the manual/Playwright smoke below.

## Manual smoke test (Playwright)

1. App on :7373. New blank design → Add text "OPEN".
2. Select tool → marquee or click-select all runs → 8 handles appear around the bbox.
3. Drag a corner outward → the whole word scales up live; release → commits; one Cmd+Z reverts it.
4. Hold Shift on a corner → aspect locked. Drag an edge → only that axis scales.
5. Validation re-runs (e.g. scaling OPEN up should clear the P-bowl bend errors as the bowl radius grows past 27mm — a nice secondary confirmation).
6. Zoom in/out → handles stay ~constant screen size and correctly placed.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Out of scope (v1)

- Rotation, skew, numeric scale entry (the rejected "Scale %" field — could be added later sharing the same op).
- Flipping (negative scale).
- Per-vertex-selection resize (handles operate on whole selected runs, not a sub-set of vertices).
- Editable-after-insert text cap height (separate follow-up; this geometric scale covers the "resize my text" need).

## Workflow

1. Implement op + tests, wire callback, add handles + drag.
2. Browser smoke test above.
3. Move this spec to `specs/done/`.
4. PR: `Add drag-to-resize handles for the editor selection`.

## Report back

PR URL, confirmation handles resize/commit/undo correctly and stay constant-size across zoom, test names, any UX tuning deferred (e.g. rotation, numeric entry), pre-merge state.
