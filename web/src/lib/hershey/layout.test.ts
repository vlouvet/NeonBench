import { describe, expect, it } from 'vitest';
import { hersheyRunsBBox, hersheyTextToRuns, type HersheyRun } from './text';
import {
  applyTextTransforms,
  arcRuns,
  arcSweepDeg,
  clampSlant,
  groupRunsByGlyph,
  MAX_SLANT_DEG,
  slantRuns,
  stackVertical,
} from './layout';

const CAP = 100;

function run(...points: [number, number][]): HersheyRun {
  return { points };
}

function textRuns(text: string, extra: Partial<Parameters<typeof hersheyTextToRuns>[0]> = {}) {
  return hersheyTextToRuns({ text, capHeightMM: CAP, originX: 0, originY: 0, ...extra });
}

function glyph(runs: HersheyRun[], index: number): HersheyRun[] {
  return runs.filter((r) => r.glyphIndex === index);
}

describe('slantRuns', () => {
  it('is the exact identity at 0°', () => {
    const src = [run([0, 0], [12.5, -100], [-3, 7.25])];
    const out = slantRuns(src, 0, 0);
    expect(out).toEqual(src);
    // Not the same objects — the transform is pure, never in-place.
    expect(out[0]).not.toBe(src[0]);
  });

  it('shears a point one cap-height above the baseline by one cap-height at 45°', () => {
    const out = slantRuns([run([0, 0], [0, -CAP])], 45, 0);
    // On the baseline: does not move at all.
    expect(out[0].points[0][0]).toBe(0);
    expect(out[0].points[0][1]).toBe(0);
    // One cap above the baseline: +1 cap in x, y untouched. Positive
    // degrees lean right.
    expect(out[0].points[1][0]).toBeCloseTo(CAP, 9);
    expect(out[0].points[1][1]).toBe(-CAP);
  });

  it('leans left for negative degrees', () => {
    const out = slantRuns([run([0, -CAP])], -45, 0);
    expect(out[0].points[0][0]).toBeCloseTo(-CAP, 9);
  });

  it('is invertible: +θ then −θ returns the original to 1e-9', () => {
    const src = textRuns('OPEN');
    const there = slantRuns(src, 17.5, 0);
    const back = slantRuns(there, -17.5, 0);
    expect(back.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(back[i].points.length).toBe(src[i].points.length);
      for (let j = 0; j < src[i].points.length; j++) {
        expect(back[i].points[j][0]).toBeCloseTo(src[i].points[j][0], 9);
        expect(back[i].points[j][1]).toBeCloseTo(src[i].points[j][1], 9);
      }
    }
  });

  it('pivots on the baseline, not the bbox centre', () => {
    // A symmetric box straddling the baseline. A bbox-centre pivot would
    // leave the vertical centre fixed and move the baseline; a baseline
    // pivot leaves the baseline fixed.
    const out = slantRuns([run([0, -CAP], [0, 0], [0, CAP])], 30, 0);
    expect(out[0].points[1][0]).toBe(0); // baseline point pinned
    expect(out[0].points[0][0]).toBeGreaterThan(0); // above → right
    expect(out[0].points[2][0]).toBeLessThan(0); // below → left
  });

  it('shears each line about its own baseline in multi-line text', () => {
    const lineHeight = 1.2;
    const src = textRuns('A\nA', { lineHeight });
    const out = slantRuns(src, 20, 0);
    const first = glyph(out, 0);
    const second = glyph(out, 1);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBe(first.length);
    // The second A must be an exact vertical translate of the first. If
    // slant used one global baseline, the lower line would be sheared
    // further right and this would fail.
    for (let i = 0; i < first.length; i++) {
      for (let j = 0; j < first[i].points.length; j++) {
        expect(second[i].points[j][0]).toBeCloseTo(first[i].points[j][0], 9);
        expect(second[i].points[j][1]).toBeCloseTo(
          first[i].points[j][1] + CAP * lineHeight,
          9,
        );
      }
    }
  });

  it('keeps per-pair kerning and baseline shifts working underneath the shear', () => {
    // These two features are applied by hersheyTextToRuns BEFORE the
    // transform, so they should fall out for free — prove it rather
    // than assume it.
    const kern = -20;
    const shift = 30;
    const deg = 15;
    const t = Math.tan((deg * Math.PI) / 180);
    const plain = slantRuns(textRuns('AV'), deg, 0);
    const tweaked = slantRuns(
      textRuns('AV', { perPairKerningMM: [kern], baselineShiftsMM: [0, shift] }),
      deg,
      0,
    );

    // Glyph 0 is untouched by either tweak.
    const a0 = glyph(plain, 0);
    const a1 = glyph(tweaked, 0);
    expect(a1.length).toBe(a0.length);
    for (let i = 0; i < a0.length; i++) {
      for (let j = 0; j < a0[i].points.length; j++) {
        expect(a1[i].points[j][0]).toBeCloseTo(a0[i].points[j][0], 6);
        expect(a1[i].points[j][1]).toBeCloseTo(a0[i].points[j][1], 6);
      }
    }

    // Glyph 1 moved by (kern, shift) BEFORE the shear, so after a shear
    // about y = 0 its x offset is kern − shift·tanθ and its y offset is
    // exactly the shift.
    const v0 = glyph(plain, 1);
    const v1 = glyph(tweaked, 1);
    expect(v1.length).toBe(v0.length);
    expect(v0.length).toBeGreaterThan(0);
    for (let i = 0; i < v0.length; i++) {
      for (let j = 0; j < v0[i].points.length; j++) {
        expect(v1[i].points[j][0] - v0[i].points[j][0]).toBeCloseTo(kern - shift * t, 6);
        expect(v1[i].points[j][1] - v0[i].points[j][1]).toBeCloseTo(shift, 6);
      }
    }
  });

  it('clamps out-of-range and non-finite slants', () => {
    expect(clampSlant(90)).toBe(MAX_SLANT_DEG);
    expect(clampSlant(-90)).toBe(-MAX_SLANT_DEG);
    expect(clampSlant(Number.NaN)).toBe(0);
    const clamped = slantRuns([run([0, -CAP])], 400, 0);
    const at45 = slantRuns([run([0, -CAP])], 45, 0);
    expect(clamped[0].points[0][0]).toBeCloseTo(at45[0].points[0][0], 9);
  });

  it('returns an empty list for empty input', () => {
    expect(slantRuns([], 30, 0)).toEqual([]);
  });
});

