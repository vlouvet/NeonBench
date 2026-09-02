import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints, type SegmentKind } from './arcGeom';
import * as ops from './docOps';
import * as onArtwork from './onArtwork';

const docOf = (...runs: DesignRun[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 600, 600],
  runs,
});

const line = (id: string, pts: [number, number][]): DesignRun => ({
  id,
  polyline: { points: pts, closed: false },
  tube_diameter_mm: 10,
});

function totalLengthMM(d: DesignDoc, ids?: string[]): number {
  return d.runs
    .filter((r) => !ids || ids.includes(r.id))
    .reduce((acc, r) => acc + ops.runLengthMM(r), 0);
}

// ---------------------------------------------------------------------------
// THE CHEATING CASE. This is the whole row.
//
// Two collinear fragments separated by 90mm of BLANK SIGN FACE, well inside
// any `near` an operator would reach for. Every metric says join them: one
// fewer run, one fewer transformer, and the takeoff gets shorter. The tube
// would leave the letters and cut across the face, and no number in the
// takeoff says so.
// ---------------------------------------------------------------------------
const gapped = () => docOf(
  line('a', [[0, 0], [100, 0]]),
  line('b', [[190, 0], [290, 0]]),
);

describe('Tier 2 #134 — a hop across blank face is refused', () => {
  it('declines two collinear fragments with blank face between them', () => {
    const out = ops.joinRunsAlongArtwork(gapped(), ['a', 'b'], { nearMM: 120 });
    expect(out.joined).toBe(0);
    expect(out.doc.runs).toHaveLength(2);
    expect(out.refusedOffArtwork).toBe(1);
  });

  it('reports the refused hop so the operator can see what it declined', () => {
    const out = ops.joinRunsAlongArtwork(gapped(), ['a', 'b'], { nearMM: 120 });
    expect(out.refused).toHaveLength(1);
    expect(out.refused[0].gapMM).toBeCloseTo(90, 6);
    // The worst sample sits mid-gap, ~45mm off the nearest glass.
    expect(out.refused[0].worstOffsetMM).toBeGreaterThan(40);
  });

  it('joins the same pair once a third run puts glass under the hop', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
      line('c', [[95, 0], [195, 0]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: 120 });
    expect(out.refusedOffArtwork).toBe(0);
    expect(out.joined).toBe(1);
  });

  it('refuses the diagonal shortcut across the middle of a design', () => {
    // Two parallel strokes 150mm apart. Their far ends are 250mm apart, so a
    // generous `near` reaches — and joining them would halve the run count,
    // shorten the takeoff and delete a transformer, all by drawing a tube
    // diagonally over blank face.
    const doc = docOf(
      line('a', [[0, 0], [200, 0]]),
      line('b', [[0, 150], [200, 150]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: 300 });
    expect(out.joined).toBe(0);
    expect(out.refusedOffArtwork).toBeGreaterThan(0);
    expect(out.runsAfter).toBe(2);
  });

  it('cannot be tuned out of the way with a huge corridor', () => {
    // "The run count is still too high" has an obvious and wrong fix. The cap
    // is what stops it, so it is pinned here rather than left to good taste.
    const out = ops.joinRunsAlongArtwork(gapped(), ['a', 'b'], {
      nearMM: 120,
      corridorDiameters: 1000,
    });
    expect(out.joined).toBe(0);
    expect(out.refusedOffArtwork).toBe(1);
    expect(out.corridorMM).toBe(onArtwork.HOP_CORRIDOR_MAX_DIAMETERS * 10);
  });

  it('states the corridor and sample interval it actually used', () => {
    // Both derive from the tube, not from absolute millimetres — the panel
    // shows these numbers, so the op has to hand them back.
    const doc = docOf(
      { ...line('a', [[0, 0], [100, 0]]), tube_diameter_mm: 8 },
      { ...line('b', [[100, 0], [100, 80]]), tube_diameter_mm: 15 },
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b']);
    // The widest tube in the selection is the one that has to fit.
    expect(out.corridorMM).toBeCloseTo(onArtwork.HOP_CORRIDOR_DIAMETERS * 15, 9);
    expect(out.sampleMM).toBeCloseTo(onArtwork.HOP_SAMPLE_DIAMETERS * 15, 9);
  });
});

describe('Tier 2 #134 — the accepted welds', () => {
  it('welds ends that already meet, exactly as #128 would', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b']);
    expect(out.joined).toBe(1);
    expect(out.doc.runs).toHaveLength(1);
    // Seam vertex dropped, and not one millimetre of glass invented.
    expect(out.doc.runs[0].polyline.points).toHaveLength(3);
    expect(totalLengthMM(out.doc)).toBeCloseTo(totalLengthMM(doc), 9);
  });

  it('adds exactly the hop it travelled, and says so in the takeoff', () => {
    // A weld across a real gap ADDS glass — the travel is tube. The naive
    // join's headline "less glass" came from the runs getting longer while the
    // count fell, so it is worth pinning that this op's arithmetic goes the
    // honest way.
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[120, 0], [220, 0]]),
      line('bridge', [[95, 0], [125, 0]]),
    );
    const before = totalLengthMM(doc, ['a', 'b']);
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: 40 });
    expect(out.joined).toBe(1);
    const after = ops.runLengthMM(out.doc.runs.find((r) => r.id === 'a')!);
    expect(after).toBeCloseTo(before + 20, 9);
  });

  it('chains a whole stroke into one tube in a single call', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 80], [0, 80]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b', 'c']);
    expect(out.joined).toBe(2);
    expect(out.doc.runs).toHaveLength(1);
    expect(totalLengthMM(out.doc)).toBeCloseTo(totalLengthMM(doc), 9);
  });

  it('touches nothing outside the selection', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
      line('c', [[100, 80], [0, 80]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b']);
    expect(out.joined).toBe(1);
    expect(out.doc.runs.map((r) => r.id)).toEqual(['a', 'c']);
  });

  it('skips closed runs and says how many', () => {
    const doc = docOf(
      { ...line('sq', [[0, 0], [50, 0], [50, 50], [0, 50]]), polyline: { points: [[0, 0], [50, 0], [50, 50], [0, 50]], closed: true } },
      line('a', [[0, 0], [100, 0]]),
    );
    const out = ops.joinRunsAlongArtwork(doc, ['sq', 'a']);
    expect(out.skippedClosed).toBe(1);
    expect(out.joined).toBe(0);
  });

  it('hands back the SAME doc reference when nothing welded', () => {
    // editDoc's identity guard skips the undo push and the dirty flag on it,
    // so a refused op must not manufacture a new object.
    const doc = gapped();
    expect(ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: 120 }).doc).toBe(doc);
  });

  it('declines rather than welds on a NaN reach', () => {
    const doc = docOf(
      line('a', [[0, 0], [100, 0]]),
      line('b', [[100, 0], [100, 80]]),
    );
    expect(ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: NaN }).joined).toBe(0);
    expect(ops.joinRunsAlongArtwork(doc, ['a', 'b'], { nearMM: -1 }).joined).toBe(0);
  });
});

