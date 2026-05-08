// Hough-on-edges deskew estimator.
//
// Given an RGBA pixel buffer, estimate the dominant skew angle (in degrees)
// of the image. The "skew" is the small rotation that, if undone, would
// level the dominant near-horizontal or near-vertical lines in the image —
// the typical use case being phone photos / scans of mostly-upright neon
// designs that the user wants to deskew before vectorizing.
//
// The algorithm:
//
//   1. Greyscale + downsample. Working in luma (Rec. 601) halves per-pixel
//      cost. If the longer side exceeds 512 px we sample with an integer
//      stride so the edge + accumulator passes stay quadratic-bounded —
//      visual quality of the skew estimate doesn't need full resolution.
//   2. Sobel gradient magnitude. We use |Gx| + |Gy| (cheaper than √(Gx²+Gy²)
//      and good enough for thresholding). A histogram-based threshold keeps
//      the top ~20% strongest edges as edge candidates.
//   3. Hough accumulator. Theta range is [-searchRangeDeg, +searchRangeDeg]
//      with default step 0.25°. Rho is parameterised over the line normal
//      from the image origin in pixel units; the accumulator is a 2D
//      Uint32Array indexed by (thetaBin, rhoBin + diag). We accumulate one
//      vote per (edge pixel, theta) pair.
//   4. Peak detection. For each theta bin, find its max-rho cell value. The
//      dominant theta is the bin with the highest such score. Confidence is
//      that peak divided by (median of bin scores + 1) — this is unitless
//      and the median guards against narrow accumulators where a few bins
//      naturally exceed others.
//   5. Theta → rotation. The Hough theta we accumulate is the angle of the
//      LINE'S NORMAL from horizontal (i.e. theta=0 means a vertical line,
//      theta=90 means a horizontal line). For deskewing a near-upright image
//      we want the rotation that makes those lines truly horizontal /
//      vertical. We pick the equivalent angle in (-45°, +45°] — see
//      thetaToRotation below — so callers receive a small "level the image"
//      number, not a 90° flip.
//
// References:
//   - Duda & Hart 1972, "Use of the Hough Transformation to Detect Lines
//     and Curves in Pictures" (the canonical Hough rho/theta formulation).
//   - Postl 1986, "Detection of linear oblique structures and skew scan in
//     digitized documents" (skew detection via Hough peak).

export type SkewEstimate = {
  angleDeg: number;
  confidence: number;
};

export type EstimateSkewOptions = {
  searchRangeDeg?: number;
  thetaStepDeg?: number;
  confidenceThreshold?: number;
};

// Per-peak ranked variant. Each entry's `confidence` is computed against the
// same global median floor so the values are directly comparable; `angleDeg`
// is the folded-into-(-45,+45] rotation that would level that peak's lines.
export type SkewPeak = SkewEstimate;

export type HoughPeaksOptions = EstimateSkewOptions & {
  // Maximum number of peaks to return (default 2). Peaks within the same
  // sub-window are suppressed via a small theta-bin window so a single broad
  // ridge doesn't masquerade as two answers.
  k?: number;
  // Half-width (in theta bins) of the non-maximum-suppression window applied
  // around each accepted peak before searching for the next. Tunable for
  // tests; default 4 (≈ 1° at the default 0.25° step).
  nmsHalfWidthBins?: number;
};

const DEFAULT_SEARCH_RANGE_DEG = 15;
const DEFAULT_THETA_STEP_DEG = 0.25;
const DEFAULT_CONFIDENCE_THRESHOLD = 3.0;
const DEFAULT_NMS_HALF_WIDTH_BINS = 4;
const MAX_WORKING_SIDE_PX = 512;
const EDGE_KEEP_FRACTION = 0.2;

export function estimateSkewDegrees(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  opts: EstimateSkewOptions = {},
): SkewEstimate | null {
  const peaks = houghPeaks(pixels, width, height, { ...opts, k: 1 });
  return peaks.length > 0 ? peaks[0] : null;
}

