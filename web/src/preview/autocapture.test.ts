import { describe, expect, it, vi } from 'vitest';
import {
  AUTOCAPTURE_GLOBAL,
  AUTOCAPTURE_VERSION,
  captureReadiness,
  installAutocaptureGlobal,
  performCapture,
  type CaptureDeps,
} from './autocapture';

// Tier 3 #137 — the headless capture path, pinned without a browser.
//
// The whole reason this task exists is that a PNG's filename says
// nothing about whether the post-process pass landed in it. Tier 1 #68
// shipped exactly that bug once. So the tests below are built around the
// *negative control*: the broken variant is constructed here, run
// through the same code, and asserted to FAIL. A passing test for the
// happy path alone would prove nothing (CLAUDE.md, recurring bug class
// #7 — "a test that asserts X passes is only meaningful if you have also
// seen it fail").

/** RGBA buffer: a bright core, optionally with a bloom-ish halo. */
function frame(withHalo: boolean): Uint8ClampedArray {
  const w = 32;
  const buf = new Uint8ClampedArray(w * w * 4);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x - 16, y - 16);
      let v = r <= 3 ? 255 : 5;
      if (withHalo && r > 3) v = 5 + Math.max(0, 220 * Math.exp(-((r - 3) ** 2) / 30));
      const o = (y * w + x) * 4;
      buf[o] = v;
      buf[o + 1] = v;
      buf[o + 2] = v;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

const FLAT = frame(false);
const BLOOMED = frame(true);

/**
 * Deps stub modelling a canvas whose pixels depend on which render call
 * ran last — the same relationship the real renderer has.
 *
 * `composedFrame` is the lever the negative control pulls: hand it
 * `FLAT` and you have wired the "composed" capture to the bare
 * renderer, which is precisely the #68 regression.
 */
function makeDeps(opts: {
  hasComposer: boolean;
  composedFrame?: Uint8ClampedArray;
}): CaptureDeps & {
  renderBare: ReturnType<typeof vi.fn>;
  captureFinal: ReturnType<typeof vi.fn>;
} {
  let current: Uint8ClampedArray = FLAT;
  const renderBare = vi.fn(() => {
    current = FLAT;
  });
  const captureFinal = vi.fn(() => {
    current = opts.hasComposer ? (opts.composedFrame ?? BLOOMED) : FLAT;
    return 'data:image/png;base64,FINAL';
  });
  return {
    renderBare,
    captureFinal,
    readPixels: () => current,
    hasComposer: opts.hasComposer,
    bloomThreshold: 0.4,
  };
}

describe('captureReadiness', () => {
  const ctx = { composer: { render: () => {} } };

  it('waits for the design doc', () => {
    const r = captureReadiness({
      docLoaded: false,
      captureContext: ctx,
      expectBloom: true,
    });
    expect(r.ready).toBe(false);
    expect(r.fatal).toBe(false);
    expect(r.reason).toMatch(/design doc/);
  });

  it('waits for the canvas to register', () => {
    const r = captureReadiness({
      docLoaded: true,
      captureContext: null,
      expectBloom: true,
    });
    expect(r.ready).toBe(false);
    expect(r.fatal).toBe(false);
  });

  // The race that would silently reproduce Tier 1 #68: the canvas has
  // registered but `<ComposerBridge>` has not yet handed over the
  // composer. Capturing here would take the bare renderer and write a
  // flat file with a perfectly ordinary name.
  it('refuses to capture before the EffectComposer exists', () => {
    const r = captureReadiness({
      docLoaded: true,
      captureContext: { composer: null },
      expectBloom: true,
    });
    expect(r.ready).toBe(false);
    expect(r.fatal).toBe(false);
    expect(r.reason).toMatch(/flat-emissive/);
  });

  it('does not wait for a composer when ?nobloom asked for the flat render', () => {
    const r = captureReadiness({
      docLoaded: true,
      captureContext: { composer: null },
      expectBloom: false,
    });
    expect(r.ready).toBe(true);
  });

  it('is ready once doc + canvas + composer are all present', () => {
    expect(
      captureReadiness({ docLoaded: true, captureContext: ctx, expectBloom: true })
        .ready,
    ).toBe(true);
  });

  it('fails fast (not slowly) when the version could not be loaded', () => {
    const r = captureReadiness({
      docLoaded: false,
      error: 'HTTP 404',
      captureContext: null,
      expectBloom: true,
    });
    expect(r.ready).toBe(false);
    expect(r.fatal).toBe(true);
    expect(r.reason).toMatch(/404/);
  });
});

