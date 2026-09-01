// Glyph outline → closed millimetre contours.
//
// This is the halfway point of the OpenType pipeline:
//
//   font file → opentype.js → glyph.path.commands  (font units, y-UP)
//                                    ↓  THIS FILE
//                             closed polylines     (millimetres, y-DOWN)
//                                    ↓  text.ts
//                             DesignRun[]          → Neonize / face flag
//
// Three things happen here, in this order, and the order is load-bearing.
//
// 1. TRANSFORM FIRST, FLATTEN SECOND. The chord tolerance is in
//    millimetres (see flatten.ts), so the control points have to be in
//    millimetres before they reach the flattener. Every face measured on
//    this machine is 2048 units/em, so flattening in font units would
//    treat 0.25 as 0.25 *units* — roughly 0.012 mm on a 100 mm cap, a
//    ~20x over-sample that turns one letter into tens of thousands of
//    vertices the node editor cannot be used on.
//
// 2. Y IS FLIPPED. OpenType font units put +y UP from the baseline; the
//    design doc (like SVG, like `hershey/text.ts`) puts +y DOWN. So
//    `Y = baselineYMM - fy * scale`. The flip negates every contour's
//    signed area, which is fine because it negates ALL of them — the
//    RELATIVE handedness of an outer contour and its counter is what
//    carries the hole information, and that survives.
//
// 3. WINDING IS PRESERVED, NEVER NORMALISED. An 'o' is two contours with
//    opposite winding: that is how a filled-outline renderer knows the
//    inner one is a hole, and `signedArea` (shapes/offset.ts) is how the
//    rest of this codebase asks the question. We emit the font's own
//    vertex order and let the sign fall where it falls.
//
//    `role` is computed SEPARATELY, by even-odd nesting depth rather than
//    by winding sign, because winding alone is a claim the font makes and
//    nesting is a fact about the geometry. A face that draws every
//    contour the same way (they exist; they render wrong everywhere) still
//    gets its counters labelled correctly, and `windingAgreesWithNesting`
//    reports the disagreement instead of hiding it.
//
// Not handled, on purpose: contours that genuinely intersect each other.
// Glyph outlines in a well-formed font do not — overlapping components
// are the exception ("Weld" / Tier 2 #98 is the task that owns them).

import {
  DEFAULT_CHORD_TOLERANCE_MM,
  flattenCubic,
  flattenQuadratic,
  type Pt,
} from './flatten';
import { signedArea } from '../shapes/offset';
import type { PathCommand } from 'opentype.js';

/** Two contours are "the same point" below this separation, in mm.
 *  1 nm — far below anything a font expresses, far above float noise.
 *  Dropping coincident vertices matters downstream: a zero-length
 *  segment divides by zero in the bend-radius validator. */
const POINT_EPSILON_MM = 1e-6;

/** Smallest chord tolerance we will honour, in mm. Below this the
 *  subdivision depth explodes for no visible gain — a 0.001 mm faceting
 *  error is 300x finer than the bender can hold. Guards the UI's number
 *  input as much as the maths. */
export const MIN_CHORD_TOLERANCE_MM = 0.01;

export type ContourRole = 'outer' | 'counter';

export type Contour = {
  /** Closed polyline in millimetres, y-down, with `first === last` — the
   *  convention `rectToPoints` / `circleToPoints` already use. */
  points: Pt[];
  /** Shoelace area of the emitted points. Sign is the font's own winding
   *  after the y-flip; magnitude is mm². */
  areaSigned: number;
  /** `outer` at even nesting depth, `counter` at odd. An 'o' is one of
   *  each; a '%' is one outer and two counters; an 'i' is two outers. */
  role: ContourRole;
  /** How many other contours of the same glyph enclose this one. */
  nestingDepth: number;
};

/** Placement of one glyph, in the terms this module needs: how big a font
 *  unit is, where the glyph's origin sits, and where its baseline sits. */
