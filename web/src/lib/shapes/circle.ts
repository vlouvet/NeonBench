// circleToPoints approximates a circle of the given radius around (cx,cy)
// with `segments` line segments. The last point is forced equal to the first
// so the polyline reads as closed under the "first === last" convention
// shared by rectToPoints and the rest of the closed-run code.
//
// 64 segments is the editor default: at a 100mm radius that gives a chord
// error of r * (1 - cos(π/segments)) ≈ 0.12mm, well below printer
// resolution and validation tolerance.
export function circleToPoints(
  cx: number,
  cy: number,
  radius: number,
  segments = 64,
): [number, number][] {
  const n = Math.max(3, Math.floor(segments));
  const r = Math.max(0, radius);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  // Close the loop with an exact copy of the first point so first === last.
  out.push([out[0][0], out[0][1]]);
  return out;
}
