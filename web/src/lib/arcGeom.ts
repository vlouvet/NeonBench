// Circular-arc geometry for Tier 3 #78 segments — the TypeScript twin of
// internal/designdoc/arc.go.
//
// The two implementations MUST agree: the editor draws from this file while
// the printed pattern, the DXF and the validator all derive from the Go one,
// and an operator who sees one curve on screen and gets another on the bench
// has been lied to. arcGeom.test.ts pins the same constants the Go tests pin
// (radius 0.625 x chord, length 1.15911 x chord, sagitta chord/4), so a change
// to one without the other fails.

import type { DesignRun } from '../api';

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

// arcFor returns the circle through p0 and p1 that bows out by ARC_BULGE,
// toward the chord direction rotated to (-dy, dx). Returns null for a
// degenerate chord, where the caller should treat the segment as a line.
export function arcFor(p0: [number, number], p1: [number, number]): Arc | null {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const chord = Math.hypot(dx, dy);
  if (!(chord > 0)) return null;
  const theta = ARC_INCLUDED_ANGLE;
  const radiusMM = chord / (2 * Math.sin(theta / 2));
  const nx = -dy / chord;
  const ny = dx / chord;
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

export function segmentLengthMM(
  p0: [number, number],
  p1: [number, number],
  isArc: boolean,
): number {
  if (!isArc) return Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const a = arcFor(p0, p1);
  return a ? a.lengthMM : 0;
}

// segmentTypeAt is the type of the segment LEAVING vertex i. Out-of-range and
// a missing array both answer 'line', which is what makes the field omittable.
export function segmentTypeAt(run: DesignRun, i: number): 'line' | 'arc' {
  const st = run.polyline.segment_types;
  if (!st || i < 0 || i >= st.length) return 'line';
  return st[i] === 'arc' ? 'arc' : 'line';
}

export function runHasArcs(run: DesignRun): boolean {
  return !!run.polyline.segment_types?.some((t) => t === 'arc');
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
export function arcCubics(
  p0: [number, number],
  p1: [number, number],
  reversed: boolean,
): Cubic[] {
  const a = arcFor(p0, p1);
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
  isArc: boolean,
): [number, number][] {
  if (!isArc) return [p1];
  const a = arcFor(p0, p1);
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
    out.push(...flattenSegment(pts[i], pts[i + 1], segmentTypeAt(run, i) === 'arc'));
  }
  if (run.polyline.closed) {
    const last = pts.length - 1;
    out.push(...flattenSegment(pts[last], pts[0], segmentTypeAt(run, last) === 'arc'));
  }
  return out;
}

// walkSegmentLengthMM is the true glass length between two ADJACENT walk
// positions, honouring an arc crossed in either direction. Non-adjacent
// positions fall back to the straight distance.
export function walkSegmentLengthMM(run: DesignRun, a: number, b: number): number {
  const pts = run.polyline.points;
  const n = pts.length;
  if (a < 0 || b < 0 || a >= n || b >= n) return 0;
  const hit = segmentIndexBetween(a, b, n, !!run.polyline.closed);
  const isArc = !!hit && segmentTypeAt(run, hit.seg) === 'arc';
  return segmentLengthMM(pts[a], pts[b], isArc);
}

// segmentTangents returns unit direction vectors for travel along a segment:
// `leaving` at p0 and `arriving` at p1. An arc leaves and rejoins its chord at
// half the included angle, which is why a bend list built from raw chords
// misreports every vertex where an arc meets a line.
export function segmentTangents(
  p0: [number, number],
  p1: [number, number],
  isArc: boolean,
): { leaving: [number, number]; arriving: [number, number] } {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const c = Math.hypot(dx, dy);
  if (!(c > 0)) return { leaving: [1, 0], arriving: [1, 0] };
  const ux = dx / c;
  const uy = dy / c;
  if (!isArc) return { leaving: [ux, uy], arriving: [ux, uy] };
  const h = ARC_INCLUDED_ANGLE / 2;
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
  const isArc = !!hit && segmentTypeAt(run, hit.seg) === 'arc';
  if (!isArc || !hit) {
    const dx = pts[b][0] - pts[a][0];
    const dy = pts[b][1] - pts[a][1];
    const c = Math.hypot(dx, dy);
    if (!(c > 0)) return [1, 0];
    return [dx / c, dy / c];
  }
  const s0 = pts[hit.seg];
  const s1 = pts[(hit.seg + 1) % n];
  let { leaving: lv, arriving: ar } = segmentTangents(s0, s1, true);
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
    if (!hit || segmentTypeAt(run, hit.seg) !== 'arc') return;
    const arc = arcFor(pts[hit.seg], pts[(hit.seg + 1) % n]);
    if (!arc) return;
    if (best === 0 || arc.radiusMM < best) best = arc.radiusMM;
  };
  consider(prev, at);
  consider(at, next);
  return best;
}