describe('groupRunsByGlyph', () => {
  it('uses the emitted glyph tags, so tightly kerned pairs stay separate', () => {
    // "AV" carries a preset kern that makes the two glyphs' ink overlap
    // in x. Tag-based grouping still sees two glyphs.
    const runs = textRuns('AV', { perPairKerningMM: [-40] });
    const groups = groupRunsByGlyph(runs);
    expect(groups.length).toBe(2);
    const aBox = hersheyRunsBBox(groups[0])!;
    const vBox = hersheyRunsBBox(groups[1])!;
    expect(vBox.minX).toBeLessThan(aBox.maxX); // they really do overlap
  });

  it('falls back to x-interval clustering for untagged runs', () => {
    const groups = groupRunsByGlyph([
      run([0, 0], [10, 0]),
      run([5, -10], [8, -10]), // overlaps the first → same glyph
      run([40, 0], [50, 0]), // disjoint → new glyph
    ]);
    expect(groups.map((g) => g.length)).toEqual([2, 1]);
  });

  it('returns an empty list for empty input', () => {
    expect(groupRunsByGlyph([])).toEqual([]);
  });
});

describe('stackVertical', () => {
  it('centres an I and an M on the same axis by INK bbox, not advance width', () => {
    const flat = textRuns('IM');
    const stacked = stackVertical(flat, { capHeightMM: CAP });
    const iBox = hersheyRunsBBox(glyph(stacked, 0))!;
    const mBox = hersheyRunsBBox(glyph(stacked, 1))!;
    // Sanity: the two glyphs have very different ink widths, so this
    // assertion is not vacuous.
    const iW = iBox.maxX - iBox.minX;
    const mW = mBox.maxX - mBox.minX;
    expect(mW).toBeGreaterThan(iW * 2);
    expect((iBox.minX + iBox.maxX) / 2).toBeCloseTo((mBox.minX + mBox.maxX) / 2, 9);
  });

  it('leaves exactly the requested clear space between each glyph and the next', () => {
    const gapMM = 25;
    const stacked = stackVertical(textRuns('ABC'), { capHeightMM: CAP, gapMM });
    const boxes = [0, 1, 2].map((i) => hersheyRunsBBox(glyph(stacked, i))!);
    expect(boxes[1].minY - boxes[0].maxY).toBeCloseTo(gapMM, 9);
    expect(boxes[2].minY - boxes[1].maxY).toBeCloseTo(gapMM, 9);
  });

  it('measures the gap INK-TO-INK, not as a capHeightMM baseline pitch', () => {
    // The bundled Hershey faces put the baseline at JHF y = +9 and the cap
    // top at y = -12, so a capital spans ~21 units while fonts.ts declares
    // capHeightUnits: 12 — rendered text is ~1.75× capHeightMM tall. A
    // `capHeightMM + gap` baseline pitch therefore OVERLAPS consecutive
    // glyphs by half a letter. Assert the real ink height differs from the
    // nominal cap height (so this test would notice if the metrics ever
    // change) and that stacking still leaves clear air regardless.
    const one = hersheyRunsBBox(textRuns('A'))!;
    const inkH = one.maxY - one.minY;
    expect(inkH).toBeGreaterThan(CAP * 1.5);
    const stacked = stackVertical(textRuns('AB'), { capHeightMM: CAP });
    const a = hersheyRunsBBox(glyph(stacked, 0))!;
    const b = hersheyRunsBBox(glyph(stacked, 1))!;
    expect(b.minY).toBeGreaterThan(a.maxY); // no overlap, whatever the metrics
  });

  it('defaults the gap to a quarter of the cap height', () => {
    const stacked = stackVertical(textRuns('AB'), { capHeightMM: CAP });
    const a = hersheyRunsBBox(glyph(stacked, 0))!;
    const b = hersheyRunsBBox(glyph(stacked, 1))!;
    expect(b.minY - a.maxY).toBeCloseTo(CAP * 0.25, 9);
  });

  it('turns a source newline into an extra gap', () => {
    const gapMM = 25;
    const stacked = stackVertical(textRuns('A\nB'), { capHeightMM: CAP, gapMM });
    const a = hersheyRunsBBox(glyph(stacked, 0))!;
    const b = hersheyRunsBBox(glyph(stacked, 1))!;
    expect(b.minY - a.maxY).toBeCloseTo(2 * gapMM, 9);
  });

  it('keeps a descender from eating the gap below it', () => {
    const gapMM = 25;
    const stacked = stackVertical(textRuns('gA'), { capHeightMM: CAP, gapMM });
    const g = hersheyRunsBBox(glyph(stacked, 0))!;
    const a = hersheyRunsBBox(glyph(stacked, 1))!;
    expect(a.minY - g.maxY).toBeCloseTo(gapMM, 9);
  });

  it('carries each glyph\'s baseline through the move for the slant pass', () => {
    const stacked = stackVertical(textRuns('AB'), { capHeightMM: CAP });
    for (const i of [0, 1]) {
      const g = glyph(stacked, i);
      const box = hersheyRunsBBox(g)!;
      const base = g[0].baselineY!;
      // The baseline tag must have moved with the ink, not stayed at 0.
      expect(base).toBeGreaterThan(box.minY);
      expect(base).toBeLessThanOrEqual(box.maxY + 1e-9);
    }
    expect(glyph(stacked, 1)[0].baselineY!).toBeGreaterThan(
      glyph(stacked, 0)[0].baselineY!,
    );
  });

  it('keeps glyphs upright — no per-glyph rotation', () => {
    // A rigid vertical translate + horizontal translate means every
    // glyph's ink height and width are preserved exactly.
    const flat = textRuns('AB');
    const stacked = stackVertical(flat, { capHeightMM: CAP });
    for (const i of [0, 1]) {
      const before = hersheyRunsBBox(glyph(flat, i))!;
      const after = hersheyRunsBBox(glyph(stacked, i))!;
      expect(after.maxX - after.minX).toBeCloseTo(before.maxX - before.minX, 9);
      expect(after.maxY - after.minY).toBeCloseTo(before.maxY - before.minY, 9);
    }
  });

  it('left- and right-aligns on the axis', () => {
    const flat = textRuns('IM');
    const left = stackVertical(flat, { capHeightMM: CAP, align: 'left', axisX: 0 });
    expect(hersheyRunsBBox(glyph(left, 0))!.minX).toBeCloseTo(0, 9);
    expect(hersheyRunsBBox(glyph(left, 1))!.minX).toBeCloseTo(0, 9);
    const right = stackVertical(flat, { capHeightMM: CAP, align: 'right', axisX: 0 });
    expect(hersheyRunsBBox(glyph(right, 0))!.maxX).toBeCloseTo(0, 9);
    expect(hersheyRunsBBox(glyph(right, 1))!.maxX).toBeCloseTo(0, 9);
  });

  it('is a no-op in position for a single glyph centred on its own axis', () => {
    const flat = textRuns('A');
    const stacked = stackVertical(flat, { capHeightMM: CAP });
    const before = hersheyRunsBBox(flat)!;
    const after = hersheyRunsBBox(stacked)!;
    expect(after.minX).toBeCloseTo(before.minX, 9);
    expect(after.minY).toBeCloseTo(before.minY, 9);
  });

  it('returns an empty list for empty input', () => {
    expect(stackVertical([], { capHeightMM: CAP })).toEqual([]);
  });
});

