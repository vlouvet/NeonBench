// offsetPolygon — closed-polygon parallel offset by signed distance, used
// by the "Neonize" doc operation to turn a single closed outline into a
// pair of parallel tube paths (a "double-stroke" channel-letter face).
//
// The math is the standard angle-bisector / miter-join construction:
//
//   For each vertex p[i] of the closed polygon:
//     - take the outward normals of the two adjacent edges (n_in, n_out)
//     - bisector = normalize(n_in + n_out)
//     - miterLen = distance / |cos(half_angle)|, where
//       cos(half_angle) = dot(bisector, n_in)
//     - new vertex = p[i] + bisector * miterLen
//
// At sharp acute corners miterLen blows up (a 30° interior angle pushes
// the miter ~3.86× the offset distance off the corner), which produces
// a "spike". SVG and most CAD packages clamp this with a *miter limit*:
// when miterLen > miterLimit * |distance|, emit a beveled corner instead
// (two output vertices, one along n_in and one along n_out, each at the
// offset distance from p[i]).
//
// Sign convention: positive `distanceMM` always means "expand the polygon
// outward". Internally we detect winding with the shoelace formula and
// flip the normal direction for CW input so the API stays winding-
// agnostic for the caller.
//
// Tier 3 #27 added:
//   - offsetOpenPolyline: parallel offset for open polylines, butt caps.
//   - Self-intersection trim: when the offset polygon's segments cross,
//     splice the polyline at the crossing so the offending loop is
//     dropped. Heuristic; figure-8 / multi-loop geometries still need
//     manual node editing (limitation documented inline).
//   - Per-corner cap styles: 'miter' (existing), 'bevel' (chamfer), or
//     'round' (sampled arc) — settable per source vertex.

const EPSILON = 1e-6;

export type CornerStyle = 'miter' | 'round' | 'bevel';

export type OffsetResult = {
  points: [number, number][];
  selfIntersected: boolean;
  miterClampedCount: number;
};

export type OffsetOptions = {
  miterLimit?: number;
  cornerStyles?: CornerStyle[];
  trimSelfIntersections?: boolean;
};

export function offsetPolygon(
  points: [number, number][],
  distanceMM: number,
  miterLimitOrOptions: number | OffsetOptions = 4.0,
): OffsetResult {
  const opts: OffsetOptions =
    typeof miterLimitOrOptions === 'number'
      ? { miterLimit: miterLimitOrOptions }
      : miterLimitOrOptions;
  const miterLimit = opts.miterLimit ?? 4.0;
  const cornerStyles = opts.cornerStyles;
  const trim = opts.trimSelfIntersections ?? false;

  // Normalize input: drop a trailing closing duplicate so we operate on
  // `n` distinct vertices. The drawing helpers (rectToPoints, etc.) emit
  // first === last for the SVG-friendly closing convention; the editor's
  // closed polylines may or may not, depending on origin.
  const verts = stripClosingDuplicate(points);
  const n = verts.length;
  if (n < 3 || !Number.isFinite(distanceMM) || distanceMM === 0) {
    return { points: verts.slice(), selfIntersected: false, miterClampedCount: 0 };
  }

  // Winding-aware outward normal sign. Shoelace > 0 = CCW = outward is
  // right-of-forward = (dy, -dx). CW flips. For positive `distanceMM`
  // the API contract is "expand", so we keep the math in CCW frame and
  // mirror the *effective* offset direction by flipping the sign on a
  // CW input.
  const area = signedArea(verts);
  const ccw = area > 0;

  // Pre-compute outward unit normals for each edge i → i+1 (mod n).
  const edgeNormals: [number, number][] = computeEdgeNormals(verts, ccw, true);

  let miterClampedCount = 0;
  const out: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const p = verts[i];
    const nIn = edgeNormals[(i - 1 + n) % n];
    const nOut = edgeNormals[i];
    const style: CornerStyle = cornerStyles?.[i] ?? 'miter';
    const result = emitCorner(p, nIn, nOut, distanceMM, miterLimit, style);
    if (result.clamped) miterClampedCount += 1;
    for (const pt of result.points) out.push(pt);
  }

  let trimmed = out;
  let selfIntersected = polylineSelfIntersects(out, true);
  if (trim && selfIntersected) {
    trimmed = trimSelfIntersections(out, true);
    selfIntersected = polylineSelfIntersects(trimmed, true);
  }
  return { points: trimmed, selfIntersected, miterClampedCount };
}

