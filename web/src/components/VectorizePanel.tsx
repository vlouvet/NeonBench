import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { api, type DesignVersion, type VectorizeRequest } from '../api';
import { cacheToFullRes } from '../lib/cropCoords';
import { estimateSkewDegrees } from '../lib/hough';

// Max dimension we'll render the preview at. Source images larger than this
// are downsampled before being binarized — this is a UI hint, not the actual
// pixels the backend will see.
const PREVIEW_MAX_DIM = 320;
// If the source image is huge (typical phone photo), the offscreen canvas we
// hold the pixel cache in is capped to this on the longest side. The backend
// still works on the full-resolution upload; this is preview-only.
const SOURCE_CACHE_MAX_DIM = 1024;

type SourceState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | {
      kind: 'ready';
      // Cached pixel data + dimensions, downsampled to fit SOURCE_CACHE_MAX_DIM.
      pixels: Uint8ClampedArray;
      width: number;
      height: number;
      // Display dimensions for the preview canvases (capped to PREVIEW_MAX_DIM).
      displayWidth: number;
      displayHeight: number;
      // Original (full-resolution) source dimensions, in source-image pixels.
      // Needed at submit time to scale cache-pixel crop coords up to full-
      // resolution coords (the units the backend interprets `crop` in).
      originalWidth: number;
      originalHeight: number;
    };

// Adjustment parameters mirror the backend's PreprocessOptions. The client-
// side preview pipeline applies them in the same documented order:
//   rotate → crop → brightness → contrast → luminance → threshold
type Adjustments = {
  rotationDeg: number;
  brightness: number;
  contrast: number;
  cropX: number | '';
  cropY: number | '';
  cropW: number | '';
  cropH: number | '';
};

const DEFAULT_ADJUSTMENTS: Adjustments = {
  rotationDeg: 0,
  brightness: 0,
  contrast: 1,
  cropX: '',
  cropY: '',
  cropW: '',
  cropH: '',
};

// Adjusted buffer: pixel data + dimensions after rotate/crop/brightness/
// contrast have been applied (but before threshold). The preview's threshold
// pass reads from this rather than the original source pixels.
type AdjustedBuffer = {
  pixels: Uint8ClampedArray;
  width: number;
  height: number;
};

// Apply rotate → crop → brightness → contrast to a source pixel buffer and
// return the resulting RGBA buffer. Mirrors PreprocessAndBinarize in
// internal/vectorize/preprocess.go (sans threshold, which the existing
// binarize useEffect handles separately).
function buildAdjustedBuffer(
  src: { pixels: Uint8ClampedArray; width: number; height: number },
  adj: Adjustments,
): AdjustedBuffer {
  let cur: AdjustedBuffer = {
    pixels: src.pixels,
    width: src.width,
    height: src.height,
  };

  if (adj.rotationDeg !== 0) {
    cur = rotateBilinear(cur, adj.rotationDeg);
  }

  // Crop is interpreted in *post-rotation* coords (matching backend). Reject
  // partial / out-of-range entries silently — the user might be mid-edit.
  const cx = adj.cropX === '' ? null : Number(adj.cropX);
  const cy = adj.cropY === '' ? null : Number(adj.cropY);
  const cw = adj.cropW === '' ? null : Number(adj.cropW);
  const ch = adj.cropH === '' ? null : Number(adj.cropH);
  if (
    cx !== null &&
    cy !== null &&
    cw !== null &&
    ch !== null &&
    Number.isFinite(cx) &&
    Number.isFinite(cy) &&
    Number.isFinite(cw) &&
    Number.isFinite(ch) &&
    cw > 0 &&
    ch > 0 &&
    cx >= 0 &&
    cy >= 0 &&
    cx + cw <= cur.width &&
    cy + ch <= cur.height
  ) {
    cur = cropBuffer(cur, cx, cy, cw, ch);
  }

  if (adj.brightness !== 0 || (adj.contrast !== 1 && adj.contrast !== 0)) {
    cur = applyBrightnessContrast(cur, adj.brightness, adj.contrast);
  }
  return cur;
}

