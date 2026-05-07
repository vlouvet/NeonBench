// threePointArcToPoints walks the unique circular arc passing through p1,
// p2, p3 in that order, sampling it with a chord step of roughly
// chordTargetMM millimeters. Returned polyline starts at p1, ends at p3, and
// is open (no first===last duplicate). Returns at least 8 segments to keep
// short arcs visibly curved.
//
// Falls back to a straight 2-point line [p1, p3] if the three points are
// (nearly) collinear — the circumscribed circle is undefined in that case
// and any solver based on it would explode the radius.
export function threePointArcToPoints(
  p1: [number, number],
  p2: [number, number],
  p3: [number, number],
  chordTargetMM = 3,
): [number, number][] {
  const collinearTol = 0.01; // mm, the area-of-triangle threshold below which we treat the three points as a straight line
  const ax = p2[0] - p1[0];
  const ay = p2[1] - p1[1];
  const bx = p3[0] - p1[0];
  const by = p3[1] - p1[1];
  const cross = ax * by - ay * bx;
  if (Math.abs(cross) < collinearTol) {
    return [p1, p3];
  }

  // Circumscribed circle through p1, p2, p3. Standard derivation from the
  // perpendicular-bisector intersection, expressed via the cross-product
  // form so we don't slip on degenerate orderings.
  const d = 2 * cross;
  const a2 = p1[0] * p1[0] + p1[1] * p1[1];
  const b2 = p2[0] * p2[0] + p2[1] * p2[1];
  const c2 = p3[0] * p3[0] + p3[1] * p3[1];
  const ux = (a2 * (p2[1] - p3[1]) + b2 * (p3[1] - p1[1]) + c2 * (p1[1] - p2[1])) / d;
  const uy = (a2 * (p3[0] - p2[0]) + b2 * (p1[0] - p3[0]) + c2 * (p2[0] - p1[0])) / d;
  const cx = ux;
  const cy = uy;
  const r = Math.hypot(p1[0] - cx, p1[1] - cy);

  const a1 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const aMid = Math.atan2(p2[1] - cy, p2[0] - cx);
  const a3 = Math.atan2(p3[1] - cy, p3[0] - cx);

  // Choose sweep direction (CW or CCW) so that p2 lies between p1 and p3
  // along the swept arc. We try both candidates and pick whichever is
  // shorter while still containing the mid point's angle.
  const sweep = chooseSweep(a1, aMid, a3);

  const arcLen = Math.abs(sweep) * r;
  const segs = Math.max(8, Math.ceil(arcLen / Math.max(0.1, chordTargetMM)));

  const out: [number, number][] = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const a = a1 + sweep * t;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  // Snap exact endpoints — the user clicked these positions and any drift
  // from numerical error is visible.
  out[0] = [p1[0], p1[1]];
  out[out.length - 1] = [p3[0], p3[1]];
  return out;
}

// chooseSweep returns the signed angular sweep from a1 to a3 that passes
// through aMid. Both candidate sweeps (CCW and CW) are considered; we pick
// whichever actually contains the mid-point angle.
function chooseSweep(a1: number, aMid: number, a3: number): number {
  // Normalize an angle delta into (-π, π] so direction is preserved.
  const norm = (x: number) => {
    while (x > Math.PI) x -= 2 * Math.PI;
    while (x <= -Math.PI) x += 2 * Math.PI;
    return x;
  };
  const dMid = norm(aMid - a1);
  const dEnd = norm(a3 - a1);
  // If aMid lies on the same side as a3 (same sign and |dMid| <= |dEnd|),
  // the short sweep going dEnd's direction works. Otherwise we need the
  // long way around.
  if (dEnd === 0) return 0;
  const sameSide = dMid * dEnd >= 0 && Math.abs(dMid) <= Math.abs(dEnd);
  if (sameSide) {
    return dEnd;
  }
  // Long way around: go in the opposite direction by 2π - |dEnd|.
  const sign = dEnd > 0 ? -1 : 1;
  return sign * (2 * Math.PI - Math.abs(dEnd));
}
