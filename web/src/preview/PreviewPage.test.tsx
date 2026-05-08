import { describe, expect, it } from 'vitest';
import PreviewPage from './PreviewPage';
import { PREVIEW_CAMERA_CONFIG } from './cameraPresets';
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

// Pins the camera frustum widening from Tier 1 #66. Units are
// millimeters; preset framing parks the camera at bbox.diagonal × 1.5
// from the design, so anything tighter than ~50 m of `far` will
// re-introduce the silent culling regression. `near=1` keeps the 24-
// bit depth buffer healthy across the 10⁶ near/far ratio.
describe('PREVIEW_CAMERA_CONFIG', () => {
  it('uses mm-realistic near/far so signs aren’t culled by the frustum', () => {
    expect(PREVIEW_CAMERA_CONFIG.near).toBe(1);
    expect(PREVIEW_CAMERA_CONFIG.far).toBeGreaterThanOrEqual(1_000_000);
  });
});
