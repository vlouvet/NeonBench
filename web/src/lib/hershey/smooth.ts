// Corner-preserving Catmull-Rom resampling for Hershey glyph strokes (Bug #07).
//
// WHY: Hershey glyphs store curves as coarse integer polylines — the capital
// "O" is a 21-point polygon. The validator computes bend radius from the
// circumradius of triples sampled at ~5mm along a run, so each facet vertex of
// that polygon reads as a tight bend (12–24mm), well under a 12mm tube's 27mm
// minimum. Inserting default text therefore produced ~10 bend-radius errors
// out of the box (Bug #07). Densifying each curved stroke along a smooth
// Catmull-Rom spline makes those sampled triples follow the true (gentle)
// curvature instead of the facets.
//
// WHY corner-preserving: the same spline through a genuine sharp corner would
// round it into a small-radius arc — creating a *new* bend error where a hard
// corner previously read as two separate straight segments. So we split a
// stroke at sharp turns and only smooth the gentle (curved) runs between them.
// In practice most Hershey corners live between *separate* strokes (E, N), but
// a stroke that mixes a curve and a corner (some D/B/R variants) is handled
// correctly by the split.

export type Pt = [number, number];

export interface SmoothOptions {
  // Turn angles at or above this (degrees, 0 = straight, 180 = U-turn) are
  // treated as intentional corners: kept as hard vertices, the spline is not
  // carried across them. The O's facet turns are ~17°; letter corners are
  // ~90°, so the default cleanly separates the two.
  cornerAngleDeg?: number;
  // Catmull-Rom samples inserted between each pair of original points on a
  // smooth run. Spacing must land well under the validator's ~5mm resample
  // step; 6 puts an ~11mm facet at <2mm.
  subdivisions?: number;
}

const DEFAULT_CORNER_ANGLE_DEG = 50;
const DEFAULT_SUBDIVISIONS = 6;

// turnAngleDeg returns the deviation-from-straight at b: 0° when a→b→c is
// straight, 180° for a full reversal.
function turnAngleDeg(a: Pt, b: Pt, c: Pt): number {
  const v1x = b[0] - a[0];
  const v1y = b[1] - a[1];
  const v2x = c[0] - b[0];
  const v2y = c[1] - b[1];
  const m1 = Math.hypot(v1x, v1y);
  const m2 = Math.hypot(v2x, v2y);
  if (m1 < 1e-9 || m2 < 1e-9) return 0;
  const cos = Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / (m1 * m2)));
  return (Math.acos(cos) * 180) / Math.PI;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

// Centripetal Catmull-Rom (α = 0.5). Unlike the uniform variant it does NOT
// overshoot or form cusps on unevenly-spaced control points — important here
// because Hershey glyph vertices are irregular, and an overshooting spline
// would invent tighter local curvature than the original polygon. Knots are
// spaced by sqrt(chord length); the point at parameter t ∈ [t1,t2] comes from
// the Barry–Goldman nested-lerp pyramid.
function centripetalSegment(p0: Pt, p1: Pt, p2: Pt, p3: Pt, sub: number): Pt[] {
  const knot = (ti: number, a: Pt, b: Pt): number =>
    ti + Math.max(Math.sqrt(Math.hypot(b[0] - a[0], b[1] - a[1])), 1e-6);
  const t0 = 0;
  const t1 = knot(t0, p0, p1);
  const t2 = knot(t1, p1, p2);
  const t3 = knot(t2, p2, p3);
  const out: Pt[] = [];
  for (let s = 0; s < sub; s++) {
    const t = t1 + ((t2 - t1) * s) / sub;
    const a1 = lerp(p0, p1, (t - t0) / (t1 - t0));
    const a2 = lerp(p1, p2, (t - t1) / (t2 - t1));
    const a3 = lerp(p2, p3, (t - t2) / (t3 - t2));
    const b1 = lerp(a1, a2, (t - t0) / (t2 - t0));
    const b2 = lerp(a2, a3, (t - t1) / (t3 - t1));
    out.push(lerp(b1, b2, (t - t1) / (t2 - t1)));
  }
  return out;
}

// catmullRom densifies an open run of >= 2 points, passing through every
// original point and inserting `sub` samples between each pair. Endpoints are
// duplicated as phantom tangents so the curve starts/ends at the run ends.
function catmullRom(pts: Pt[], sub: number): Pt[] {
  const n = pts.length;
  if (n < 3) return pts.slice();
  const out: Pt[] = [];
  for (let i = 0; i < n - 1; i++) {
    const p0 = pts[i === 0 ? 0 : i - 1];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2 < n ? i + 2 : n - 1];
    out.push(...centripetalSegment(p0, p1, p2, p3, sub));
  }
  out.push(pts[n - 1]);
  return out;
}

// smoothStrokePoints resamples one stroke: split at sharp corners, Catmull-Rom
// densify the gentle runs, keep straight 2-point runs as-is. Returns the
// original array unchanged when there's nothing to smooth (< 3 points).
export function smoothStrokePoints(points: Pt[], opts: SmoothOptions = {}): Pt[] {
  const cornerAngleDeg = opts.cornerAngleDeg ?? DEFAULT_CORNER_ANGLE_DEG;
  const sub = Math.max(1, Math.floor(opts.subdivisions ?? DEFAULT_SUBDIVISIONS));
  if (points.length < 3) return points;

  // Split into runs at interior corner vertices. A corner is shared: it ends
  // one run and starts the next, so it survives as an exact hard vertex.
  const runs: Pt[][] = [];
  let cur: Pt[] = [points[0]];
  for (let i = 1; i < points.length; i++) {
    cur.push(points[i]);
    const isInteriorCorner =
      i < points.length - 1 &&
      turnAngleDeg(points[i - 1], points[i], points[i + 1]) >= cornerAngleDeg;
    if (isInteriorCorner) {
      runs.push(cur);
      cur = [points[i]];
    }
  }
  runs.push(cur);

  const out: Pt[] = [];
  for (const run of runs) {
    const dense = run.length >= 3 ? catmullRom(run, sub) : run;
    for (const p of dense) {
      const last = out[out.length - 1];
      // Drop the duplicate shared corner where two runs meet.
      if (last && last[0] === p[0] && last[1] === p[1]) continue;
      out.push(p);
    }
  }
  return out;
}
