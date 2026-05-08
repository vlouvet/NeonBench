import { describe, expect, it } from 'vitest';
import PreviewPage from './PreviewPage';
import * as PreviewBarrel from './index';

// Minimal smoke tests for the Phase 3 #1 foundation. We can't render
// the component end-to-end here because react-three-fiber's `<Canvas>`
// requires a real WebGL context (jsdom doesn't ship one), and React
// Testing Library isn't set up in this repo. Instead we pin the export
// shape: the route component exists, is a function, and the barrel
// re-exports both PreviewPage and Scene. That's enough to catch
// accidental refactors that would break the route registration.

describe('PreviewPage', () => {
  it('exports a default function component', () => {
    expect(typeof PreviewPage).toBe('function');
  });
});

describe('preview barrel', () => {
  it('re-exports PreviewPage and Scene', () => {
    expect(typeof PreviewBarrel.PreviewPage).toBe('function');
    expect(typeof PreviewBarrel.Scene).toBe('function');
  });
});
