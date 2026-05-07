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
// V1 limitations (Tier 3 follow-ups):
//   - Self-intersection of the offset polyline is detected and flagged
//     but not repaired. At deep concave vertices an inset offset can
//     "wrap around" and emit a self-overlapping ribbon. The Neonize op
//     surfaces this to the user as a warning; they can node-edit the
//     result.
//   - Round joins (arc bevels) and per-corner cap-style overrides are
//     not implemented — a single `miterLimit` controls the global
//     miter-vs-bevel decision.

const EPSILON = 1e-6;

export type OffsetResult = {
  points: [number, number][];
  selfIntersected: boolean;
  miterClampedCount: number;
};

export function offsetPolygon(
  points: [number, number][],
  distanceMM: number,
  miterLimit: number = 4.0,
): OffsetResult {
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
  const edgeNormals: [number, number][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const a = verts[i];
    const b = verts[(i + 1) % n];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy);
    if (len < EPSILON) {
      // Degenerate zero-length edge — fall back to the previous edge's
      // normal so the bisector at adjacent vertices stays sane. If
      // there's no previous (first edge) leave as a unit vector that
      // won't break normalization downstream.
      edgeNormals[i] = i > 0 ? edgeNormals[i - 1] : [0, 1];
      continue;
    }
    const ux = dx / len;
    const uy = dy / len;
    // Outward normal: right-of-forward for CCW, left-of-forward for CW.
    edgeNormals[i] = ccw ? [uy, -ux] : [-uy, ux];
  }

  let miterClampedCount = 0;
  const out: [number, number][] = [];

  for (let i = 0; i < n; i++) {
    const p = verts[i];
    const nIn = edgeNormals[(i - 1 + n) % n];
    const nOut = edgeNormals[i];

    // Bisector: vector from p into the offset side, halfway between the
    // two adjacent outward normals.
    const bx = nIn[0] + nOut[0];
    const by = nIn[1] + nOut[1];
    const bLen = Math.hypot(bx, by);

    if (bLen < EPSILON) {
      // 180° fold (the polyline doubles back on itself at this vertex).
      // Treat as a bevel: emit two vertices along the two edge normals
      // — same as the miter-clamp branch but unconditional.
      miterClampedCount += 1;
      out.push([p[0] + nIn[0] * distanceMM, p[1] + nIn[1] * distanceMM]);
      out.push([p[0] + nOut[0] * distanceMM, p[1] + nOut[1] * distanceMM]);
      continue;
    }

    const ubx = bx / bLen;
    const uby = by / bLen;
    // dot(bisector, n_in) === cos(half_angle).
    const halfAngleCos = ubx * nIn[0] + uby * nIn[1];
    const safeCos = Math.max(Math.abs(halfAngleCos), EPSILON);
    const miterLen = distanceMM / safeCos;

    if (Math.abs(miterLen) > miterLimit * Math.abs(distanceMM)) {
      // Bevel clamp: emit two vertices instead of a miter spike.
      miterClampedCount += 1;
      out.push([p[0] + nIn[0] * distanceMM, p[1] + nIn[1] * distanceMM]);
      out.push([p[0] + nOut[0] * distanceMM, p[1] + nOut[1] * distanceMM]);
      continue;
    }

    out.push([p[0] + ubx * miterLen, p[1] + uby * miterLen]);
  }

  const selfIntersected = polylineSelfIntersects(out);
  return { points: out, selfIntersected, miterClampedCount };
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
// edges (treating the polyline as closed). Adequate for hand-drawn /
// vectorized neon outlines, which rarely exceed a few hundred vertices.
function polylineSelfIntersects(points: [number, number][]): boolean {
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i++) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    for (let j = i + 2; j < n; j++) {
      // Skip the immediate neighbor pair (edges that share a vertex
      // never count as a self-intersection).
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
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
