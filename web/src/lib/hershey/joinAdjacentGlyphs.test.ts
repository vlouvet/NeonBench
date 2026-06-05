import { describe, expect, it } from 'vitest';
import { joinAdjacentGlyphs } from './joinAdjacentGlyphs';
import { hersheyTextToRuns, type HersheyRun } from './text';

const CAP = 100; // mm — convenient reference for these tests

describe('joinAdjacentGlyphs', () => {
  it('joins two horizontally-adjacent stub glyphs at the same Y', () => {
    // Two synthetic single-stroke "glyphs" with endpoints sitting at the
    // same Y and a small X gap — the canonical cursive join case.
    const prev: HersheyRun[] = [{ points: [[0, 4], [20, 4]] }];
    const next: HersheyRun[] = [{ points: [[28, 4], [50, 4]] }];
    const { joined, joinedStrokes } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(true);
    // One merged run (both stubs are single-stroke).
    expect(joinedStrokes.length).toBe(1);
    const merged = joinedStrokes[0].points;
    // First point is prev's first point, last point is next's last point.
    expect(merged[0]).toEqual([0, 4]);
    expect(merged[merged.length - 1]).toEqual([50, 4]);
    // Bridge contributes 3 interior vertices, so length should be
    // prev.length (2) + 3 bridge + next.length (2) = 7.
    expect(merged.length).toBe(7);
    // All interior points lie within the X range of the gap (roughly).
    // Tangent extension can push samples slightly past the endpoints, so
    // allow a 25% slop on each side of the chord.
    const minX = -5;
    const maxX = 55;
    for (const [x, y] of merged) {
      expect(x).toBeGreaterThanOrEqual(minX);
      expect(x).toBeLessThanOrEqual(maxX);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('refuses to join when the X gap exceeds maxJoinDistance', () => {
    // 200mm gap at capHeightMM=100 → exceeds default 1.5×cap = 150mm.
    const prev: HersheyRun[] = [{ points: [[0, 4], [20, 4]] }];
    const next: HersheyRun[] = [{ points: [[220, 4], [240, 4]] }];
    const { joined, joinedStrokes } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(false);
    // Passthrough: both originals returned unchanged.
    expect(joinedStrokes.length).toBe(2);
    expect(joinedStrokes[0].points).toEqual(prev[0].points);
    expect(joinedStrokes[1].points).toEqual(next[0].points);
  });

  it('refuses to join when the Y drop exceeds maxJoinDrop', () => {
    // Y delta = 80mm > default 0.5×cap = 50mm.
    const prev: HersheyRun[] = [{ points: [[0, 4], [20, 4]] }];
    const next: HersheyRun[] = [{ points: [[30, 84], [50, 84]] }];
    const { joined } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(false);
  });

  it('respects custom maxJoinDistance / maxJoinDrop options', () => {
    // Same geometry as the refusing tests above, but with overridden
    // thresholds that allow the join.
    const prev: HersheyRun[] = [{ points: [[0, 4], [20, 4]] }];
    const next: HersheyRun[] = [{ points: [[220, 84], [240, 84]] }];
    const { joined } = joinAdjacentGlyphs(prev, next, {
      capHeightMM: CAP,
      maxJoinDistance: 250,
      maxJoinDrop: 100,
    });
    expect(joined).toBe(true);
  });

  it('returns joined:false on empty glyph stroke lists', () => {
    const stub: HersheyRun[] = [{ points: [[0, 4], [10, 4]] }];
    const r1 = joinAdjacentGlyphs([], stub, { capHeightMM: CAP });
    expect(r1.joined).toBe(false);
    expect(r1.joinedStrokes).toEqual(stub);
    const r2 = joinAdjacentGlyphs(stub, [], { capHeightMM: CAP });
    expect(r2.joined).toBe(false);
    expect(r2.joinedStrokes).toEqual(stub);
  });

  it('preserves non-merged strokes from multi-stroke glyphs (the "i" dot case)', () => {
    // prev has 2 strokes; the FIRST is a "dot" (single 2-point stroke
    // up at y=-10), the SECOND is the joining body. Joining should keep
    // the dot as a separate run and merge only the body + next's first.
    const prevDot: HersheyRun = { points: [[1, -10], [1.5, -10]] };
    const prevBody: HersheyRun = { points: [[-2, 4], [4, 4]] };
    const prev: HersheyRun[] = [prevDot, prevBody];
    const next: HersheyRun[] = [{ points: [[10, 4], [30, 4]] }];
    const { joined, joinedStrokes } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(true);
    // 1 dot + 1 merged body = 2 runs.
    expect(joinedStrokes.length).toBe(2);
    expect(joinedStrokes[0].points).toEqual(prevDot.points);
    // Merged body starts where prevBody started and ends where next ended.
    const merged = joinedStrokes[1].points;
    expect(merged[0]).toEqual([-2, 4]);
    expect(merged[merged.length - 1]).toEqual([30, 4]);
  });

  it('refuses to join when the prev glyph exits at the cap top (t-like)', () => {
    // Simulated 't': last stroke ends at y=-80 (way above baseline).
    // The next glyph's first stroke starts at y=4. Y delta = 84mm > 50mm.
    const tBody: HersheyRun = { points: [[-2, 4], [4, 4]] };
    const tCross: HersheyRun = { points: [[-5, -40], [5, -40]] }; // dummy
    // Pick a t-shape whose last stroke is the vertical-then-up exit:
    const tExit: HersheyRun = { points: [[3, 4], [5, -80]] };
    const prev: HersheyRun[] = [tBody, tCross, tExit];
    const next: HersheyRun[] = [{ points: [[10, 4], [30, 4]] }];
    const { joined } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(false);
  });

  it('joined polyline is smooth across the bridge (no big jumps at the seam)', () => {
    // Smoothness sanity: the bridge interior shouldn't introduce a step
    // BIGGER than the chord from prevEnd → nextStart. We measure the
    // bridge-only steps (between prevEnd and the first bridge vertex,
    // through the bridge, and between the last bridge vertex and
    // nextStart) — interior glyph strokes have their own step sizes that
    // aren't relevant.
    const prevEnd: [number, number] = [20, 4];
    const nextStart: [number, number] = [30, 6];
    const prev: HersheyRun[] = [{ points: [[0, 4], prevEnd] }];
    const next: HersheyRun[] = [{ points: [nextStart, [50, 6]] }];
    const { joined, joinedStrokes } = joinAdjacentGlyphs(prev, next, { capHeightMM: CAP });
    expect(joined).toBe(true);
    const merged = joinedStrokes[0].points;
    const chord = Math.hypot(nextStart[0] - prevEnd[0], nextStart[1] - prevEnd[1]); // ~10mm
    // Find prevEnd in the merged array (point with same coords as prevEnd).
    // It's at index 1 (after [0,4]) for this input, with the 3 bridge
    // vertices following and nextStart at index 5.
    expect(merged[1]).toEqual(prevEnd);
    expect(merged[5]).toEqual(nextStart);
    for (let i = 2; i <= 5; i++) {
      const dx = merged[i][0] - merged[i - 1][0];
      const dy = merged[i][1] - merged[i - 1][1];
      // Each bridge step should be < the chord (we sample t=0.25, 0.5,
      // 0.75 so each step covers ~25% of the curve arc-length).
      expect(Math.hypot(dx, dy)).toBeLessThan(chord);
    }
  });

  // -- Integration with hersheyTextToRuns + the cursive font -----------------

  it('cursive font: "oo" emits a SINGLE continuous run (joined)', () => {
    const runs = hersheyTextToRuns({
      text: 'oo',
      capHeightMM: CAP,
      originX: 0,
      originY: 0,
      font: 'cursive',
    });
    // Each 'o' is 1 stroke in cursive.json; joined becomes 1 continuous run.
    expect(runs.length).toBe(1);
    const totalPts = runs[0].points.length;
    // At least 2 (o1) + 3 (bridge) + 2 (o2) = 7; cursive 'o' is ~22 pts,
    // so we expect ~47 total.
    expect(totalPts).toBeGreaterThanOrEqual(40);
  });

  it('cursive font: spaces interrupt joining ("oo oo" yields 2 runs)', () => {
    const runs = hersheyTextToRuns({
      text: 'oo oo',
      capHeightMM: CAP,
      originX: 0,
      originY: 0,
      font: 'cursive',
    });
    expect(runs.length).toBe(2);
  });

  it('cursive font: roman simplex stays UNJOINED for the same input', () => {
    // Sanity: changing only the font key from cursive → rowmans should
    // re-disconnect the strokes (rowmans has joinAdjacent: false).
    const cursive = hersheyTextToRuns({
      text: 'oo',
      capHeightMM: CAP,
      originX: 0,
      originY: 0,
      font: 'cursive',
    });
    const roman = hersheyTextToRuns({
      text: 'oo',
      capHeightMM: CAP,
      originX: 0,
      originY: 0,
      font: 'rowmans',
    });
    expect(cursive.length).toBeLessThan(roman.length);
  });
});
