// Tier 3 #137 — the headless capture handshake.
//
// `?autocapture=1` on the preview route tells the page to configure
// itself from the URL, wait until the scene is genuinely ready, take one
// composer-path capture, and resolve a promise on `window` with the PNG.
// A driver (`scripts/render-preview.mjs`) awaits that promise instead of
// clicking through the sidebar.
//
// Two invariants this file exists to hold:
//
//  1. **Never capture early.** The composer is registered by
//     `<ComposerBridge>` a tick after the Canvas mounts. Capturing before
//     it lands would silently fall back to `gl.render` and write a
//     flat-emissive PNG — the Tier 1 #68 bug, re-introduced by a race
//     rather than by a wrong call. `captureReadiness` refuses until the
//     composer is present, unless `?nobloom` says there isn't one.
//
//  2. **Never hand back an unverified image.** Even with the composer in
//     hand, `performCapture` renders the frame twice — once bare, once
//     composed — and measures that the post-process pass changed the
//     pixels. If it didn't, the capture *fails*; it does not write a
//     plausible-looking file. See `bloomMetric.ts` for what that
//     measurement does and does not claim.
//
// The pure core (`captureReadiness`, `performCapture`) takes its
// rendering and pixel-reading as injected functions, so both invariants
// are unit-testable in node — including the negative control where the
// final capture is deliberately wired to the bare renderer and the
// capture must fail.
import * as THREE from 'three';
import {
  BLOOM_CONTENT_FLOOR,
  BLOOM_DELTA_FLOOR,
  fractionAboveLuminance,
  meanAbsLuminanceDelta,
  verifyBloomDelta,
  type BloomVerdict,
  type RGBABuffer,
} from './bloomMetric';
import { renderCanvasToDataURL, type ComposerLike } from './screenshot';

/**
 * Where the handshake lives on `window`. The driver polls for this, so
 * treat it as a published contract — renaming it breaks every committed
 * and ad-hoc driver at once.
 */
export const AUTOCAPTURE_GLOBAL = '__neonbenchPreviewCapture';

/** Contract version, so a driver can fail clearly against an older build. */
export const AUTOCAPTURE_VERSION = 1;

/** Default ceiling on "wait for the scene to be ready", in ms. */
export const AUTOCAPTURE_TIMEOUT_MS = 20_000;

/** How often readiness is re-checked while waiting. */
export const AUTOCAPTURE_POLL_MS = 100;

export interface AutocaptureResult {
  /** `data:image/png;base64,…` for the captured frame. */
  dataURL: string;
  /** True when the composer path produced the image. */
  bloom: boolean;
  /** Mean absolute luminance delta bare-vs-composed; null on the `?nobloom` path. */
  bloomDelta: number | null;
  /** Whether that delta was enforced (a dark frame skips enforcement). */
  bloomEnforced: boolean;
  /** Explanation of the bloom verdict, for the driver to print. */
  bloomReason: string;
  /** Camera preset that was applied, or null if the default front fit was used. */
  preset: string | null;
  /** Drawing-buffer dimensions of the captured canvas. */
  width: number;
  height: number;
  /** Non-fatal complaints about the URL (unknown preset / wall / bg values). */
  warnings: string[];
}

export interface AutocaptureHandle {
  /** Resolves with the capture, or rejects with why it could not be taken. */
  ready: Promise<AutocaptureResult>;
  version: number;
}

export interface ReadinessInput {
  /** The design doc has loaded. */
  docLoaded: boolean;
  /** Load error message, if the version could not be fetched. */
  error?: string | null;
  /** Whatever `<ScreenshotBridge>` most recently registered. */
  captureContext: { composer?: ComposerLike | null } | null;
  /** False when `?nobloom` is set — then there is no composer to wait for. */
  expectBloom: boolean;
}

export interface Readiness {
  ready: boolean;
  /** Set when the wait can never succeed (load error) — fail immediately. */
  fatal: boolean;
  reason: string;
}

/**
 * Is the page ready for a capture that will actually contain what the
 * caller asked for?
 *
 * The `expectBloom && composer == null` case is the important one: it is
 * the difference between "wait 200 ms longer" and "write a flat PNG and
 * never mention it".
 */
export function captureReadiness(input: ReadinessInput): Readiness {
  if (input.error) {
    return {
      ready: false,
      fatal: true,
      reason: `design version failed to load: ${input.error}`,
    };
  }
  if (!input.docLoaded) {
    return { ready: false, fatal: false, reason: 'waiting for the design doc' };
  }
  if (!input.captureContext) {
    return {
      ready: false,
      fatal: false,
      reason: 'waiting for the WebGL canvas to register',
    };
  }
  if (input.expectBloom && !input.captureContext.composer) {
    return {
      ready: false,
      fatal: false,
      reason:
        'waiting for the EffectComposer — capturing now would take the bare ' +
        'gl.render path and produce a flat-emissive image (Tier 1 #68)',
    };
  }
  return { ready: true, fatal: false, reason: 'ready' };
}

