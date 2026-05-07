// rectToPoints emits the four axis-aligned corners of the rectangle defined
// by two opposite corners (x1,y1) and (x2,y2), with the first point
// duplicated at the end so the resulting polyline reads as closed under the
// "first === last" convention used by runArcs / ToSVG.
export function rectToPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): [number, number][] {
  const xMin = Math.min(x1, x2);
  const xMax = Math.max(x1, x2);
  const yMin = Math.min(y1, y2);
  const yMax = Math.max(y1, y2);
  return [
    [xMin, yMin],
    [xMax, yMin],
    [xMax, yMax],
    [xMin, yMax],
    [xMin, yMin],
  ];
}