// Multi-peak variant: returns up to `k` orientations sorted by confidence
// (descending). Each peak is gated by the same confidence threshold as
// estimateSkewDegrees, and peaks within the configured NMS window of an
// already-accepted peak are suppressed so a single dominant ridge can't
// fill the result list. Returns [] for degenerate input (no edges, low
// confidence, peaks pinned to the search-range edge, etc.) — callers
// should treat an empty array the same as estimateSkewDegrees returning
// null.
export function houghPeaks(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  opts: HoughPeaksOptions = {},
): SkewPeak[] {
  const k = Math.max(1, Math.floor(opts.k ?? 2));
  const searchRangeDeg = opts.searchRangeDeg ?? DEFAULT_SEARCH_RANGE_DEG;
  const thetaStepDeg = opts.thetaStepDeg ?? DEFAULT_THETA_STEP_DEG;
  const confidenceThreshold =
    opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const nmsHalfWidth = Math.max(
    0,
    Math.floor(opts.nmsHalfWidthBins ?? DEFAULT_NMS_HALF_WIDTH_BINS),
  );

  if (width < 8 || height < 8) return [];
  if (pixels.length !== width * height * 4) return [];

  // Step 1: greyscale + downsample.
  const { gray, w, h } = greyscaleDownsample(pixels, width, height);

  // Step 2: Sobel magnitude + histogram-thresholded edge mask.
  const { mag, threshold } = sobelMagnitude(gray, w, h);
  const edges = collectEdgePixels(mag, w, h, threshold);
  if (edges.length < 32) return [];

  // Step 3: Hough accumulator.
  //
  // Theta is the angle of the LINE'S NORMAL from the x-axis. A horizontal
  // bar tilted by α has normals near 90° ± α; a vertical bar tilted by α
  // has normals near 0° ± α. Since we want to deskew BOTH, we sweep two
  // narrow theta windows: one around 0° (vertical lines) and one around
  // 90° (horizontal lines). Both contributions get merged into a single
  // accumulator and the dominant peak (across either family) wins.
  const halfRange = searchRangeDeg;
  // Build the theta sweep: two contiguous sub-ranges, [-halfRange, +halfRange]
  // and [90-halfRange, 90+halfRange]. Each sub-range gets the same step.
  const subThetas: number[] = [];
  const stepsPerSide = Math.floor(halfRange / thetaStepDeg);
  for (let i = -stepsPerSide; i <= stepsPerSide; i++) {
    subThetas.push(i * thetaStepDeg);
  }
  for (let i = -stepsPerSide; i <= stepsPerSide; i++) {
    subThetas.push(90 + i * thetaStepDeg);
  }
  const nThetas = subThetas.length;
  const thetas = new Float64Array(nThetas);
  const cosT = new Float64Array(nThetas);
  const sinT = new Float64Array(nThetas);
  for (let i = 0; i < nThetas; i++) {
    const deg = subThetas[i];
    const rad = (deg * Math.PI) / 180;
    thetas[i] = deg;
    cosT[i] = Math.cos(rad);
    sinT[i] = Math.sin(rad);
  }
  const subRangeLen = 2 * stepsPerSide + 1;
  const diag = Math.ceil(Math.hypot(w, h));
  const nRhos = 2 * diag + 1;
  const accumulator = new Uint32Array(nThetas * nRhos);

  for (let p = 0; p < edges.length; p += 2) {
    const x = edges[p];
    const y = edges[p + 1];
    for (let t = 0; t < nThetas; t++) {
      const rho = Math.round(x * cosT[t] + y * sinT[t]) + diag;
      // rho is in [0, nRhos) by construction (|x cos + y sin| <= diag).
      accumulator[t * nRhos + rho]++;
    }
  }

  // Step 4: per-theta-bin score = max-rho cell. Used by both the global
  // median (the confidence floor) and the iterated peak search below.
  const binMax = new Uint32Array(nThetas);
  for (let t = 0; t < nThetas; t++) {
    let m = 0;
    const rowStart = t * nRhos;
    for (let r = 0; r < nRhos; r++) {
      const v = accumulator[rowStart + r];
      if (v > m) m = v;
    }
    binMax[t] = m;
  }

  const sorted = Array.from(binMax).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];

  // Iterate up to k peaks. After accepting a peak we zero out its NMS
  // window in `available` so the next-strongest peak comes from a
  // different ridge. We never zero `binMax` itself — sub-bin refinement
  // still reads the original bin scores.
  const available = new Uint8Array(nThetas);
  available.fill(1);
  // Don't allow peaks at the edge of either sub-window; the final-guard
  // logic below already declines them, and eliding them up front avoids
  // wasted iterations when the strongest cell happens to be on the rail.
  available[0] = 0;
  available[subRangeLen - 1] = 0;
  available[subRangeLen] = 0;
  available[2 * subRangeLen - 1] = 0;

  const peaks: SkewPeak[] = [];
  for (let pick = 0; pick < k; pick++) {
    let peakBin = -1;
    let peakValue = 0;
    for (let t = 0; t < nThetas; t++) {
      if (!available[t]) continue;
      const v = binMax[t];
      if (v > peakValue) {
        peakValue = v;
        peakBin = t;
      }
    }
    if (peakBin < 0 || peakValue === 0) break;

    const confidence = peakValue / (median + 1);
    if (confidence < confidenceThreshold) break;

    // Sub-bin parabolic refinement: fit a parabola through (peakBin-1,
    // peak, peakBin+1) bin scores to nudge the angle estimate toward
    // the true peak when it sits between bins. Only apply within a
    // contiguous sub-range — the sweep is two disjoint [-h,+h] and
    // [90-h,90+h] windows, so the joint between them is not a smooth
    // neighbourhood.
    let dominantThetaDeg = thetas[peakBin];
    const subIdx = peakBin < subRangeLen ? peakBin : peakBin - subRangeLen;
    if (subIdx > 0 && subIdx < subRangeLen - 1) {
      const yPrev = binMax[peakBin - 1];
      const yPeak = binMax[peakBin];
      const yNext = binMax[peakBin + 1];
      const denom = yPrev - 2 * yPeak + yNext;
      if (denom !== 0) {
        const offset = (0.5 * (yPrev - yNext)) / denom;
        if (offset > -1 && offset < 1) {
          dominantThetaDeg += offset * thetaStepDeg;
        }
      }
    }

    // Final guard: peaks at the edge of either sub-window can't be
    // refined, and the true skew may lie outside our search range. Skip
    // and keep iterating — but make sure the bin gets suppressed below
    // so we don't infinite-loop on it.
    const onSubEdge =
      subIdx === 0 || subIdx === subRangeLen - 1;
    if (!onSubEdge) {
      const angleDeg = thetaToRotation(dominantThetaDeg);
      peaks.push({
        angleDeg: roundTo(angleDeg, 4),
        confidence: roundTo(confidence, 4),
      });
    }

    // Non-maximum suppression: zero a window of `nmsHalfWidth` bins on
    // each side of the picked bin within its own sub-window. We don't
    // suppress across the sub-window boundary; horizontal-vs-vertical
    // ridges are exactly what the multi-peak path is meant to surface.
    const subStart = peakBin < subRangeLen ? 0 : subRangeLen;
    const subEnd = peakBin < subRangeLen ? subRangeLen - 1 : 2 * subRangeLen - 1;
    const lo = Math.max(subStart, peakBin - nmsHalfWidth);
    const hi = Math.min(subEnd, peakBin + nmsHalfWidth);
    for (let t = lo; t <= hi; t++) available[t] = 0;
  }

  // Already in confidence-descending order: each pick took the global max
  // of the remaining `available` bins.
  return peaks;
}

