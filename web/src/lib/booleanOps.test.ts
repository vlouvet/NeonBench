import { describe, expect, it } from 'vitest';
import { union as martinezUnion } from 'martinez-polygon-clipping';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints, runHasArcs } from './arcGeom';
import { neonize } from './docOps';
import { nestRings, unionOutlinesPlan, unionRuns, type Ring } from './booleanOps';

// ── fixtures ─────────────────────────────────────────────────────────────

/** A closed axis-aligned square, straight segments only, no closing
 *  duplicate — the shape a `closed: true` run stores. */
function sq(id: string, x: number, y: number, w: number, h = w, extra: Partial<DesignRun> = {}): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      closed: true,
    },
    ...extra,
  };
}

function docOf(...runs: DesignRun[]): DesignDoc {
  return { version: 1, view_box_mm: [0, 0, 200, 200], runs };
}

/** Shoelace area of a ring with no closing duplicate. */
function area(points: [number, number][]): number {
  let a = 0;
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const p = points[i];
    const q = points[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

const ringOf = (r: DesignRun): Ring => r.polyline.points;

// ── the golden case ──────────────────────────────────────────────────────

describe('unionRuns — overlapping outlines', () => {
  it('merges two overlapping squares into one 8-vertex outline of the right area', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 5, 5, 10));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);

    expect(plan.error).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(after.runs[0].polyline.closed).toBe(true);
    // L-shaped union: 100 + 100 - 25 overlap.
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(175, 6);
    // Eight corners, and no more: the two co-linear crossing points martinez
    // leaves behind are cleaned off.
    expect(after.runs[0].polyline.points).toHaveLength(8);
    // Neither input survives, and neither id is reused.
    expect(after.runs.map((r) => r.id)).not.toContain('r1');
    expect(after.runs.map((r) => r.id)).not.toContain('r2');
  });

  it('emits line segments only — no segment_types on any result run', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 5, 5, 10));
    const { doc: after } = unionRuns(doc, ['r1', 'r2']);
    for (const r of after.runs) {
      expect(r.polyline.segment_types).toBeUndefined();
      expect(runHasArcs(r)).toBe(false);
    }
  });

  it('keeps the merged outline at the draw-order slot of the first input', () => {
    const doc = docOf(sq('a', 100, 100, 5), sq('r1', 0, 0, 10), sq('r2', 5, 5, 10), sq('z', 150, 150, 5));
    const { doc: after } = unionRuns(doc, ['r1', 'r2']);
    expect(after.runs.map((r) => r.id)[0]).toBe('a');
    expect(after.runs.map((r) => r.id)[after.runs.length - 1]).toBe('z');
    expect(after.runs).toHaveLength(3);
  });
});

// ── the cases that break naive implementations ───────────────────────────

describe('unionRuns — the hard geometry', () => {
  it('leaves disjoint outlines alone and returns the SAME doc object', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 20, 0, 10));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(after).toBe(doc); // reference identity: applyOp treats this as a no-op
    expect(plan.error).toMatch(/do not overlap/i);
  });

  it('treats squares touching at a single vertex as disjoint, not merged', () => {
    // (0,0)-(10,10) and (10,10)-(20,20) share exactly one corner. A naive
    // sweep either merges them into a self-touching figure-8 or crashes.
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 10, 10, 10));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(after).toBe(doc);
    expect(plan.error).toMatch(/do not overlap/i);
  });

  it('merges two squares that share a full co-linear edge into one rectangle', () => {
    // (0,0,10,10) and (10,0,10,10) share the whole x = 10 edge. The union is
    // a 20 x 10 rectangle with FOUR corners — the two mid-edge vertices at
    // (10,0) and (10,10) are co-linear artefacts of the seam.
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 10, 0, 10));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(plan.error).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(200, 6);
    expect(after.runs[0].polyline.points).toHaveLength(4);
  });

  it('merges a partial co-linear edge overlap without losing the step', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 10, 5, 10));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(plan.error).toBeNull();
    expect(after.runs).toHaveLength(1);
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(200, 6);
    // Eight corners: two squares joined along half an edge.
    expect(after.runs[0].polyline.points).toHaveLength(8);
  });
});

// ── holes ────────────────────────────────────────────────────────────────