// offsetOpenPolyline — parallel offset for an open polyline. Butt caps at
// each endpoint (no closing arc, no extension): the first/last output
// vertex is the source endpoint translated perpendicularly to the
// adjoining segment by `distanceMM`. Interior vertices use the same
// angle-bisector / miter-clamp / per-corner style logic as offsetPolygon.
//
// Sign convention matches offsetPolygon: positive `distanceMM` offsets
// to the right of forward (CCW outward). The caller handles the ±half
// pair to produce two parallel runs.
export function offsetOpenPolyline(
  points: [number, number][],
  distanceMM: number,
  miterLimitOrOptions: number | OffsetOptions = 4.0,
): OffsetResult {
  const opts: OffsetOptions =
    typeof miterLimitOrOptions === 'number'
      ? { miterLimit: miterLimitOrOptions }
      : miterLimitOrOptions;
  const miterLimit = opts.miterLimit ?? 4.0;
  const cornerStyles = opts.cornerStyles;
  const trim = opts.trimSelfIntersections ?? false;

  const verts = points.slice();
  const n = verts.length;
  if (n < 2 || !Number.isFinite(distanceMM) || distanceMM === 0) {
    return { points: verts.slice(), selfIntersected: false, miterClampedCount: 0 };
  }

  // For an open polyline we always work in the polyline's natural
  // forward direction — there's no winding to detect. Right-of-forward
  // is (dy, -dx); positive distance offsets to that side.
  const edgeNormals = computeEdgeNormals(verts, true, false);

  let miterClampedCount = 0;
  const out: [number, number][] = [];

  // First endpoint: butt cap perpendicular to the first edge.
  const first = verts[0];
  out.push([
    first[0] + edgeNormals[0][0] * distanceMM,
    first[1] + edgeNormals[0][1] * distanceMM,
  ]);

  // Interior vertices: bisector miter (or per-corner style).
  for (let i = 1; i < n - 1; i++) {
    const p = verts[i];
    const nIn = edgeNormals[i - 1];
    const nOut = edgeNormals[i];
    const style: CornerStyle = cornerStyles?.[i] ?? 'miter';
    const result = emitCorner(p, nIn, nOut, distanceMM, miterLimit, style);
    if (result.clamped) miterClampedCount += 1;
    for (const pt of result.points) out.push(pt);
  }

  // Last endpoint: butt cap perpendicular to the last edge.
  const last = verts[n - 1];
  const lastNormal = edgeNormals[n - 2];
  out.push([
    last[0] + lastNormal[0] * distanceMM,
    last[1] + lastNormal[1] * distanceMM,
  ]);

  let trimmed = out;
  let selfIntersected = polylineSelfIntersects(out, false);
  if (trim && selfIntersected) {
    trimmed = trimSelfIntersections(out, false);
    selfIntersected = polylineSelfIntersects(trimmed, false);
  }
  return { points: trimmed, selfIntersected, miterClampedCount };
}

// computeEdgeNormals — outward unit normal for each edge i → i+1.
// `wrapClosed` controls whether we wrap the last edge index; for open
// polylines there are only n-1 edges and the last slot is unused.
function computeEdgeNormals(
  verts: [number, number][],
  ccw: boolean,
  wrapClosed: boolean,
): [number, number][] {
  const n = verts.length;
  const edgeCount = wrapClosed ? n : n - 1;
  const edgeNormals: [number, number][] = new Array(edgeCount);
  for (let i = 0; i < edgeCount; i++) {
    const a = verts[i];
    const b = verts[wrapClosed ? (i + 1) % n : i + 1];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < EPSILON) {
      edgeNormals[i] = i > 0 ? edgeNormals[i - 1] : [0, 1];
      continue;
    }
    const ux = dx / len;
    const uy = dy / len;
    edgeNormals[i] = ccw ? [uy, -ux] : [-uy, ux];
  }
  return edgeNormals;
}