// Convert a Hough-line-normal angle (degrees) into the small rotation that
// levels the image. Hough theta=0 means the dominant lines are vertical
// (their normals point horizontally); theta=±90 means horizontal lines. For
// a near-upright image whose lines are slightly tilted, theta will be near
// 0 or near ±90; we want the small angle in (-45, +45] either way.
function thetaToRotation(thetaDeg: number): number {
  // Reduce into (-90, +90]:
  let t = thetaDeg;
  while (t > 90) t -= 180;
  while (t <= -90) t += 180;
  // Fold (-90, -45] and (+45, +90] into (-45, +45] by snapping toward zero.
  if (t > 45) t -= 90;
  else if (t < -45) t += 90;
  return t;
}

function greyscaleDownsample(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): { gray: Uint8Array; w: number; h: number } {
  const longer = Math.max(width, height);
  const stride = longer > MAX_WORKING_SIDE_PX
    ? Math.ceil(longer / MAX_WORKING_SIDE_PX)
    : 1;
  const w = Math.max(1, Math.floor(width / stride));
  const h = Math.max(1, Math.floor(height / stride));
  const gray = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy = y * stride;
    for (let x = 0; x < w; x++) {
      const sx = x * stride;
      const i = (sy * width + sx) * 4;
      // Rec. 601 luma; matches the binarize convention elsewhere.
      const lum = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
      gray[y * w + x] = lum < 0 ? 0 : lum > 255 ? 255 : lum;
    }
  }
  return { gray, w, h };
}