describe('unionRuns — holes survive', () => {
  it('reads a square nested in a square as a shell plus one hole', () => {
    const doc = docOf(sq('outer', 0, 0, 30), sq('inner', 10, 10, 10));
    const { doc: after, plan } = unionRuns(doc, ['outer', 'inner']);
    expect(plan.error).toBeNull();
    expect(plan.outerCount).toBe(1);
    expect(plan.holeCount).toBe(1);
    expect(after.runs).toHaveLength(2);
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(900, 6);
    expect(Math.abs(area(after.runs[1].polyline.points))).toBeCloseTo(100, 6);
    // Convention shared with fonts/outline.ts: a counter's winding is the
    // opposite of its shell's, so a filled renderer knocks it out.
    expect(Math.sign(area(after.runs[0].polyline.points))).toBe(
      -Math.sign(area(after.runs[1].polyline.points)),
    );
  });

  it("keeps BOTH counters when two 'O' rings overlap", () => {
    // Two annuli, each an outer 30x30 with a 10x10 counter, overlapping by
    // 5 mm. This is the case the feature exists for: script 'oo'.
    const doc = docOf(
      sq('o1', 0, 0, 30),
      sq('c1', 10, 10, 10),
      sq('o2', 25, 0, 30),
      sq('c2', 35, 10, 10),
    );
    const { doc: after, plan } = unionRuns(doc, ['o1', 'c1', 'o2', 'c2']);
    expect(plan.error).toBeNull();
    expect(plan.outerCount).toBe(1);
    expect(plan.holeCount).toBe(2);
    expect(after.runs).toHaveLength(3);
    // 900 + 900 - (5 x 30 overlap) = 1650 for the shell.
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(1650, 6);
    expect(Math.abs(area(after.runs[1].polyline.points))).toBeCloseTo(100, 6);
    expect(Math.abs(area(after.runs[2].polyline.points))).toBeCloseTo(100, 6);
  });

  it('clips a counter that the neighbouring glyph body covers', () => {
    // o2's body runs over the right half of c1, and o1's body over the left
    // half of c2. The surviving holes are the uncovered halves — 50 mm²
    // each, not 100. Getting this wrong fills a counter in solid.
    const doc = docOf(
      sq('o1', 0, 0, 30),
      sq('c1', 10, 10, 10),
      sq('o2', 15, 0, 30),
      sq('c2', 25, 10, 10),
    );
    const { plan } = unionRuns(doc, ['o1', 'c1', 'o2', 'c2']);
    expect(plan.error).toBeNull();
    expect(plan.holeCount).toBe(2);
    const holes = plan.rings.filter((r) => r.hole).map((r) => Math.abs(area(r.points)));
    expect(holes[0]).toBeCloseTo(50, 6);
    expect(holes[1]).toBeCloseTo(50, 6);
  });

  it('NEGATIVE CONTROL: skipping the nesting step gets the same case wrong', () => {
    // The proof that `nestRings` is load-bearing rather than decorative.
    // Handing martinez the four rings as ONE polygon applies even-odd across
    // the whole selection, so the two glyph bodies cancel where they
    // overlap. If this ever starts agreeing with the nested answer, the
    // library changed semantics and the test above stopped meaning anything.
    const rings: Ring[] = [
      ringOf(sq('o1', 0, 0, 30)),
      ringOf(sq('c1', 10, 10, 10)),
      ringOf(sq('o2', 25, 0, 30)),
      ringOf(sq('c2', 35, 10, 10)),
    ];
    const close = (r: Ring) => [...r, r[0]] as [number, number][];
    const flat = rings.map(close);
    const naive = martinezUnion(flat, flat) as [number, number][][][];
    const nested = nestRings(rings);
    expect(nested).toHaveLength(2); // two shells, one counter each
    expect(nested[0]).toHaveLength(2);
    expect(nested[1]).toHaveLength(2);
    // The un-nested call does NOT produce one shell of 1650.
    const naiveShells = naive.map((p) => Math.abs(area(p[0].slice(0, -1))));
    expect(naiveShells).not.toContain(1650);
    expect(naive.length).toBeGreaterThan(1);
  });
});

// ── arcs ─────────────────────────────────────────────────────────────────

