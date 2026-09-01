// Tier 2 #98 — union of overlapping closed outlines (NeonWizard calls the
// effect "Weld"; this codebase does not, see below).
//
// Script and connected lettering is drawn as overlapping glyph outlines.
// Neon is bent as ONE continuous tube per stroke, so before Neonize can run
// those overlapping outlines have to become a single outline. Without this
// op, connected script has to be hand-traced.
//
// NAMING. `weld` already means a PHYSICAL glass weld here — the joint where
// a glassblower fuses two tubes — and `internal/validate/rules.go` spaces
// electrodes against `weldRadius`. A boolean-union feature sharing that word
// would make both unreadable. Everything here says "union" / "merge
// outlines"; NW's name appears only in the parity table.
//
// ── Four things in this file are load-bearing ────────────────────────────
//
// 1. ARCS ARE FLATTENED, AND THE RESULT CARRIES NO `segment_types`.
//    `segment_types` can only say "this chord bows by a fixed 0.5 bulge".
//    A union boundary is whatever the intersection maths produced; there is
//    no bulge that expresses it. So every input goes through
//    `flatRunPoints` and every output run is line segments only. The
//    operator is trading curve fidelity for a joinable outline and the UI
//    says so — quietly emitting `segment_types` that describe a different
//    curve than the one computed would be the worse answer.
//
// 2. HOLES SURVIVE AS THEIR OWN RUNS. Two overlapping 'O's produce an outer
//    boundary and two counters. A channel-letter face with a dropped
//    counter is wrong at the bench, not just on screen. Each boundary ring
//    is emitted as its own closed run, which is exactly what the OpenType
//    outline path already does (`fonts/text.ts` emits a counter as a
//    sibling run and the preview uses `fill-rule: evenodd`).
//
// 3. THE RINGS MUST BE NESTED BEFORE THEY REACH MARTINEZ. Handing the
//    library a flat list of rings as one polygon applies even-odd across
//    the WHOLE selection, so the overlap of two glyph bodies comes back as
//    a hole. Probed directly on 0.8.1: four rings (two 'O's) as one polygon
//    returned three polygons including a zero-area triangle; the same four
//    rings nested into two polygons returned the right answer (one shell of
//    1650 mm², two 100 mm² counters). `nestRings` below is that step, and
//    `booleanOps.test.ts` keeps a negative control that fails without it.
//
// 4. INDEXED CHILDREN CANNOT BE CARRIED. Electrodes, blockouts,
//    annotations, bends and `direction` all address vertices that the union
//    dissolves — there is no honest remap, because the vertex an electrode
//    sat on may be inside the merged body and no longer on any boundary.
//    They are dropped, counted, and reported. Everything on CLAUDE.md's
//    carry table that is NOT index-based (`is_channel_letter_face`,
//    `channel_letter_depth_mm`, `raceway_id`, `group_id`, `kind`) is
//    carried when the inputs agree and dropped-with-a-warning when they
//    disagree, because picking one input's value silently is how a face
//    stops emitting return strips.
//
// ── Traps found in martinez-polygon-clipping@0.8.1, all pinned by tests ──
//
//   * A ring WITHOUT its closing duplicate vertex silently produces a wrong
//     area (two overlapping 10x10 squares came back as 112.5 mm² instead of
//     175). `toMartinezRing` always appends the closure.
//   * A zero-area ring THROWS (`Cannot read properties of undefined
//     (reading 'holeOf')`), and a 2-point ring is accepted and silently
//     treated as a sliver. Degenerate rings are filtered before the call
//     and the call itself is wrapped.
//   * Output holes come back with the SAME winding as their shell, so
//     winding cannot be used to tell them apart. Ring position in the
//     polygon does (index 0 is the shell). We renormalise on the way out:
//     shells positive area, holes negative, matching the convention
//     `fonts/outline.ts` documents for glyph contours.
//   * EXACTLY TANGENT CURVES DEGRADE. Two flattened arcs that meet at a
//     single tangent point (rather than crossing) come back as the main
//     body plus a scatter of ~0.5 mm² slivers, and about 0.9% of the total
//     area goes missing. Probed on the raw library, so it is not this
//     file's doing: two 20 mm arc squares whose facing arcs are tangent at
//     one point returned 10 polygons, one of them zero-area. The spec's
//     three named hard cases — co-linear edges, vertex-touching, holes —
//     are all exact; this fourth one is not, and pretending otherwise
//     would hand the bench a broken outline. So the op reports it: rings
//     below a physically meaningless area are dropped and counted, and a
//     union that comes apart into more than one shell says so out loud
//     instead of quietly adding nine runs to the doc.
//
// Every op here is a pure `DesignDoc -> DesignDoc` and returns the SAME doc
// object when there is nothing to do — `applyOp` in EditorPage and the
// undo-coalescing window both key off reference identity.

