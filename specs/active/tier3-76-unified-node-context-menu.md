# Tier 3 #76 — Unified context menu on node-edit

> **Status:** active · drafted 2026-05-09 · branch `task/3-unified-node-context-menu` · NW parity (node double-click menu)

## Goal

NW gives the operator a single right-click menu at any tube node containing every relevant action: special-bend toggle, add tube support, move opening, blackout, insert point, convert arc↔line, break loop, delete point, add doubleback, add housing. One discoverable surface.

NeonBench has all those operations, but as separate toolbar tools and sidebar actions. Operators have to memorize which tool maps to which task and switch between them.

"Done" means: in node-edit mode, right-click on a polyline vertex (or alt+click for trackpad parity) opens a small floating menu listing every action applicable to that vertex's context. Selecting an item triggers the existing op via `editDoc()`.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-unified-node-context-menu origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**New:**

- `web/src/components/NodeContextMenu.tsx` — floating menu component anchored to a viewport coordinate. Auto-flips to keep on-screen (top-right corner near right edge → flip to top-left, etc.). Closes on Esc + click-outside. Each item is a button calling the existing op.
- `web/src/lib/nodeMenuItems.ts` — pure helper `availableActionsForVertex(doc, runId, vertexIndex) → MenuItem[]`. Returns the contextually-relevant subset (e.g. "Move opening here" only shows for runs with electrodes; "Convert to arc" only shows when arc-line conversion lands in #78).

**Modify:**

- `web/src/components/EditorCanvas.tsx` — bind `onContextMenu` on each NodeHandle when in node-edit mode. Right-click suppresses the default browser menu and opens `<NodeContextMenu>`. Alt+click is the trackpad-friendly alternate (already partially in PR #44 for snap-to-vertex; reuse the modifier).
- `web/src/pages/EditorPage.tsx` — wire the menu items to existing op handlers (`insertVertex`, `splitRun`, `placeElectrode`, `placeBlockout`, `placeAnnotation`, `breakOpenOnRun`, `moveOpeningOnRun`, `insertDoubleback`, `openHousingPicker`, `setRunColor`, `setRunDiameter`).
- `web/src/App.css` — menu styling (small floating panel, dark theme matching SceneControls aesthetic).

**Don't touch:**

- Toolbar tools or sidebar actions — they stay as the discoverable explicit affordance. Context menu is an additional way in, not a replacement.
- The underlying ops — every menu item maps to an existing op; this PR adds zero new geometry.
- 3D preview — node-edit is 2D-canvas-only.

## Deliverables

1. **`<NodeContextMenu>`** — anchors to a `{x, y}` viewport coordinate, auto-flips at viewport edges, closes on Esc + click-outside. Each item is a label + optional hint (e.g. "Special bend (toggle flat/drop)" / "Add tube support" / "Insert vertex" / "Split run here" / "Place electrode here" / "Mark blockout from here" / "Move opening here" / "Insert doubleback" / "Add housing" / "Delete vertex" / "Break loop open").
2. **`availableActionsForVertex(doc, runId, vertexIndex)`** — returns only items applicable to context. Examples:
   - "Move opening here" only when run has 2 electrodes.
   - "Place electrode" hidden when this vertex already has an electrode.
   - "Break loop open" only when run is closed.
   - "Insert doubleback" hidden on the second-to-last vertex of an open run (would create a degenerate hairpin).
3. **Menu wiring** — each item dispatches to its existing op. Op signatures stay unchanged.
4. **Keyboard support** — Esc closes; arrow keys navigate items; Enter activates.
5. **Tests** — `availableActionsForVertex` table-test across run states (open/closed, with/without electrodes, mid-polyline vs endpoint, blockouts present).

## Constraints

- **No new ops.** Pure UX surface over existing functionality.
- **No replacement of toolbar.** Discoverable affordances stay.
- **Trackpad parity.** Alt+click works as right-click for users without two-button mice.
- **Esc always closes.** Don't trap focus.

## Tests

Manual smoke:

1. Node-edit mode, right-click a mid-polyline vertex on a run with 2 electrodes → menu shows: Insert vertex, Split run, Place electrode, Place blockout, Mark jump, Mark support, Mark doubleback, Move opening, Insert doubleback, Delete vertex.
2. Right-click on an electrode-bearing vertex → "Place electrode" hidden, "Add housing" visible.
3. Right-click on the last vertex of an open run → "Insert doubleback" disabled (degenerate hairpin guard).
4. Esc closes the menu; click-outside also closes.

## Pre-merge

Standard four.

## Workflow

1. `availableActionsForVertex` + tests (drives the visibility logic).
2. `<NodeContextMenu>` + auto-flip math + Esc/click-outside.
3. EditorCanvas right-click + alt-click bindings.
4. EditorPage wiring of each menu item to its existing op.
5. CSS.
6. Pre-merge + smoke.
7. PR titled `Unified node context menu (Tier 3 #76)`.

## Report back

Under 200 words. PR URL, visibility-rule decisions for each context (which ops are gated and why), trackpad parity behavior, CI state, follow-ups.

## Follow-ups

- Add Tier 3 #77 drop-bend toggle as a menu item once that lands.
- Add Tier 3 #78 arc/line conversion as menu items.
- Multi-select node-edit context menu (when 2+ vertices selected).