describe('unionRuns — arcs are flattened, and the result says so', () => {
  // A closed 4-vertex run whose every segment bows OUTWARD: a rounded blob,
  // the shape of a fat 'O'. 'arc_r' is the outward side for this vertex
  // order — 'arc' bows toward (-dy, dx), which for these points is inward.
  function blob(id: string, x: number, y: number, s = 20): DesignRun {
    return {
      id,
      polyline: {
        points: [
          [x, y],
          [x + s, y],
          [x + s, y + s],
          [x, y + s],
        ],
        closed: true,
        segment_types: ['arc_r', 'arc_r', 'arc_r', 'arc_r'],
      },
    };
  }

  it('unions arc runs through their flattened outline, not their chords', () => {
    const a = blob('a', 0, 0);
    const b = blob('b', 10, 0);
    const doc = docOf(a, b);
    const { doc: after, plan } = unionRuns(doc, ['a', 'b']);

    expect(plan.error).toBeNull();
    expect(plan.flattenedInputs).toBe(2);
    expect(after.runs).toHaveLength(1);

    // The arc-aware measure is the one that matters (CLAUDE.md class 1): the
    // union must be bigger than either flattened input, and bigger than the
    // chord-polygon union a naive implementation would compute — an outward
    // bow puts real area outside the chord that the chords cannot see.
    const flatA = Math.abs(area(flatRunPoints(a) as [number, number][]));
    const merged = Math.abs(area(after.runs[0].polyline.points));
    expect(flatA).toBeGreaterThan(Math.abs(area(a.polyline.points))); // sanity: bows outward
    expect(merged).toBeGreaterThan(flatA);
    const chordUnion = 400 + 400 - 200; // two 20x20 chord squares overlapping by 10 mm
    expect(merged).toBeGreaterThan(chordUnion);

    // And the curve is still there as vertices, not as a 4-corner box.
    expect(after.runs[0].polyline.points.length).toBeGreaterThan(40);
  });

  it('drops segment_types rather than claiming a bulge it did not compute', () => {
    const doc = docOf(blob('a', 0, 0), blob('b', 10, 0));
    const { doc: after } = unionRuns(doc, ['a', 'b']);
    expect(after.runs[0].polyline.segment_types).toBeUndefined();
  });

  it('does not straighten a flattened arc when cleaning co-linear vertices', () => {
    const a = blob('a', 0, 0);
    const flatCount = flatRunPoints(a).length;
    const doc = docOf(a, blob('b', 10, 0));
    const { doc: after } = unionRuns(doc, ['a', 'b']);
    // Both blobs contribute most of their sampled arc vertices; a
    // co-linearity pass that could not tell a chord from a circle would
    // collapse this to a handful.
    expect(after.runs[0].polyline.points.length).toBeGreaterThan(flatCount);
  });

  it('WARNS instead of pretending, when two arcs are exactly tangent', () => {
    // A known martinez 0.8.1 limitation, probed against the raw library:
    // two inward-bowed squares 10 mm apart put their facing arcs tangent at
    // exactly one point, and the union comes back as the main body plus
    // eight ~0.5 mm² slivers with ~0.9% of the area missing. Nothing here
    // can fix that; what it must not do is hand the bench nine runs with no
    // explanation. Delete this test only when the library stops doing it.
    function inward(id: string, x: number): DesignRun {
      return {
        id,
        polyline: {
          points: [[x, 0], [x + 20, 0], [x + 20, 20], [x, 20]],
          closed: true,
          segment_types: ['arc', 'arc', 'arc', 'arc'],
        },
      };
    }
    const { plan } = unionRuns(docOf(inward('a', 0), inward('b', 10)), ['a', 'b']);
    expect(plan.error).toBeNull();
    expect(plan.outerCount).toBeGreaterThan(1);
    expect(plan.warnings.join(' ')).toMatch(/tangent/i);
  });
});

// ── the carry-and-remap table ────────────────────────────────────────────