import { union as martinezUnion } from 'martinez-polygon-clipping';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints, runHasArcs } from './arcGeom';
import { nextRunId } from './docOps';
import { pointInPolygon } from './fonts/outline';
import { signedArea } from './shapes/offset';

/** A closed boundary with NO closing duplicate vertex — the shape a
 *  `DesignRun` with `closed: true` stores. */
export type Ring = [number, number][];

/** Shell first, holes after. The shape martinez wants. */
type NestedPolygon = Ring[];

/** Two vertices this close are the same vertex. 1 nm — the same constant
 *  `fonts/outline.ts` uses, far below anything a font or a bender expresses
 *  and far above float noise. Coincident vertices are not cosmetic: a
 *  zero-length segment divides by zero in the bend-radius validator. */
const POINT_EPSILON_MM = 1e-6;

/** Rings below this magnitude are not shapes. Martinez THROWS on a
 *  zero-area ring, and its own output occasionally carries a degenerate
 *  sliver, so this filter runs on both sides of the call. */
const AREA_EPSILON_MM2 = 1e-9;

/** Perpendicular deviation under which a vertex is on the line between its
 *  neighbours and adds nothing. Deliberately tiny: a flattened arc's
 *  vertices sit on a circle, never on a chord, so this cannot straighten a
 *  curve — it only removes the spurious corners martinez leaves where two
 *  co-linear input edges met (a shared-edge union of two squares came back
 *  with 6 corners for a rectangle). */
const COLLINEAR_EPSILON_MM = 1e-6;

/** Output rings enclosing less than this are numerical noise, not glass:
 *  0.01 mm² is a 0.1 mm square, three orders of magnitude below the
 *  smallest feature any bender can form. Sized in trade terms on purpose —
 *  a relative threshold would scale with the design and start eating real
 *  detail on small work. Anything ABOVE it is kept even when it looks like
 *  an artefact, and the shell count in the plan is what warns about it:
 *  report, do not repair. */
const SLIVER_AREA_MM2 = 0.01;

/** Which run fields the union carries, and what it did with each. Surfaced
 *  in the toast so "my raceway id vanished" is never a discovery made at
 *  the bench. */
export type UnionCarry = {
  color?: string;
  tube_diameter_mm?: number;
  is_channel_letter_face?: boolean;
  channel_letter_depth_mm?: number;
  raceway_id?: string;
  group_id?: string;
  kind?: '' | 'jumper';
  notes?: string;
};

export type UnionOutlinesPlan = {
  /** Closed runs that will take part, in doc order. */
  runIds: string[];
  /** Selected runs skipped because they are open polylines. A union needs
   *  an inside, and an open polyline does not have one. */
  skippedOpen: number;
  /** Closed inputs dropped as degenerate (fewer than three distinct
   *  vertices, or no enclosed area). */
  degenerateDropped: number;
  /** Output rings below SLIVER_AREA_MM2, dropped as numerical noise. */
  sliverDropped: number;
  /** Inputs that carried arc segments and were flattened. */
  flattenedInputs: number;
  /** Shell rings and hole rings in the result. */
  outerCount: number;
  holeCount: number;
  /** Index-addressed children that cannot survive and were dropped. */
  droppedElectrodes: number;
  droppedBlockouts: number;
  droppedAnnotations: number;
  droppedBends: number;
  droppedDirections: number;
  /** Fields carried onto every emitted run. */
  carried: UnionCarry;
  /** Fields the inputs disagreed on, so nothing could be carried. */
  mixedFields: string[];
  /** Why the union cannot run, or null. Non-null means the op is a no-op
   *  and this string is the whole explanation. */
  error: string | null;
  /** Runs, but the operator should know. */
  warnings: string[];
  /** The computed boundary rings: shells and holes, already cleaned and
   *  wound. Empty when `error` is set. */
  rings: { points: Ring; hole: boolean }[];
};

