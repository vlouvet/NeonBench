import { describe, expect, it } from 'vitest';
import {
  drawingReducer,
  initialDrawingState,
  initialStateForTool,
  type DrawingAction,
  type DrawingState,
  type DrawingTool,
} from './drawingState';

// The reducer is a pure function; these tests pin every transition
// the EditorCanvas relies on. They double as documentation of the
// state machine for future drawing-tool work.

const tools: DrawingTool[] = [
  'select',
  'electrode',
  'blockout',
  'jump',
  'support',
  'doubleback',
  'insert-doubleback',
  'bend',
  'label',
  'text',
  'dimension',
  'node',
  'pen',
  'rect',
  'circle',
  'arc',
];

describe('initialDrawingState', () => {
  it('boots into select with no anchors', () => {
    expect(initialDrawingState).toEqual({ tool: 'select' });
  });
});

describe('initialStateForTool', () => {
  it('seeds pen with an empty vertex list', () => {
    expect(initialStateForTool('pen')).toEqual({ tool: 'pen', vertices: [] });
  });
  it('seeds rect with a null first-corner', () => {
    expect(initialStateForTool('rect')).toEqual({ tool: 'rect', firstCorner: null });
  });
  it('seeds circle with a null center', () => {
    expect(initialStateForTool('circle')).toEqual({ tool: 'circle', center: null });
  });
  it('seeds arc with both clicks null', () => {
    expect(initialStateForTool('arc')).toEqual({
      tool: 'arc',
      firstClick: null,
      secondClick: null,
    });
  });

  it.each(['select', 'electrode', 'blockout', 'jump', 'support', 'doubleback', 'insert-doubleback', 'bend', 'label', 'text', 'dimension', 'node'] as DrawingTool[])(
    'seeds non-shape tool %s with no anchor fields',
    (tool) => {
      expect(initialStateForTool(tool)).toEqual({ tool });
    },
  );
});

describe('drawingReducer — switchTool', () => {
  it('resets to the destination tool when the tool changes', () => {
    const start: DrawingState = {
      tool: 'pen',
      vertices: [
        [1, 2],
        [3, 4],
      ],
    };
    expect(drawingReducer(start, { type: 'switchTool', tool: 'rect' })).toEqual({
      tool: 'rect',
      firstCorner: null,
    });
  });

  it('returns the same reference when switching to the current tool', () => {
    // Avoids unnecessary rerenders on no-op dispatches.
    const start: DrawingState = { tool: 'pen', vertices: [[1, 2]] };
    expect(drawingReducer(start, { type: 'switchTool', tool: 'pen' })).toBe(start);
  });

  it.each(tools)('reaches a valid initial state when switching from any tool to %s', (target) => {
    for (const from of tools) {
      const start = initialStateForTool(from);
      const next = drawingReducer(start, { type: 'switchTool', tool: target });
      expect(next).toEqual(initialStateForTool(target));
    }
  });

  it('drops in-progress arc anchors when leaving the arc tool', () => {
    const start: DrawingState = {
      tool: 'arc',
      firstClick: [10, 20],
      secondClick: [30, 40],
    };
    const next = drawingReducer(start, { type: 'switchTool', tool: 'circle' });
    expect(next).toEqual({ tool: 'circle', center: null });
  });
});

