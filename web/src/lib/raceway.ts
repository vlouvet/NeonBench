// Auto-raceway grouping for channel-letter face runs (Tier 3 #46).
//
// Manually labelling each face run with a `raceway_id` is the v1 wiring
// (PR #43). This module's `groupByBaseline` does that automatically: it
// clusters face-flagged runs by baseline (bbox bottom-Y) and within-
// baseline horizontal proximity, then assigns deterministic raceway IDs
// in left-to-right order.
//
// Heuristic constants:
//   - BASELINE_TOL_FRACTION_OF_H = 0.15. Two runs share a baseline when
//     their bbox bottoms differ by less than 0.15 × the median bbox
//     height. Tested against handwritten "OPEN" / "DINER" / "CAFÉ"
//     style multi-letter signs where letters are roughly the same size.
//     Cap-and-baseline mixed designs (capitals next to lowercase
//     descenders, e.g. "Pizza") need manual cleanup; the threshold is
//     generous enough that most fixtures cluster correctly but tight
//     enough that rooftop letters (very different baselines) split.
//   - GAP_TOL_FRACTION_OF_H = 2.0. On a single baseline, two adjacent
//     letters belong to the same raceway when the bbox horizontal gap
//     is below 2 × median height. A single 2-em-space-style gap
//     (typical between words) splits a baseline into two raceways,
//     matching shop intuition: "OPEN | NOW" gets two raceways even on
//     one baseline.
//
// Both numbers are tunable; future maintainers should adjust if real
// fixtures cluster wrong. Stay below 0.25 × H for the baseline tol or
// distinct rows merge; stay above 1.5 × H for the gap tol or natural
// kerning splits letters that should share.

import type { DesignRun } from '../api';

export interface BBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
  w: number;
  h: number;
}

export interface GroupOptions {
  /**
   * When true, runs that already have a non-empty `raceway_id` are not
   * overwritten — useful for incremental tagging when an operator has
   * already manually grouped a subset. Default false (auto-assignment
   * replaces every face-flagged run's raceway_id).
   */
  preserveExisting?: boolean;
}

const BASELINE_TOL_FRACTION_OF_H = 0.15;
const GAP_TOL_FRACTION_OF_H = 2.0;

function bbox(points: ReadonlyArray<readonly [number, number]>): BBox | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return {
    left: minX,
    right: maxX,
    top: minY,
    bottom: maxY,
    w: maxX - minX,
    h: maxY - minY,
  };
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  const mid = sorted.length >>> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface FaceEntry {
  run: DesignRun;
  bbox: BBox;
}

/**
 * Cluster face-flagged runs into raceway groups by baseline + horizontal
 * proximity, then return a map from run.id → assigned raceway id.
 *
 * Determinism: groups are sorted left-to-right by their leftmost X before
 * IDs are assigned, and within each group the per-run map entries are
 * inserted in input-stable order. Shuffling the input run order produces
 * the same set of map entries with the same IDs as long as the geometry
 * is unchanged.
 *
 * Non-face runs and runs with empty polylines are ignored entirely (they
 * never appear in the output map).
 */
export function groupByBaseline(
  runs: ReadonlyArray<DesignRun>,
  opts: GroupOptions = {},
): Map<string, string> {
  const out = new Map<string, string>();

  const faces: FaceEntry[] = [];
  for (const r of runs) {
    if (!r.is_channel_letter_face) continue;
    const bb = bbox(r.polyline.points);
    if (bb === null) continue;
    faces.push({ run: r, bbox: bb });
  }
  if (faces.length === 0) return out;

  const heights = faces.map((f) => f.bbox.h).filter((h) => h > 0);
  // If every bbox is degenerate, fall back to 1 so divisions are safe.
  // The tolerances become ~0.15 mm / 2 mm — effectively "exact match" for
  // baseline and "any visible gap splits" — which is the right behavior
  // for ill-formed input.
  const H = heights.length > 0 ? median(heights) : 1;
  const baselineTol = H * BASELINE_TOL_FRACTION_OF_H;
  const gapTol = H * GAP_TOL_FRACTION_OF_H;

  // Step 1: bucket runs by baseline. We keep one anchor bottom-Y per
  // bucket (the bottom of the first run added to the bucket) so every
  // subsequent run is compared against the bucket's seed, not a moving
  // average. This keeps the result deterministic regardless of input
  // order — adding the same run set in a different order produces the
  // same bucket membership as long as the seed-to-other distance check
  // is symmetric.
  interface BaselineBucket {
    anchorBottom: number;
    members: FaceEntry[];
  }
  const buckets: BaselineBucket[] = [];
  // Sort faces by bottom-Y first so the bucket seeds get picked
  // deterministically (the topmost-bottom face seeds each bucket).
  // Stable secondary key: leftmost X.
  const facesByBaseline = faces.slice().sort((a, b) => {
    if (a.bbox.bottom !== b.bbox.bottom) return a.bbox.bottom - b.bbox.bottom;
    return a.bbox.left - b.bbox.left;
  });
  for (const f of facesByBaseline) {
    const found = buckets.find(
      (b) => Math.abs(b.anchorBottom - f.bbox.bottom) < baselineTol,
    );
    if (found) {
      found.members.push(f);
    } else {
      buckets.push({ anchorBottom: f.bbox.bottom, members: [f] });
    }
  }

  // Step 2: within each baseline bucket, sort left-to-right and split
  // by horizontal gap > gapTol. Each split produces a separate raceway
  // group — same baseline, different raceway because the inter-letter
  // gap is too wide to bridge.
  const racewayGroups: FaceEntry[][] = [];
  for (const bucket of buckets) {
    const members = bucket.members.slice().sort((a, b) => {
      if (a.bbox.left !== b.bbox.left) return a.bbox.left - b.bbox.left;
      // Stable secondary key on bottom-Y just to avoid tie ordering surprises
      return a.bbox.bottom - b.bbox.bottom;
    });
    let current: FaceEntry[] = [];
    let prev: FaceEntry | null = null;
    for (const f of members) {
      if (prev === null) {
        current = [f];
        prev = f;
        continue;
      }
      const gap = f.bbox.left - prev.bbox.right;
      if (gap > gapTol) {
        racewayGroups.push(current);
        current = [f];
      } else {
        current.push(f);
      }
      prev = f;
    }
    if (current.length > 0) racewayGroups.push(current);
  }

  // Step 3: assign IDs in left-to-right order by group leftmost X. Ties
  // (same leftmost X — rare, only happens if two groups stack vertically)
  // break by topmost-bottom so the result is fully deterministic.
  racewayGroups.sort((a, b) => {
    const aLeft = Math.min(...a.map((f) => f.bbox.left));
    const bLeft = Math.min(...b.map((f) => f.bbox.left));
    if (aLeft !== bLeft) return aLeft - bLeft;
    const aBottom = Math.min(...a.map((f) => f.bbox.bottom));
    const bBottom = Math.min(...b.map((f) => f.bbox.bottom));
    return aBottom - bBottom;
  });

  racewayGroups.forEach((group, i) => {
    const id = `raceway-${i + 1}`;
    for (const f of group) {
      if (opts.preserveExisting) {
        const existing = f.run.raceway_id;
        if (existing && existing.trim() !== '') continue;
      }
      out.set(f.run.id, id);
    }
  });

  return out;
}