describe('unionRuns — classification carry', () => {
  it('face union face is still a face, and carries depth / raceway / group / kind', () => {
    const extra: Partial<DesignRun> = {
      is_channel_letter_face: true,
      channel_letter_depth_mm: 90,
      raceway_id: 'raceway-1',
      group_id: 'g1',
      kind: '',
      color: '#ff0000',
      tube_diameter_mm: 15,
    };
    const doc = docOf(sq('r1', 0, 0, 10, 10, extra), sq('r2', 5, 5, 10, 10, extra));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(plan.mixedFields).toEqual([]);
    const out = after.runs[0];
    expect(out.is_channel_letter_face).toBe(true);
    expect(out.channel_letter_depth_mm).toBe(90);
    expect(out.raceway_id).toBe('raceway-1');
    expect(out.group_id).toBe('g1');
    expect(out.color).toBe('#ff0000');
    expect(out.tube_diameter_mm).toBe(15);
  });

  it('puts the face flag on the counters too — an O needs an inner return', () => {
    const face: Partial<DesignRun> = { is_channel_letter_face: true, channel_letter_depth_mm: 90 };
    const doc = docOf(
      sq('o1', 0, 0, 30, 30, face),
      sq('c1', 10, 10, 10, 10, face),
      sq('o2', 25, 0, 30, 30, face),
      sq('c2', 35, 10, 10, 10, face),
    );
    const { doc: after } = unionRuns(doc, ['o1', 'c1', 'o2', 'c2']);
    expect(after.runs).toHaveLength(3);
    for (const r of after.runs) {
      expect(r.is_channel_letter_face).toBe(true);
      expect(r.channel_letter_depth_mm).toBe(90);
    }
  });

  it('drops a field the inputs disagree on rather than picking one silently', () => {
    const doc = docOf(
      sq('r1', 0, 0, 10, 10, { is_channel_letter_face: true, raceway_id: 'raceway-1' }),
      sq('r2', 5, 5, 10, 10, { raceway_id: 'raceway-2' }),
    );
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(plan.mixedFields).toContain('is_channel_letter_face');
    expect(plan.mixedFields).toContain('raceway_id');
    expect(after.runs[0].is_channel_letter_face).toBeUndefined();
    expect(after.runs[0].raceway_id).toBeUndefined();
    expect(plan.warnings.join(' ')).toMatch(/channel-letter/i);
    expect(plan.warnings.join(' ')).toMatch(/raceway/i);
  });

  it('emits no optional keys at all when the inputs carried none', () => {
    // The back-compat invariant: a pre-#98 doc merged here still serialises
    // to the minimal shape the Go decoder round-trips byte-identically.
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 5, 5, 10));
    const { doc: after } = unionRuns(doc, ['r1', 'r2']);
    expect(Object.keys(after.runs[0]).sort()).toEqual(['id', 'polyline']);
  });
});

describe('unionRuns — what it refuses and what it drops', () => {
  it('refuses to merge a jumper into a live tube', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('j1', 5, 5, 10, 10, { kind: 'jumper' }));
    const { doc: after, plan } = unionRuns(doc, ['r1', 'j1']);
    expect(after).toBe(doc);
    expect(plan.error).toMatch(/jumper/i);
  });

  it('drops indexed children explicitly and reports the count', () => {
    const doc = docOf(
      sq('r1', 0, 0, 10, 10, {
        electrodes: [{ point_index: 0 }, { point_index: 2 }],
        blockouts: [{ start_live_index: 0, end_live_index: 1 }],
        annotations: [{ kind: 'jump', live_index: 1 }],
        bends: [{ live_index: 1 }],
        direction: 'forward',
      }),
      sq('r2', 5, 5, 10, 10, { electrodes: [{ point_index: 1 }] }),
    );
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2']);
    expect(plan.droppedElectrodes).toBe(3);
    expect(plan.droppedBlockouts).toBe(1);
    expect(plan.droppedAnnotations).toBe(1);
    expect(plan.droppedBends).toBe(1);
    expect(plan.droppedDirections).toBe(1);
    // Dropped means dropped — never a garbage index into vertices that no
    // longer exist.
    for (const r of after.runs) {
      expect(r.electrodes).toBeUndefined();
      expect(r.blockouts).toBeUndefined();
      expect(r.annotations).toBeUndefined();
      expect(r.bends).toBeUndefined();
      expect(r.direction).toBeUndefined();
    }
  });

  it('is a no-op below two closed runs', () => {
    const doc = docOf(sq('r1', 0, 0, 10));
    expect(unionRuns(doc, ['r1']).doc).toBe(doc);
    expect(unionRuns(doc, []).doc).toBe(doc);
    const withOpen = docOf(sq('r1', 0, 0, 10), {
      id: 'open',
      polyline: { points: [[0, 0], [5, 5]], closed: false },
    });
    const { doc: after, plan } = unionRuns(withOpen, ['r1', 'open']);
    expect(after).toBe(withOpen);
    expect(plan.skippedOpen).toBe(1);
    expect(plan.error).toMatch(/closed/i);
  });

  it('drops a degenerate outline instead of handing martinez a zero-area ring', () => {
    // A zero-area ring THROWS inside martinez 0.8.1 ("Cannot read properties
    // of undefined (reading 'holeOf')"), so the filter is not cosmetic.
    const sliver: DesignRun = {
      id: 'z',
      polyline: { points: [[0, 0], [10, 0], [5, 0]], closed: true },
    };
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 5, 5, 10), sliver);
    const { doc: after, plan } = unionRuns(doc, ['r1', 'r2', 'z']);
    expect(plan.degenerateDropped).toBe(1);
    expect(plan.error).toBeNull();
    expect(Math.abs(area(after.runs[0].polyline.points))).toBeCloseTo(175, 6);
  });
});