describe('arcRuns', () => {
  // Stated tolerance for the huge-radius flatness check. The sagitta of a
  // chord of half-width s on a circle of radius R is s²/2R; "OPEN" at a
  // 100mm cap is ~633mm wide, so s ≤ 317mm and the worst-case deviation is
  // 317²/2e6 ≈ 0.050mm. 0.10mm gives 2× headroom and is still ~1/100 of a
  // tube diameter — far tighter than anything visible, and any sign
  // inversion blows past it by four orders of magnitude.
  const FLAT_TOL = 0.1; // mm

  it('approximates the flat original at a 1e6 mm radius', () => {
    // The sign-inversion canary: an arc bent the wrong way diverges from
    // the flat text immediately, at any radius.
    const src = textRuns('OPEN');
    const arced = arcRuns(src, {
      radiusMM: 1e6,
      direction: 'up',
      baselineY: 0,
      // Big enough that no densification happens, so points correspond
      // 1:1 with the input and we can compare them directly.
      maxSegmentAngleRad: 1,
    });
    expect(arced.length).toBe(src.length);
    for (let i = 0; i < src.length; i++) {
      expect(arced[i].points.length).toBe(src[i].points.length);
      for (let j = 0; j < src[i].points.length; j++) {
        expect(arced[i].points[j][0]).toBeCloseTo(src[i].points[j][0], 1);
        expect(Math.abs(arced[i].points[j][0] - src[i].points[j][0])).toBeLessThan(FLAT_TOL);
        expect(Math.abs(arced[i].points[j][1] - src[i].points[j][1])).toBeLessThan(FLAT_TOL);
      }
    }
  });

  it('lands a baseline point exactly radiusMM from the arc centre', () => {
    const R = 500;
    for (const s of [0, 137, -260]) {
      for (const direction of ['up', 'down'] as const) {
        const out = arcRuns([run([s, 0])], { radiusMM: R, direction, centerX: 0, baselineY: 0 });
        const [x, y] = out[0].points[0];
        const cy = direction === 'up' ? R : -R;
        expect(Math.hypot(x - 0, y - cy)).toBeCloseTo(R, 9);
      }
    }
  });

  it('arches text over a centre below it for direction "up"', () => {
    const R = 500;
    const out = arcRuns([run([-200, 0], [0, 0], [200, 0])], {
      radiusMM: R,
      direction: 'up',
      centerX: 0,
      baselineY: 0,
      maxSegmentAngleRad: 1,
    });
    const [, mid, end] = out[0].points;
    expect(mid[1]).toBeCloseTo(0, 9); // crown stays on the baseline
    expect(end[1]).toBeGreaterThan(mid[1]); // ends fall away (y is down)
  });

  it('puts the glyph top FARTHER from the centre than the baseline for "up"', () => {
    const R = 500;
    const out = arcRuns([run([0, 0], [0, -CAP])], {
      radiusMM: R,
      direction: 'up',
      centerX: 0,
      baselineY: 0,
      maxSegmentAngleRad: 1,
    });
    const centre: [number, number] = [0, R];
    const dBase = Math.hypot(out[0].points[0][0] - centre[0], out[0].points[0][1] - centre[1]);
    const dTop = Math.hypot(out[0].points[1][0] - centre[0], out[0].points[1][1] - centre[1]);
    expect(dBase).toBeCloseTo(R, 9);
    expect(dTop).toBeCloseTo(R + CAP, 9);
  });

  it('up and down are mirror images about the baseline', () => {
    const R = 400;
    const baselineY = 0;
    const src = textRuns('OPEN');
    const opts = { radiusMM: R, centerX: 0, baselineY };
    const up = arcRuns(src, { ...opts, direction: 'up' });
    // Mirror the input about the baseline first: reflect(arc_up(p)) must
    // equal arc_down(reflect(p)).
    const mirroredSrc = src.map((r) => ({
      ...r,
      points: r.points.map(([x, y]) => [x, 2 * baselineY - y] as [number, number]),
    }));
    const down = arcRuns(mirroredSrc, { ...opts, direction: 'down' });
    expect(down.length).toBe(up.length);
    for (let i = 0; i < up.length; i++) {
      expect(down[i].points.length).toBe(up[i].points.length);
      for (let j = 0; j < up[i].points.length; j++) {
        expect(down[i].points[j][0]).toBeCloseTo(up[i].points[j][0], 9);
        expect(down[i].points[j][1]).toBeCloseTo(2 * baselineY - up[i].points[j][1], 9);
      }
    }
  });

  it('densifies long straight segments so they follow the arc instead of chording', () => {
    const R = 300;
    const out = arcRuns([run([-200, 0], [200, 0])], {
      radiusMM: R,
      direction: 'up',
      centerX: 0,
      baselineY: 0,
    });
    expect(out[0].points.length).toBeGreaterThan(10);
    // Every emitted point of a baseline stroke must sit on the circle.
    for (const [x, y] of out[0].points) {
      expect(Math.hypot(x, y - R)).toBeCloseTo(R, 9);
    }
  });

  it('guards a zero or negative or non-finite radius by passing the runs through', () => {
    const src = [run([0, 0], [10, -20])];
    for (const radiusMM of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const out = arcRuns(src, { radiusMM });
      expect(out).toEqual(src);
      for (const p of out[0].points) {
        expect(Number.isFinite(p[0])).toBe(true);
        expect(Number.isFinite(p[1])).toBe(true);
      }
    }
  });

  it('returns an empty list for empty input and handles a single glyph', () => {
    expect(arcRuns([], { radiusMM: 500 })).toEqual([]);
    const one = arcRuns(textRuns('A'), { radiusMM: 500 });
    expect(one.length).toBeGreaterThan(0);
    for (const r of one) {
      for (const [x, y] of r.points) {
        expect(Number.isFinite(x)).toBe(true);
        expect(Number.isFinite(y)).toBe(true);
      }
    }
  });

  it('reports the sweep angle so the UI can warn past a full lap', () => {
    const src = textRuns('OPEN');
    const width = hersheyRunsBBox(src)!.maxX - hersheyRunsBBox(src)!.minX;
    expect(arcSweepDeg(src, width / (2 * Math.PI))).toBeCloseTo(360, 6);
    expect(arcSweepDeg(src, 0)).toBe(0);
    expect(arcSweepDeg([], 500)).toBe(0);
  });
});

