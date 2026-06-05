// channelLetter.ts — Tier 2 #71 / NW #1 + #123 parity.
//
// One-call composition of NeonWizard's headline "Auto Tube Layout"
// workflow: text → Hershey single-stroke skeleton → per-glyph face
// outline → parallel offset → optional raceway-line split → array of
// DesignRuns ready to drop into the editor doc.
//
// Architectural decisions worth remembering:
//
//   - We DELIBERATELY reuse `is_channel_letter_face` + `raceway_id` on
//     DesignRun rather than introducing a new run kind. The PDF/DXF
//     emitters already honour those fields (PR #43, #26); a new kind
//     would touch the backend schema and the print path — out of scope.
//
//   - Face outlines are tight axis-aligned bounding RECTANGLES around
//     each glyph's Hershey strokes, NOT convex hulls. Reason: every
//     bundled face (rowmans/rowmand/futural) renders a glyph that fits
//     its advance bracket cleanly; the bracket IS the rectangle the
//     channel-letter operator builds in the metal shop. A convex hull
//     would shrink-wrap diagonals (like the angled stems of 'A' or 'V')
//     and emit a polygon that doesn't match the rectangular tube layout
//     a fabricator actually bends. If we ever ship a calligraphic face
//     with non-rectangular metrics, this is where it gets revisited.
//
//   - The face polyline is a CLOSED rectangle. offsetPolygon then emits
//     two parallel rectangles: one at +clearance/2 (outer return) and
//     one at -clearance/2 (inner tube hugging the face). Mirrors the
//     existing `neonize` op's ±half logic.
//
//   - Raceway-Y split: when the user provides a raceway baseline, every
//     emitted tube polyline gets cut at each Y-crossing. A rectangle
//     parallel to X crosses the line either 0 or 2 times (clean cut);
//     a rotated rectangle could cross more, but our face outlines are
//     axis-aligned so we never see >2 crossings in practice. The split
//     piece above the raceway keeps the original face's raceway_id;
//     the piece below also gets the same raceway_id so the PDF emitter
//     aggregates them on one strip page (per the existing PR #43
//     contract: same raceway_id = same combined strip).

import { hersheyTextToRuns, type HersheyRun } from './hershey/text';
import { FONTS, type FontKey } from './hershey/fonts';
import { offsetPolygon } from './shapes/offset';
import type { DesignRun } from '../api';

