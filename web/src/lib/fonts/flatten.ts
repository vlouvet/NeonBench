// Bezier flattening for OpenType glyph outlines.
//
// Glyph outlines arrive as quadratic ('Q', TrueType/`glyf`) or cubic
// ('C', PostScript/CFF) beziers. The design doc stores polylines only, so
// every curve has to become a chain of straight segments — and the number
// that decides how many is the CHORD TOLERANCE: the largest distance the
// real curve is ever allowed to stray from the polyline that replaces it.
//
// Why a chord tolerance and not "N segments per curve": a fixed segment
// count over-samples a 4 mm comma and under-samples a 900 mm 'O' on the
// same sign. The operator cares about one thing — how far the bent tube
// can sit from the drawn letter — and that is a distance in millimetres.
//
// DEFAULT_CHORD_TOLERANCE_MM is 0.25 mm: an order of magnitude below the
// ±3 mm a bender can hold on a glass tube, and below the resolution of the
// full-size printed pattern the shop bends against, so the faceting is
// never the limiting error.
//
// The subdivision criterion is deliberately conservative. A bezier lies
// inside the convex hull of its control points, so the greatest distance
// from any curve point to the chord is at most the greatest distance from
// a CONTROL point to that chord. We recurse until that hull bound is under
// the tolerance rather than using one of the tighter analytic estimates:
// it costs a few extra vertices and it cannot under-sample. `flatten.test.ts`
// checks the emitted polyline against densely sampled true-curve points,
// which is the assertion that actually matters.
//
// UNITS — the one thing to get wrong here. The tolerance is in MILLIMETRES,
// so every point handed to these functions must already be in millimetres.
// Glyph outlines arrive in font units (2048 per em on every face measured
// on this machine), where 0.25 would mean 0.25 *units* — about 0.012 mm on a
// 100 mm cap, i.e. a 20x over-sample and a polyline nobody can edit. So
// `outline.ts` applies the cap-height scale, the y-flip and the pen offset to
// the control points BEFORE calling in here, and flattens in the operator's
// coordinate system. Do not "optimise" that by flattening in font units.

export type Pt = [number, number];

/** Largest distance (mm) the flattened polyline may deviate from the true
 *  curve. See the module comment for why 0.25 mm. */
export const DEFAULT_CHORD_TOLERANCE_MM = 0.25;

/** Hard recursion cap. Each level doubles the segment count, so 12 is
 *  4096 segments per curve — two orders of magnitude past what any
 *  legible tolerance needs, and a HARD bound on the damage a pathological
 *  input can do. It matters: this runs synchronously on the UI thread
 *  while the operator types, and the old value of 20 would have allowed
 *  a single cusp to emit 1,048,576 vertices and hang the tab. de
 *  Casteljau halves the hull each split, so real curves terminate at
 *  depth 3-6 and never see this. */
const MAX_DEPTH = 12;

/** Distance from `p` to the infinite line through `a`,`b`. Degenerate
 *  chord (a ≈ b) falls back to the point distance, which is the right
 *  answer for a curve that starts and ends in the same place. */
function distToLine(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < 1e-12) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dy * (p[0] - a[0]) - dx * (p[1] - a[1])) / len;
}

function mid(a: Pt, b: Pt): Pt {
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
}

/**
 * Flatten one quadratic bezier. Returns the points AFTER `p0` up to and
 * including `p1`, so a caller can concatenate segments without having to
 * de-duplicate the shared endpoints.
 */
export function flattenQuadratic(
  p0: Pt,
  c: Pt,
  p1: Pt,
  toleranceMM: number = DEFAULT_CHORD_TOLERANCE_MM,
): Pt[] {
  const out: Pt[] = [];
  const tol = toleranceMM > 0 ? toleranceMM : DEFAULT_CHORD_TOLERANCE_MM;
  recurseQuad(p0, c, p1, tol, 0, out);
  out.push(p1);
  return out;
}

function recurseQuad(p0: Pt, c: Pt, p1: Pt, tol: number, depth: number, out: Pt[]): void {
  if (depth >= MAX_DEPTH || distToLine(c, p0, p1) <= tol) return;
  // de Casteljau split at t = 0.5.
  const a = mid(p0, c);
  const b = mid(c, p1);
  const m = mid(a, b);
  recurseQuad(p0, a, m, tol, depth + 1, out);
  out.push(m);
  recurseQuad(m, b, p1, tol, depth + 1, out);
}

/**
 * Flatten one cubic bezier. Same emission contract as
 * {@link flattenQuadratic}: points after `p0`, ending at `p1`.
 */
export function flattenCubic(
  p0: Pt,
  c1: Pt,
  c2: Pt,
  p1: Pt,
  toleranceMM: number = DEFAULT_CHORD_TOLERANCE_MM,
): Pt[] {
  const out: Pt[] = [];
  const tol = toleranceMM > 0 ? toleranceMM : DEFAULT_CHORD_TOLERANCE_MM;
  recurseCubic(p0, c1, c2, p1, tol, 0, out);
  out.push(p1);
  return out;
}

function recurseCubic(
  p0: Pt,
  c1: Pt,
  c2: Pt,
  p1: Pt,
  tol: number,
  depth: number,
  out: Pt[],
): void {
  const flat = Math.max(distToLine(c1, p0, p1), distToLine(c2, p0, p1));
  if (depth >= MAX_DEPTH || flat <= tol) return;
  const a = mid(p0, c1);
  const bc = mid(c1, c2);
  const d = mid(c2, p1);
  const ab = mid(a, bc);
  const cd = mid(bc, d);
  const m = mid(ab, cd);
  recurseCubic(p0, a, ab, m, tol, depth + 1, out);
  out.push(m);
  recurseCubic(m, cd, d, p1, tol, depth + 1, out);
}

/** Exact point on a quadratic bezier at parameter `t`. Test helper AND
 *  the reference the tolerance assertion is written against — exported so
 *  the test cannot quietly re-derive the same mistake as the flattener. */
export function quadraticAt(p0: Pt, c: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
  ];
}

/** Exact point on a cubic bezier at parameter `t`. */
export function cubicAt(p0: Pt, c1: Pt, c2: Pt, p1: Pt, t: number): Pt {
  const u = 1 - t;
  const uu = u * u;
  const tt = t * t;
  return [
    uu * u * p0[0] + 3 * uu * t * c1[0] + 3 * u * tt * c2[0] + tt * t * p1[0],
    uu * u * p0[1] + 3 * uu * t * c1[1] + 3 * u * tt * c2[1] + tt * t * p1[1],
  ];
}

/** Shortest distance from `p` to the polyline `pts` (segment distance,
 *  not vertex distance — a vertex-only measure reports a curve as well
 *  approximated when it is not). */
export function distanceToPolyline(p: Pt, pts: Pt[]): number {
  let best = Infinity;
  for (let i = 0; i + 1 < pts.length; i++) {
    const d = distToSegment(p, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  return best;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  if (l2 < 1e-24) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}