const EMPTY_PLAN: Omit<UnionOutlinesPlan, 'error'> = {
  runIds: [],
  skippedOpen: 0,
  degenerateDropped: 0,
  sliverDropped: 0,
  flattenedInputs: 0,
  outerCount: 0,
  holeCount: 0,
  droppedElectrodes: 0,
  droppedBlockouts: 0,
  droppedAnnotations: 0,
  droppedBends: 0,
  droppedDirections: 0,
  carried: {},
  mixedFields: [],
  warnings: [],
  rings: [],
};

// ── ring hygiene ─────────────────────────────────────────────────────────

function samePoint(a: [number, number], b: [number, number]): boolean {
  return Math.hypot(a[0] - b[0], a[1] - b[1]) < POINT_EPSILON_MM;
}

/** Drop the trailing copy of the first vertex, then any consecutive
 *  duplicates (including across the wrap). */
function cleanRing(raw: [number, number][]): Ring {
  const out: Ring = [];
  for (const p of raw) {
    if (out.length === 0 || !samePoint(out[out.length - 1], p)) out.push([p[0], p[1]]);
  }
  while (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

/** Remove vertices that lie on the straight line between their neighbours.
 *  See COLLINEAR_EPSILON_MM for why this cannot straighten a flattened
 *  arc. */
function dropCollinear(ring: Ring): Ring {
  if (ring.length < 3) return ring;
  let pts = ring;
  // One pass is not enough: removing a vertex can make its neighbour
  // co-linear in turn (three points on one straight seam).
  for (;;) {
    const out: Ring = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n];
      const cur = pts[i];
      const next = pts[(i + 1) % n];
      const ax = cur[0] - prev[0];
      const ay = cur[1] - prev[1];
      const bx = next[0] - prev[0];
      const by = next[1] - prev[1];
      const baseLen = Math.hypot(bx, by);
      // Perpendicular distance from `cur` to the prev→next line.
      const dev = baseLen > 0 ? Math.abs(ax * by - ay * bx) / baseLen : Math.hypot(ax, ay);
      if (dev >= COLLINEAR_EPSILON_MM) out.push(cur);
    }
    if (out.length === pts.length || out.length < 3) return out.length < 3 ? pts : out;
    pts = out;
  }
}

function bboxOf(ring: Ring): [number, number, number, number] {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  return [minX, minY, maxX, maxY];
}

function pointOnRing(pt: [number, number], ring: Ring): boolean {
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const abx = b[0] - a[0];
    const aby = b[1] - a[1];
    const len2 = abx * abx + aby * aby;
    let t = len2 > 0 ? ((pt[0] - a[0]) * abx + (pt[1] - a[1]) * aby) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    if (Math.hypot(pt[0] - (a[0] + t * abx), pt[1] - (a[1] + t * aby)) < POINT_EPSILON_MM) {
      return true;
    }
  }
  return false;
}

/**
 * True when EVERY vertex of `inner` is inside (or exactly on) `outer`.
 *
 * The strictness is the point. `fonts/outline.ts` samples three vertices
 * and takes the majority, which is right for glyph contours because a
 * well-formed font's contours never cross. Here they cross by definition —
 * that is the feature — and a majority vote gets the interesting case
 * wrong: when a neighbouring glyph's body covers three of a counter's four
 * corners, "mostly inside" would nest the counter under the WRONG parent,
 * flip it to even depth, and fill the hole in. Requiring all vertices makes
 * a crossing pair simply not a nesting pair, which is the truth.
 */
