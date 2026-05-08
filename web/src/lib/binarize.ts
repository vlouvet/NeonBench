// Binarize-related primitives for the vectorize preview pipeline.
//
// The frontend's threshold preview (in VectorizePanel) and the Hough deskew
// estimator both reduce RGB to a single luminance channel. This module
// centralises the weights so changes stay in one place. The backend
// (internal/vectorize/preprocess.go) recomputes luminance with its own
// Rec. 601 constants when actually vectorizing — these weights are
// PREVIEW-ONLY state and are never sent in the vectorize request.

// Default Rec. 601 luminance weights. Match the backend convention so
// "no overrides" looks identical in preview and final output.
export const DEFAULT_LUMA_R = 0.299;
export const DEFAULT_LUMA_G = 0.587;
export const DEFAULT_LUMA_B = 0.114;

export type LumaWeights = {
  r: number;
  g: number;
  b: number;
};

export const DEFAULT_LUMA_WEIGHTS: LumaWeights = {
  r: DEFAULT_LUMA_R,
  g: DEFAULT_LUMA_G,
  b: DEFAULT_LUMA_B,
};

// Compute weighted luminance for a single RGB triplet. Channels are
// 0-255; the result is in the same range. With default weights this is
// the BT.601 luma `0.299*R + 0.587*G + 0.114*B`.
export function luminance(
  r: number,
  g: number,
  b: number,
  weights: LumaWeights = DEFAULT_LUMA_WEIGHTS,
): number {
  return weights.r * r + weights.g * g + weights.b * b;
}

// Binarize an RGBA buffer in place into a fresh output buffer using
// the supplied threshold + luminance weights. `pixels[i] < threshold`
// becomes 0 (foreground), >= becomes 255. Output preserves alpha=255.
//
// This is hot — VectorizePanel inlines the same loop directly to avoid the
// per-pixel function-call overhead. We export the slow path for tests.
export function binarizeRGBA(
  pixels: Uint8ClampedArray,
  threshold: number,
  weights: LumaWeights = DEFAULT_LUMA_WEIGHTS,
): Uint8ClampedArray {
  const out = new Uint8ClampedArray(pixels.length);
  const wr = weights.r;
  const wg = weights.g;
  const wb = weights.b;
  for (let i = 0; i < pixels.length; i += 4) {
    const lum = wr * pixels[i] + wg * pixels[i + 1] + wb * pixels[i + 2];
    const v = lum < threshold ? 0 : 255;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}