export interface CaptureDeps {
  /**
   * Draw the scene through the bare renderer. Used **only** as the
   * comparison baseline — never as the image that goes to disk.
   */
  renderBare(): void;
  /**
   * Produce the image that goes to disk. Always routed through
   * `renderCanvasToDataURL`, the one function that decides
   * composer-vs-bare, so this path and the Save PNG button cannot drift.
   */
  captureFinal(): string;
  /** Read the current drawing buffer as RGBA bytes. */
  readPixels(): RGBABuffer;
  /**
   * True when a composer is wired up, i.e. `captureFinal` is expected to
   * differ from `renderBare`. False on the `?nobloom` path.
   */
  hasComposer: boolean;
  /** The scene's configured bloom luminance threshold. */
  bloomThreshold: number;
  deltaFloor?: number;
  contentFloor?: number;
}

export interface CaptureOutcome {
  dataURL: string;
  bloom: boolean;
  bloomDelta: number | null;
  verdict: BloomVerdict;
}

/**
 * Take the capture and verify it.
 *
 * Ordering is load-bearing twice over:
 *   - the *bare* render happens first so the final (composed) render is
 *     the last thing to touch the drawing buffer. Swap them and the
 *     returned PNG is the flat one.
 *   - each pixel read immediately follows its render, because
 *     `preserveDrawingBuffer` is false and the buffer is cleared once
 *     the browser composites the frame. Everything here runs in one
 *     synchronous task for that reason.
 *
 * Throws when verification fails. A thrown error becomes a non-zero exit
 * from the driver; that is the point — a silently flat PNG is the
 * failure mode this whole task exists to prevent.
 */
export function performCapture(deps: CaptureDeps): CaptureOutcome {
  if (!deps.hasComposer) {
    // `?nobloom` — no composer exists, so there is nothing to compare
    // against and nothing to verify. The caller asked for the flat
    // image explicitly.
    return {
      dataURL: deps.captureFinal(),
      bloom: false,
      bloomDelta: null,
      verdict: {
        ok: true,
        enforced: false,
        reason: '?nobloom requested: captured through the bare renderer',
      },
    };
  }

  deps.renderBare();
  const bare = deps.readPixels();

  const dataURL = deps.captureFinal();
  const composed = deps.readPixels();

  const bloomDelta = meanAbsLuminanceDelta(bare, composed);
  const fractionAbove = fractionAboveLuminance(composed, deps.bloomThreshold);
  const verdict = verifyBloomDelta({
    delta: bloomDelta,
    fractionAbove,
    deltaFloor: deps.deltaFloor ?? BLOOM_DELTA_FLOOR,
    contentFloor: deps.contentFloor ?? BLOOM_CONTENT_FLOOR,
  });
  if (!verdict.ok) {
    throw new Error(`headless capture rejected: ${verdict.reason}`);
  }
  return { dataURL, bloom: true, bloomDelta, verdict };
}

/**
 * Minimal 2D-canvas surface used to read pixels back off the WebGL
 * canvas. Declared structurally so `makeDomCaptureDeps` stays honest
 * about what it needs without a DOM in the type environment.
 */
export interface ScratchCanvasEnv {
  createElement(tag: 'canvas'): HTMLCanvasElement;
}

/**
 * Wire the real three.js objects into `CaptureDeps`.
 *
 * Pixel readback goes through a scratch 2D canvas (`drawImage` +
 * `getImageData`) rather than `gl.readRenderTargetPixels`, because the
 * thing we want to compare is exactly what `toDataURL` will serialise —
 * the composited drawing buffer, after tone mapping and colour-space
 * conversion. Reading a render target instead would compare a different
 * image than the one being written to disk.
 */
export function makeDomCaptureDeps(
  gl: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  composer: ComposerLike | null,
  bloomThreshold: number,
  env: ScratchCanvasEnv = document as unknown as ScratchCanvasEnv,
): CaptureDeps {
  const canvas = gl.domElement;
  const scratch = env.createElement('canvas');
  scratch.width = canvas.width;
  scratch.height = canvas.height;
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('autocapture: could not get a 2D context for pixel readback');
  }
  return {
    renderBare: () => {
      gl.render(scene, camera);
    },
    captureFinal: () => renderCanvasToDataURL(gl, scene, camera, composer),
    readPixels: () => {
      ctx.drawImage(canvas, 0, 0);
      return ctx.getImageData(0, 0, scratch.width, scratch.height).data;
    },
    hasComposer: composer !== null,
    bloomThreshold,
  };
}

/**
 * Create the deferred promise and publish it on `target` (normally
 * `window`). Returns the settle / fail hooks for the page to call.
 */
export function installAutocaptureGlobal(target: Record<string, unknown>): {
  handle: AutocaptureHandle;
  settle: (r: AutocaptureResult) => void;
  fail: (e: Error) => void;
} {
  let settle!: (r: AutocaptureResult) => void;
  let fail!: (e: Error) => void;
  const ready = new Promise<AutocaptureResult>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // A rejection nobody has attached to yet is an unhandled rejection in
  // some browsers. The driver attaches immediately, but a human opening
  // the URL by hand would otherwise see a console error.
  ready.catch(() => {});
  const handle: AutocaptureHandle = { ready, version: AUTOCAPTURE_VERSION };
  target[AUTOCAPTURE_GLOBAL] = handle;
  return { handle, settle, fail };
}