function ringContains(outer: Ring, inner: Ring): boolean {
  const [oMinX, oMinY, oMaxX, oMaxY] = bboxOf(outer);
  const [iMinX, iMinY, iMaxX, iMaxY] = bboxOf(inner);
  const slack = POINT_EPSILON_MM;
  if (iMinX < oMinX - slack || iMinY < oMinY - slack) return false;
  if (iMaxX > oMaxX + slack || iMaxY > oMaxY + slack) return false;
  for (const v of inner) {
    if (!pointInPolygon(v, outer) && !pointOnRing(v, outer)) return false;
  }
  return true;
}

/**
 * Group a flat list of rings into polygons by even-odd nesting depth: a
 * ring at even depth is a shell, a ring at odd depth is a hole of its
 * nearest enclosing shell. This is the same rule `classifyContours` uses to
 * label a glyph's counters, and the same rule the editor's own outline
 * preview draws with (`fill-rule: evenodd` per glyph).
 *
 * A ring can only nest inside a strictly LARGER one, which is what stops
 * two coincident duplicates from declaring each other holes.
 */
export function nestRings(rings: Ring[]): NestedPolygon[] {
  const areas = rings.map((r) => Math.abs(signedArea(r)));
  const parent: number[] = rings.map(() => -1);
  for (let i = 0; i < rings.length; i++) {
    let best = -1;
    for (let j = 0; j < rings.length; j++) {
      if (i === j || areas[j] <= areas[i]) continue;
      if (!ringContains(rings[j], rings[i])) continue;
      if (best === -1 || areas[j] < areas[best]) best = j;
    }
    parent[i] = best;
  }
  const depth: number[] = rings.map(() => -1);
  const depthOf = (i: number, guard = 0): number => {
    if (depth[i] >= 0) return depth[i];
    if (guard > rings.length) return 0; // cycle guard; cannot happen with the area rule
    const d = parent[i] === -1 ? 0 : depthOf(parent[i], guard + 1) + 1;
    depth[i] = d;
    return d;
  };
  for (let i = 0; i < rings.length; i++) depthOf(i);

  const polys: NestedPolygon[] = [];
  const shellSlot = new Map<number, number>();
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 0) {
      shellSlot.set(i, polys.length);
      polys.push([rings[i]]);
    }
  }
  for (let i = 0; i < rings.length; i++) {
    if (depth[i] % 2 === 0) continue;
    const slot = parent[i] === -1 ? undefined : shellSlot.get(parent[i]);
    // An odd-depth ring always has a parent, and that parent is always at
    // even depth, so the slot always resolves. The fallback keeps a hole
    // from vanishing if that ever stops being true.
    if (slot === undefined) polys.push([rings[i]]);
    else polys[slot].push(rings[i]);
  }
  return polys;
}

// ── martinez plumbing ────────────────────────────────────────────────────

/** Martinez wants the closing duplicate. Omitting it does not error — it
 *  silently computes against a different shape. */
function toMartinezRing(ring: Ring): [number, number][] {
  return [...ring.map((p): [number, number] => [p[0], p[1]]), [ring[0][0], ring[0][1]]];
}

/** martinez returns `Polygon | MultiPolygon | null` and the two are not
 *  distinguishable by type alone (a Polygon is Position[][], a MultiPolygon
 *  is Position[][][]), so sniff the nesting depth of the first element. */
function toMultiPolygon(g: unknown): [number, number][][][] {
  if (!Array.isArray(g) || g.length === 0) return [];
  const first = g[0];
  if (!Array.isArray(first) || first.length === 0) return [];
  const second = first[0];
  if (Array.isArray(second) && typeof second[0] === 'number') {
    return [g as [number, number][][]];
  }
  return g as [number, number][][][];
}

// ── field carrying ───────────────────────────────────────────────────────

function normStr(v: string | undefined): string | undefined {
  return v === undefined || v === '' ? undefined : v;
}

function unanimous<T>(values: T[]): { agreed: boolean; value: T | undefined } {
  if (values.length === 0) return { agreed: true, value: undefined };
  const first = values[0];
  return { agreed: values.every((v) => v === first), value: first };
}

// ── the op ───────────────────────────────────────────────────────────────

