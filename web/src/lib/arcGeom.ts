// Circular-arc geometry for Tier 3 #78 segments — the TypeScript twin of
// internal/designdoc/arc.go.
//
// The two implementations MUST agree: the editor draws from this file while
// the printed pattern, the DXF and the validator all derive from the Go one,
// and an operator who sees one curve on screen and gets another on the bench
// has been lied to. arcGeom.test.ts pins the same constants the Go tests pin
// (radius 0.625 x chord, length 1.15911 x chord, sagitta chord/4), so a change
// to one without the other fails.

import type { DesignRun, SegmentKind } from '../api';

export type { SegmentKind };

// The arc's sagitta as a fraction of half its chord — AutoCAD's "bulge".
// Everything else falls out of this one number. See the Go file for why a
// circle rather than a bezier.
export const ARC_BULGE = 0.5;

// Included angle: 4*atan(bulge). ~106.26 degrees at bulge 0.5.
export const ARC_INCLUDED_ANGLE = 4 * Math.atan(ARC_BULGE);

export type Arc = {
  cx: number;
  cy: number;
  radiusMM: number;
  startAngle: number;
  endAngle: number;
  lengthMM: number;
};

// isArcKind / arcKindFlipped / flipArcKind are the TS twins of IsArcType,
// ArcFlipped and FlipArcType. Ask these rather than comparing against 'arc':
// a bare `=== 'arc'` silently straightens every flipped segment, which is the
// exact shape of the bug this schema exists to end.
export function isArcKind(t: SegmentKind): boolean {
  return t === 'arc' || t === 'arc_r';
}

export function arcKindFlipped(t: SegmentKind): boolean {
  return t === 'arc_r';
}

// flipArcKind moves the bow to the other side of the chord. A line has no
// side and comes back unchanged.
//
// This is what every point-order reversal owes each of its arcs: travelling a
// chord backwards flips which side is "left", so the stored side must flip to
// keep the glass where it was.
export function flipArcKind(t: SegmentKind): SegmentKind {
  if (t === 'arc') return 'arc_r';
  if (t === 'arc_r') return 'arc';
  return 'line';
}

// arcFor returns the circle through p0 and p1 that bows out by ARC_BULGE.
// `flipped` false bows toward the chord direction rotated to (-dy, dx) — the
// left of travel, which is what 'arc' has always meant; true is the mirror of
// that about the chord. Returns null for a degenerate chord, where the caller
// should treat the segment as a line.
export function arcFor(
  p0: [number, number],
  p1: [number, number],
  flipped: boolean,
): Arc | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (!(chord > 0)) return null;
  const theta = ARC_INCLUDED_ANGLE;
  const radiusMM = chord / (2 * Math.sin(theta / 2));
  const s = flipped ? -1 : 1;
  const nx = (s * -dy) / chord;
  const ny = (s * dx) / chord;
  const mx = (p0[0] + p1[0]) / 2;
  const my = (p0[1] + p1[1]) / 2;
  const d = radiusMM * Math.cos(theta / 2);
  const cx = mx - d * nx;
  const cy = my - d * ny;
  return {
    cx,
    cy,
    radiusMM,
    startAngle: Math.atan2(p0[1] - cy, p0[0] - cx),
    endAngle: Math.atan2(p1[1] - cy, p1[0] - cx),
    lengthMM: radiusMM * theta,
  };
}

// segmentLengthMM measures one segment by its type. The two arc sides measure
// identically — flipping a bow moves glass, it does not add or remove any — so
// no takeoff, estimate or validation number moves when a flip happens.
export function segmentLengthMM(
  p0: [number, number],
  p1: [number, number],
  segType: SegmentKind,
): number {
  if (!isArcKind(segType)) return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const a = arcFor(p0, p1, arcKindFlipped(segType));
  return a ? a.lengthMM : 0;
}

// segmentTypeAt is the type of the segment LEAVING vertex i. Out-of-range and
// a missing array both answer 'line', which is what makes the field omittable.
export function segmentTypeAt(run: DesignRun, i: number): SegmentKind {
  const st = run.polyline.segment_types;
  if (!st || i < 0 || i >= st.length) return 'line';
  return st[i] === 'arc' || st[i] === 'arc_r' ? st[i] : 'line';
}

