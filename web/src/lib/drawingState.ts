// Drawing-tool state machine for the editor canvas (Tier 3 #42).
//
// Before this refactor, EditorCanvas held six pieces of in-progress
// drawing-tool state in separate `useState` hooks plus a `prevTool`
// watcher that walked through every variable on tool change to clear
// it. The watcher (and matching Esc / commit cleanup) was easy to get
// wrong: every new tool meant remembering to reset its sibling tools'
// state, and it was already drifting (PR #37 flagged the symptom; PR
// #44 noted the dangling `shapeDragRef`).
//
// This module replaces all of that with one reducer keyed on the
// active tool. Switching tools dispatches `switchTool`, which seeds
// the reducer with the destination tool's empty initial state — so
// stale anchors from the abandoned tool simply cease to exist. Per-
// tool actions (`penVertex`, `rectFirstCorner`, etc.) are silently
// ignored when the current tool doesn't match, keeping the reducer
// total: it never throws, never enters an undefined state.
//
// The reducer is a pure function so it lives here (vitest-friendly)
// rather than inside the component. Hover/preview cursor positions
// remain in component-local state since they don't need the same
// tool-change cleanup — rendering already gates on the anchor state
// the reducer owns, so a stale hover never makes it to the screen.

export type Point = [number, number];

// Mirrors EditorTool from EditorCanvas. Kept as a string-literal union
// here (rather than importing) so this module has no React/component
// dependency and remains a pure data layer.
export type DrawingTool =
  | 'select'
  | 'electrode'
  | 'blockout'
  | 'jump'
  | 'support'
  | 'doubleback'
  | 'insert-doubleback'
  | 'bend'
  | 'label'
  | 'dimension'
  | 'node'
  | 'pen'
  | 'rect'
  | 'circle'
  | 'arc';

// Discriminated union: each shape-drawing tool that has in-progress
// anchor state spells it out as named fields; tools without anchor
// state share a single empty variant.
//
// Note: live cursor/drag-current points (the `b` corner mid-drag, the
// pen rubber-band hover, the arc preview hover) deliberately do NOT
// live here. Those mutate every pointermove — keeping them in the
// reducer would force a dispatch per frame for no benefit. The render
// path gates on the anchor state below before reading the hover, so a
// stale hover from an abandoned tool never affects the displayed
// preview.
export type DrawingState =
  | {
      tool:
        | 'select'
        | 'electrode'
        | 'blockout'
        | 'jump'
        | 'support'
        | 'doubleback'
        | 'insert-doubleback'
        | 'bend'
        | 'label'
        | 'dimension'
        | 'node';
    }
  | { tool: 'pen'; vertices: Point[] }
  | { tool: 'rect'; firstCorner: Point | null }
  | { tool: 'circle'; center: Point | null }
  | { tool: 'arc'; firstClick: Point | null; secondClick: Point | null };

export type DrawingAction =
  // Tool change: reset to the destination tool's initial state. The
  // single reset path replaces the per-tool `if (tool !== 'X' && ...)`
  // cleanup chain that EditorCanvas used to run on every render.
  | { type: 'switchTool'; tool: DrawingTool }
  // Pen tool — append a vertex; commit (caller pushes the run); cancel.
  | { type: 'penVertex'; point: Point }
  | { type: 'penCommit' }
  | { type: 'penCancel' }
  // Rect tool — pointerdown captures the first corner; pointerup
  // commits (caller pushes the run); cancel discards.
  | { type: 'rectFirstCorner'; point: Point }
  | { type: 'rectCommit' }
  // Circle tool — same shape as rect, but the anchor is a center.
  | { type: 'circleCenter'; point: Point }
  | { type: 'circleCommit' }
  // Arc tool — three sequential clicks. The reducer carries the first
  // two; the third is consumed by the caller and dispatched as
  // `arcCommit` to clear.
  | { type: 'arcFirstClick'; point: Point }
  | { type: 'arcSecondClick'; point: Point }
  | { type: 'arcCommit' };

// Per-tool empty / "ready to draw" state. Centralized so the reducer
// can hand the same object back from `switchTool` and from each tool's
// commit/cancel path — both transitions reset the anchors to "fresh
// start for this tool" in identical fashion.
export function initialStateForTool(tool: DrawingTool): DrawingState {
  switch (tool) {
    case 'pen':
      return { tool, vertices: [] };
    case 'rect':
      return { tool, firstCorner: null };
    case 'circle':
      return { tool, center: null };
    case 'arc':
      return { tool, firstClick: null, secondClick: null };
    default:
      return { tool };
  }
}

// Exported convenience: the reducer's "fresh boot" state. The default
// editor tool is `select`, matching EditorPage's prop default.
export const initialDrawingState: DrawingState = initialStateForTool('select');

// Total reducer: every (state, action) pair returns a valid state.
// Mismatched-for-current-tool actions return the same reference, which
// also lets React skip rerenders when an unrelated dispatch fires.
export function drawingReducer(state: DrawingState, action: DrawingAction): DrawingState {
  switch (action.type) {
    case 'switchTool':
      // Always reset to the destination tool's initial state — this is
      // the whole reason the reducer exists. Even when the tool is the
      // same as the current one, a `switchTool` resets in-progress
      // anchors; callers should dispatch on actual user-driven tool
      // changes only.
      if (action.tool === state.tool) return state;
      return initialStateForTool(action.tool);

    case 'penVertex':
      if (state.tool !== 'pen') return state;
      return { tool: 'pen', vertices: [...state.vertices, action.point] };

    case 'penCommit':
    case 'penCancel':
      // Both clear vertices; the caller decides whether to push a run
      // through `onCommitShape` first.
      if (state.tool !== 'pen') return state;
      if (state.vertices.length === 0) return state;
      return { tool: 'pen', vertices: [] };

    case 'rectFirstCorner':
      if (state.tool !== 'rect') return state;
      return { tool: 'rect', firstCorner: action.point };

    case 'rectCommit':
      if (state.tool !== 'rect') return state;
      if (state.firstCorner === null) return state;
      return { tool: 'rect', firstCorner: null };

    case 'circleCenter':
      if (state.tool !== 'circle') return state;
      return { tool: 'circle', center: action.point };

    case 'circleCommit':
      if (state.tool !== 'circle') return state;
      if (state.center === null) return state;
      return { tool: 'circle', center: null };

    case 'arcFirstClick':
      if (state.tool !== 'arc') return state;
      return { tool: 'arc', firstClick: action.point, secondClick: null };

    case 'arcSecondClick':
      if (state.tool !== 'arc') return state;
      // First click must already be set — without it, this action is
      // out of sequence and silently ignored.
      if (state.firstClick === null) return state;
      return { tool: 'arc', firstClick: state.firstClick, secondClick: action.point };

    case 'arcCommit':
      if (state.tool !== 'arc') return state;
      if (state.firstClick === null && state.secondClick === null) return state;
      return { tool: 'arc', firstClick: null, secondClick: null };

    default: {
      // Exhaustiveness guard. If a new action type is added above
      // without a case here, TypeScript flags `_exhaustive` as not
      // assignable to `never`.
      const _exhaustive: never = action;
      return _exhaustive;
    }
  }
}