// ── the trap that makes the library usable ───────────────────────────────

describe('martinez-polygon-clipping 0.8.1 contract', () => {
  it('needs the closing duplicate vertex — omitting it silently computes a different shape', () => {
    const open = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ] as [number, number][];
    const open2 = [
      [5, 5],
      [15, 5],
      [15, 15],
      [5, 15],
    ] as [number, number][];
    const closedA = [...open, open[0]] as [number, number][];
    const closedB = [...open2, open2[0]] as [number, number][];

    const wrong = martinezUnion([open], [open2]) as [number, number][][][];
    const right = martinezUnion([closedA], [closedB]) as [number, number][][][];
    expect(Math.abs(area(right[0][0].slice(0, -1)))).toBeCloseTo(175, 6);
    expect(Math.abs(area(wrong[0][0].slice(0, -1)))).not.toBeCloseTo(175, 6);
  });

  it('throws on a zero-area ring', () => {
    expect(() =>
      martinezUnion(
        [[[0, 0], [10, 0], [0, 0]]],
        [[[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]],
      ),
    ).toThrow();
  });
});

// ── the consumer test ────────────────────────────────────────────────────

describe('unionRuns feeds Neonize', () => {
  it('turns two overlapping outlines into ONE continuous tube path', () => {
    // The whole point of the feature. Two overlapping letter bodies Neonized
    // separately give two independent double-stroke pairs — four runs the
    // bender has to splice. Merged first, Neonize sees one boundary.
    const doc = docOf(sq('r1', 0, 0, 40), sq('r2', 25, 0, 40));

    const separate = neonize(neonize(doc, 'r1', 6).doc, 'r2', 6).doc;
    const { doc: merged } = unionRuns(doc, ['r1', 'r2']);
    expect(merged.runs).toHaveLength(1);
    const neonized = neonize(merged, merged.runs[0].id, 6, { stitch: true }).doc;

    // Neonize on a closed run emits an outer and an inner offset; stitched,
    // it emits ONE run. Either way the merged input yields strictly fewer
    // runs than Neonizing the two overlapping outlines separately.
    expect(neonized.runs.length).toBeLessThan(separate.runs.length);
    expect(neonized.runs).toHaveLength(1);
    expect(neonized.runs[0].polyline.points.length).toBeGreaterThan(4);
    // Nothing carries a stale curve claim through the whole chain.
    for (const r of neonized.runs) expect(r.polyline.segment_types).toBeUndefined();
  });
});

// ── plan ─────────────────────────────────────────────────────────────────

describe('unionOutlinesPlan', () => {
  it('reports the same numbers the op applies', () => {
    const doc = docOf(sq('o1', 0, 0, 30), sq('c1', 10, 10, 10), sq('o2', 25, 0, 30), sq('c2', 35, 10, 10));
    const ids = ['o1', 'c1', 'o2', 'c2'];
    const plan = unionOutlinesPlan(doc, ids);
    const { doc: after } = unionRuns(doc, ids);
    expect(plan.outerCount + plan.holeCount).toBe(after.runs.length);
    expect(plan.runIds).toEqual(ids);
  });

  it('does not mutate the doc it is planning against', () => {
    const doc = docOf(sq('r1', 0, 0, 10), sq('r2', 5, 5, 10));
    const before = JSON.stringify(doc);
    unionOutlinesPlan(doc, ['r1', 'r2']);
    expect(JSON.stringify(doc)).toBe(before);
  });
});
