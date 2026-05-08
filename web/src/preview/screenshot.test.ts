import { describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  captureCanvasToPNG,
  screenshotFilename,
  type DownloadEnv,
} from './screenshot';

// Vitest's default env is node — no `document`, no `HTMLAnchorElement`.
// Adding jsdom/happy-dom for this one helper would be a new top-level
// dev dep and a 100x slower test run, so the helper accepts a
// `DownloadEnv` seam and we stub it here. Keeping the seam internal-
// looking (interface, not optional public API surface) so production
// callers continue using the global `document`.

interface StubAnchor {
  href: string;
  download: string;
  click: ReturnType<typeof vi.fn>;
}

interface StubEnv extends DownloadEnv {
  // Test-only handles for assertions.
  _appended: StubAnchor[];
  _removed: StubAnchor[];
}

function makeStubEnv(): StubEnv {
  const appended: StubAnchor[] = [];
  const removed: StubAnchor[] = [];
  return {
    createElement: () => {
      const a: StubAnchor = { href: '', download: '', click: vi.fn() };
      return a as unknown as HTMLAnchorElement;
    },
    body: {
      appendChild: (n) => {
        appended.push(n as unknown as StubAnchor);
        return n;
      },
      removeChild: (n) => {
        removed.push(n as unknown as StubAnchor);
        return n;
      },
    },
    _appended: appended,
    _removed: removed,
  };
}

interface StubRenderer {
  render: ReturnType<typeof vi.fn>;
  domElement: { toDataURL: ReturnType<typeof vi.fn> };
}

function makeStubRenderer(dataURL = 'data:image/png;base64,FAKE'): StubRenderer {
  return {
    render: vi.fn(),
    domElement: {
      toDataURL: vi.fn(() => dataURL),
    },
  };
}

describe('captureCanvasToPNG', () => {
  it('renders a fresh frame before reading pixels', () => {
    const gl = makeStubRenderer();
    const env = makeStubEnv();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    captureCanvasToPNG(
      gl as unknown as THREE.WebGLRenderer,
      scene,
      camera,
      'x.png',
      env,
    );
    expect(gl.render).toHaveBeenCalledOnce();
    expect(gl.render).toHaveBeenCalledWith(scene, camera);
    // Render must precede toDataURL — order matters because
    // `preserveDrawingBuffer: false` clears the backbuffer between
    // present and dataURL read.
    const renderOrder = gl.render.mock.invocationCallOrder[0];
    const grabOrder = gl.domElement.toDataURL.mock.invocationCallOrder[0];
    expect(renderOrder).toBeLessThan(grabOrder);
  });

  it('triggers an anchor click with the requested filename and dataURL', () => {
    const gl = makeStubRenderer('data:image/png;base64,DEADBEEF');
    const env = makeStubEnv();
    captureCanvasToPNG(
      gl as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      'My Sign-preview-2026-05-07.png',
      env,
    );
    expect(env._appended.length).toBe(1);
    const anchor = env._appended[0];
    expect(anchor.download).toBe('My Sign-preview-2026-05-07.png');
    expect(anchor.href).toBe('data:image/png;base64,DEADBEEF');
    expect(anchor.click).toHaveBeenCalledOnce();
  });

  it('removes the transient anchor after click', () => {
    const gl = makeStubRenderer();
    const env = makeStubEnv();
    captureCanvasToPNG(
      gl as unknown as THREE.WebGLRenderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      'x.png',
      env,
    );
    // Append + remove must both happen so we don't leak detached
    // anchors into the DOM across repeated screenshots.
    expect(env._appended.length).toBe(1);
    expect(env._removed.length).toBe(1);
    expect(env._appended[0]).toBe(env._removed[0]);
  });

  // Tier 1 #68 — when an `EffectComposer` is wired up, the screenshot
  // helper must drive the post-process pipeline (so bloom lands in
  // the PNG) rather than the bare `gl.render(scene, camera)` path
  // (which would skip post-processing and produce a flat-emissive
  // image).
  it('drives composer.render() when a composer is provided (bloom path)', () => {
    const gl = makeStubRenderer();
    const env = makeStubEnv();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    const composer = { render: vi.fn() };
    captureCanvasToPNG(
      gl as unknown as THREE.WebGLRenderer,
      scene,
      camera,
      'x.png',
      env,
      composer,
    );
    // Composer ran exactly once; the bare renderer was NOT touched.
    // Driving both would double-paint the frame and waste the GPU
    // cost (and on some drivers the bare-render call after the
    // composer reset would clobber the bloomed framebuffer).
    expect(composer.render).toHaveBeenCalledOnce();
    expect(gl.render).not.toHaveBeenCalled();
    // Composer render must precede the dataURL grab — same backbuffer
    // ordering invariant as the bare-renderer path above.
    const composerOrder = composer.render.mock.invocationCallOrder[0];
    const grabOrder = gl.domElement.toDataURL.mock.invocationCallOrder[0];
    expect(composerOrder).toBeLessThan(grabOrder);
  });

  it('falls back to gl.render when composer is explicitly null (?nobloom)', () => {
    // `?nobloom` short-circuits the EffectComposer wrap inside Scene,
    // so PreviewPage forwards `composer: null` here. Behavior must
    // match the no-composer back-compat path so `?nobloom` still
    // produces a (flat-emissive) PNG.
    const gl = makeStubRenderer();
    const env = makeStubEnv();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera();
    captureCanvasToPNG(
      gl as unknown as THREE.WebGLRenderer,
      scene,
      camera,
      'x.png',
      env,
      null,
    );
    expect(gl.render).toHaveBeenCalledOnce();
    expect(gl.render).toHaveBeenCalledWith(scene, camera);
  });
});

describe('screenshotFilename', () => {
  it('formats a clean ISO-ish stamp', () => {
    const name = screenshotFilename('My Cafe', new Date('2026-05-07T15:23:11.456Z'));
    expect(name).toBe('My_Cafe-preview-2026-05-07T15-23-11Z.png');
  });

  it('falls back to `preview` when the project name is blank', () => {
    expect(screenshotFilename('', new Date('2026-01-01T00:00:00Z'))).toBe(
      'preview-preview-2026-01-01T00-00-00Z.png',
    );
    expect(screenshotFilename(null, new Date('2026-01-01T00:00:00Z'))).toBe(
      'preview-preview-2026-01-01T00-00-00Z.png',
    );
    expect(screenshotFilename(undefined, new Date('2026-01-01T00:00:00Z'))).toBe(
      'preview-preview-2026-01-01T00-00-00Z.png',
    );
  });

  it('strips characters illegal on Windows / macOS filesystems', () => {
    const name = screenshotFilename('A:B/C\\D*E?F', new Date('2026-05-07T00:00:00Z'));
    // All of `:/\*?` should be replaced; the alphabet survives.
    expect(name).toMatch(/^A_B_C_D_E_F-preview-2026-05-07T00-00-00Z\.png$/);
  });
});
