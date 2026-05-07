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

const DEFAULT_SEARCH_RANGE_DEG = 15;
const DEFAULT_THETA_STEP_DEG = 0.25;
const DEFAULT_CONFIDENCE_THRESHOLD = 3.0;
const MAX_WORKING_SIDE_PX = 512;
const EDGE_KEEP_FRACTION = 0.2;

export function estimateSkewDegrees(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  opts: EstimateSkewOptions = {},
): SkewEstimate | null {
  const searchRangeDeg = opts.searchRangeDeg ?? DEFAULT_SEARCH_RANGE_DEG;
  const thetaStepDeg = opts.thetaStepDeg ?? DEFAULT_THETA_STEP_DEG;
  const confidenceThreshold =
    opts.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;

  if (width < 8 || height < 8) return null;
  if (pixels.length !== width * height * 4) return null;

  // Step 1: greyscale + downsample.
  const { gray, w, h } = greyscaleDownsample(pixels, width, height);

  // Step 2: Sobel magnitude + histogram-thresholded edge mask.
  const { mag, threshold } = sobelMagnitude(gray, w, h);
  const edges = collectEdgePixels(mag, w, h, threshold);
  if (edges.length < 32) return null;

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

  // Step 4: peak detection. For each theta bin, take the max-rho cell.
  const binMax = new Uint32Array(nThetas);
  let peakBin = 0;
  let peakValue = 0;
  for (let t = 0; t < nThetas; t++) {
    let m = 0;
    const rowStart = t * nRhos;
    for (let r = 0; r < nRhos; r++) {
      const v = accumulator[rowStart + r];
      if (v > m) m = v;
    }
    binMax[t] = m;
    if (m > peakValue) {
      peakValue = m;
      peakBin = t;
    }
  }
  if (peakValue === 0) return null;

  const sorted = Array.from(binMax).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const confidence = peakValue / (median + 1);

  if (confidence < confidenceThreshold) return null;

  // Sub-bin parabolic refinement: fit a parabola through (peakBin-1, peak,
  // peakBin+1) bin scores to nudge the angle estimate toward the true peak
  // when it sits between bins. Only apply within a contiguous sub-range —
  // the sweep is two disjoint [-h,+h] and [90-h,90+h] windows, so the joint
  // between them is not a smooth neighbourhood.
  let dominantThetaDeg = thetas[peakBin];
  // Index within its sub-range: 0..subRangeLen-1 for the first window, then
  // 0..subRangeLen-1 for the second.
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

  // Final guard: if the peak sits on the edge of either sub-window, the
  // true skew may exceed our range and any answer we'd return would be
  // misleading. Treat it as "outside search range" and decline.
  if (subIdx === 0 || subIdx === subRangeLen - 1) {
    return null;
  }

  // Step 5: theta → rotation. Map dominantThetaDeg into (-45, +45] so we
  // return the small rotation that levels the image, not the equivalent
  // 90°-flipped one.
  const angleDeg = thetaToRotation(dominantThetaDeg);

  return {
    angleDeg: roundTo(angleDeg, 4),
    confidence: roundTo(confidence, 4),
  };
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