export type GlyphPlacement = {
  /** Millimetres per font unit — `mmPerUnit(capHeightInfo, capHeightMM)`. */
  scale: number;
  /** Millimetre X that font-unit x = 0 maps to (the pen position). */
  originXMM: number;
  /** Millimetre Y that font-unit y = 0 maps to (the baseline). */
  baselineYMM: number;
};

export type ContourResult = {
  contours: Contour[];
  /** Contours dropped for having fewer than three distinct vertices.
   *  Usually a stray `M`/`Z` pair in a sloppy face; counted rather than
   *  silently swallowed. */
  degenerateDropped: number;
  /** False when at least one counter shares its winding sign with its
   *  parent. The outlines are still emitted and still correctly ROLED —
   *  this is a "your font is unusual" signal for the UI. */
  windingAgreesWithNesting: boolean;
};

function tx(p: GlyphPlacement, fx: number, fy: number): Pt {
  return [p.originXMM + fx * p.scale, p.baselineYMM - fy * p.scale];
}

function pushDistinct(out: Pt[], pt: Pt): void {
  const last = out[out.length - 1];
  if (last && Math.hypot(pt[0] - last[0], pt[1] - last[1]) < POINT_EPSILON_MM) return;
  out.push(pt);
}

/**
 * Walk one glyph's path commands and emit raw closed contours in
 * millimetres. No classification — see {@link classifyContours}.
 *
 * `Z` closes the current contour back to the most recent `M`, which is
 * the OpenType semantic. A contour left open at the end of the command
 * list (fonts do ship these) is closed anyway rather than dropped.
 */
export function contoursFromCommands(
  commands: readonly PathCommand[],
  placement: GlyphPlacement,
  toleranceMM: number = DEFAULT_CHORD_TOLERANCE_MM,
): Pt[][] {
  const tol = Math.max(
    MIN_CHORD_TOLERANCE_MM,
    Number.isFinite(toleranceMM) && toleranceMM > 0
      ? toleranceMM
      : DEFAULT_CHORD_TOLERANCE_MM,
  );

  const out: Pt[][] = [];
  let current: Pt[] | null = null;

  function finish(): void {
    if (!current) return;
    // Drop a trailing vertex that coincides with the first, then re-add
    // an exact copy so the closing duplicate is bit-identical rather
    // than merely close. Downstream code compares with ===-ish tests.
    while (
      current.length > 1 &&
      Math.hypot(
        current[current.length - 1][0] - current[0][0],
        current[current.length - 1][1] - current[0][1],
      ) < POINT_EPSILON_MM
    ) {
      current.pop();
    }
    if (current.length >= 2) {
      current.push([current[0][0], current[0][1]]);
      out.push(current);
    } else {
      out.push(current);
    }
    current = null;
  }

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        finish();
        current = [tx(placement, cmd.x, cmd.y)];
        break;
      case 'L':
        if (!current) current = [];
        pushDistinct(current, tx(placement, cmd.x, cmd.y));
        break;
      case 'Q': {
        if (!current || current.length === 0) {
          // A curve with no starting point is malformed; anchor it at
          // the control point rather than throwing away the glyph.
          current = [tx(placement, cmd.x1, cmd.y1)];
        }
        const p0 = current[current.length - 1];
        const pts = flattenQuadratic(
          p0,
          tx(placement, cmd.x1, cmd.y1),
          tx(placement, cmd.x, cmd.y),
          tol,
        );
        for (const pt of pts) pushDistinct(current, pt);
        break;
      }
      case 'C': {
        if (!current || current.length === 0) {
          current = [tx(placement, cmd.x1, cmd.y1)];
        }
        const p0 = current[current.length - 1];
        const pts = flattenCubic(
          p0,
          tx(placement, cmd.x1, cmd.y1),
          tx(placement, cmd.x2, cmd.y2),
          tx(placement, cmd.x, cmd.y),
          tol,
        );
        for (const pt of pts) pushDistinct(current, pt);
        break;
      }
      case 'Z':
        finish();
        break;
    }
  }
  finish();
  return out;
}