function sobelMagnitude(
  gray: Uint8Array,
  w: number,
  h: number,
): { mag: Uint16Array; threshold: number } {
  const mag = new Uint16Array(w * h);
  // Border pixels stay 0 — skip them rather than sample out-of-bounds.
  for (let y = 1; y < h - 1; y++) {
    const rowAbove = (y - 1) * w;
    const rowMid = y * w;
    const rowBelow = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[rowAbove + x - 1];
      const tc = gray[rowAbove + x];
      const tr = gray[rowAbove + x + 1];
      const ml = gray[rowMid + x - 1];
      const mr = gray[rowMid + x + 1];
      const bl = gray[rowBelow + x - 1];
      const bc = gray[rowBelow + x];
      const br = gray[rowBelow + x + 1];
      const gx = -tl - 2 * ml - bl + tr + 2 * mr + br;
      const gy = -tl - 2 * tc - tr + bl + 2 * bc + br;
      const m = Math.abs(gx) + Math.abs(gy);
      mag[rowMid + x] = m > 65535 ? 65535 : m;
    }
  }
  // Histogram-based threshold: keep the top EDGE_KEEP_FRACTION of magnitudes.
  const histo = new Uint32Array(1024);
  let total = 0;
  let maxBucket = 0;
  for (let i = 0; i < mag.length; i++) {
    const m = mag[i];
    if (m === 0) continue;
    const bucket = m < 1023 ? m : 1023;
    histo[bucket]++;
    total++;
    if (bucket > maxBucket) maxBucket = bucket;
  }
  const target = Math.floor(total * EDGE_KEEP_FRACTION);
  let acc = 0;
  let threshold = 1;
  for (let b = maxBucket; b >= 0; b--) {
    acc += histo[b];
    if (acc >= target) {
      threshold = b;
      break;
    }
  }
  if (threshold < 1) threshold = 1;
  return { mag, threshold };
}

function collectEdgePixels(
  mag: Uint16Array,
  w: number,
  h: number,
  threshold: number,
): Int32Array {
  // Two-pass: count, allocate, fill. The flat (x, y) interleaved layout is
  // cheaper to iterate than two parallel arrays.
  let count = 0;
  for (let i = 0; i < mag.length; i++) {
    if (mag[i] >= threshold) count++;
  }
  const out = new Int32Array(count * 2);
  let p = 0;
  for (let y = 1; y < h - 1; y++) {
    const row = y * w;
    for (let x = 1; x < w - 1; x++) {
      if (mag[row + x] >= threshold) {
        out[p] = x;
        out[p + 1] = y;
        p += 2;
      }
    }
  }
  return out.subarray(0, p);
}

function roundTo(value: number, decimals: number): number {
  const k = Math.pow(10, decimals);
  return Math.round(value * k) / k;
}

// Exposed for tests.
export const __test__ = { thetaToRotation };