describe('drawingReducer — pen', () => {
  it('penVertex appends to the end in click order', () => {
    let s: DrawingState = { tool: 'pen', vertices: [] };
    s = drawingReducer(s, { type: 'penVertex', point: [1, 1] });
    s = drawingReducer(s, { type: 'penVertex', point: [2, 2] });
    s = drawingReducer(s, { type: 'penVertex', point: [3, 3] });
    expect(s).toEqual({
      tool: 'pen',
      vertices: [
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    });
  });

  it('penCommit clears vertices', () => {
    const s: DrawingState = {
      tool: 'pen',
      vertices: [
        [1, 1],
        [2, 2],
      ],
    };
    expect(drawingReducer(s, { type: 'penCommit' })).toEqual({ tool: 'pen', vertices: [] });
  });

  it('penCancel clears vertices', () => {
    const s: DrawingState = { tool: 'pen', vertices: [[5, 5]] };
    expect(drawingReducer(s, { type: 'penCancel' })).toEqual({ tool: 'pen', vertices: [] });
  });

  it('penCommit on an already-empty pen state is a no-op (same reference)', () => {
    const s: DrawingState = { tool: 'pen', vertices: [] };
    expect(drawingReducer(s, { type: 'penCommit' })).toBe(s);
  });

  it('penVertex is ignored when tool !== pen', () => {
    const s: DrawingState = { tool: 'rect', firstCorner: null };
    expect(drawingReducer(s, { type: 'penVertex', point: [1, 1] })).toBe(s);
  });
});

describe('drawingReducer — rect', () => {
  it('rectFirstCorner stores the anchor', () => {
    const s: DrawingState = { tool: 'rect', firstCorner: null };
    expect(drawingReducer(s, { type: 'rectFirstCorner', point: [10, 20] })).toEqual({
      tool: 'rect',
      firstCorner: [10, 20],
    });
  });

  it('rectFirstCorner overwrites a previous anchor (e.g. user re-presses)', () => {
    const s: DrawingState = { tool: 'rect', firstCorner: [1, 1] };
    expect(drawingReducer(s, { type: 'rectFirstCorner', point: [9, 9] })).toEqual({
      tool: 'rect',
      firstCorner: [9, 9],
    });
  });

  it('rectCommit clears the anchor', () => {
    const s: DrawingState = { tool: 'rect', firstCorner: [3, 3] };
    expect(drawingReducer(s, { type: 'rectCommit' })).toEqual({
      tool: 'rect',
      firstCorner: null,
    });
  });

  it('rectCommit on an unset rect is a no-op', () => {
    const s: DrawingState = { tool: 'rect', firstCorner: null };
    expect(drawingReducer(s, { type: 'rectCommit' })).toBe(s);
  });

  it('rectFirstCorner is ignored when tool !== rect', () => {
    const s: DrawingState = { tool: 'circle', center: null };
    expect(drawingReducer(s, { type: 'rectFirstCorner', point: [1, 1] })).toBe(s);
  });
});

describe('drawingReducer — circle', () => {
  it('circleCenter stores the anchor', () => {
    const s: DrawingState = { tool: 'circle', center: null };
    expect(drawingReducer(s, { type: 'circleCenter', point: [50, 60] })).toEqual({
      tool: 'circle',
      center: [50, 60],
    });
  });

  it('circleCommit clears the anchor', () => {
    const s: DrawingState = { tool: 'circle', center: [4, 4] };
    expect(drawingReducer(s, { type: 'circleCommit' })).toEqual({
      tool: 'circle',
      center: null,
    });
  });

  it('circleCenter is ignored when tool !== circle', () => {
    const s: DrawingState = { tool: 'pen', vertices: [] };
    expect(drawingReducer(s, { type: 'circleCenter', point: [1, 1] })).toBe(s);
  });
});

describe('drawingReducer — arc', () => {
  it('arcFirstClick populates firstClick', () => {
    const s: DrawingState = { tool: 'arc', firstClick: null, secondClick: null };
    expect(drawingReducer(s, { type: 'arcFirstClick', point: [1, 1] })).toEqual({
      tool: 'arc',
      firstClick: [1, 1],
      secondClick: null,
    });
  });

  it('arcSecondClick populates secondClick after firstClick', () => {
    let s: DrawingState = { tool: 'arc', firstClick: null, secondClick: null };
    s = drawingReducer(s, { type: 'arcFirstClick', point: [1, 1] });
    s = drawingReducer(s, { type: 'arcSecondClick', point: [2, 2] });
    expect(s).toEqual({ tool: 'arc', firstClick: [1, 1], secondClick: [2, 2] });
  });

  it('arcSecondClick is ignored when firstClick is null (out-of-sequence)', () => {
    const s: DrawingState = { tool: 'arc', firstClick: null, secondClick: null };
    expect(drawingReducer(s, { type: 'arcSecondClick', point: [9, 9] })).toBe(s);
  });

  it('arcFirstClick re-presses reset both clicks (operator restarting the arc)', () => {
    const s: DrawingState = { tool: 'arc', firstClick: [1, 1], secondClick: [2, 2] };
    expect(drawingReducer(s, { type: 'arcFirstClick', point: [3, 3] })).toEqual({
      tool: 'arc',
      firstClick: [3, 3],
      secondClick: null,
    });
  });

  it('arcCommit clears both clicks after the third click commits the run', () => {
    const s: DrawingState = { tool: 'arc', firstClick: [1, 1], secondClick: [2, 2] };
    expect(drawingReducer(s, { type: 'arcCommit' })).toEqual({
      tool: 'arc',
      firstClick: null,
      secondClick: null,
    });
  });

  it('arcCommit on a cleared arc is a no-op', () => {
    const s: DrawingState = { tool: 'arc', firstClick: null, secondClick: null };
    expect(drawingReducer(s, { type: 'arcCommit' })).toBe(s);
  });

  it('arc actions are ignored when tool !== arc', () => {
    const s: DrawingState = { tool: 'pen', vertices: [] };
    expect(drawingReducer(s, { type: 'arcFirstClick', point: [1, 1] })).toBe(s);
    expect(drawingReducer(s, { type: 'arcSecondClick', point: [2, 2] })).toBe(s);
    expect(drawingReducer(s, { type: 'arcCommit' })).toBe(s);
  });
});

describe('drawingReducer — cross-tool isolation', () => {
  // Action × tool grid: every per-tool action is a no-op under every
  // tool other than its own. Pinned here so a future refactor can't
  // silently fail this guarantee.
  const otherActions = (own: DrawingTool): DrawingAction[] => {
    if (own !== 'pen') return [];
    return [];
  };
  void otherActions;

  it.each([
    ['penVertex', { type: 'penVertex', point: [1, 1] } satisfies DrawingAction, 'pen'],
    ['penCommit', { type: 'penCommit' } satisfies DrawingAction, 'pen'],
    ['penCancel', { type: 'penCancel' } satisfies DrawingAction, 'pen'],
    ['rectFirstCorner', { type: 'rectFirstCorner', point: [1, 1] } satisfies DrawingAction, 'rect'],
    ['rectCommit', { type: 'rectCommit' } satisfies DrawingAction, 'rect'],
    ['circleCenter', { type: 'circleCenter', point: [1, 1] } satisfies DrawingAction, 'circle'],
    ['circleCommit', { type: 'circleCommit' } satisfies DrawingAction, 'circle'],
    ['arcFirstClick', { type: 'arcFirstClick', point: [1, 1] } satisfies DrawingAction, 'arc'],
    ['arcSecondClick', { type: 'arcSecondClick', point: [1, 1] } satisfies DrawingAction, 'arc'],
    ['arcCommit', { type: 'arcCommit' } satisfies DrawingAction, 'arc'],
  ])('%s is a no-op under every tool other than %s', (_label, action, owner) => {
    for (const t of tools) {
      if (t === owner) continue;
      const s = initialStateForTool(t);
      expect(drawingReducer(s, action)).toBe(s);
    }
  });
});

describe('drawingReducer — switchTool sequences', () => {
  it('switching out of pen mid-draw, then back, returns an empty pen', () => {
    let s: DrawingState = { tool: 'pen', vertices: [] };
    s = drawingReducer(s, { type: 'penVertex', point: [1, 1] });
    s = drawingReducer(s, { type: 'penVertex', point: [2, 2] });
    s = drawingReducer(s, { type: 'switchTool', tool: 'rect' });
    s = drawingReducer(s, { type: 'switchTool', tool: 'pen' });
    expect(s).toEqual({ tool: 'pen', vertices: [] });
  });

  it('switching out of arc mid-draw, then back, drops both clicks', () => {
    let s: DrawingState = { tool: 'arc', firstClick: null, secondClick: null };
    s = drawingReducer(s, { type: 'arcFirstClick', point: [1, 1] });
    s = drawingReducer(s, { type: 'arcSecondClick', point: [2, 2] });
    s = drawingReducer(s, { type: 'switchTool', tool: 'select' });
    s = drawingReducer(s, { type: 'switchTool', tool: 'arc' });
    expect(s).toEqual({ tool: 'arc', firstClick: null, secondClick: null });
  });
});