/**
 * Compute what `unionRuns` would do, without touching the doc. Split out
 * so the caller can word its toast from exactly the numbers the op used —
 * the two cannot disagree because the op calls this.
 */
export function unionOutlinesPlan(doc: DesignDoc, runIds: string[]): UnionOutlinesPlan {
  const wanted = new Set(runIds);
  const selected = doc.runs.filter((r) => wanted.has(r.id));
  const closed = selected.filter((r) => r.polyline.closed);
  const skippedOpen = selected.length - closed.length;

  if (closed.length < 2) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      error:
        skippedOpen > 0
          ? `Merging outlines needs at least two CLOSED runs; ${skippedOpen} of the selected run${
              skippedOpen === 1 ? ' is an open polyline' : 's are open polylines'
            }, which has no inside to merge.`
          : 'Select at least two closed runs to merge into one outline.',
    };
  }

  // A jumper is a splice tube between two primary runs, not a face
  // boundary. Merging one into a live tube would erase the distinction the
  // PDF, the 3D preview and the bend-list summary all key off.
  const kinds = closed.map((r) => (r.kind === 'jumper' ? 'jumper' : 'tube'));
  if (kinds.includes('jumper') && kinds.includes('tube')) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      error:
        'Refusing to merge a jumper with a live tube: a jumper is a splice between two runs, ' +
        'not part of a tube outline. Merging them would put the splice on the fabrication ' +
        'drawing as glass to bend. Deselect the jumper and try again.',
    };
  }

  const warnings: string[] = [];
  if (skippedOpen > 0) {
    warnings.push(
      `${skippedOpen} open run${skippedOpen === 1 ? '' : 's'} left untouched — only closed outlines merge.`,
    );
  }

  // Flatten first. `flatRunPoints` returns the raw points untouched when a
  // run has no arcs, so the common case costs nothing; when it does have
  // arcs it walks the closing segment too and lands back on points[0],
  // which `cleanRing` strips.
  let flattenedInputs = 0;
  let degenerateDropped = 0;
  const rings: Ring[] = [];
  for (const run of closed) {
    if (runHasArcs(run)) flattenedInputs += 1;
    const ring = dropCollinear(cleanRing(flatRunPoints(run)));
    if (ring.length < 3 || Math.abs(signedArea(ring)) < AREA_EPSILON_MM2) {
      degenerateDropped += 1;
      continue;
    }
    rings.push(ring);
  }
  if (rings.length < 2) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      degenerateDropped,
      error:
        'Not enough usable outlines to merge — a run needs three distinct vertices and some ' +
        'enclosed area to have an inside.',
    };
  }

  const polys = nestRings(rings);
  let result: [number, number][][][];
  try {
    // Always at least one martinez call, even for a single nested polygon:
    // union(P, P) is the identity and it normalises ring order and closure
    // on the way through, so there is exactly one output code path.
    let acc: [number, number][][][] = [polys[0].map(toMartinezRing)];
    if (polys.length === 1) {
      acc = toMultiPolygon(martinezUnion(acc, acc));
    } else {
      for (let i = 1; i < polys.length; i++) {
        acc = toMultiPolygon(martinezUnion(acc, [polys[i].map(toMartinezRing)]));
      }
    }
    result = acc;
  } catch (err) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      degenerateDropped,
      error:
        'The outline union failed on this geometry (' +
        (err instanceof Error ? err.message : String(err)) +
        '). Self-intersecting or zero-width outlines are the usual cause — try Simplify on ' +
        'the inputs first.',
    };
  }

  const out: { points: Ring; hole: boolean }[] = [];
  let sliverDropped = 0;
  for (const poly of result) {
    for (let ri = 0; ri < poly.length; ri++) {
      const hole = ri > 0;
      const ring = dropCollinear(cleanRing(poly[ri] as [number, number][]));
      if (ring.length < 3) continue;
      const a = signedArea(ring);
      if (Math.abs(a) < AREA_EPSILON_MM2) continue;
      if (Math.abs(a) < SLIVER_AREA_MM2) {
        sliverDropped += 1;
        continue;
      }
      // Renormalise winding: shells positive, holes negative. Martinez
      // hands holes back with the SAME sign as their shell, and the rest of
      // this codebase reads a counter's role off the opposite sign
      // (`fonts/outline.ts`). Safe to reverse here precisely because the
      // output has no arcs — reversing a run WITH arcs moves the bow to the
      // other side of the chord (CLAUDE.md, Bug #11).
      const wantPositive = !hole;
      out.push({ points: a > 0 === wantPositive ? ring : ring.slice().reverse(), hole });
    }
  }

  if (out.length === 0) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      degenerateDropped,
      sliverDropped,
      error: 'The union came back empty — nothing was merged.',
    };
  }

  const inRingCount = rings.length;
  const outerCount = out.filter((r) => !r.hole).length;
  const holeCount = out.length - outerCount;

  // Nothing merged: every input polygon came back as its own shell with its
  // own rings. Doing it anyway would only renumber the runs and throw away
  // their arcs, so decline and say why.
  //
  // Gated on there being two or more polygons to start with. A single
  // NESTED polygon (a square inside a square, an 'O' and its counter) also
  // comes back ring-for-ring, but that is not "nothing happened": it is the
  // op resolving the pair into a shell and a hole with the winding
  // convention the rest of the codebase reads, which is exactly what the
  // spec asks for.
  if (polys.length >= 2 && out.length === inRingCount && outerCount === polys.length) {
    return {
      ...EMPTY_PLAN,
      skippedOpen,
      degenerateDropped,
      sliverDropped,
      flattenedInputs,
      error:
        `Those ${closed.length} outlines do not overlap, so there is nothing to merge. ` +
        'Move them until they intersect (or nest one inside another) and try again.',
    };
  }

  // Index-addressed children. There is no honest remap: the vertex an
  // electrode sat on may now be inside the merged body, on no boundary at
  // all. Count them, drop them, say so.
  let droppedElectrodes = 0;
  let droppedBlockouts = 0;
  let droppedAnnotations = 0;
  let droppedBends = 0;
  let droppedDirections = 0;
  for (const r of closed) {
    droppedElectrodes += r.electrodes?.length ?? 0;
    droppedBlockouts += r.blockouts?.length ?? 0;
    droppedAnnotations += r.annotations?.length ?? 0;
    droppedBends += r.bends?.length ?? 0;
    if (r.direction) droppedDirections += 1;
  }

  // Carryable fields: unanimous or nothing. Picking one input's value is
  // how a channel-letter face silently stops emitting return-strip pages.
  const mixedFields: string[] = [];
  const carried: UnionCarry = {};
  const takeStr = (
    label: string,
    pick: (r: DesignRun) => string | undefined,
    set: (v: string) => void,
  ) => {
    const { agreed, value } = unanimous(closed.map((r) => normStr(pick(r))));
    if (!agreed) mixedFields.push(label);
    else if (value !== undefined) set(value);
  };
  const takeNum = (
    label: string,
    pick: (r: DesignRun) => number | undefined,
    set: (v: number) => void,
  ) => {
    const { agreed, value } = unanimous(closed.map((r) => pick(r)));
    if (!agreed) mixedFields.push(label);
    else if (value !== undefined) set(value);
  };

  takeStr('color', (r) => r.color, (v) => { carried.color = v; });
  takeStr('notes', (r) => r.notes, (v) => { carried.notes = v; });
  takeStr('raceway_id', (r) => r.raceway_id, (v) => { carried.raceway_id = v; });
  takeStr('group_id', (r) => r.group_id, (v) => { carried.group_id = v; });
  takeStr('kind', (r) => r.kind, (v) => { carried.kind = v as '' | 'jumper'; });
  takeNum('tube_diameter_mm', (r) => r.tube_diameter_mm, (v) => { carried.tube_diameter_mm = v; });
  takeNum(
    'channel_letter_depth_mm',
    (r) => r.channel_letter_depth_mm,
    (v) => { carried.channel_letter_depth_mm = v; },
  );
  {
    const { agreed, value } = unanimous(closed.map((r) => !!r.is_channel_letter_face));
    if (!agreed) mixedFields.push('is_channel_letter_face');
    else if (value) carried.is_channel_letter_face = true;
  }

  if (mixedFields.includes('is_channel_letter_face')) {
    warnings.push(
      'The inputs disagreed about being channel-letter faces, so the merged outline is NOT ' +
        'flagged as one — set it by hand if the face is what you wanted.',
    );
  }
  if (mixedFields.includes('raceway_id')) {
    warnings.push('The inputs carried different raceway IDs, so the merged outline is ungrouped.');
  }
  if (outerCount > 1) {
    // The honest warning for the tangency case in the header notes. Two
    // outlines that only TOUCH also land here, and so does a selection
    // where one pair overlaps and a third outline does not.
    warnings.push(
      `The union came apart into ${outerCount} separate outlines rather than one. Outlines ` +
        'that only touch do this, and so do two curves that run tangent instead of crossing — ' +
        'check the result before bending it.',
    );
  }
  if (sliverDropped > 0) {
    warnings.push(
      `Dropped ${sliverDropped} boundary fragment${sliverDropped === 1 ? '' : 's'} smaller than ` +
        `${SLIVER_AREA_MM2} mm² as numerical noise.`,
    );
  }

  return {
    runIds: closed.map((r) => r.id),
    skippedOpen,
    degenerateDropped,
    sliverDropped,
    flattenedInputs,
    outerCount,
    holeCount,
    droppedElectrodes,
    droppedBlockouts,
    droppedAnnotations,
    droppedBends,
    droppedDirections,
    carried,
    mixedFields,
    error: null,
    warnings,
    rings: out,
  };
}