describe('performCapture (composer path)', () => {
  it('renders bare first so the composed frame is the one serialised', () => {
    const deps = makeDeps({ hasComposer: true });
    const out = performCapture(deps);
    expect(out.dataURL).toBe('data:image/png;base64,FINAL');
    expect(out.bloom).toBe(true);
    // The bare pass is a measurement, not the product: it must run
    // before the final capture, or the PNG on disk is the flat one.
    expect(deps.renderBare.mock.invocationCallOrder[0]).toBeLessThan(
      deps.captureFinal.mock.invocationCallOrder[0],
    );
  });

  it('reports a measurable post-process delta', () => {
    const out = performCapture(makeDeps({ hasComposer: true }));
    expect(out.bloomDelta).not.toBeNull();
    expect(out.bloomDelta as number).toBeGreaterThan(0.01);
    expect(out.verdict.ok).toBe(true);
    expect(out.verdict.enforced).toBe(true);
  });

  // ---- the negative control ----
  //
  // Wire the "final" capture to the bare renderer — i.e. reintroduce
  // Tier 1 #68 in the headless path — and the capture must throw rather
  // than hand back a flat PNG. This is the assertion the whole spec is
  // about; if it ever stops failing for the broken variant, the guard
  // has gone vacuous.
  it('THROWS when the final capture is secretly the bare renderer', () => {
    const deps = makeDeps({ hasComposer: true, composedFrame: FLAT });
    expect(() => performCapture(deps)).toThrow(/headless capture rejected/);
    expect(() => performCapture(deps)).toThrow(/bare gl\.render/);
  });

  it('still allows a legitimately dark frame through, unenforced', () => {
    // Every pixel below the bloom threshold: nothing for bloom to act
    // on, so an identical composed frame is expected, not a bug.
    const dark = new Uint8ClampedArray(32 * 32 * 4).fill(8);
    for (let i = 3; i < dark.length; i += 4) dark[i] = 255;
    const deps: CaptureDeps = {
      renderBare: () => {},
      captureFinal: () => 'data:image/png;base64,DARK',
      readPixels: () => dark,
      hasComposer: true,
      bloomThreshold: 0.4,
    };
    const out = performCapture(deps);
    expect(out.verdict.ok).toBe(true);
    expect(out.verdict.enforced).toBe(false);
    expect(out.bloomDelta).toBe(0);
  });
});

describe('performCapture (?nobloom path)', () => {
  it('captures once through the bare renderer and verifies nothing', () => {
    const deps = makeDeps({ hasComposer: false });
    const out = performCapture(deps);
    expect(out.dataURL).toBe('data:image/png;base64,FINAL');
    expect(out.bloom).toBe(false);
    expect(out.bloomDelta).toBeNull();
    expect(out.verdict.enforced).toBe(false);
    // No comparison pass: `?nobloom` explicitly asked for the flat
    // image, so there is nothing to compare it against.
    expect(deps.renderBare).not.toHaveBeenCalled();
    expect(deps.captureFinal).toHaveBeenCalledOnce();
  });
});

describe('installAutocaptureGlobal', () => {
  it('publishes a versioned handle the driver can await', async () => {
    const target: Record<string, unknown> = {};
    const { settle } = installAutocaptureGlobal(target);
    const handle = target[AUTOCAPTURE_GLOBAL] as {
      ready: Promise<{ dataURL: string }>;
      version: number;
    };
    expect(handle.version).toBe(AUTOCAPTURE_VERSION);
    settle({
      dataURL: 'data:image/png;base64,X',
      bloom: true,
      bloomDelta: 0.02,
      bloomEnforced: true,
      bloomReason: 'ok',
      preset: 'iso',
      width: 10,
      height: 10,
      warnings: [],
    });
    await expect(handle.ready).resolves.toMatchObject({ preset: 'iso' });
  });

  it('surfaces a failure as a rejection, not a silent hang', async () => {
    const target: Record<string, unknown> = {};
    const { handle, fail } = installAutocaptureGlobal(target);
    fail(new Error('no composer'));
    await expect(handle.ready).rejects.toThrow(/no composer/);
  });
});