// Tight axis-aligned bbox of one Hershey stroke set. Returns null when
// the input is empty.
function bboxOfPoints(pts: [number, number][]): {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
} | null {
  if (pts.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Given the strokes of ONE rendered Hershey glyph, return a closed
 * rectangular polyline that bounds those strokes — i.e. the face
 * silhouette the channel-letter operator builds from sheet metal.
 *
 * Why a rectangle and not a convex hull / tight outline: see module
 * comment. The fabricator builds rectangular faces; matching that is
 * the right model for tube layout.
 *
 * Padding (in mm) is added on each side so the inner tube has room to
 * sit slightly inside the metal return without touching the wall.
 * Default 0; the wizard normally adds padding via `clearance` instead.
 *
 * Returns the polyline as a closed sequence of vertices, CCW (matching
 * offsetPolygon's preferred winding) with NO closing duplicate.
 */
export function glyphOutlineFromHersheyRuns(
  runs: HersheyRun[],
  paddingMM: number = 0,
): [number, number][] | null {
  const allPts: [number, number][] = [];
  for (const r of runs) for (const p of r.points) allPts.push(p);
  const bb = bboxOfPoints(allPts);
  if (!bb) return null;
  const x0 = bb.minX - paddingMM;
  const x1 = bb.maxX + paddingMM;
  const y0 = bb.minY - paddingMM;
  const y1 = bb.maxY + paddingMM;
  // CCW in math-frame coords (signed area > 0). offsetPolygon is
  // winding-agnostic so CW would work too, but staying CCW matches the
  // convention used elsewhere in the codebase (see `squareCCW` in
  // offset.test.ts).
  return [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
  ];
}

/** Group Hershey runs by glyph. We rebuild glyph-by-glyph by re-running
 *  `hersheyTextToRuns` on each visible character at the correct cursor
 *  position. Cheaper and more robust than trying to back-compute glyph
 *  boundaries from a combined-text emission. */
type GlyphRender = {
  /** The single character (one printable ASCII codepoint). */
  ch: string;
  /** Strokes for this glyph, already positioned in design coords. */
  runs: HersheyRun[];
  /** Baseline Y of this glyph in design coords. */
  baselineY: number;
  /** Cap-top Y of this glyph in design coords (baselineY - capHeightMM). */
  capTopY: number;
};

/** Re-walk `text` and emit each non-newline visible glyph at its own
 *  baseline. Mirrors `hersheyTextToRuns`'s cursor advance for the
 *  no-kerning case so the bounding boxes line up exactly. */
function renderPerGlyph(
  text: string,
  fontKey: FontKey,
  capHeightMM: number,
  originX: number,
  originY: number,
  lineHeight: number,
): GlyphRender[] {
  const font = FONTS[fontKey];
  const scale = capHeightMM / font.capHeightUnits;
  const out: GlyphRender[] = [];
  let cursorX = originX;
  let baselineY = originY;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      baselineY += capHeightMM * lineHeight;
      cursorX = originX;
      continue;
    }
    const code = ch.codePointAt(0);
    if (code === undefined || code < 32 || code > 127) continue;
    const glyph = font.data.glyphs[String(code)];
    if (!glyph) continue;
    // Render this single glyph at the current cursor position.
    const runs = hersheyTextToRuns({
      text: ch,
      font: fontKey,
      capHeightMM,
      originX: cursorX,
      originY: baselineY,
      lineHeight,
    });
    // Even whitespace glyphs (' ') return [] runs but still consume an
    // advance. We DON'T emit GlyphRender entries for those — the
    // wizard would otherwise try to offset an empty bbox.
    if (runs.length > 0) {
      out.push({
        ch,
        runs,
        baselineY,
        capTopY: baselineY - capHeightMM,
      });
    }
    cursorX += (glyph.right - glyph.left) * scale;
  }
  return out;
}

export type ChannelLetterColor = string;

export type ChannelLetterOptions = {
  text: string;
  font?: FontKey;
  /** Visible uppercase letter height (mm). Default 100. */
  capHeightMM: number;
  /** Distance between the inner tube and the outer (face-perimeter) tube
   *  in mm. Default = 1.5 × tubeDiameterMM (computed by the dialog;
   *  this is a pure function so the caller decides). The two offsets
   *  are placed at ±clearanceMM/2 from the face outline. */
  clearanceMM: number;
  /** Optional padding (mm) added around the Hershey stroke bbox before
   *  the bbox becomes the face outline. Defaults to clearanceMM so the
   *  inner tube doesn't intrude on the letter strokes. */
  facePaddingMM?: number;
  /** Tube color (CSS color string, e.g. '#fff8d2'). Default warm white. */
  tubeColor?: ChannelLetterColor;
  /** Tube outside diameter (mm). Defaults to 10 — the standard 10mm
   *  glass channel-letter tube. */
  tubeDiameterMM?: number;
  /** Multi-line line-height multiplier. Default 1.2 to match Hershey. */
  lineHeight?: number;
  /** Origin X for the leftmost glyph on the first line, mm. Default 0. */
  originX?: number;
  /** Baseline Y of the first line, mm. Default 0. */
  originY?: number;
  /** When set, every emitted tube run that crosses this Y coordinate is
   *  split into two pieces (above + below). Both pieces share the same
   *  raceway_id so the PDF emitter aggregates them onto one strip page.
   *  Pass `undefined` (or omit) to skip the split entirely. */
  racewayY?: number;
  /** When `racewayY` is set, this is the raceway grouping label
   *  written onto every emitted run. Default "wizard-raceway". */
  racewayId?: string;
};

const DEFAULT_TUBE_COLOR = '#fff8d2';
const DEFAULT_TUBE_DIAM_MM = 10;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_RACEWAY_ID = 'wizard-raceway';

/**
 * Convert text + font + dimensions into a set of populated channel-
 * letter DesignRuns, ready to drop straight into the editor doc.
 *
 * The emitted runs come in declaration order:
 *   1. Glyph 0's face outline (closed polyline, `is_channel_letter_face`).
 *   2. Glyph 0's outer tube (offset +clearance/2, closed by default).
 *   3. Glyph 0's inner tube (offset -clearance/2, closed by default).
 *   4–6. Glyph 1's face + tubes.
 *   ...etc.
 *
 * With `racewayY` set, each tube run that crosses Y is replaced by two
 * separate runs (above and below), both sharing the same `raceway_id`.
 * Face outlines are NOT split (the metal face perimeter is one piece
 * even when the raceway runs through the lower edge); only the glass
 * tubes are.
 *
 * Returns an empty array for empty or whitespace-only input.
 */
export function channelLetterFromText(opts: ChannelLetterOptions): DesignRun[] {
  const text = opts.text ?? '';
  if (text.trim().length === 0) return [];
  const fontKey = opts.font ?? 'rowmans';
  const capHeightMM = opts.capHeightMM;
  const clearanceMM = opts.clearanceMM;
  const facePaddingMM = opts.facePaddingMM ?? clearanceMM;
  const tubeColor = opts.tubeColor ?? DEFAULT_TUBE_COLOR;
  const tubeDiameterMM = opts.tubeDiameterMM ?? DEFAULT_TUBE_DIAM_MM;
  const lineHeight = opts.lineHeight ?? DEFAULT_LINE_HEIGHT;
  const originX = opts.originX ?? 0;
  const originY = opts.originY ?? 0;
  const racewayY = opts.racewayY;
  const racewayId =
    typeof racewayY === 'number' && Number.isFinite(racewayY)
      ? (opts.racewayId ?? DEFAULT_RACEWAY_ID)
      : undefined;

  // Bail on nonsensical inputs rather than emitting degenerate geometry.
  if (!(capHeightMM > 0) || !Number.isFinite(capHeightMM)) return [];
  if (!(clearanceMM >= 0) || !Number.isFinite(clearanceMM)) return [];

  const glyphs = renderPerGlyph(text, fontKey, capHeightMM, originX, originY, lineHeight);
  if (glyphs.length === 0) return [];

  const half = clearanceMM / 2;
  const out: DesignRun[] = [];

  for (let gi = 0; gi < glyphs.length; gi++) {
    const g = glyphs[gi];
    // Stable id prefix per glyph. The caller's appendRuns will rewrite
    // the id with a unique counter — we use these slugs purely as
    // human-readable hints in the temporary id field.
    const slug = `letter-${gi}`;
    const facePts = glyphOutlineFromHersheyRuns(g.runs, facePaddingMM);
    if (!facePts) continue;
    // Face: the closed rectangle. NW emits the face perimeter as a
    // single piece even when a raceway runs through it (the operator
    // bends one metal strip around the whole letter).
    out.push(makeRun(`${slug}-face`, facePts, true, tubeColor, tubeDiameterMM, racewayId, true));

    // Tubes. With half === 0 the two offsets coincide; emit only one
    // run in that pathological case so the editor doesn't ship a
    // zero-thickness duplicate. (Dialog UI prevents this, but the
    // pure-function contract should still be sane.)
    if (half > 0) {
      const outer = offsetPolygon(facePts, +half, { trimSelfIntersections: true });
      const inner = offsetPolygon(facePts, -half, { trimSelfIntersections: true });
      pushTube(out, `${slug}-outer`, outer.points, tubeColor, tubeDiameterMM, racewayY, racewayId);
      pushTube(out, `${slug}-inner`, inner.points, tubeColor, tubeDiameterMM, racewayY, racewayId);
    } else {
      pushTube(out, `${slug}-tube`, facePts, tubeColor, tubeDiameterMM, racewayY, racewayId);
    }
  }

  return out;
}

/** Build the canonical channel-letter DesignRun. */
function makeRun(
  id: string,
  points: [number, number][],
  closed: boolean,
  color: string,
  tubeDiameter: number,
  racewayId: string | undefined,
  isFace: boolean,
): DesignRun {
  const run: DesignRun = {
    id,
    polyline: { points, closed },
    color,
    tube_diameter_mm: tubeDiameter,
  };
  if (isFace) run.is_channel_letter_face = true;
  if (racewayId) run.raceway_id = racewayId;
  return run;
}

/** Append one tube to `out`, splitting at `racewayY` if it crosses. */
function pushTube(
  out: DesignRun[],
  id: string,
  points: [number, number][],
  color: string,
  tubeDiameter: number,
  racewayY: number | undefined,
  racewayId: string | undefined,
): void {
  if (points.length < 2) return;
  if (typeof racewayY !== 'number' || !Number.isFinite(racewayY)) {
    out.push(makeRun(id, points, true, color, tubeDiameter, racewayId, false));
    return;
  }
  // Tube crosses raceway — split into open arcs above/below.
  const pieces = splitClosedAtY(points, racewayY);
  if (pieces.length <= 1) {
    // No crossing or degenerate (line tangent to corner). Emit as one
    // closed run anyway — the operator sees the tube on the right
    // side of the raceway and can hand-split if needed.
    out.push(makeRun(id, points, true, color, tubeDiameter, racewayId, false));
    return;
  }
  for (let pi = 0; pi < pieces.length; pi++) {
    out.push(
      makeRun(
        `${id}-${pi}`,
        pieces[pi],
        false,
        color,
        tubeDiameter,
        racewayId,
        false,
      ),
    );
  }
}

/**
 * Split a CLOSED polyline at every Y-crossing of horizontal line `y`,
 * returning the resulting OPEN arcs (one per contiguous segment of the
 * loop on one side of the line). Each crossing point is duplicated into
 * the two arcs it bridges, so the geometry is loss-less.
 *
 * For an axis-aligned rectangle (our face outline) this always returns
 * either 0 (no crossing), 1 (the rectangle lies entirely on one side
 * with one edge tangent to the line — treat as no crossing), or 2 arcs
 * (the rectangle straddles the line). Concave polygons could produce
 * more; the algorithm handles those too.
 *
 * Exposed for the unit tests; not a stable public API.
 */
export function splitClosedAtY(
  points: [number, number][],
  y: number,
): [number, number][][] {
  const n = points.length;
  if (n < 3) return [points.slice()];

  // First, walk every edge and collect the "expanded" polyline that
  // includes crossing points as explicit vertices. We also tag each
  // vertex with which side of `y` it sits on (above, below, or on).
  type Side = -1 | 0 | 1; // -1 below (y > line), 0 on line, +1 above (y < line)
  const sideOf = (yy: number): Side => {
    if (yy < y) return 1;
    if (yy > y) return -1;
    return 0;
  };
  const expanded: { pt: [number, number]; side: Side }[] = [];
  for (let i = 0; i < n; i++) {
    const a = points[i];
    const b = points[(i + 1) % n];
    expanded.push({ pt: a, side: sideOf(a[1]) });
    const sa = sideOf(a[1]);
    const sb = sideOf(b[1]);
    // Edge crosses the line if one endpoint is strictly above and the
    // other strictly below. Endpoints exactly on the line are not new
    // crossings — they're already vertices, so we'll split there
    // naturally below.
    if ((sa === 1 && sb === -1) || (sa === -1 && sb === 1)) {
      const t = (y - a[1]) / (b[1] - a[1]);
      const cx = a[0] + t * (b[0] - a[0]);
      expanded.push({ pt: [cx, y], side: 0 });
    }
  }

  // If no vertex sits exactly on the line, the polygon is entirely on
  // one side — no split.
  const hasOn = expanded.some((v) => v.side === 0);
  if (!hasOn) return [points.slice()];

  // Tangent case: the line touches a vertex/edge but doesn't actually
  // separate the polygon. If all non-on vertices fall on the same
  // side, no real split happened.
  const sides = expanded.filter((v) => v.side !== 0).map((v) => v.side);
  if (sides.length === 0) return [points.slice()];
  const hasAbove = sides.some((s) => s === 1);
  const hasBelow = sides.some((s) => s === -1);
  if (!(hasAbove && hasBelow)) return [points.slice()];

  // Walk the expanded loop, starting at a side==0 vertex. At each
  // side==0 vertex we cut: the arc accumulates from one cut to the
  // next. The duplicated crossing point is included as BOTH the end of
  // the previous arc and the start of the next.
  // Find the index of the first "on" vertex to start the walk there.
  const m = expanded.length;
  const startIdx = expanded.findIndex((v) => v.side === 0);
  if (startIdx < 0) return [points.slice()];

  const arcs: [number, number][][] = [];
  let current: [number, number][] = [expanded[startIdx].pt];
  for (let k = 1; k <= m; k++) {
    const v = expanded[(startIdx + k) % m];
    current.push(v.pt);
    if (v.side === 0) {
      // Close the arc at this crossing.
      // Drop arcs with <2 vertices (degenerate — two consecutive crossings
      // with nothing between, which can happen if `y` clips a corner).
      if (current.length >= 2) arcs.push(current);
      current = [v.pt];
    }
  }
  // If the walk ended without closing on a crossing, dump the trailing
  // arc — this happens when the start vertex isn't repeated at the end.
  if (current.length > 1) {
    arcs.push(current);
  }

  // If we only saw the start crossing and nothing else, the polygon was
  // tangent — no real split.
  if (arcs.length <= 1) return [points.slice()];
  return arcs;
}