/**
 * Replace two or more closed runs with the boundary of their union.
 *
 * Returns the same doc object (and a plan carrying `error`) whenever the
 * union cannot or should not run, so `applyOp`'s reference-identity check
 * makes it a genuine no-op rather than an undo entry that changed nothing.
 */
export function unionRuns(
  doc: DesignDoc,
  runIds: string[],
): { doc: DesignDoc; plan: UnionOutlinesPlan } {
  const plan = unionOutlinesPlan(doc, runIds);
  if (plan.error) return { doc, plan };

  const consumed = new Set(plan.runIds);
  // Ids are allocated against the ORIGINAL doc plus everything allocated so
  // far, so no emitted run can take the id of a run it replaced. Reusing an
  // id is how a stale selection ends up pointing at different geometry.
  const emitted: DesignRun[] = [];
  for (const ring of plan.rings) {
    const id = nextRunId({ ...doc, runs: [...doc.runs, ...emitted] });
    const run: DesignRun = { id, polyline: { points: ring.points, closed: true } };
    // No `segment_types`: the result is line segments, and an array of
    // 'line' entries would only be a longer way of saying the same thing
    // (and one more length the Go decoder can reject).
    if (plan.carried.color !== undefined) run.color = plan.carried.color;
    if (plan.carried.tube_diameter_mm !== undefined) {
      run.tube_diameter_mm = plan.carried.tube_diameter_mm;
    }
    if (plan.carried.notes !== undefined) run.notes = plan.carried.notes;
    if (plan.carried.is_channel_letter_face) run.is_channel_letter_face = true;
    if (plan.carried.channel_letter_depth_mm !== undefined) {
      run.channel_letter_depth_mm = plan.carried.channel_letter_depth_mm;
    }
    if (plan.carried.raceway_id !== undefined) run.raceway_id = plan.carried.raceway_id;
    if (plan.carried.group_id !== undefined) run.group_id = plan.carried.group_id;
    if (plan.carried.kind !== undefined) run.kind = plan.carried.kind;
    emitted.push(run);
  }

  // Splice the results in where the first consumed run sat, so the merged
  // outline keeps the draw order (and so the depth) its inputs had.
  const at = doc.runs.findIndex((r) => consumed.has(r.id));
  const runs: DesignRun[] = [];
  for (let i = 0; i < doc.runs.length; i++) {
    if (i === at) runs.push(...emitted);
    if (!consumed.has(doc.runs[i].id)) runs.push(doc.runs[i]);
  }
  return { doc: { ...doc, runs }, plan };
}
