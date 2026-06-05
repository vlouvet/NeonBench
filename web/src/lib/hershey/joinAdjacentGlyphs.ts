// Connecting-script glyph joiner. The Hershey cursive face is designed
// so adjacent lowercase letters can be stitched into a single tube path:
// each lowercase glyph enters at ~(left, 4) and exits at ~(right, 4) in
// JHF units, which after scaling sits just below the baseline. The
// neighbouring glyphs almost touch — the remaining gap is the small
// inter-letter air the rendering engine inserts for kerning.
//
// What this module does: given two adjacent glyphs' rendered strokes
// (already in design-mm coordinates, post-`hersheyTextToRuns` shape),
// decide whether they're "join-eligible" and, if so, emit a continuous
// stroke list with the two glyphs merged into one HersheyRun via a small
// bridging polyline at the connection point.
//
// What this module does NOT do: kerning, scaling, font selection,
// anything coordinate-system-aware beyond a `capHeightMM` reference for
// the eligibility tolerances. All the "should we even try to join?"
// gating lives in `text.ts` (where `font.joinAdjacent` is consulted).
//
// Tolerances (see spec tier3-79-connecting-script-font.md):
//   maxJoinDistance — max X distance from prevEnd to nextStart, default
//                     1.5 × capHeightMM. The cursive face puts adjacent
//                     glyph endpoints within ~1 cap-height of each other
//                     even at default spacing, so 1.5× covers normal
//                     kerning. If the user has loosened kerning past
//                     this, no join (intentional — a wide gap means the
//                     user wants a visual break).
//   maxJoinDrop —     max |Y| distance from prevEnd to nextStart, default
//                     0.5 × capHeightMM. Stops a 't' (last stroke ends at
//                     cap-top, the cross-bar) from joining its neighbour
//                     even though X is close. 0.5× cap-height is half a
//                     line — far enough to permit normal cursive baseline
//                     curve variation, tight enough to reject cap-top or
//                     descender exits.

import type { HersheyRun } from './text';

export type JoinOptions = {
  /** Reference for tolerance scaling. Must match the capHeightMM the
   *  glyphs were rendered with — passing the wrong value silently
   *  changes which adjacent pairs join. */
  capHeightMM: number;
  /** Max X distance (mm) between prev endpoint and next startpoint to
   *  permit a join. Default: 1.5 × capHeightMM. */
  maxJoinDistance?: number;
  /** Max |Y| distance (mm) between prev endpoint and next startpoint to
   *  permit a join. Default: 0.5 × capHeightMM. */
  maxJoinDrop?: number;
};

export type JoinResult = {
  joined: boolean;
  /** When joined === true: the merged stroke list (prev's strokes EXCEPT
   *  the last, then one combined stroke = prev's last + bridge + next's
   *  first, then next's strokes EXCEPT the first). When joined === false:
   *  the strokes returned are `[...prev, ...next]` unchanged.
   *
   *  Why merge into ONE continuous stroke (vs leaving them as two runs
   *  with a connecting third): downstream consumers (3D preview, bend
   *  list, export) treat each HersheyRun as a single tube. The neon-shop
   *  benefit of cursive joining is "one tube per word" — merging into a
   *  single run is what realises that benefit. */
  joinedStrokes: HersheyRun[];
};

/**
 * Determine whether two adjacent glyphs can be joined, and if so emit a
 * merged stroke list with a small bridge connecting them.
 *
 * Inputs are the rendered strokes of `prevGlyph` and `nextGlyph` in
 * design-mm coordinates (the same `HersheyRun[]` shape that
 * `hersheyTextToRuns` already produces). Neither input is mutated.
 *
 * Joining algorithm:
 *   1. Pick prev's LAST stroke (the one whose last point is the
 *      conceptual "exit") and find its final point.
 *   2. Pick next's FIRST stroke (whose first point is the conceptual
 *      "entry") and find its starting point.
 *   3. Check X distance ≤ maxJoinDistance AND |Y distance| ≤ maxJoinDrop.
 *      Both must hold for a join.
 *   4. If joined: emit a single merged run = prev's last stroke points,
 *      followed by 1-3 intermediate bridge points, followed by next's
 *      first stroke points. Other strokes from prev/next pass through
 *      unmerged. (Multi-stroke glyphs like 'i' = dot + body keep their
 *      dot as its own run.)
 *
 * Edge cases:
 *  - Either glyph has zero strokes → joined: false, return concatenation.
 *  - prev's last stroke has < 2 points → joined: false (we can't compute
 *    a tangent direction with 1 point). Same for next's first stroke.
 *  - The X distance is NEGATIVE (overlap from tight user kerning) but
 *    within tolerance → still joined; the bridge becomes a tiny backwards
 *    nudge. We don't reject overlap because overlap is what cursive
 *    cursive is meant to do.
 *
 * @param prevGlyph stroke list for the left-side glyph
 * @param nextGlyph stroke list for the right-side glyph
 * @param opts      tolerance settings (capHeightMM required)
 */
