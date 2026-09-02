// Tier 3 #137 — the measurement half of the headless-render bloom guard.
//
// Background. `captureCanvasToPNG` renders through the `EffectComposer`
// (`composer.render()`) rather than the bare `gl.render(scene, camera)`
// precisely so the post-process pass lands in the PNG. Tier 1 #68 was
// that bug: the screenshot path bypassed the composer and every export
// came back flat-emissive — no bloom halos, a visibly different product
// in a file whose name says nothing about it.
//
// A headless entry point re-opens that hole, because nothing about a
// written PNG tells you which path produced it. So the headless capture
// does not merely *call* the composer — it **measures** that calling it
// changed the pixels, and refuses to hand back an image when it didn't.
// If a future refactor wires the headless path to `gl.render`, the two
// buffers come back byte-identical, the delta is exactly 0, and the
// capture fails loudly instead of writing a flat file.
//
// What the delta does and does not claim: it is the mean absolute
// luminance difference between "scene rendered bare" and "scene rendered
// through the composer". That is a measurement of *post-processing was
// applied*, not of "bloom specifically, and at the right intensity". It
// is the property the guard needs — the failure mode being defended
// against is the composer not running at all — and overclaiming it would
// be its own kind of vacuous test.
//
// Everything here is pure arithmetic over RGBA byte buffers, so it is
// unit-testable in node (`web/` has no DOM test environment, by design —
// see CLAUDE.md). The DOM-side pixel grabbing lives in `autocapture.ts`.

/**
 * Rec. 709 luma coefficients — the same weighting the eye applies, and
 * the same one `Bloom`'s `luminanceThreshold` is expressed against, so
 * `fractionAboveLuminance` is comparable to the bloom threshold the
 * scene was configured with.
 */
export const LUMA_R = 0.2126;
export const LUMA_G = 0.7152;
export const LUMA_B = 0.0722;

/** Relative luminance of an 8-bit RGB triple, normalised to 0..1. */
export function luminance8(r: number, g: number, b: number): number {
  return (LUMA_R * r + LUMA_G * g + LUMA_B * b) / 255;
}

/** RGBA byte buffer, as returned by `CanvasRenderingContext2D.getImageData`. */
export type RGBABuffer = ArrayLike<number>;

/**
 * Mean absolute luminance difference between two same-sized RGBA
 * buffers, in 0..1 luminance units. Alpha is ignored: the preview
 * renders an opaque background, and a difference in alpha is not
 * something a customer can see.
 *
 * Two identical buffers give exactly 0 — that exact-zero case is the
 * signal the bloom guard keys off, so it must not be fuzzed by
 * sampling or rounding.
 */
export function meanAbsLuminanceDelta(a: RGBABuffer, b: RGBABuffer): number {
  if (a.length !== b.length) {
    throw new Error(
      `meanAbsLuminanceDelta: buffer length mismatch (${a.length} vs ${b.length})`,
    );
  }
  const pixels = Math.floor(a.length / 4);
  if (pixels === 0) return 0;
  let sum = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    const la = luminance8(a[o], a[o + 1], a[o + 2]);
    const lb = luminance8(b[o], b[o + 1], b[o + 2]);
    sum += Math.abs(la - lb);
  }
  return sum / pixels;
}

/**
 * Fraction of pixels (0..1) whose luminance exceeds `threshold`.
 *
 * Used to answer "is there anything in this frame bloom could act on?"
 * A design rendered entirely below the bloom luminance threshold — an
 * empty doc, or a very dim scene — legitimately produces a near-zero
 * delta, and failing that capture would be a false alarm. The guard
 * therefore only *enforces* the delta when the frame has bright content.
 */
export function fractionAboveLuminance(
  rgba: RGBABuffer,
  threshold: number,
): number {
  const pixels = Math.floor(rgba.length / 4);
  if (pixels === 0) return 0;
  let above = 0;
  for (let i = 0; i < pixels; i++) {
    const o = i * 4;
    if (luminance8(rgba[o], rgba[o + 1], rgba[o + 2]) > threshold) above++;
  }
  return above / pixels;
}

/**
 * Minimum mean-absolute-luminance delta that counts as "the composer
 * pass actually did something".
 *
 * Calibrated against real headless renders (`scripts/render-preview.mjs
 * --compare-nobloom`, headless Chromium / SwiftShader, 1552×1053):
 * a two-run 600×400 mm design at the `iso` preset measured **0.021962**,
 * and a 3 m single-run design at `front` measured **0.020562** — both an
 * order of magnitude above this floor. Wiring the headless path to
 * `gl.render` instead (the Tier 1 #68 regression, injected on purpose to
 * check this fires) measured exactly **0.000000**.
 *
 * The floor is set low on purpose: its job is to separate "post-
 * processing ran" from "post-processing did not run at all", not to
 * police bloom intensity. A tight floor would turn every legitimate
 * tuning of `bloomIntensity` into a spurious failure.
 */
export const BLOOM_DELTA_FLOOR = 0.002;

/**
 * Minimum fraction of above-threshold pixels before the delta is
 * enforced. One pixel in ten thousand is enough to prove there is
 * emissive content in frame; below that we skip the check rather than
 * fail a legitimately dark render.
 */
export const BLOOM_CONTENT_FLOOR = 0.0001;

export interface BloomVerdict {
  /** False means: refuse the capture. */
  ok: boolean;
  /** True when the delta was actually enforced (vs skipped for a dark frame). */
  enforced: boolean;
  /** Human-readable explanation, surfaced by the driver on failure. */
  reason: string;
}

export interface BloomVerifyInput {
  /** `meanAbsLuminanceDelta(bare, composed)`. */
  delta: number;
  /** `fractionAboveLuminance(composed, bloomThreshold)`. */
  fractionAbove: number;
  deltaFloor?: number;
  contentFloor?: number;
}

/**
 * Decide whether a headless capture may be handed back.
 *
 * Pure so the decision — including the exact-zero regression case — is
 * pinned in the node suite without a browser.
 */
export function verifyBloomDelta({
  delta,
  fractionAbove,
  deltaFloor = BLOOM_DELTA_FLOOR,
  contentFloor = BLOOM_CONTENT_FLOOR,
}: BloomVerifyInput): BloomVerdict {
  if (!Number.isFinite(delta)) {
    return { ok: false, enforced: true, reason: 'bloom delta is not a finite number' };
  }
  if (fractionAbove < contentFloor) {
    return {
      ok: true,
      enforced: false,
      reason:
        `nothing above the bloom luminance threshold in frame ` +
        `(${(fractionAbove * 100).toFixed(4)}% of pixels); ` +
        `post-process delta not enforced`,
    };
  }
  if (delta < deltaFloor) {
    return {
      ok: false,
      enforced: true,
      reason:
        `post-process pass changed nothing: mean luminance delta ${delta.toFixed(6)} ` +
        `is below the ${deltaFloor} floor while ` +
        `${(fractionAbove * 100).toFixed(2)}% of pixels are above the bloom ` +
        `threshold. The capture almost certainly took the bare gl.render path ` +
        `instead of composer.render() — this is the Tier 1 #68 regression.`,
    };
  }
  return {
    ok: true,
    enforced: true,
    reason: `post-process delta ${delta.toFixed(6)} (floor ${deltaFloor})`,
  };
}