export function runHasArcs(run: DesignRun): boolean {
  return !!run.polyline.segment_types?.some((t) => isArcKind(t));
}

// segmentCount is what a segment_types array must be as long as: one per gap,
// plus the closing segment when the run is closed.
export function segmentCount(run: DesignRun): number {
  const n = run.polyline.points.length;
  if (n < 2) return 0;
  return run.polyline.closed ? n : n - 1;
}

// segmentIndexBetween resolves which segment joins two adjacent walk
// positions, and whether the walk crosses it backwards. Mirrors the Go
// function of the same name — a walk can run either way around a closed run,
// and an arc traversed backwards is the same circle with the sweep flipped.
export function segmentIndexBetween(
  a: number,
  b: number,
  n: number,
  closed: boolean,
): { seg: number; reversed: boolean } | null {
  if (n < 2) return null;
  if (b === a + 1) return { seg: a, reversed: false };
  if (b === a - 1) return { seg: b, reversed: true };
  if (closed && a === n - 1 && b === 0) return { seg: a, reversed: false };
  if (closed && a === 0 && b === n - 1) return { seg: b, reversed: true };
  return null;
}

const ARC_CUBIC_PIECES = 2;

export type Cubic = {
  c1x: number; c1y: number;
  c2x: number; c2y: number;
  x: number; y: number;
};

// arcCubics expresses the arc from p0 to p1 as cubic Beziers — the same two
// pieces the Go writer emits, so the on-screen curve and the printed one are
// the same geometry rather than two approximations that happen to look alike.
//
// `reversed` is a WALK direction, not a side: segType alone decides which way
// the bow falls, and a walk that crosses a flipped arc backwards still traces
// the same glass.
export function arcCubics(
  p0: [number, number],
  p1: [number, number],
  segType: SegmentKind,
  reversed: boolean,
): Cubic[] {
  if (!isArcKind(segType)) return [];
  const a = arcFor(p0, p1, arcKindFlipped(segType));
  if (!a) return [];
  let start = a.startAngle;
  let end = a.endAngle;
  if (reversed) [start, end] = [end, start];
  let sweep = end - start;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  const phi = sweep / ARC_CUBIC_PIECES;
  const k = (4 / 3) * Math.tan(phi / 4) * a.radiusMM;
  const out: Cubic[] = [];
  for (let i = 0; i < ARC_CUBIC_PIECES; i++) {
    const a0 = start + phi * i;
    const a1 = a0 + phi;
    const p0x = a.cx + a.radiusMM * Math.cos(a0);
    const p0y = a.cy + a.radiusMM * Math.sin(a0);
    const p3x = a.cx + a.radiusMM * Math.cos(a1);
    const p3y = a.cy + a.radiusMM * Math.sin(a1);
    out.push({
      c1x: p0x - k * Math.sin(a0), c1y: p0y + k * Math.cos(a0),
      c2x: p3x + k * Math.sin(a1), c2y: p3y - k * Math.cos(a1),
      x: p3x, y: p3y,
    });
  }
  const tgt = reversed ? p0 : p1;
  out[out.length - 1].x = tgt[0];
  out[out.length - 1].y = tgt[1];
  return out;
}

// Angular resolution for flattening, matching the Go side: holding the step
// constant holds the sagitta error proportional to the radius.
const ARC_SAMPLE_STEP_RAD = (5 * Math.PI) / 180;

function arcSampleCount(): number {
  return Math.max(8, Math.ceil(ARC_INCLUDED_ANGLE / ARC_SAMPLE_STEP_RAD));
}