// emitCorner — produce the offset output vertices at a single source
// vertex `p`, given the adjacent edge normals `nIn` and `nOut`. Returns
// 1 vertex for the miter case (or angle ~0 fold) and 2+ for bevel /
// round. `clamped` is true whenever we fell back from miter to a
// multi-vertex emit (so neonize's warning count stays accurate).
function emitCorner(
  p: [number, number],
  nIn: [number, number],
  nOut: [number, number],
  distance: number,
  miterLimit: number,
  style: CornerStyle,
): { points: [number, number][]; clamped: boolean } {
  // Bisector: vector from p into the offset side, halfway between the
  // two adjacent outward normals.
  const bx = nIn[0] + nOut[0];
  const by = nIn[1] + nOut[1];
  const bLen = Math.hypot(bx, by);
  // Pre-computed bevel endpoints (used by bevel and the miter clamp).
  const bevelIn: [number, number] = [p[0] + nIn[0] * distance, p[1] + nIn[1] * distance];
  const bevelOut: [number, number] = [p[0] + nOut[0] * distance, p[1] + nOut[1] * distance];

  if (bLen < EPSILON) {
    // 180° fold. Always emit the two-point bevel — there's no usable
    // bisector. Counts as a clamp regardless of requested style.
    return { points: [bevelIn, bevelOut], clamped: true };
  }

  if (style === 'bevel') {
    return { points: [bevelIn, bevelOut], clamped: true };
  }

  if (style === 'round') {
    // Round join: arc of radius |distance| centered at p, swept from
    // bevelIn to bevelOut through the bisector side. We only need an
    // arc on the "outer" side of the corner (where a miter would have
    // overshot); on the inner side a single shared vertex is correct,
    // but bisector + bevel here give a usable approximation either way.
    const ubx = bx / bLen;
    const uby = by / bLen;
    const halfAngleCos = ubx * nIn[0] + uby * nIn[1];
    const halfAngle = Math.acos(Math.max(-1, Math.min(1, halfAngleCos)));
    const sweepAngle = Math.PI - 2 * halfAngle;
    if (sweepAngle <= 0) {
      // Degenerate / inward corner — nothing to round, just emit a single
      // bisector point (same as the miter case at small angles).
      const safeCos = Math.max(Math.abs(halfAngleCos), EPSILON);
      const miterLen = distance / safeCos;
      return {
        points: [[p[0] + ubx * miterLen, p[1] + uby * miterLen]],
        clamped: false,
      };
    }
    const arcPoints = sampleCornerArc(p, bevelIn, bevelOut, distance, sweepAngle);
    return { points: arcPoints, clamped: true };
  }

  // miter (default)
  const ubx = bx / bLen;
  const uby = by / bLen;
  const halfAngleCos = ubx * nIn[0] + uby * nIn[1];
  const safeCos = Math.max(Math.abs(halfAngleCos), EPSILON);
  const miterLen = distance / safeCos;

  if (Math.abs(miterLen) > miterLimit * Math.abs(distance)) {
    // Bevel clamp.
    return { points: [bevelIn, bevelOut], clamped: true };
  }
  return { points: [[p[0] + ubx * miterLen, p[1] + uby * miterLen]], clamped: false };
}

// sampleCornerArc — sample N points along the circular arc of radius
// |distance| centered at `p`, sweeping the shorter direction from
// `start` to `end`. Sample density ~1 point per 10° of arc, clamped to
// at least 3 and at most 32 samples (the spec asks 5–10; we extend the
// upper bound a bit so 180° folds still look smooth).
function sampleCornerArc(
  p: [number, number],
  start: [number, number],
  end: [number, number],
  distance: number,
  sweepAngle: number,
): [number, number][] {
  const r = Math.abs(distance);
  // Choose the shorter sweep direction.
  const startAngle = Math.atan2(start[1] - p[1], start[0] - p[0]);
  const endAngle = Math.atan2(end[1] - p[1], end[0] - p[0]);
  let delta = endAngle - startAngle;
  // Normalize delta to [-π, π].
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  // If the magnitude doesn't match the requested sweep, prefer the
  // requested sweep magnitude in the same sign direction.
  const sign = delta >= 0 ? 1 : -1;
  const sweep = sign * Math.min(Math.abs(delta), sweepAngle);
  const nSamples = Math.max(3, Math.min(32, Math.ceil(Math.abs(sweep) / (Math.PI / 18))));
  const out: [number, number][] = [];
  for (let i = 0; i <= nSamples; i++) {
    const t = i / nSamples;
    const a = startAngle + sweep * t;
    out.push([p[0] + r * Math.cos(a), p[1] + r * Math.sin(a)]);
  }
  return out;
}