// rotateBilinear matches the backend rotateBilinear in preprocess.go: rotate
// CCW about the source center, output canvas grows to fit, white background
// fills the corners outside the rotated source quad.
function rotateBilinear(
  src: AdjustedBuffer,
  angleDeg: number,
): AdjustedBuffer {
  const theta = (angleDeg * Math.PI) / 180;
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const sw = src.width;
  const sh = src.height;
  const cx = sw / 2;
  const cy = sh / 2;
  const corners: [number, number][] = [
    [0, 0],
    [sw, 0],
    [0, sh],
    [sw, sh],
  ];
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const [x, y] of corners) {
    const xr = (x - cx) * cosT + (y - cy) * sinT;
    const yr = -(x - cx) * sinT + (y - cy) * cosT;
    if (xr < minX) minX = xr;
    if (xr > maxX) maxX = xr;
    if (yr < minY) minY = yr;
    if (yr > maxY) maxY = yr;
  }
  const dw = Math.max(1, Math.ceil(maxX - minX));
  const dh = Math.max(1, Math.ceil(maxY - minY));
  const out = new Uint8ClampedArray(dw * dh * 4);
  const sp = src.pixels;
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const xc = x + minX;
      const yc = y + minY;
      // Inverse map: rotate by -theta, then re-add center.
      const sx = xc * cosT - yc * sinT + cx;
      const sy = xc * sinT + yc * cosT + cy;
      const di = (y * dw + x) * 4;
      if (sx < -1 || sy < -1 || sx > sw || sy > sh) {
        out[di] = 255;
        out[di + 1] = 255;
        out[di + 2] = 255;
        out[di + 3] = 255;
        continue;
      }
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const x1 = x0 + 1;
      const y1 = y0 + 1;
      const dx = sx - x0;
      const dy = sy - y0;
      const p00 = samplePixel(sp, sw, sh, x0, y0);
      const p10 = samplePixel(sp, sw, sh, x1, y0);
      const p01 = samplePixel(sp, sw, sh, x0, y1);
      const p11 = samplePixel(sp, sw, sh, x1, y1);
      out[di + 0] = bilerpClamp(p00[0], p10[0], p01[0], p11[0], dx, dy);
      out[di + 1] = bilerpClamp(p00[1], p10[1], p01[1], p11[1], dx, dy);
      out[di + 2] = bilerpClamp(p00[2], p10[2], p01[2], p11[2], dx, dy);
      out[di + 3] = bilerpClamp(p00[3], p10[3], p01[3], p11[3], dx, dy);
    }
  }
  return { pixels: out, width: dw, height: dh };
}

function samplePixel(
  pix: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number, number, number] {
  if (x < 0 || y < 0 || x >= w || y >= h) return [255, 255, 255, 255];
  const i = (y * w + x) * 4;
  return [pix[i], pix[i + 1], pix[i + 2], pix[i + 3]];
}

function bilerpClamp(
  a: number,
  b: number,
  c: number,
  d: number,
  dx: number,
  dy: number,
): number {
  const ab = a + (b - a) * dx;
  const cd = c + (d - c) * dx;
  const v = ab + (cd - ab) * dy;
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

function cropBuffer(
  src: AdjustedBuffer,
  x: number,
  y: number,
  w: number,
  h: number,
): AdjustedBuffer {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let yy = 0; yy < h; yy++) {
    const si = ((y + yy) * src.width + x) * 4;
    const di = yy * w * 4;
    out.set(src.pixels.subarray(si, si + w * 4), di);
  }
  return { pixels: out, width: w, height: h };
}

// Minimum crop rectangle dimension in CACHE-pixel space. Smaller than this
// and the rectangle becomes hard to grab + degenerate to vectorize.
const MIN_CROP_PX = 8;

// Crop drag interaction modes. The crop overlay is the first interactive
// layer on the source preview canvas, so we own the state directly.
type CropDragMode =
  | { kind: 'none' }
  | {
      kind: 'create';
      startCacheX: number;
      startCacheY: number;
    }
  | {
      kind: 'move';
      startCropX: number;
      startCropY: number;
      cropW: number;
      cropH: number;
      pointerStartCacheX: number;
      pointerStartCacheY: number;
    }
  | {
      kind: 'resize';
      // The four corners of the rectangle at drag start, in cache-pixel
      // coords. For a corner drag, the anchor is the opposite corner; the
      // dragged corner is replaced by the pointer position. For an edge
      // drag, two corners share an axis with the anchor and don't move on
      // that axis; we encode this via `axis`:
      //   'both' = corner drag (free X and Y)
      //   'x'    = vertical edge drag (free X only — Y locked)
      //   'y'    = horizontal edge drag (free Y only — X locked)
      anchorCacheX: number;
      anchorCacheY: number;
      // For edge drags, the OPPOSITE-side coordinate that must stay fixed
      // on the locked axis. (Unused for 'both'.)
      lockedOppositeX: number;
      lockedOppositeY: number;
      axis: 'both' | 'x' | 'y';
      pointerStartCacheX: number;
      pointerStartCacheY: number;
      // For aspect-ratio lock: the original aspect ratio of the rectangle
      // when the drag started (W / H). Read when shiftKey is held during
      // pointermove on a corner drag.
      startAspect: number;
    };

type CropRect = { x: number; y: number; w: number; h: number };

// Clamp a cache-pixel rectangle to the buffer bounds and the MIN_CROP_PX
// minimum. Returns the clamped rectangle; preserves the (top-left, bottom-
// right) orientation supplied (the caller is responsible for normalising
// "dragged through anchor" before calling this).
function clampCrop(
  rect: CropRect,
  bufferW: number,
  bufferH: number,
): CropRect {
  let x = Math.max(0, Math.min(bufferW - MIN_CROP_PX, rect.x));
  let y = Math.max(0, Math.min(bufferH - MIN_CROP_PX, rect.y));
  let w = Math.max(MIN_CROP_PX, Math.min(bufferW - x, rect.w));
  let h = Math.max(MIN_CROP_PX, Math.min(bufferH - y, rect.h));
  // Round to integer cache pixels — the typed inputs are integer-only too.
  x = Math.round(x);
  y = Math.round(y);
  w = Math.round(w);
  h = Math.round(h);
  if (x + w > bufferW) w = bufferW - x;
  if (y + h > bufferH) h = bufferH - y;
  return { x, y, w, h };
}

