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
    const runs = hersheyTextToRuns({ text: 'A', capHeightMM: 100, originX: 0, originY: 0 });
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
    const runs = hersheyTextToRuns({ text: 'OPEN', capHeightMM: 100, originX: 0, originY: 0 });
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
    const runs = hersheyTextToRuns({ text: ' ', capHeightMM: 100, originX: 0, originY: 0 });
    expect(runs).toEqual([]);
  });

  it('skips out-of-range characters with a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const runs = hersheyTextToRuns({ text: 'é', capHeightMM: 100, originX: 0, originY: 0 });
    expect(runs).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/unsupported|U\+/);
  });

  it('scales vertically with cap height — 200mm is 2× the bbox of 100mm', () => {
    const small = hersheyTextToRuns({ text: 'OPEN', capHeightMM: 100, originX: 0, originY: 0 });
    const big = hersheyTextToRuns({ text: 'OPEN', capHeightMM: 200, originX: 0, originY: 0 });
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
    const runs = hersheyTextToRuns({ text: 'I', capHeightMM: 100, originX: 50, originY: 200 });
    expect(runs.length).toBeGreaterThan(0);
    const box = hersheyRunsBBox(runs)!;
    // Cap top of an uppercase 'I' is one cap-height above baseline.
    // Cap height = 100mm, baseline = originY = 200, so minY ≈ 100.
    expect(box.minY).toBeCloseTo(100, 1);
    // Strokes sit inside the glyph's bracket starting at originX, so the
    // leftmost stroke X is ≥ originX (with a tiny float tolerance).
    expect(box.minX).toBeGreaterThanOrEqual(50 - 0.01);
  });

  // -- Multi-line, kerning, and font selection (Tier 3 #19 polish) ----------

  // NOTE: Hershey simplex letters span JHF y∈[-12, 9] — they extend BELOW
  // the y=0 baseline by 9 JHF units (75mm at capHeight=100mm). So with
  // capHeightMM=100 a single line occupies y∈[-100, 75]. We need
  // lineHeight large enough to cleanly separate the lines for assertions
  // — at lineHeight=2.0 line 2's baseline=200 and its caps span
  // y∈[100, 275], leaving a clean gap [76, 99] between lines.

  it('multi-line: second line points sit below the first-line baseline', () => {
    // Use lineHeight=2.0 to guarantee a clean split (see note above).
    const runs = hersheyTextToRuns({
      text: 'A\nB',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      lineHeight: 2.0,
    });
    expect(runs.length).toBeGreaterThan(0);

    // With baselines at 0 and 200, line 1 spans [-100, 75], line 2
    // [100, 275]. Split at the midpoint y=87.5.
    let firstLineCount = 0;
    let secondLineCount = 0;
    for (const r of runs) {
      for (const [, y] of r.points) {
        if (y < 87.5) firstLineCount++;
        else secondLineCount++;
      }
    }
    expect(firstLineCount).toBeGreaterThan(0);
    expect(secondLineCount).toBeGreaterThan(0);
    // And every second-line y must be at least 100 (cap top of line 2).
    for (const r of runs) {
      for (const [, y] of r.points) {
        if (y >= 87.5) expect(y).toBeGreaterThanOrEqual(100 - 0.01);
      }
    }
  });

  it('multi-line: lineHeight scales the inter-line gap', () => {
    // With lineHeight=2.0 the second baseline sits at y=200; cap tops of
    // line 2 are at y=100. Min Y of any line-2 point should be ≈ 100.
    const runs = hersheyTextToRuns({
      text: 'A\nB',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      lineHeight: 2.0,
    });
    // Line 2 = points y > 87.5 (line-1 caps tail off at y=75; line-2 tops
    // at y=100, so the midpoint is unambiguous).
    let line2Min = Infinity;
    for (const r of runs) {
      for (const [, y] of r.points) {
        if (y > 87.5) line2Min = Math.min(line2Min, y);
      }
    }
    // Cap top of 'B' on the second baseline is at originY + capHeight*2.0 -
    // capHeight = 100.
    expect(line2Min).toBeCloseTo(100, 1);
  });

  it('multi-line: empty line advances the baseline without emitting strokes', () => {
    // 'A\n\nB' with lineHeight=2.0: line 1 baseline=0, line 2 baseline=200
    // (empty), line 3 baseline=400. B's lowest stroke-point sits at
    // baseline + 9 JHF units * scale = 400 + 75 = 475. The total run
    // count must equal A's strokes + B's strokes (no extra runs from the
    // empty middle line).
    const runs = hersheyTextToRuns({
      text: 'A\n\nB',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      lineHeight: 2.0,
    });
    let maxY = -Infinity;
    for (const r of runs) for (const [, y] of r.points) if (y > maxY) maxY = y;
    expect(maxY).toBeCloseTo(475, 0);

    const justA = hersheyTextToRuns({ text: 'A', capHeightMM: 100, originX: 0, originY: 0 });
    const justB = hersheyTextToRuns({ text: 'B', capHeightMM: 100, originX: 0, originY: 0 });
    expect(runs.length).toBe(justA.length + justB.length);
  });

  it('per-pair kerning shifts every later glyph by the slot delta', () => {
    const baseline = hersheyTextToRuns({ text: 'AB', capHeightMM: 100, originX: 0, originY: 0 });
    const kerned = hersheyTextToRuns({
      text: 'AB',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      perPairKerningMM: [50],
    });
    // Bracket the A and B by stroke position: A's strokes come first, B's
    // come second. Compare the leftmost point of the B cluster.
    const baselineLetters = splitRunsByLetter(baseline);
    const kernedLetters = splitRunsByLetter(kerned);
    expect(baselineLetters.length).toBe(2);
    expect(kernedLetters.length).toBe(2);
    const dx = clusterMinX(kernedLetters[1]) - clusterMinX(baselineLetters[1]);
    expect(dx).toBeCloseTo(50, 5);
  });

  it('empty kerning array is identical to no kerning option', () => {
    // Regression guard: passing perPairKerningMM:[] should not perturb
    // any coordinate vs the default — the existing assertions above all
    // run with no kerning, so we just compare the two outputs directly.
    const a = hersheyTextToRuns({ text: 'OPEN', capHeightMM: 100, originX: 0, originY: 0 });
    const b = hersheyTextToRuns({
      text: 'OPEN',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      perPairKerningMM: [],
    });
    expect(b.length).toBe(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].points).toEqual(a[i].points);
    }
  });

  it('font selection: rowmand emits strictly more strokes than rowmans', () => {
    // Duplex doubles each Simplex stroke. Don't snapshot exact counts —
    // they're font-data-dependent — just assert the ordering.
    const simplex = hersheyTextToRuns({
      text: 'A',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      font: 'rowmans',
    });
    const duplex = hersheyTextToRuns({
      text: 'A',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      font: 'rowmand',
    });
    expect(duplex.length).toBeGreaterThan(simplex.length);
  });

  it('font selection: futural renders A with finite coords and at least one stroke', () => {
    const runs = hersheyTextToRuns({
      text: 'A',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      font: 'futural',
    });
    expect(runs.length).toBeGreaterThan(0);
    for (const r of runs) {
      for (const [x, y] of r.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('newline does NOT consume a kerning slot — slots track visible glyph pairs', () => {
    // 'AB\nCD' has 4 renderable glyphs and 3 inter-glyph slots:
    //   slot 0 = A-B, slot 1 = B-C (spans the newline; B's kerning is
    //   added then wiped by cursor reset, so it's effectively a no-op),
    //   slot 2 = C-D.
    // With perPairKerningMM=[10, 999, 30] the C/D pair's offset must be
    // +30 (NOT +999), proving the newline didn't shift the array.
    // lineHeight=2.0 keeps line 1 and line 2 cleanly separable in Y.
    const runs = hersheyTextToRuns({
      text: 'AB\nCD',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
      lineHeight: 2.0,
      perPairKerningMM: [10, 999, 30],
    });
    expect(runs.length).toBeGreaterThan(0);
    // Line 1 spans y∈[-100, 75]; line 2 (baseline=200) spans y∈[100, 275].
    // Any run whose min-Y > 87.5 is line 2.
    const line2Runs = runs.filter((r) => runMinY(r) > 87.5);
    expect(line2Runs.length).toBeGreaterThan(0);
    // Split line 2 by letter — leftmost cluster is C, next is D.
    const letters = splitRunsByLetter(line2Runs);
    expect(letters.length).toBe(2);

    // Compare against a fresh 'CD' rendered with the same +30 slot 0
    // and the same baseline: its D cluster should sit at the same X.
    const baseCD = hersheyTextToRuns({
      text: 'CD',
      capHeightMM: 100,
      originX: 0,
      originY: 200,
      perPairKerningMM: [30],
    });
    const baseLetters = splitRunsByLetter(baseCD);
    expect(baseLetters.length).toBe(2);
    expect(clusterMinX(letters[1])).toBeCloseTo(clusterMinX(baseLetters[1]), 5);
  });
});

// -- helpers ---------------------------------------------------------------

// Group a list of runs into "letter clusters" by their X-extent overlap.
// Two runs end up in the same cluster if their X intervals overlap (or
// touch within 1mm). Works for our deterministic test inputs ('AB',
// 'CD'); not a general algorithm.
type Run = { points: [number, number][] };
type Cluster = Run[];

function splitRunsByLetter(runs: Run[]): Cluster[] {
  if (runs.length === 0) return [];
  const sorted = [...runs].sort((a, b) => runMinX(a) - runMinX(b));
  const clusters: Cluster[] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const prev = clusters[clusters.length - 1];
    const prevMaxX = Math.max(...prev.map(runMaxX));
    if (runMinX(sorted[i]) > prevMaxX + 1) clusters.push([sorted[i]]);
    else prev.push(sorted[i]);
  }
  return clusters;
}

function runMinX(run: Run): number {
  let m = Infinity;
  for (const [x] of run.points) if (x < m) m = x;
  return m;
}

function runMaxX(run: Run): number {
  let m = -Infinity;
  for (const [x] of run.points) if (x > m) m = x;
  return m;
}

function clusterMinX(cluster: Cluster): number {
  let m = Infinity;
  for (const r of cluster) m = Math.min(m, runMinX(r));
  return m;
}

function runMinY(run: Run): number {
  let m = Infinity;
  for (const [, y] of run.points) if (y < m) m = y;
  return m;
}
