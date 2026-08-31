# Tier 2 — Editor right-panel: resize, collapsible sections, category icons, click-to-highlight

> **Status:** active · drafted 2026-06-05 · branch `task/2-editor-panel-resize-highlight` · requested by user

## Goal

Four related improvements to the editor's right panel (`.editor-sidebar`):

1. **Horizontally resizable.** A drag handle on the panel's left edge lets the operator widen/narrow
   it; the width persists across reloads.
2. **Collapsible per-run sections.** The **Bends** section (and the sibling **Electrodes**,
   **Blockouts**, **Annotations** sections) can be collapsed to a header row.
3. **Category icons.** Each section header (Electrodes, Blockouts, Bends, Annotations) shows a small
   icon matching the on-canvas marker for that category.
4. **Click-to-highlight.** Clicking an item's name in any of those lists pulses the corresponding
   marker on the canvas, so the operator can find it on the stage.

## Scope (files)

- `web/src/pages/EditorPage.tsx` — sidebar width state + resize handle; collapsible section state;
  section headers with icons; `focusedElement` state + click handlers; pass `focusedElement` to canvas.
- `web/src/components/EditorCanvas.tsx` — accept `focusedElement` prop; render a pulse-ring overlay at
  the focused element's canvas position (electrode `point_index`, annotation/blockout `live_index`,
  bend arc-length).
- `web/src/components/CategoryIcon.tsx` (new, small) — inline-SVG icons keyed by category/annotation kind.
- `web/src/App.css` — resize-handle styling, collapsible header styling, focused-marker pulse keyframes.

## Design decisions

- **Resize:** handle is a 6 px hit-strip on the sidebar's left border (cursor `col-resize`). Pointer
  drag updates width; clamp **280–680 px**; persist to `localStorage['nb.editorSidebarWidth']`. Double-click
  the handle resets to the default (~340 px). Uses `setPointerCapture` like the canvas resize handles.
- **Collapse:** each section header is a `<button>` with a chevron (`▾` expanded / `▸` collapsed).
  Collapsed sections render only the header. State is a `Set<string>` of collapsed section keys in
  component state (not persisted — cheap, and the selected run changes often). Default expanded.
- **Icons:** a tiny `CategoryIcon` component returns a 14 px inline SVG per category —
  `electrode` (pin/bolt), `blockout` (hatched square), `bend` (angle), and per annotation `kind`
  (`jump`, `support`, `doubleback`, `drop_bend`). Colors mirror the on-canvas markers.
- **Highlight:** `focusedElement: { runId, kind: 'electrode'|'blockout'|'bend'|'annotation', index } | null`
  lives in EditorPage. Clicking an item's name (a `<button className="focus-link">`, distinct from the
  existing **Remove** button) sets it and ensures the run is selected. The canvas renders a pulsing
  ring (reuses the Tier 3 #47 pulse idea) at that element's point. The focus auto-clears after
  ~2.5 s (timeout) and on selection change, so the pulse is a transient "there it is" cue.
  - electrode → `run.polyline.points[point_index]`
  - annotation → `run.polyline.points[arcs.live[live_index]]`
  - bend → walk the polyline to the bend's `arcLengthMM`
  - blockout → midpoint of its `blockoutSegments(...)` span

## Out of scope (follow-ups)

- Auto-pan/zoom so an off-screen focused element scrolls into view (v1 pulses in place only).
- Persisting collapse state across sessions.
- Making the validation-category groups (Bend radius, Tube spacing, …) collapsible — separate concern.

## Tests

- Component: clicking a focus-link sets `focusedElement` and selects the run; the canvas receives it.
- A `localStorage` round-trip test for the persisted width (clamp honored).
- Manual (Playwright): resize the panel, collapse Bends, click an annotation/electrode/blockout name and
  see the canvas pulse the right marker.
