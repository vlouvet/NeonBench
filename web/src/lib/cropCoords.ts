// Crop-coordinate space conversions for the vectorize panel.
//
// The frontend's preview pipeline downsamples the uploaded source image to a
// cache buffer capped at SOURCE_CACHE_MAX_DIM (1024 px on the long side). All
// on-screen crop interactions — typed inputs, draggable overlay — measure and
// store coordinates in *cache-buffer pixel space* so the rectangle the user
// drew lines up with the buffer the preview is binarized from.
//
// The backend, however, applies `crop` directly to the *original* full-
// resolution image. Sending cache-pixel coords produces a shrunken crop —
// for a 2048-wide source the applied crop covers 1/4 of the intended area.
//
// The fix is one-sided: scale cache-space coords up to full-res space on the
// way out of `submit()`. This module hosts that conversion as a pure helper
// so it can be unit-tested without RTL setup. Tier 3 #36.

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Convert a crop rectangle from cache-buffer pixel space to full-resolution
 * pixel space.
 *
 * `cacheScale` is `originalImageWidth / cacheBufferWidth` (≥ 1.0; equals 1.0
 * when the source was already small enough to skip the downsample). The
 * function rounds every component to integer pixels — fractional crop pixels
 * are meaningless to the backend's image library.
 *
 * Degenerate crops (w=0 or h=0) short-circuit to all zeros so callers never
 * have to special-case "user hasn't drawn anything yet".
 */
export function cacheToFullRes(crop: CropRect, cacheScale: number): CropRect {
  if (crop.w === 0 || crop.h === 0) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }
  return {
    x: Math.round(crop.x * cacheScale),
    y: Math.round(crop.y * cacheScale),
    w: Math.round(crop.w * cacheScale),
    h: Math.round(crop.h * cacheScale),
  };
}