// flattenSegment returns the points from p0 to p1 EXCLUDING p0 and including
// p1, so segments concatenate without duplicating vertices.
export function flattenSegment(
  p0: [number, number],
  p1: [number, number],
  segType: SegmentKind,
): [number, number][] {
  if (!isArcKind(segType)) return [p1];
  const a = arcFor(p0, p1, arcKindFlipped(segType));
  if (!a) return [p1];
  const n = arcSampleCount();
  let sweep = a.endAngle - a.startAngle;
  while (sweep <= -Math.PI) sweep += 2 * Math.PI;
  while (sweep > Math.PI) sweep -= 2 * Math.PI;
  const out: [number, number][] = [];
  for (let i = 1; i <= n; i++) {
    const ang = a.startAngle + (sweep * i) / n;
    out.push([a.cx + a.radiusMM * Math.cos(ang), a.cy + a.radiusMM * Math.sin(ang)]);
  }
  out[out.length - 1] = p1;
  return out;
}

// flatRunPoints returns the run as straight segments only. Returns the
// original array when there are no arcs, so the common case costs nothing.
//
// Indices do NOT survive flattening — anything resolving an electrode, bend or
// annotation index must walk polyline.points and consult segmentTypeAt.
export function flatRunPoints(run: DesignRun): [number, number][] {
  const pts = run.polyline.points;
  if (!runHasArcs(run) || pts.length < 2) return pts;
  const out: [number, number][] = [pts[0]];
  for (let i = 0; i < pts.length - 1; i++) {
    out.push(...flattenSegment(pts[i], pts[i + 1], segmentTypeAt(run, i)));
  }
  if (run.polyline.closed) {
    const last = pts.length - 1;
    out.push(...flattenSegment(pts[last], pts[0], segmentTypeAt(run, last)));
  }
  return out;
}

// pointToSegmentDistanceMM is the perpendicular distance from p to the CLOSED
// segment ab — not to the infinite line, so a click past either end measures
// to the nearer endpoint.
function pointToSegmentDistanceMM(
  p: [number, number],
  a: [number, number],
  b: [number, number],
): number {
  const abx = b[0] - a[0];
  const aby = b[1] - a[1];
  const len2 = abx * abx + aby * aby;
  if (!(len2 > 0)) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * abx + (p[1] - a[1]) * aby) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * abx), p[1] - (a[1] + t * aby));
}

// runPathDistanceMM is the distance from a world-space point to the glass the
// run actually draws — Tier 3 #87's curve-aware hit test.
//
// Two things it deliberately does that the old vertex-distance test did not:
//
//   1. It measures to SEGMENTS, not vertices. A click halfway along a 400 mm
//      straight run is 200 mm from either end, which is a miss by any sane
//      tolerance even though the operator was pointing right at the tube.
//   2. It measures to the FLATTENED curve when the run has arcs. An arc at
//      bulge 0.5 bows a quarter of its chord off the chord, so on a strongly
//      curved segment the chord-based answer is wrong by up to chord/4 —
//      worst on exactly the segments that are most obviously curved.
//
// Guarded on runHasArcs so a run with no curves never pays for the flatten.
// Returns Infinity for a run with no points, so callers can compare directly.
export function runPathDistanceMM(run: DesignRun, target: [number, number]): number {
  const hasArcs = runHasArcs(run);
  const pts = hasArcs ? flatRunPoints(run) : run.polyline.points;
  if (pts.length === 0) return Infinity;
  if (pts.length === 1) return Math.hypot(pts[0][0] - target[0], pts[0][1] - target[1]);
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const d = pointToSegmentDistanceMM(target, pts[i], pts[i + 1]);
    if (d < best) best = d;
  }
  // flatRunPoints already walks a closed run's closing segment (and lands back
  // on points[0]), so only the raw-point path still has to close the loop.
  if (run.polyline.closed && !hasArcs) {
    const d = pointToSegmentDistanceMM(target, pts[pts.length - 1], pts[0]);
    if (d < best) best = d;
  }
  return best;
}

// walkSegmentLengthMM is the true glass length between two ADJACENT walk
// positions, honouring an arc crossed in either direction. Non-adjacent
// positions fall back to the straight distance.
export function walkSegmentLengthMM(run: DesignRun, a: number, b: number): number {
  const pts = run.polyline.points;
  const n = pts.length;
  if (a < 0 || b < 0 || a >= n || b >= n) return 0;
  const hit = segmentIndexBetween(a, b, n, !!run.polyline.closed);
  const segType = hit ? segmentTypeAt(run, hit.seg) : 'line';
  return segmentLengthMM(pts[a], pts[b], segType);
}