describe('Tier 2 #134 — determinism', () => {
  const spread = () => docOf(
    line('a', [[0, 0], [100, 0]]),
    line('b', [[100, 0], [100, 80]]),
    line('c', [[100, 80], [0, 80]]),
    line('d', [[0, 80], [0, 0]]),
  );

  it('welds the same way whatever order the operator shift-clicked', () => {
    const shape = (ids: string[]) => JSON.stringify(
      ops.joinRunsAlongArtwork(spread(), ids).doc.runs,
    );
    const forward = shape(['a', 'b', 'c', 'd']);
    expect(shape(['d', 'c', 'b', 'a'])).toBe(forward);
    expect(shape(['c', 'a', 'd', 'b'])).toBe(forward);
    expect(shape(['b', 'd', 'a', 'c'])).toBe(forward);
  });

  it('is idempotent — a second click changes nothing', () => {
    const once = ops.joinRunsAlongArtwork(spread(), ['a', 'b', 'c', 'd']);
    const twice = ops.joinRunsAlongArtwork(once.doc, once.doc.runs.map((r) => r.id));
    expect(twice.joined).toBe(0);
    expect(twice.doc).toBe(once.doc);
  });
});

describe('Tier 2 #134 — what a chained join has to carry', () => {
  // CLAUDE.md bug class 1. This op changes point count and point order through
  // joinRuns, so every field that indexes into or describes those points has
  // to survive. joinRuns owns the logic; this asserts it anyway, because both
  // segment_types (Bug #14) and the classification carry (Bug #15) have
  // regressed here before, and a chained join is the shape that exercises the
  // second fold against an already-merged run.
  const arcy = (id: string, pts: [number, number][], types: SegmentKind[]): DesignRun => ({
    id,
    polyline: { points: pts, closed: false, segment_types: types },
    tube_diameter_mm: 10,
    is_channel_letter_face: true,
    channel_letter_depth_mm: 90,
    raceway_id: 'rw1',
    group_id: 'g1',
  });

  const chain = () => docOf(
    arcy('a', [[0, 0], [100, 0], [200, 0]], ['arc', 'line']),
    arcy('b', [[200, 0], [300, 0], [400, 0]], ['line', 'arc_r']),
    arcy('c', [[400, 0], [500, 0]], ['arc']),
  );

  it('keeps segment_types well formed and the drawn glass unmoved', () => {
    const doc = chain();
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b', 'c']);
    expect(out.joined).toBe(2);
    const merged = out.doc.runs[0];
    expect(ops.segmentTypesWellFormed(merged)).toBe(true);
    expect(merged.polyline.segment_types).toHaveLength(merged.polyline.points.length - 1);

    // The geometric invariant, per CLAUDE.md: field assertions pass while the
    // drawn shape is wrong. flatRunPoints is the shape.
    const drawnBefore = doc.runs.flatMap((r) => flatRunPoints(r).map((p) => p.join(',')));
    const drawnAfter = flatRunPoints(merged).map((p) => p.join(','));
    // The seams are dropped duplicates, so the merged walk is the three walks
    // minus one point per seam.
    expect(drawnAfter).toHaveLength(drawnBefore.length - 2);
    expect(new Set(drawnAfter)).toEqual(new Set(drawnBefore));

    // Glass is conserved: every weld here is on a coincident endpoint.
    expect(ops.runLengthMM(merged)).toBeCloseTo(totalLengthMM(doc), 6);
  });

  it('keeps the classification that drives the return-strip pages', () => {
    const out = ops.joinRunsAlongArtwork(chain(), ['a', 'b', 'c']);
    const merged = out.doc.runs[0];
    expect(merged.is_channel_letter_face).toBe(true);
    expect(merged.channel_letter_depth_mm).toBe(90);
    expect(merged.raceway_id).toBe('rw1');
    expect(merged.group_id).toBe('g1');
    expect(merged.tube_diameter_mm).toBe(10);
  });

  it('remaps electrodes onto the same physical points', () => {
    const doc = docOf(
      { ...line('a', [[0, 0], [100, 0]]), electrodes: [{ point_index: 0 }] },
      { ...line('b', [[100, 0], [200, 0]]), electrodes: [{ point_index: 1 }] },
    );
    const out = ops.joinRunsAlongArtwork(doc, ['a', 'b']);
    const merged = out.doc.runs[0];
    const at = (i: number) => merged.polyline.points[i];
    const where = (merged.electrodes ?? []).map((e) => at(e.point_index).join(','));
    expect(new Set(where)).toEqual(new Set(['0,0', '200,0']));
  });
});