// trimSelfIntersections — heuristic auto-trim. Walks the polyline and,
// for each crossing between non-adjacent edges (i, i+1) and (j, j+1)
// with j > i+1, splices: keeps points[0..i], inserts the intersection
// point, then continues at points[j+1..end]. This drops the loop
// between the two crossing edges. Iterates until no crossings remain
// or `maxIterations` (default 32) prevents pathological inputs from
// looping.
//
// Limitations: figure-8 self-intersections (the polyline crosses itself
// twice in a way that forms two distinct loops) require a global
// treatment we don't do here; the user falls back to the node editor.
// Three-loop / multi-loop pathologies are even more complex and remain
// V1 follow-up work.
export function trimSelfIntersections(
  points: [number, number][],
  closed: boolean,
  maxIterations: number = 32,
): [number, number][] {
  let cur = points.slice();
  for (let iter = 0; iter < maxIterations; iter++) {
    const cross = findFirstSelfCrossing(cur, closed);
    if (!cross) return cur;
    const { i, j, point } = cross;
    // Splice: keep [0..i], insert intersection, then continue from j+1.
    // For a closed polyline, we keep both arcs — the dropped arc is the
    // one between i+1 and j (inclusive). For an open polyline, same:
    // anything strictly between the two crossing edges is the loop.
    const before = cur.slice(0, i + 1);
    const after = cur.slice(j + 1);
    const next: [number, number][] = [...before, point, ...after];
    if (next.length < (closed ? 3 : 2)) return cur; // degenerate, bail
    cur = next;
  }
  return cur;
}

function findFirstSelfCrossing(
  points: [number, number][],
  closed: boolean,
): { i: number; j: number; point: [number, number] } | null {
  const n = points.length;
  if (n < 4) return null;
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a1 = points[i];
    const a2 = points[closed ? (i + 1) % n : i + 1];
    for (let j = i + 2; j < edgeCount; j++) {
      // Skip the wrap-around adjacency for closed polylines.
      if (closed && i === 0 && j === edgeCount - 1) continue;
      const b1 = points[j];
      const b2 = points[closed ? (j + 1) % n : j + 1];
      // Try strict crossing first (returns a clean intersection point).
      // Fall back to the loose check (T-junction / collinear overlap),
      // which is what `polylineSelfIntersects` reports — without this
      // fallback the trim leaves T-junctions in place even though the
      // self-intersected flag still fires.
      const pt = segmentIntersection(a1, a2, b1, b2);
      if (pt) {
        return { i, j, point: pt };
      }
      if (segmentsTouchOrCross(a1, a2, b1, b2)) {
        // T-junction or shared endpoint — splice at the touch point.
        // Use the loose intersection point (the parametric formula
        // still computes a sensible point even at t==0 / t==1).
        const touchPt = looseIntersectionPoint(a1, a2, b1, b2);
        if (touchPt) return { i, j, point: touchPt };
      }
    }
  }
  return null;
}

// segmentIntersection — strict-crossing intersection point or null. Uses
// the parametric form: returns the (x, y) where the two segments cross
// when 0 < t < 1 and 0 < u < 1 (open intervals so shared endpoints don't
// count as crossings). Parallel/collinear segments return null.
export function segmentIntersection(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): [number, number] | null {
  const denom = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(denom) < EPSILON) return null;
  const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denom;
  const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denom;
  if (t > EPSILON && t < 1 - EPSILON && u > EPSILON && u < 1 - EPSILON) {
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  }
  return null;
}

// segmentsTouchOrCross — the loose check that `polylineSelfIntersects`
// runs. Returns true when the segments cross, T-junction, or share a
// non-endpoint touch.
function segmentsTouchOrCross(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  return segmentsIntersect(p1, p2, p3, p4);
}

