/**
 * Bug #09 — automatic crossing depth for the 3D preview.
 *
 * Where two tubes cross in plan view the preview used to draw both at Z=0, so
 * the glass visibly passed *through* the other tube. Real neon cannot do that.
 * Tubes may **stack** — sit at different standoff depths, one in front of the
 * other — but they may never **intersect**.
 *
 * That distinction gives the hard constraint this module exists to satisfy:
 * two tubes of diameter dA and dB do not intersect iff their centre lines are
 * at least (dA + dB) / 2 apart. Lifting the "over" tube by that much at the
 * crossing is therefore the minimum correct answer, and
 * `AUTO_CROSSING_LIFT_HEIGHT_MULT` adds clearance on top.
 *
 * This is deliberately NOT the same thing as a `kind: 'jump'` annotation. A
 * jump is a fabrication instruction the designer made — a tall, intentional
 * horseshoe (2.5× diameter). Auto-lift is only the preview refusing to render
 * something physically impossible; it stays small so a real jump still reads
 * as the louder gesture.
 *
 * Self-crossings matter as much as run-to-run ones: the bug was found on a
 * cursive "Salon" whose single connected run crosses itself four times, which
 * is why this works on segment pairs rather than whole runs.
 */
import type { DesignRun } from '../api';

/** A detected plan-view crossing between two polyline segments. */
export interface Crossing {
  /** Index into the runs array for the first segment's run. */
  runA: number;
  /** Index of the first segment's START vertex within that run's polyline. */
  segA: number;
  runB: number;
  segB: number;
  /** Intersection point in mm, doc coordinates. */
  at: readonly [number, number];
}

/**
 * Segment-segment intersection in 2D, excluding shared endpoints.
 *
 * Returns null for parallel, collinear or merely touching segments. Touching
 * is excluded deliberately: consecutive segments of one polyline share a
 * vertex, and a tube is not crossing itself where it simply continues.
 */
function segmentIntersection(
  p1: readonly [number, number], p2: readonly [number, number],
  p3: readonly [number, number], p4: readonly [number, number],
): [number, number] | null {
  const d1x = p2[0] - p1[0], d1y = p2[1] - p1[1];
  const d2x = p4[0] - p3[0], d2y = p4[1] - p3[1];
  const denom = d1x * d2y - d1y * d2x;
  if (denom === 0) return null; // parallel or collinear
  const t = ((p3[0] - p1[0]) * d2y - (p3[1] - p1[1]) * d2x) / denom;
  const u = ((p3[0] - p1[0]) * d1y - (p3[1] - p1[1]) * d1x) / denom;
  // Strict interior on both: endpoints touching is continuation, not a crossing.
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null;
  return [p1[0] + t * d1x, p1[1] + t * d1y];
}

/** Segment endpoints for run `r`, honouring closure (the wrap segment counts). */
function segmentsOf(run: DesignRun): number {
  const n = run.polyline.points.length;
  if (n < 2) return 0;
  return run.polyline.closed ? n : n - 1;
}

function segEnd(run: DesignRun, i: number): readonly [number, number] {
  const pts = run.polyline.points;
  return pts[(i + 1) % pts.length];
}

/**
 * Every plan-view crossing among `runs`, including a run crossing itself.
 *
 * Segment pairs are rejected early by bounding box, which keeps this near-linear
 * on real designs — vectorised polylines are dense (hundreds of points) but
 * their segments are short, so almost every pair fails the box test immediately.
 */
export function findCrossings(runs: ReadonlyArray<DesignRun>): Crossing[] {
  const out: Crossing[] = [];
  for (let a = 0; a < runs.length; a++) {
    const ra = runs[a];
    const pa = ra.polyline.points;
    const na = segmentsOf(ra);
    for (let i = 0; i < na; i++) {
      const a1 = pa[i], a2 = segEnd(ra, i);
      const aMinX = Math.min(a1[0], a2[0]), aMaxX = Math.max(a1[0], a2[0]);
      const aMinY = Math.min(a1[1], a2[1]), aMaxY = Math.max(a1[1], a2[1]);
      for (let b = a; b < runs.length; b++) {
        const rb = runs[b];
        const pb = rb.polyline.points;
        const nb = segmentsOf(rb);
        // Within one run, only look forward, and skip the immediately
        // adjacent segment (it shares a vertex by construction).
        const jStart = b === a ? i + 2 : 0;
        for (let j = jStart; j < nb; j++) {
          // For a closed run the last segment wraps onto segment 0, so that
          // pair is adjacent too.
          if (b === a && ra.polyline.closed && i === 0 && j === nb - 1) continue;
          const b1 = pb[j], b2 = segEnd(rb, j);
          if (Math.max(b1[0], b2[0]) < aMinX || Math.min(b1[0], b2[0]) > aMaxX) continue;
          if (Math.max(b1[1], b2[1]) < aMinY || Math.min(b1[1], b2[1]) > aMaxY) continue;
          const hit = segmentIntersection(a1, a2, b1, b2);
          if (hit) out.push({ runA: a, segA: i, runB: b, segB: j, at: hit });
        }
      }
    }
  }
  return out;
}

/**
 * Decide which side of each crossing lifts, returning the crossing POINTS
 * (doc mm) per run index.
 *
 * Points rather than vertex indices because the guarantee is "no intersecting
 * glass *at* the crossing". The renderer converts these to arc positions on
 * whichever split segment actually contains them, so the lift peaks exactly
 * where the tubes meet instead of at some nearby vertex.
 *
 * The rule is deterministic so the render never flickers between frames or
 * differs between machines: the **later** segment goes over — later run index,
 * or later segment index within one run. Arbitrary, but stable, so a design
 * looks identical every time it is shown to a customer.
 *
 * Only one side lifts. Raising both would separate them by twice the offset and
 * leave neither tube on the backing plane, which is not how a crossing is built.
 */
export function overCrossingPointsByRun(
  crossings: ReadonlyArray<Crossing>,
): Map<number, [number, number][]> {
  const byRun = new Map<number, [number, number][]>();
  for (const c of crossings) {
    let overRun: number;
    if (c.runA === c.runB) {
      overRun = c.runA;
    } else {
      overRun = Math.max(c.runA, c.runB);
    }
    const list = byRun.get(overRun);
    const pt: [number, number] = [c.at[0], c.at[1]];
    if (list) list.push(pt);
    else byRun.set(overRun, [pt]);
  }
  return byRun;
}
