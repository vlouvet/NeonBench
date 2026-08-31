import { describe, expect, it } from 'vitest';
import type { DesignRun } from '../api';
import { findCrossings, overCrossingPointsByRun } from './crossings';

const run = (id: string, points: [number, number][], closed = false): DesignRun => ({
  id,
  polyline: { points, closed },
});

describe('findCrossings', () => {
  it('finds the crossing where two runs form an X', () => {
    const a = run('a', [[0, 0], [10, 10]]);
    const b = run('b', [[0, 10], [10, 0]]);
    const cs = findCrossings([a, b]);
    expect(cs).toHaveLength(1);
    expect(cs[0].at[0]).toBeCloseTo(5);
    expect(cs[0].at[1]).toBeCloseTo(5);
  });

  it('reports nothing for runs that merely pass nearby', () => {
    expect(findCrossings([
      run('a', [[0, 0], [10, 0]]),
      run('b', [[0, 5], [10, 5]]),
    ])).toHaveLength(0);
  });

  // The bug was found on a cursive "Salon": one connected run crossing itself.
  // Per-run depth layering cannot fix that, which is why detection is
  // segment-pairwise rather than run-pairwise.
  it('finds a run crossing ITSELF', () => {
    const loop = run('a', [[0, 0], [10, 10], [10, 0], [0, 10]]);
    const cs = findCrossings([loop]);
    expect(cs.length).toBeGreaterThan(0);
    expect(cs.every((c) => c.runA === c.runB)).toBe(true);
  });

  it('does not treat consecutive segments as a crossing', () => {
    // A simple corner: two segments sharing a vertex, going nowhere near each other.
    expect(findCrossings([run('a', [[0, 0], [10, 0], [10, 10]])])).toHaveLength(0);
  });

  it('does not treat a closed polyline\'s wrap seam as a crossing', () => {
    // Square: last segment joins back to the first. They share a vertex.
    expect(findCrossings([
      run('sq', [[0, 0], [10, 0], [10, 10], [0, 10]], true),
    ])).toHaveLength(0);
  });

  it('ignores degenerate runs', () => {
    expect(findCrossings([run('p', [[1, 1]]), run('e', [])])).toHaveLength(0);
  });

  it('does not count parallel overlapping segments as crossing', () => {
    expect(findCrossings([
      run('a', [[0, 0], [10, 0]]),
      run('b', [[2, 0], [8, 0]]),
    ])).toHaveLength(0);
  });
});

describe('overCrossingPointsByRun', () => {
  it('lifts exactly one side of a crossing', () => {
    const a = run('a', [[0, 0], [10, 10]]);
    const b = run('b', [[0, 10], [10, 0]]);
    const over = overCrossingPointsByRun(findCrossings([a, b]));
    // Only one run lifts — raising both would separate them by 2x the offset
    // and leave neither tube on the backing plane.
    expect(over.size).toBe(1);
    expect(over.has(1)).toBe(true);
    expect(over.get(1)![0][0]).toBeCloseTo(5);
  });

  it('is deterministic — the later run goes over, every time', () => {
    const a = run('a', [[0, 0], [10, 10]]);
    const b = run('b', [[0, 10], [10, 0]]);
    const first = overCrossingPointsByRun(findCrossings([a, b]));
    const again = overCrossingPointsByRun(findCrossings([a, b]));
    expect([...again]).toEqual([...first]);
  });

  it('assigns self-crossings to their own run', () => {
    const loop = run('a', [[0, 0], [10, 10], [10, 0], [0, 10]]);
    const over = overCrossingPointsByRun(findCrossings([loop]));
    expect(over.get(0)?.length).toBeGreaterThan(0);
  });

  it('returns an empty map when nothing crosses', () => {
    const rs = [run('a', [[0, 0], [10, 0]]), run('b', [[0, 5], [10, 5]])];
    expect(overCrossingPointsByRun(findCrossings(rs)).size).toBe(0);
  });
});