// looseIntersectionPoint — for a non-strict touch (T-junction or shared
// endpoint), pick a representative point on the touch. For collinear
// overlaps we just use p1 of segment B (a point on segment A by the
// onSegment guarantee) — good enough for the trim heuristic.
function looseIntersectionPoint(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): [number, number] | null {
  // Try the parametric form with closed intervals.
  const denom = (b[0] - a[0]) * (d[1] - c[1]) - (b[1] - a[1]) * (d[0] - c[0]);
  if (Math.abs(denom) >= EPSILON) {
    const t = ((c[0] - a[0]) * (d[1] - c[1]) - (c[1] - a[1]) * (d[0] - c[0])) / denom;
    const u = ((c[0] - a[0]) * (b[1] - a[1]) - (c[1] - a[1]) * (b[0] - a[0])) / denom;
    if (t >= -EPSILON && t <= 1 + EPSILON && u >= -EPSILON && u <= 1 + EPSILON) {
      return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
    }
  }
  // Collinear / parallel — pick the endpoint of B that lands on A.
  if (orient(a, b, c) === 0 && onSegment(a, b, c)) return c;
  if (orient(a, b, d) === 0 && onSegment(a, b, d)) return d;
  if (orient(c, d, a) === 0 && onSegment(c, d, a)) return a;
  if (orient(c, d, b) === 0 && onSegment(c, d, b)) return b;
  return null;
}

// signedArea — shoelace; >0 = CCW, <0 = CW. Doesn't care whether the
// closing duplicate is present (the `(i+1) % n` wrap handles either).
export function signedArea(points: [number, number][]): number {
  const n = points.length;
  if (n < 3) return 0;
  let a = 0;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

// stripClosingDuplicate — if the polyline ends with (within EPSILON) the
// same vertex it began with, drop the trailing copy so we operate on
// distinct vertices only.
function stripClosingDuplicate(points: [number, number][]): [number, number][] {
  if (points.length < 2) return points.slice();
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.hypot(last[0] - first[0], last[1] - first[1]) < EPSILON) {
    return points.slice(0, -1);
  }
  return points.slice();
}

// polylineSelfIntersects — O(n²) check across every pair of non-adjacent
// edges. `closed` controls whether we wrap the final edge to vertex 0.
// Adequate for hand-drawn / vectorized neon outlines, which rarely
// exceed a few hundred vertices.
function polylineSelfIntersects(points: [number, number][], closed: boolean): boolean {
  const n = points.length;
  if (n < 4) return false;
  const edgeCount = closed ? n : n - 1;
  for (let i = 0; i < edgeCount; i++) {
    const a1 = points[i];
    const a2 = points[closed ? (i + 1) % n : i + 1];
    for (let j = i + 2; j < edgeCount; j++) {
      if (closed && i === 0 && j === edgeCount - 1) continue;
      const b1 = points[j];
      const b2 = points[closed ? (j + 1) % n : j + 1];
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

// segmentsIntersect — segment intersection that catches both proper
// crossings AND T-junctions where one endpoint lands mid-edge of the
// other. T-junctions are common in degraded inset offsets (the polyline
// pinches through a thin neck and an inset endpoint coincides with a
// mid-edge of the opposite wall) — they're a self-intersection signal
// for our purposes even though strict-crossing tests would miss them.
//
// Pure shared-endpoint touching between non-adjacent edges (which only
// happens in genuine self-overlap) also counts.
function segmentsIntersect(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  p4: [number, number],
): boolean {
  const d1 = orient(p3, p4, p1);
  const d2 = orient(p3, p4, p2);
  const d3 = orient(p1, p2, p3);
  const d4 = orient(p1, p2, p4);
  // Proper crossing: each segment has its endpoints on opposite sides
  // of the other's line.
  if (
    ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
    ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))
  ) {
    return true;
  }
  // Collinear-on-segment cases (T-junction or endpoint-on-edge):
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

// onSegment — returns true if point q lies on segment p-r (assumes
// collinear; checks bounding-box containment).
function onSegment(
  p: [number, number],
  r: [number, number],
  q: [number, number],
): boolean {
  return (
    q[0] >= Math.min(p[0], r[0]) - EPSILON &&
    q[0] <= Math.max(p[0], r[0]) + EPSILON &&
    q[1] >= Math.min(p[1], r[1]) - EPSILON &&
    q[1] <= Math.max(p[1], r[1]) + EPSILON
  );
}

function orient(
  a: [number, number],
  b: [number, number],
  c: [number, number],
): number {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}
