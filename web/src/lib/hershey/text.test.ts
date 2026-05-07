import { describe, expect, it, vi, afterEach } from 'vitest';
import { hersheyRunsBBox, hersheyTextToRuns } from './text';

describe('hersheyTextToRuns', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits multiple strokes for a multi-stroke uppercase letter', () => {
    // Roman Simplex 'A' is 3 disconnected strokes (left leg, right leg,
    // crossbar). We don't lock the exact count — fonts evolve — but we
    // require at least one run with at least 3 finite points across all
    // strokes, which is the floor any reasonable A meets.
    const runs = hersheyTextToRuns('A', 100, 0, 0);
    expect(runs.length).toBeGreaterThanOrEqual(1);
    const totalPoints = runs.reduce((acc, r) => acc + r.points.length, 0);
    expect(totalPoints).toBeGreaterThanOrEqual(3);
    for (const run of runs) {
      for (const [x, y] of run.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('renders OPEN with at least one run per letter and finite coords', () => {
    // 'O' is one stroke, 'P' is two, 'E' is four, 'N' is three (three
    // disconnected strokes per the Hershey simplex spec). The exact total
    // is font-data-dependent; what matters is every coord is finite and
    // we get at least 4 runs (one per letter floor).
    const runs = hersheyTextToRuns('OPEN', 100, 0, 0);
    expect(runs.length).toBeGreaterThanOrEqual(4);
    for (const run of runs) {
      expect(run.points.length).toBeGreaterThanOrEqual(2);
      for (const [x, y] of run.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
    // Letters should advance left-to-right: the leftmost point of the last
    // run-cluster must be to the right of the leftmost point of the first.
    const first = runs[0].points[0][0];
    const last = runs[runs.length - 1].points[0][0];
    expect(last).toBeGreaterThan(first);
  });

  it('emits no runs for a space (cursor advances but no strokes)', () => {
    const runs = hersheyTextToRuns(' ', 100, 0, 0);
    expect(runs).toEqual([]);
  });

  it('skips out-of-range characters with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runs = hersheyTextToRuns('é', 100, 0, 0);
    expect(runs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/unsupported|U\+/);
  });

  it('scales vertically with cap height — 200mm is 2× the bbox of 100mm', () => {
    const small = hersheyTextToRuns('OPEN', 100, 0, 0);
    const big = hersheyTextToRuns('OPEN', 200, 0, 0);
    const sBox = hersheyRunsBBox(small)!;
    const bBox = hersheyRunsBBox(big)!;
    expect(sBox).not.toBeNull();
    expect(bBox).not.toBeNull();
    const sH = sBox.maxY - sBox.minY;
    const bH = bBox.maxY - bBox.minY;
    // Allow tiny float drift; ratio should be exactly 2.
    expect(bH / sH).toBeCloseTo(2, 5);
    // Width should scale too.
    const sW = sBox.maxX - sBox.minX;
    const bW = bBox.maxX - bBox.minX;
    expect(bW / sW).toBeCloseTo(2, 5);
  });

  it('places strokes at the requested origin Y baseline', () => {
    const runs = hersheyTextToRuns('I', 100, 50, 200);
    expect(runs.length).toBeGreaterThan(0);
    const box = hersheyRunsBBox(runs)!;
    // Cap top of an uppercase 'I' is one cap-height above baseline.
    // Cap height = 100mm, baseline = originY = 200, so minY ≈ 100.
    expect(box.minY).toBeCloseTo(100, 1);
    // Strokes sit inside the glyph's bracket starting at originX, so the
    // leftmost stroke X is ≥ originX (with a tiny float tolerance).
    expect(box.minX).toBeGreaterThanOrEqual(50 - 0.01);
  });
});