/**
 * Point-in-polygon by ray casting. `poly` may or may not carry a closing
 * duplicate — the `(i+1) % n` wrap covers both, matching `signedArea`.
 */
export function pointInPolygon(pt: Pt, poly: Pt[]): boolean {
  const n = poly.length;
  if (n < 3) return false;
  let inside = false;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > pt[1] !== yj > pt[1]) {
      const xCross = xi + ((pt[1] - yi) * (xj - xi)) / (yj - yi);
      if (pt[0] < xCross) inside = !inside;
    }
  }
  return inside;
}

/**
 * Label each contour outer / counter by even-odd nesting depth.
 *
 * The containment test samples three vertices of the candidate contour
 * and takes the majority verdict. One vertex would be enough for truly
 * disjoint contours, but real faces occasionally have contours that
 * touch at a single point (a tight 'e' aperture), and a sample landing
 * exactly on the boundary makes the ray cast a coin flip. Three samples
 * make that a tie-break instead of a wrong answer.
 */
export function classifyContours(raw: Pt[][]): ContourResult {
  const kept: Pt[][] = [];
  let degenerateDropped = 0;
  for (const c of raw) {
    // Distinct-vertex count: the closing duplicate does not add a corner.
    const distinct = c.length >= 2 &&
      Math.hypot(c[c.length - 1][0] - c[0][0], c[c.length - 1][1] - c[0][1]) <
        POINT_EPSILON_MM
      ? c.length - 1
      : c.length;
    if (distinct < 3) {
      degenerateDropped += 1;
      continue;
    }
    kept.push(c);
  }

  const contours: Contour[] = kept.map((points) => ({
    points,
    areaSigned: signedArea(points),
    role: 'outer' as ContourRole,
    nestingDepth: 0,
  }));

  for (let i = 0; i < contours.length; i++) {
    const samples = sampleVertices(contours[i].points);
    let depth = 0;
    for (let j = 0; j < contours.length; j++) {
      if (i === j) continue;
      // A contour can only be inside a strictly larger one; the area
      // guard keeps a degenerate ray cast from nesting a shape inside
      // its own sibling.
      if (Math.abs(contours[j].areaSigned) <= Math.abs(contours[i].areaSigned)) continue;
      let votes = 0;
      for (const s of samples) if (pointInPolygon(s, contours[j].points)) votes += 1;
      if (votes * 2 > samples.length) depth += 1;
    }
    contours[i].nestingDepth = depth;
    contours[i].role = depth % 2 === 0 ? 'outer' : 'counter';
  }

  // A well-formed face alternates winding with nesting depth. Report
  // rather than repair: the outlines are the operator's font, not ours.
  let windingAgreesWithNesting = true;
  const outerSigns = contours
    .filter((c) => c.role === 'outer')
    .map((c) => Math.sign(c.areaSigned));
  const counterSigns = contours
    .filter((c) => c.role === 'counter')
    .map((c) => Math.sign(c.areaSigned));
  if (outerSigns.length > 0 && counterSigns.length > 0) {
    const outerSign = outerSigns[0];
    if (counterSigns.some((s) => s === outerSign)) windingAgreesWithNesting = false;
    if (outerSigns.some((s) => s !== outerSign)) windingAgreesWithNesting = false;
  }

  return { contours, degenerateDropped, windingAgreesWithNesting };
}

function sampleVertices(points: Pt[]): Pt[] {
  const n = points.length;
  if (n === 0) return [];
  return [points[0], points[Math.floor(n / 3)], points[Math.floor((2 * n) / 3)]];
}

/** Convenience: commands → classified contours in one call. */
export function glyphContours(
  commands: readonly PathCommand[],
  placement: GlyphPlacement,
  toleranceMM: number = DEFAULT_CHORD_TOLERANCE_MM,
): ContourResult {
  return classifyContours(contoursFromCommands(commands, placement, toleranceMM));
}