describe('applyTextTransforms', () => {
  it('applies layout before slant, never the other way round', () => {
    const src = textRuns('OPEN');
    const composed = applyTextTransforms(src, {
      capHeightMM: CAP,
      layout: 'arc',
      arc: { radiusMM: 400, direction: 'up', centerX: 0, baselineY: 0 },
      slantDeg: 12,
      baselineY: 0,
    });
    const manual = slantRuns(
      arcRuns(src, { radiusMM: 400, direction: 'up', centerX: 0, baselineY: 0 }),
      12,
      0,
    );
    expect(composed.length).toBe(manual.length);
    for (let i = 0; i < manual.length; i++) {
      for (let j = 0; j < manual[i].points.length; j++) {
        expect(composed[i].points[j][0]).toBeCloseTo(manual[i].points[j][0], 9);
        expect(composed[i].points[j][1]).toBeCloseTo(manual[i].points[j][1], 9);
      }
    }
    // ...and slant-first is a genuinely different result, so the order
    // is load-bearing rather than incidental.
    const wrongOrder = arcRuns(slantRuns(src, 12, 0), {
      radiusMM: 400,
      direction: 'up',
      centerX: 0,
      baselineY: 0,
    });
    const differs = manual.some((r, i) =>
      r.points.some((p, j) => Math.abs(p[0] - wrongOrder[i].points[j][0]) > 1e-6),
    );
    expect(differs).toBe(true);
  });

  it('treats stack and arc as mutually exclusive', () => {
    const src = textRuns('AB');
    const stacked = applyTextTransforms(src, { capHeightMM: CAP, layout: 'stack' });
    const a = hersheyRunsBBox(glyph(stacked, 0))!;
    const b = hersheyRunsBBox(glyph(stacked, 1))!;
    expect(b.minY - a.maxY).toBeCloseTo(CAP * 0.25, 9);
    const none = applyTextTransforms(src, { capHeightMM: CAP, layout: 'none' });
    expect(none).toEqual(src);
  });

  it('is the identity when nothing is enabled', () => {
    const src = textRuns('OPEN');
    expect(applyTextTransforms(src, { capHeightMM: CAP })).toEqual(src);
  });
});