function applyBrightnessContrast(
  src: AdjustedBuffer,
  brightness: number,
  contrast: number,
): AdjustedBuffer {
  // Treat contrast=0 as "field unset" / pass-through, matching backend.
  const factor = contrast === 0 ? 1 : contrast;
  const out = new Uint8ClampedArray(src.pixels.length);
  for (let i = 0; i < src.pixels.length; i += 4) {
    let r = src.pixels[i] + brightness;
    let g = src.pixels[i + 1] + brightness;
    let b = src.pixels[i + 2] + brightness;
    if (r < 0) r = 0;
    else if (r > 255) r = 255;
    if (g < 0) g = 0;
    else if (g > 255) g = 255;
    if (b < 0) b = 0;
    else if (b > 255) b = 255;
    if (factor !== 1) {
      r = (r - 128) * factor + 128;
      g = (g - 128) * factor + 128;
      b = (b - 128) * factor + 128;
      if (r < 0) r = 0;
      else if (r > 255) r = 255;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      if (b < 0) b = 0;
      else if (b > 255) b = 255;
    }
    out[i] = r;
    out[i + 1] = g;
    out[i + 2] = b;
    out[i + 3] = src.pixels[i + 3];
  }
  return { pixels: out, width: src.width, height: src.height };
}

export default function VectorizePanel({
  projectId,
  assetId,
  isSVG,
  onCreated,
}: {
  projectId: number;
  assetId: number;
  isSVG: boolean;
  onCreated: (dv: DesignVersion) => void;
}) {
  const [targetWidthMM, setTargetWidthMM] = useState(600);
  const [threshold, setThreshold] = useState(128);
  const [label, setLabel] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [smoothingMM, setSmoothingMM] = useState<number | ''>('');
  const [minSpurMM, setMinSpurMM] = useState<number | ''>('');

  // Image adjustments. Collapsed by default — most users only touch
  // threshold. Enabled the panel auto-opens when any value is non-default.
  const [showImageAdjust, setShowImageAdjust] = useState(false);
  const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Live preview state: source pixel cache + canvas refs for the two panels.
  // We use useDeferredValue on threshold so dragging the slider stays smooth
  // while the binarize pass catches up — re-binarizing a 1k-pixel image on
  // every onChange is fast but not free.
  const [source, setSource] = useState<SourceState>({ kind: 'loading' });
  // Track which asset/isSVG combo `source` corresponds to. When this changes,
  // we reset to 'loading' during render rather than in an effect — that way
  // we don't trip the react-hooks/set-state-in-effect rule.
  const [sourceKey, setSourceKey] = useState<string>(`${assetId}:${isSVG}`);
  const currentKey = `${assetId}:${isSVG}`;
  if (sourceKey !== currentKey) {
    setSourceKey(currentKey);
    setSource({ kind: 'loading' });
  }
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const binCanvasRef = useRef<HTMLCanvasElement | null>(null);

  // Defer the heavy adjustment values so dragging sliders stays responsive.
  // Threshold is also deferred so the existing binarize useEffect doesn't
  // re-run on every keypress.
  const deferredAdjustments = useDeferredValue(adjustments);
  const deferredThreshold = useDeferredValue(threshold);

  // Load the source image once per assetId. Decode → composite onto white
  // (matching backend preprocess.go) → downsample to SOURCE_CACHE_MAX_DIM →
  // cache the RGBA pixel buffer for repeated binarize passes.
  useEffect(() => {
    if (isSVG) return;
    let cancelled = false;

    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      const srcW = img.naturalWidth || img.width;
      const srcH = img.naturalHeight || img.height;
      if (srcW === 0 || srcH === 0) {
        setSource({ kind: 'error' });
        return;
      }
      // Downsample for caching; preview width capped separately below.
      const cacheScale = Math.min(1, SOURCE_CACHE_MAX_DIM / Math.max(srcW, srcH));
      const cw = Math.max(1, Math.round(srcW * cacheScale));
      const ch = Math.max(1, Math.round(srcH * cacheScale));
      const off = document.createElement('canvas');
      off.width = cw;
      off.height = ch;
      const ctx = off.getContext('2d');
      if (!ctx) {
        setSource({ kind: 'error' });
        return;
      }
      // Composite onto white so transparent pixels read as background, not
      // black — matches DecodeImage in internal/vectorize/preprocess.go.
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      let data: ImageData;
      try {
        data = ctx.getImageData(0, 0, cw, ch);
      } catch {
        // Tainted canvas (cross-origin without CORS). Shouldn't happen for
        // same-origin /api/projects/... but degrade gracefully.
        setSource({ kind: 'error' });
        return;
      }
      const displayScale = Math.min(1, PREVIEW_MAX_DIM / Math.max(cw, ch));
      setSource({
        kind: 'ready',
        pixels: data.data,
        width: cw,
        height: ch,
        displayWidth: Math.max(1, Math.round(cw * displayScale)),
        displayHeight: Math.max(1, Math.round(ch * displayScale)),
        originalWidth: srcW,
        originalHeight: srcH,
      });
    };
    img.onerror = () => {
      if (!cancelled) setSource({ kind: 'error' });
    };
    img.src = api.assetURL(projectId, assetId);

    return () => {
      cancelled = true;
    };
  }, [projectId, assetId, isSVG]);

  // Build the post-adjustment pre-threshold buffer. Memoized on the deferred
  // adjustments and the source pixel cache so dragging a slider only kicks
  // off one rebuild per concurrent-render commit. The threshold pass below
  // reads from THIS buffer instead of the original source pixels.
  const adjustedBuffer = useMemo<AdjustedBuffer | null>(() => {
    if (source.kind !== 'ready') return null;
    return buildAdjustedBuffer(
      { pixels: source.pixels, width: source.width, height: source.height },
      deferredAdjustments,
    );
  }, [source, deferredAdjustments]);

  // Paint the adjusted source canvas (post rotate/crop/brightness/contrast,
  // pre-threshold) so the user sees what's being fed to the binarizer.
  useEffect(() => {
    if (!adjustedBuffer) return;
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    canvas.width = adjustedBuffer.width;
    canvas.height = adjustedBuffer.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const imageData = new ImageData(
      new Uint8ClampedArray(adjustedBuffer.pixels),
      adjustedBuffer.width,
      adjustedBuffer.height,
    );
    ctx.putImageData(imageData, 0, 0);
  }, [adjustedBuffer]);

  // Re-binarize whenever the deferred threshold or the adjusted buffer
  // change. Backend convention: luminance < threshold → foreground (black).
  // We use Rec. 601 luma; the source is composited onto white above so
  // transparent pixels don't surprise us.
  useEffect(() => {
    if (!adjustedBuffer) return;
    const canvas = binCanvasRef.current;
    if (!canvas) return;
    canvas.width = adjustedBuffer.width;
    canvas.height = adjustedBuffer.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const px = adjustedBuffer.pixels;
    const out = new Uint8ClampedArray(px.length);
    const t = deferredThreshold;
    for (let i = 0; i < px.length; i += 4) {
      const lum = 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2];
      const v = lum < t ? 0 : 255;
      out[i] = v;
      out[i + 1] = v;
      out[i + 2] = v;
      out[i + 3] = 255;
    }
    ctx.putImageData(
      new ImageData(out, adjustedBuffer.width, adjustedBuffer.height),
      0,
      0,
    );
  }, [adjustedBuffer, deferredThreshold]);

  // Display dimensions for the preview canvases — keep the aspect ratio of
  // the *adjusted* buffer (rotation grows it, crop shrinks it).
  const previewSize = useMemo(() => {
    if (!adjustedBuffer) {
      if (source.kind === 'ready') {
        return { w: source.displayWidth, h: source.displayHeight };
      }
      return { w: PREVIEW_MAX_DIM, h: PREVIEW_MAX_DIM };
    }
    const scale = Math.min(
      1,
      PREVIEW_MAX_DIM / Math.max(adjustedBuffer.width, adjustedBuffer.height),
    );
    return {
      w: Math.max(1, Math.round(adjustedBuffer.width * scale)),
      h: Math.max(1, Math.round(adjustedBuffer.height * scale)),
    };
  }, [adjustedBuffer, source]);

  function resetCrop() {
    setAdjustments((a) => ({ ...a, cropX: '', cropY: '', cropW: '', cropH: '' }));
  }

  // Crop overlay drag state. Component-local — the spec disallows
  // persistence to URL / localStorage. We keep it in a ref because the
  // pointermove handlers run on the window and don't need to re-render.
  const cropDragRef = useRef<CropDragMode>({ kind: 'none' });
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [autoRotateHint, setAutoRotateHint] = useState<string | null>(null);
  const autoRotateTimerRef = useRef<number | null>(null);

  // Resolve the current crop rectangle from `adjustments`. Returns null when
  // any of the four fields is unset — the overlay then renders the rubber-
  // band-only state.
  const cropRect: CropRect | null = useMemo(() => {
    const { cropX, cropY, cropW, cropH } = adjustments;
    if (cropX === '' || cropY === '' || cropW === '' || cropH === '') return null;
    const x = Number(cropX);
    const y = Number(cropY);
    const w = Number(cropW);
    const h = Number(cropH);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) return null;
    if (w <= 0 || h <= 0) return null;
    return { x, y, w, h };
  }, [adjustments]);

  // Pointer-event → cache-pixel conversion. We measure the overlay's
  // bounding rect on each pointer event because CSS resizes the canvas as
  // the adjusted buffer changes (rotation grows it, crop shrinks it).
  const pointerToCache = useCallback(
    (clientX: number, clientY: number) => {
      const overlay = overlayRef.current;
      if (!overlay || !adjustedBuffer) return null;
      const rect = overlay.getBoundingClientRect();
      const dx = clientX - rect.left;
      const dy = clientY - rect.top;
      const sx = adjustedBuffer.width / Math.max(1, rect.width);
      const sy = adjustedBuffer.height / Math.max(1, rect.height);
      return { x: dx * sx, y: dy * sy };
    },
    [adjustedBuffer],
  );

  // Commit a (cache-pixel) rectangle to adjustments, clamped + rounded.
  const commitCropRect = useCallback(
    (rect: CropRect) => {
      if (!adjustedBuffer) return;
      const clamped = clampCrop(rect, adjustedBuffer.width, adjustedBuffer.height);
      setAdjustments((a) => ({
        ...a,
        cropX: clamped.x,
        cropY: clamped.y,
        cropW: clamped.w,
        cropH: clamped.h,
      }));
    },
    [adjustedBuffer],
  );

  // Pointermove / pointerup are bound at the window level so a drag stays
  // smooth even when the cursor leaves the overlay. The single useEffect
  // below installs them whenever a drag is in progress.
  const [dragActive, setDragActive] = useState(false);
  useEffect(() => {
    if (!dragActive) return;
    function onMove(e: PointerEvent) {
      const drag = cropDragRef.current;
      if (drag.kind === 'none') return;
      const cur = pointerToCache(e.clientX, e.clientY);
      if (!cur || !adjustedBuffer) return;
      if (drag.kind === 'create') {
        const x = Math.min(drag.startCacheX, cur.x);
        const y = Math.min(drag.startCacheY, cur.y);
        const w = Math.abs(cur.x - drag.startCacheX);
        const h = Math.abs(cur.y - drag.startCacheY);
        // Only commit if user has dragged far enough that the rectangle
        // exceeds the minimum size — avoids a stray click leaving a tiny
        // crop. Below the minimum we keep the previous (null) crop and
        // wait for them to drag further.
        if (w >= MIN_CROP_PX && h >= MIN_CROP_PX) {
          commitCropRect({ x, y, w, h });
        }
        return;
      }
      if (drag.kind === 'move') {
        const dx = cur.x - drag.pointerStartCacheX;
        const dy = cur.y - drag.pointerStartCacheY;
        // For a translate, preserve the size and clamp x/y so the
        // rectangle stays inside the buffer. clampCrop's generic logic
        // would shrink the rect at the boundary, which is wrong for a
        // pure move — handle it explicitly here.
        const maxX = Math.max(0, adjustedBuffer.width - drag.cropW);
        const maxY = Math.max(0, adjustedBuffer.height - drag.cropH);
        const nx = Math.max(0, Math.min(maxX, drag.startCropX + dx));
        const ny = Math.max(0, Math.min(maxY, drag.startCropY + dy));
        commitCropRect({
          x: nx,
          y: ny,
          w: drag.cropW,
          h: drag.cropH,
        });
        return;
      }
      // Resize: anchor stays fixed. For corner drags both axes follow the
      // pointer; for edge drags only one axis follows and the other holds
      // its drag-start size via lockedOppositeX/Y.
      let oppX = drag.axis === 'y' ? drag.lockedOppositeX : cur.x;
      let oppY = drag.axis === 'x' ? drag.lockedOppositeY : cur.y;
      // Aspect-ratio lock with Shift on a true corner drag. For edge drags
      // Shift has no effect — there's only one free dimension.
      if (e.shiftKey && drag.axis === 'both' && drag.startAspect > 0) {
        const dx = oppX - drag.anchorCacheX;
        const dy = oppY - drag.anchorCacheY;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        if (absDx >= absDy) {
          const sign = dy < 0 ? -1 : 1;
          oppY = drag.anchorCacheY + sign * (absDx / drag.startAspect);
        } else {
          const sign = dx < 0 ? -1 : 1;
          oppX = drag.anchorCacheX + sign * absDy * drag.startAspect;
        }
      }
      const x = Math.min(drag.anchorCacheX, oppX);
      const y = Math.min(drag.anchorCacheY, oppY);
      const w = Math.max(MIN_CROP_PX, Math.abs(oppX - drag.anchorCacheX));
      const h = Math.max(MIN_CROP_PX, Math.abs(oppY - drag.anchorCacheY));
      commitCropRect({ x, y, w, h });
    }
    function onUp() {
      cropDragRef.current = { kind: 'none' };
      setDragActive(false);
    }
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragActive, pointerToCache, adjustedBuffer, commitCropRect]);

  // Pointerdown on the overlay container: either start rubber-banding (if
  // no crop is set) or fall through (the crop body / handles install their
  // own pointerdown listeners and stopPropagation here).
  const onOverlayPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!adjustedBuffer) return;
      if (cropRect) return; // body / handles handle their own events
      const cur = pointerToCache(e.clientX, e.clientY);
      if (!cur) return;
      cropDragRef.current = {
        kind: 'create',
        startCacheX: cur.x,
        startCacheY: cur.y,
      };
      setDragActive(true);
      e.preventDefault();
    },
    [adjustedBuffer, cropRect, pointerToCache],
  );

  const onCropBodyPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!adjustedBuffer || !cropRect) return;
      const cur = pointerToCache(e.clientX, e.clientY);
      if (!cur) return;
      cropDragRef.current = {
        kind: 'move',
        startCropX: cropRect.x,
        startCropY: cropRect.y,
        cropW: cropRect.w,
        cropH: cropRect.h,
        pointerStartCacheX: cur.x,
        pointerStartCacheY: cur.y,
      };
      setDragActive(true);
      e.stopPropagation();
      e.preventDefault();
    },
    [adjustedBuffer, cropRect, pointerToCache],
  );

  // Begin a resize. `anchor` names the corner / edge that STAYS FIXED.
  const onHandlePointerDown = useCallback(
    (
      e: React.PointerEvent<HTMLDivElement>,
      anchor: 'tl' | 'tr' | 'bl' | 'br' | 't' | 'b' | 'l' | 'r',
    ) => {
      if (!adjustedBuffer || !cropRect) return;
      const cur = pointerToCache(e.clientX, e.clientY);
      if (!cur) return;
      const { x, y, w, h } = cropRect;
      // Anchor is the opposite corner / edge of the one being dragged.
      // For edge drags, the locked-opposite encodes the side that must keep
      // its current coord on the locked axis (e.g. dragging the top edge
      // moves Y but neither X side moves; we encode anchor at one X side
      // and lockedOppositeX at the other).
      let anchorX = x;
      let anchorY = y;
      let lockedOppositeX = x + w;
      let lockedOppositeY = y + h;
      let axis: 'both' | 'x' | 'y' = 'both';
      switch (anchor) {
        case 'tl': // dragging top-left → anchor bottom-right
          anchorX = x + w;
          anchorY = y + h;
          break;
        case 'tr': // dragging top-right → anchor bottom-left
          anchorX = x;
          anchorY = y + h;
          break;
        case 'bl': // dragging bottom-left → anchor top-right
          anchorX = x + w;
          anchorY = y;
          break;
        case 'br': // dragging bottom-right → anchor top-left
          anchorX = x;
          anchorY = y;
          break;
        case 't': // top edge: Y follows pointer, both X sides locked
          anchorX = x + w;
          anchorY = y + h;
          lockedOppositeX = x;
          axis = 'x';
          break;
        case 'b': // bottom edge
          anchorX = x + w;
          anchorY = y;
          lockedOppositeX = x;
          axis = 'x';
          break;
        case 'l': // left edge: X follows pointer, both Y sides locked
          anchorX = x + w;
          anchorY = y + h;
          lockedOppositeY = y;
          axis = 'y';
          break;
        case 'r': // right edge
          anchorX = x;
          anchorY = y + h;
          lockedOppositeY = y;
          axis = 'y';
          break;
      }
      cropDragRef.current = {
        kind: 'resize',
        anchorCacheX: anchorX,
        anchorCacheY: anchorY,
        lockedOppositeX,
        lockedOppositeY,
        axis,
        pointerStartCacheX: cur.x,
        pointerStartCacheY: cur.y,
        startAspect: h > 0 ? w / h : 1,
      };
      setDragActive(true);
      e.stopPropagation();
      e.preventDefault();
    },
    [adjustedBuffer, cropRect, pointerToCache],
  );

  // Auto-rotate. Runs synchronously — the Hough estimator on a 1024×768
  // cache buffer takes < 30 ms in dev, well under the 500 ms budget.
  const onAutoRotate = useCallback(() => {
    if (!adjustedBuffer) return;
    const result = estimateSkewDegrees(
      adjustedBuffer.pixels,
      adjustedBuffer.width,
      adjustedBuffer.height,
      { searchRangeDeg: 15 },
    );
    if (autoRotateTimerRef.current !== null) {
      window.clearTimeout(autoRotateTimerRef.current);
      autoRotateTimerRef.current = null;
    }
    if (!result) {
      setAutoRotateHint('No clear skew detected (try cropping first).');
    } else {
      // Negate: we want to apply the rotation that UNDOES the detected skew.
      const target = Math.round(-result.angleDeg * 10) / 10;
      setAdjustments((a) => ({ ...a, rotationDeg: target }));
      const sign = result.angleDeg >= 0 ? '' : '−';
      const absSkew = Math.abs(result.angleDeg).toFixed(1);
      const targetSign = target >= 0 ? '+' : '−';
      const absTarget = Math.abs(target).toFixed(1);
      setAutoRotateHint(
        `Detected ${sign}${absSkew}° skew → ${targetSign}${absTarget}°`,
      );
    }
    autoRotateTimerRef.current = window.setTimeout(() => {
      setAutoRotateHint(null);
      autoRotateTimerRef.current = null;
    }, 4000);
  }, [adjustedBuffer]);

  useEffect(() => {
    return () => {
      if (autoRotateTimerRef.current !== null) {
        window.clearTimeout(autoRotateTimerRef.current);
      }
    };
  }, []);

  // Compute the overlay's pixel-space rectangle from the cache-space crop
  // and the displayed canvas size. Used both for rendering and for the
  // mask overlay's clip-path.
  const overlayRect = useMemo(() => {
    if (!cropRect || !adjustedBuffer) return null;
    const sx = previewSize.w / Math.max(1, adjustedBuffer.width);
    const sy = previewSize.h / Math.max(1, adjustedBuffer.height);
    return {
      left: cropRect.x * sx,
      top: cropRect.y * sy,
      width: cropRect.w * sx,
      height: cropRect.h * sy,
    };
  }, [cropRect, adjustedBuffer, previewSize]);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    const body: VectorizeRequest = {
      asset_id: assetId,
      target_width_mm: targetWidthMM,
    };
    if (label.trim()) body.label = label.trim();
    if (!isSVG) {
      body.threshold = threshold;
      if (showAdvanced) {
        if (smoothingMM !== '' && smoothingMM > 0) body.smoothing_mm = smoothingMM;
        if (minSpurMM !== '' && minSpurMM > 0) body.min_spur_mm = minSpurMM;
      }
      // Image adjustments — only send fields that diverge from the default
      // so the backend's "no-op zero values" path stays in effect for the
      // common case.
      if (adjustments.rotationDeg !== 0) body.rotation_deg = adjustments.rotationDeg;
      if (adjustments.brightness !== 0) body.brightness = adjustments.brightness;
      if (adjustments.contrast !== 0 && adjustments.contrast !== 1)
        body.contrast = adjustments.contrast;
      const cx = adjustments.cropX;
      const cy = adjustments.cropY;
      const cw = adjustments.cropW;
      const ch = adjustments.cropH;
      if (
        cx !== '' &&
        cy !== '' &&
        cw !== '' &&
        ch !== '' &&
        Number(cw) > 0 &&
        Number(ch) > 0 &&
        Number(cx) >= 0 &&
        Number(cy) >= 0
      ) {
        // The crop fields above are in *cache-buffer pixel space* (the
        // downsampled SOURCE_CACHE_MAX_DIM-capped buffer the preview is drawn
        // from). The backend interprets `crop` in *original full-resolution
        // pixel space*. For a >1024 px source these two spaces differ — scale
        // up before submitting. Scale is 1.0 for already-small sources, ≥1.0
        // otherwise. Tier 3 #36.
        const cacheScale =
          source.kind === 'ready' && source.width > 0
            ? source.originalWidth / source.width
            : 1;
        body.crop = cacheToFullRes(
          { x: Number(cx), y: Number(cy), w: Number(cw), h: Number(ch) },
          cacheScale,
        );
      }
    }
    try {
      const dv = await api.vectorize(projectId, body);
      onCreated(dv);
      setLabel('');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="vectorize-panel" onSubmit={submit}>
      <h3>{isSVG ? 'Import SVG' : 'Vectorize'}</h3>
      <div className="vp-grid">
        <label>
          Target width (mm)
          <input
            type="number"
            min={1}
            max={5000}
            value={targetWidthMM}
            onChange={(e) => setTargetWidthMM(Number(e.target.value))}
          />
        </label>
        {!isSVG && (
          <label>
            Threshold (0–255)
            <input
              type="range"
              min={1}
              max={254}
              value={threshold}
              onChange={(e) => setThreshold(Number(e.target.value))}
            />
            <span className="meta">{threshold}</span>
          </label>
        )}
        <label className="vp-full">
          Label (optional)
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. 'tighter corners' or 'final draft'"
          />
        </label>
      </div>

      {!isSVG && (
        <div className="vp-preview" aria-label="Threshold preview">
          {source.kind === 'loading' && (
            <p className="vp-preview-status">Loading source…</p>
          )}
          {source.kind === 'error' && (
            <p className="vp-preview-status">
              Preview unavailable; vectorize anyway will use the latest threshold.
            </p>
          )}
          {source.kind === 'ready' && (
            <div className="vp-preview-pair">
              <figure className="vp-preview-figure">
                <div
                  className="vp-source-stack"
                  style={{ width: previewSize.w, height: previewSize.h }}
                >
                  <canvas
                    ref={sourceCanvasRef}
                    className="vp-preview-canvas"
                    style={{
                      width: previewSize.w,
                      height: previewSize.h,
                    }}
                  />
                  <div
                    ref={overlayRef}
                    className={`vp-crop-overlay${cropRect ? ' has-crop' : ''}`}
                    onPointerDown={onOverlayPointerDown}
                    style={{ width: previewSize.w, height: previewSize.h }}
                    role="presentation"
                  >
                    {overlayRect && (
                      <>
                        {/* Four masking quads that dim everything outside
                            the crop. Using four divs (rather than SVG +
                            clip-path) keeps the markup simple and the dim
                            shade falls behind the rectangle stroke. */}
                        <div
                          className="vp-crop-mask"
                          style={{
                            left: 0,
                            top: 0,
                            width: '100%',
                            height: overlayRect.top,
                          }}
                        />
                        <div
                          className="vp-crop-mask"
                          style={{
                            left: 0,
                            top: overlayRect.top + overlayRect.height,
                            width: '100%',
                            bottom: 0,
                          }}
                        />
                        <div
                          className="vp-crop-mask"
                          style={{
                            left: 0,
                            top: overlayRect.top,
                            width: overlayRect.left,
                            height: overlayRect.height,
                          }}
                        />
                        <div
                          className="vp-crop-mask"
                          style={{
                            left: overlayRect.left + overlayRect.width,
                            top: overlayRect.top,
                            right: 0,
                            height: overlayRect.height,
                          }}
                        />
                        <div
                          className="vp-crop-rect"
                          onPointerDown={onCropBodyPointerDown}
                          style={{
                            left: overlayRect.left,
                            top: overlayRect.top,
                            width: overlayRect.width,
                            height: overlayRect.height,
                          }}
                        >
                          {(['tl', 'tr', 'bl', 'br', 't', 'b', 'l', 'r'] as const).map(
                            (h) => (
                              <div
                                key={h}
                                className={`vp-crop-handle h-${h}`}
                                onPointerDown={(e) => onHandlePointerDown(e, h)}
                              />
                            ),
                          )}
                        </div>
                      </>
                    )}
                  </div>
                </div>
                <figcaption>Source (after adjustments)</figcaption>
              </figure>
              <figure className="vp-preview-figure">
                <canvas
                  ref={binCanvasRef}
                  className="vp-preview-canvas"
                  style={{
                    width: previewSize.w,
                    height: previewSize.h,
                  }}
                />
                <figcaption>Binarized (preview)</figcaption>
              </figure>
            </div>
          )}
        </div>
      )}

      {!isSVG && (
        <details
          open={showImageAdjust}
          onToggle={(e) =>
            setShowImageAdjust((e.target as HTMLDetailsElement).open)
          }
        >
          <summary>Image adjustments</summary>
          <p className="vp-adjust-help">
            Applied before binarize, in this order: rotate &rarr; crop &rarr;
            brightness &rarr; contrast &rarr; threshold. Useful for
            slightly-skewed phone photos or faint scans.
          </p>
          <div className="vp-grid">
            <label
              title="Rotate the image counter-clockwise. Positive values turn the picture left. Use to straighten skewed phone photos."
            >
              Rotation ({adjustments.rotationDeg >= 0 ? '+' : ''}
              {adjustments.rotationDeg.toFixed(1)}°)
              <input
                type="range"
                min={-45}
                max={45}
                step={0.5}
                value={adjustments.rotationDeg}
                onChange={(e) =>
                  setAdjustments((a) => ({
                    ...a,
                    rotationDeg: Number(e.target.value),
                  }))
                }
              />
              <div className="vp-rotation-row">
                <input
                  type="number"
                  min={-45}
                  max={45}
                  step={0.5}
                  value={adjustments.rotationDeg}
                  onChange={(e) =>
                    setAdjustments((a) => ({
                      ...a,
                      rotationDeg: Number(e.target.value),
                    }))
                  }
                />
                <button
                  type="button"
                  className="vp-auto-rotate"
                  onClick={onAutoRotate}
                  disabled={source.kind !== 'ready'}
                  title="Estimate the dominant skew of the (cropped) image and rotate to level it. Crop to a region first if the image has a clear feature you want straightened."
                >
                  Auto-rotate
                </button>
              </div>
              {autoRotateHint && (
                <span className="vp-auto-rotate-hint">{autoRotateHint}</span>
              )}
            </label>
            <label title="Brightness offset added to each channel. Negative darkens, positive brightens.">
              Brightness ({adjustments.brightness >= 0 ? '+' : ''}
              {adjustments.brightness})
              <input
                type="range"
                min={-100}
                max={100}
                step={5}
                value={adjustments.brightness}
                onChange={(e) =>
                  setAdjustments((a) => ({
                    ...a,
                    brightness: Number(e.target.value),
                  }))
                }
              />
            </label>
            <label title="Contrast multiplier around the channel midpoint. Values above 1 steepen, values below 1 flatten.">
              Contrast ({adjustments.contrast.toFixed(2)}×)
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={adjustments.contrast}
                onChange={(e) =>
                  setAdjustments((a) => ({
                    ...a,
                    contrast: Number(e.target.value),
                  }))
                }
              />
            </label>
          </div>
          <fieldset className="vp-crop">
            <legend>Crop (source pixels)</legend>
            <div className="vp-grid">
              <label>
                X
                <input
                  type="number"
                  min={0}
                  value={adjustments.cropX}
                  onChange={(e) =>
                    setAdjustments((a) => ({
                      ...a,
                      cropX: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder="0"
                />
              </label>
              <label>
                Y
                <input
                  type="number"
                  min={0}
                  value={adjustments.cropY}
                  onChange={(e) =>
                    setAdjustments((a) => ({
                      ...a,
                      cropY: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder="0"
                />
              </label>
              <label>
                W
                <input
                  type="number"
                  min={1}
                  value={adjustments.cropW}
                  onChange={(e) =>
                    setAdjustments((a) => ({
                      ...a,
                      cropW: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder="full"
                />
              </label>
              <label>
                H
                <input
                  type="number"
                  min={1}
                  value={adjustments.cropH}
                  onChange={(e) =>
                    setAdjustments((a) => ({
                      ...a,
                      cropH: e.target.value === '' ? '' : Number(e.target.value),
                    }))
                  }
                  placeholder="full"
                />
              </label>
            </div>
            <div className="vp-crop-actions">
              <button type="button" onClick={resetCrop}>
                Reset crop
              </button>
              <button
                type="button"
                onClick={() => setAdjustments(DEFAULT_ADJUSTMENTS)}
              >
                Reset all adjustments
              </button>
            </div>
          </fieldset>
        </details>
      )}

      {!isSVG && (
        <details open={showAdvanced} onToggle={(e) => setShowAdvanced((e.target as HTMLDetailsElement).open)}>
          <summary>Advanced centerline options</summary>
          <div className="vp-grid">
            <label title="Ramer-Douglas-Peucker tolerance in mm. Higher values smooth more aggressively (fewer vertices, more rounded corners). Blank uses an automatic value derived from the project tube diameter.">
              Smoothing ε (mm)
              <input
                type="number"
                step={0.1}
                min={0}
                max={5}
                value={smoothingMM}
                onChange={(e) => {
                  const v = e.target.value;
                  setSmoothingMM(v === '' ? '' : Number(v));
                }}
                placeholder="auto"
              />
            </label>
            <label title="Minimum branch length to keep, in mm. Skeleton spurs shorter than this get pruned. Blank uses an automatic value of about 2× the project tube diameter.">
              Min spur (mm)
              <input
                type="number"
                step={0.5}
                min={0}
                max={50}
                value={minSpurMM}
                onChange={(e) => {
                  const v = e.target.value;
                  setMinSpurMM(v === '' ? '' : Number(v));
                }}
                placeholder="auto"
              />
            </label>
          </div>
        </details>
      )}

      {error && <p className="error">{error}</p>}
      <div className="actions">
        <button type="submit" disabled={submitting || targetWidthMM <= 0}>
          {submitting ? 'Working…' : isSVG ? 'Import as design' : 'Vectorize'}
        </button>
      </div>
    </form>
  );
}
