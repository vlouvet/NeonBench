// Phase 3 #7 — single-shot canvas-to-PNG export helper.
//
// React-three-fiber's `<Canvas>` defaults to `preserveDrawingBuffer:
// false`, so the WebGL backbuffer is typically empty by the time
// `toDataURL` reads it (the browser has already presented + cleared
// the framebuffer). The robust workaround is to force a fresh render
// synchronously before reading pixels: `gl.render(scene, camera)`
// repaints the backbuffer in the same frame we then call
// `gl.domElement.toDataURL`, so the PNG always matches the on-screen
// view.
//
// We picked render-on-demand over flipping `preserveDrawingBuffer` to
// `true` for two reasons:
//   1. `preserveDrawingBuffer: true` carries a measurable perf hit on
//      some drivers (the browser keeps an extra copy of every frame).
//      For an interactive 3D preview the cost is real.
//   2. The screenshot button is the *only* code path that needs the
//      pixels off-canvas. Pay the render cost there, not on every
//      orbit-drag tick.
//
// The download path uses a transient `<a download>` element rather
// than the File System Access API so it works in every browser
// without prompting; the browser's default download behavior takes
// over from there. See MDN's "data URL download" pattern for prior
// art.
import * as THREE from 'three';

/**
 * Minimal subset of `Document` we need for the download path. Carved
 * out as an interface so unit tests can pass a stub without needing
 * jsdom (vitest's default env is node; we don't want to add a
 * jsdom/happy-dom dep just for one helper).
 */
export interface DownloadEnv {
  createElement(tag: 'a'): HTMLAnchorElement;
  body: { appendChild: (n: HTMLAnchorElement) => unknown; removeChild: (n: HTMLAnchorElement) => unknown };
}

/**
 * Minimal post-process composer surface this helper drives. Keeps the
 * dep-free signature: tests can pass a `{ render: vi.fn() }` stub
 * without pulling in `@react-three/postprocessing` types.
 */
export interface ComposerLike {
  render(): void;
}

/**
 * Render one frame to the WebGL canvas, then trigger a PNG download
 * of that canvas via a transient `<a download>` element.
 *
 * Pure side-effect-only helper. No return value; failures (e.g.
 * security errors when the canvas is tainted) propagate as thrown
 * exceptions and the caller can show a toast. We deliberately don't
 * try/catch because the only realistic failure modes are programmer
 * errors (passing a bad gl/scene/camera) and WebGL context loss,
 * both of which the caller should surface.
 *
 * When `composer` is provided, we drive the post-process pipeline via
 * `composer.render()` so bloom (and any other configured passes) lands
 * in the captured PNG. When it's absent or `null`, we fall back to
 * `gl.render(scene, camera)` — that's the `?nobloom` debug path and
 * the back-compat path for callers that never had a composer to
 * surface (Tier 1 #68).
 *
 * @param gl       The Three.js WebGL renderer driving the Canvas.
 * @param scene    The scene to render.
 * @param camera   The camera to render through.
 * @param filename The download filename (e.g. `My Sign-preview-...png`).
 * @param env      Document-like seam for tests; defaults to the global `document`.
 * @param composer Optional post-process composer; when present, drives the bloom pipeline.
 */
export function captureCanvasToPNG(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  filename: string,
  env: DownloadEnv = (typeof document !== 'undefined'
    ? (document as unknown as DownloadEnv)
    : (undefined as unknown as DownloadEnv)),
  composer?: ComposerLike | null,
): void {
  // Force a fresh frame so the backbuffer is populated. Without this
  // the dataURL is usually transparent black on Chrome/Firefox.
  //
  // When a composer is wired up (bloom path), drive its `render()` so
  // the post-process chain writes the final image (with bloom halos)
  // into the canvas backbuffer. Otherwise fall back to the bare
  // renderer — used by the `?nobloom` URL flag and any pre-bloom
  // callers.
  if (composer) {
    composer.render();
  } else {
    gl.render(scene, camera);
  }
  const dataURL = gl.domElement.toDataURL('image/png');
  const a = env.createElement('a');
  a.href = dataURL;
  a.download = filename;
  // Some browsers require the anchor to be in the DOM for click() to
  // honor the `download` attribute (Firefox in particular). Append +
  // remove inside the same task so the element never paints.
  env.body.appendChild(a);
  a.click();
  env.body.removeChild(a);
}

/**
 * Build a screenshot filename from a (possibly user-controlled)
 * project name. Strips/replaces characters that would break on
 * Windows / macOS / Linux filesystems and tacks on an ISO-ish
 * timestamp so multiple captures in a session don't clobber each
 * other.
 *
 * Example: `screenshotFilename("My Cafe", new Date('2026-05-07T15:23:11Z'))`
 *   → `"My_Cafe-preview-2026-05-07T15-23-11.png"`
 */
export function screenshotFilename(
  projectName: string | null | undefined,
  now: Date = new Date(),
): string {
  // Replace anything that isn't alnum/dash/underscore with `_`. This is
  // strict — we'd rather a slightly ugly filename than a download
  // dialog refusing to save because of a colon on Windows.
  const safeName =
    (projectName ?? '').trim().replace(/[^A-Za-z0-9._-]+/g, '_') || 'preview';
  // ISO 8601 with `:` swapped for `-` (colons are illegal on
  // Windows). Drop milliseconds for readability — within-second
  // collisions on a one-button click are functionally impossible.
  const stamp = now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-');
  return `${safeName}-preview-${stamp}.png`;
}