// segmentTangents returns unit direction vectors for travel along a segment:
// `leaving` at p0 and `arriving` at p1. An arc leaves and rejoins its chord at
// half the included angle, which is why a bend list built from raw chords
// misreports every vertex where an arc meets a line.
export function segmentTangents(
  p0: [number, number],
  p1: [number, number],
  segType: SegmentKind,
): { leaving: [number, number]; arriving: [number, number] } {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const c = Math.hypot(dx, dy);
  if (!(c > 0)) return { leaving: [1, 0], arriving: [1, 0] };
  const ux = dx / c;
  const uy = dy / c;
  if (!isArcKind(segType)) return { leaving: [ux, uy], arriving: [ux, uy] };
  // A flipped arc bows the other way, so its two rotations swap sign.
  const h = arcKindFlipped(segType) ? -ARC_INCLUDED_ANGLE / 2 : ARC_INCLUDED_ANGLE / 2;
  const rot = (x: number, y: number, ang: number): [number, number] => {
    const s = Math.sin(ang);
    const co = Math.cos(ang);
    return [x * co - y * s, x * s + y * co];
  };
  return { leaving: rot(ux, uy, h), arriving: rot(ux, uy, -h) };
}

function walkTangent(run: DesignRun, a: number, b: number, leaving: boolean): [number, number] {
  const pts = run.polyline.points;
  const n = pts.length;
  const hit = segmentIndexBetween(a, b, n, !!run.polyline.closed);
  const segType = hit ? segmentTypeAt(run, hit.seg) : 'line';
  if (!isArcKind(segType) || !hit) {
    const dx = pts[b][0] - pts[a][0];
    const dy = pts[b][1] - pts[a][1];
    const c = Math.hypot(dx, dy);
    if (!(c > 0)) return [1, 0];
    return [dx / c, dy / c];
  }
  const s0 = pts[hit.seg];
  const s1 = pts[(hit.seg + 1) % n];
  let { leaving: lv, arriving: ar } = segmentTangents(s0, s1, segType);
  if (hit.reversed) {
    const nlv: [number, number] = [-ar[0], -ar[1]];
    const nar: [number, number] = [-lv[0], -lv[1]];
    lv = nlv;
    ar = nar;
  }
  return leaving ? lv : ar;
}

// vertexTurnDeg is the SIGNED direction change at a walk vertex, in degrees.
// Callers that threshold on size must take the magnitude — feeding a signed
// value into a magnitude comparison silently drops every right-hand bend,
// which is a bug this codebase has already shipped once.
export function vertexTurnDeg(run: DesignRun, prev: number, at: number, next: number): number {
  const n = run.polyline.points.length;
  if (n < 3) return 0;
  for (const i of [prev, at, next]) if (i < 0 || i >= n) return 0;
  const inDir = walkTangent(run, prev, at, false);
  const outDir = walkTangent(run, at, next, true);
  const ang = Math.atan2(
    inDir[0] * outDir[1] - inDir[1] * outDir[0],
    inDir[0] * outDir[0] + inDir[1] * outDir[1],
  );
  return (ang * 180) / Math.PI;
}

// vertexArcRadiusMM is the radius the glass actually forms at a walk vertex
// when an arc meets it; the tighter side wins. 0 means neither side is an arc
// and the caller should fall back to its three-point circumradius.
export function vertexArcRadiusMM(
  run: DesignRun,
  prev: number,
  at: number,
  next: number,
): number {
  const pts = run.polyline.points;
  const n = pts.length;
  let best = 0;
  const consider = (a: number, b: number) => {
    const hit = segmentIndexBetween(a, b, n, !!run.polyline.closed);
    if (!hit) return;
    const segType = segmentTypeAt(run, hit.seg);
    if (!isArcKind(segType)) return;
    const arc = arcFor(pts[hit.seg], pts[(hit.seg + 1) % n], arcKindFlipped(segType));
    if (!arc) return;
    if (best === 0 || arc.radiusMM < best) best = arc.radiusMM;
  };
  consider(prev, at);
  consider(at, next);
  return best;
}