export function joinAdjacentGlyphs(
  prevGlyph: HersheyRun[],
  nextGlyph: HersheyRun[],
  opts: JoinOptions,
): JoinResult {
  const passthrough: HersheyRun[] = [...prevGlyph, ...nextGlyph];

  if (prevGlyph.length === 0 || nextGlyph.length === 0) {
    return { joined: false, joinedStrokes: passthrough };
  }

  const cap = opts.capHeightMM;
  const maxDx = opts.maxJoinDistance ?? cap * 1.5;
  const maxDy = opts.maxJoinDrop ?? cap * 0.5;

  const prevLast = prevGlyph[prevGlyph.length - 1];
  const nextFirst = nextGlyph[0];
  if (prevLast.points.length < 2 || nextFirst.points.length < 2) {
    return { joined: false, joinedStrokes: passthrough };
  }

  const prevEnd = prevLast.points[prevLast.points.length - 1];
  const nextStart = nextFirst.points[0];

  const dx = nextStart[0] - prevEnd[0];
  const dy = nextStart[1] - prevEnd[1];

  // X gating: nextStart should be to the RIGHT of prevEnd (positive dx)
  // OR slightly to the left (negative dx) up to ~one cap-height of
  // overlap from tight kerning. Use absolute distance check against
  // maxDx — the spec calls it "X distance" without a sign requirement
  // and overlapping cursive is real (e.g. "of" with a tucked-in 'f').
  if (Math.abs(dx) > maxDx) {
    return { joined: false, joinedStrokes: passthrough };
  }
  if (Math.abs(dy) > maxDy) {
    return { joined: false, joinedStrokes: passthrough };
  }

  // Build the bridge. The spec asks for "a small Bézier-like polyline
  // (3-5 vertices) connecting the endpoints" — we emit 3 interior
  // vertices for a smooth quadratic-ish curve. Tangent direction is
  // extrapolated from the last two points of prev and the first two of
  // next, so the bridge enters and exits along the local stroke
  // direction (not a hard corner at the join point).
  const prevTanFrom = prevLast.points[prevLast.points.length - 2];
  const nextTanTo = nextFirst.points[1];
  const bridge = buildBridgePoints(prevEnd, prevTanFrom, nextStart, nextTanTo);

  // Merged stroke = prev's last stroke points + bridge interior points
  // + next's first stroke points. We drop the duplicate prevEnd/nextStart
  // endpoints from the bridge — they're already in the prev/next stroke
  // arrays — so the result is a single continuous polyline.
  const mergedPoints: [number, number][] = [
    ...prevLast.points,
    ...bridge,
    ...nextFirst.points,
  ];

  const out: HersheyRun[] = [];
  // All but the last stroke of prev: pass through unchanged (e.g. the
  // dot of an 'i' stays as its own run).
  for (let i = 0; i < prevGlyph.length - 1; i++) {
    out.push(prevGlyph[i]);
  }
  out.push({ points: mergedPoints });
  // All but the first stroke of next: pass through unchanged.
  for (let i = 1; i < nextGlyph.length; i++) {
    out.push(nextGlyph[i]);
  }

  return { joined: true, joinedStrokes: out };
}

/**
 * Build 3 interior bridge points between two adjacent stroke endpoints,
 * using a simple quadratic-Bezier-like curve whose tangents match the
 * local stroke directions at each side.
 *
 * The control point sits at the average of the two extrapolated tangent
 * lines (basically a midpoint with a slight curve toward where the
 * strokes were heading). Then we sample t=0.25, 0.5, 0.75 along the
 * quadratic for the interior bridge vertices. We don't include t=0 or
 * t=1 because those equal prevEnd and nextStart, which are already in
 * the merged stroke arrays.
 */
function buildBridgePoints(
  prevEnd: [number, number],
  prevTanFrom: [number, number],
  nextStart: [number, number],
  nextTanTo: [number, number],
): [number, number][] {
  // Tangent direction at prevEnd: from prevTanFrom → prevEnd, extended.
  const tanPrevX = prevEnd[0] - prevTanFrom[0];
  const tanPrevY = prevEnd[1] - prevTanFrom[1];
  // Tangent direction at nextStart: from nextStart → nextTanTo, reversed
  // to point INTO the join (so two tangent lines both point "outward"
  // from the join span and we average them).
  const tanNextX = nextStart[0] - nextTanTo[0];
  const tanNextY = nextStart[1] - nextTanTo[1];

  // Distance over which to extrapolate each tangent before averaging.
  // 1/3 of the chord length is the canonical "smooth Bezier" rule of
  // thumb. Floor at 0.5mm so two glyphs touching at one point still
  // produce a defined control vector.
  const chord = Math.hypot(nextStart[0] - prevEnd[0], nextStart[1] - prevEnd[1]);
  const ext = Math.max(chord / 3, 0.5);

  const normTanPrev = normalise(tanPrevX, tanPrevY);
  const normTanNext = normalise(tanNextX, tanNextY);

  // Two control candidates: one extrapolated from prev, one from next.
  const cpPrevX = prevEnd[0] + normTanPrev[0] * ext;
  const cpPrevY = prevEnd[1] + normTanPrev[1] * ext;
  const cpNextX = nextStart[0] + normTanNext[0] * ext;
  const cpNextY = nextStart[1] + normTanNext[1] * ext;

  // Single shared control point = average. For a smooth join this gives
  // a quadratic that respects both end tangents reasonably (a full cubic
  // would be ideal but the visual difference at neon-tube scale is < 1mm).
  const cpX = (cpPrevX + cpNextX) / 2;
  const cpY = (cpPrevY + cpNextY) / 2;

  // Quadratic Bezier at t: (1-t)^2 * P0 + 2(1-t)t * CP + t^2 * P1.
  const samples: [number, number][] = [];
  for (const t of [0.25, 0.5, 0.75]) {
    const oneMinus = 1 - t;
    const x = oneMinus * oneMinus * prevEnd[0] + 2 * oneMinus * t * cpX + t * t * nextStart[0];
    const y = oneMinus * oneMinus * prevEnd[1] + 2 * oneMinus * t * cpY + t * t * nextStart[1];
    samples.push([x, y]);
  }
  return samples;
}

function normalise(x: number, y: number): [number, number] {
  const len = Math.hypot(x, y);
  if (len < 1e-9) return [1, 0]; // degenerate fallback: horizontal
  return [x / len, y / len];
}