// ---------------------------------------------------------------------------
// The sweep. The naive join's whole appeal was that loosening `near` kept
// making every number better; this asserts that under the constraint it stops
// making them better, and that the thing it stops at is the artwork.
// ---------------------------------------------------------------------------
describe('Tier 2 #134 — loosening the reach cannot break the on-artwork floor', () => {
  // Two clusters of fragments, each internally continuous, 150mm of blank
  // face apart. Inside a cluster the fragments nearly meet; between them
  // there is nothing but sign face.
  const cluster = (tag: string, dx: number): DesignRun[] => [
    line(`${tag}1`, [[dx + 0, 0], [dx + 0, 100]]),
    line(`${tag}2`, [[dx + 2, 98], [dx + 50, 0]]),
    line(`${tag}3`, [[dx + 52, 2], [dx + 100, 100]]),
    line(`${tag}4`, [[dx + 100, 98], [dx + 100, 0]]),
  ];
  const fragmented = () => docOf(...cluster('l', 0), ...cluster('r', 250));
  const allIds = fragmented().runs.map((r) => r.id);

  it('floors at the number of things the artwork actually connects', () => {
    const counts = [5, 35, 90, 150, 200, 400].map((nearMM) => {
      const out = ops.joinRunsAlongArtwork(fragmented(), allIds, { nearMM });
      return { nearMM, runs: out.runsAfter, refused: out.refusedOffArtwork };
    });

    // Loosening never increases the run count...
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i].runs).toBeLessThanOrEqual(counts[i - 1].runs);
    }
    // ...and never gets below two, because the two clusters are not connected
    // by glass. The naive join reaches one here, and every metric applauds.
    for (const c of counts) {
      expect(c.runs, `near=${c.nearMM}mm broke the floor`).toBeGreaterThanOrEqual(2);
    }
    expect(counts[counts.length - 1].runs).toBe(2);

    // NEGATIVE CONTROL: the floor would be meaningless if the cross-face hop
    // were simply out of reach. At the widest sweep it is well within reach
    // and it is REFUSED — which is the only reason the count stopped at two.
    expect(counts[counts.length - 1].refused).toBeGreaterThan(0);
  });

  it('reports the refusal instead of quietly returning a tidy number', () => {
    const out = ops.joinRunsAlongArtwork(fragmented(), allIds, { nearMM: 400 });
    expect(out.refused.length).toBe(out.refusedOffArtwork);
    // Worst offender first, so a panel can name the worst one.
    for (let i = 1; i < out.refused.length; i++) {
      expect(out.refused[i - 1].worstOffsetMM).toBeGreaterThanOrEqual(out.refused[i].worstOffsetMM);
    }
    expect(out.refused[0].worstOffsetMM).toBeGreaterThan(out.corridorMM);
  });
});
