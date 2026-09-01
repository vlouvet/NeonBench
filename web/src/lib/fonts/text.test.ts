import { describe, expect, it } from 'vitest';
import {
  outlineRunsBBox,
  outlineTextToRuns,
  translateOutlineRuns,
  type OutlineRun,
} from './text';
import { SYNTH_ADVANCE, SYNTH_CAP_UNITS, SYNTH_UPM, synthFace } from './synthFont';
import { signedArea } from '../shapes/offset';
import type { LoadedFace } from './face';

function bboxOf(runs: OutlineRun[]) {
  const b = outlineRunsBBox(runs);
  if (!b) throw new Error('no runs emitted');
  return b;
}

describe('cap height comes from the font, not a constant', () => {
  // THE HEADLINE ASSERTION OF THIS FEATURE. Bug #13 shipped because a
  // declared cap-height constant disagreed with the data it described and
  // nothing measured the result. So: type 100 into the box, get an 'H'
  // that a tape measures at 100 mm.
  it('capHeightMM = 100 yields a 100 mm H', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'H', capHeightMM: 100 });
    const b = bboxOf(runs);
    expect(b.maxY - b.minY).toBeCloseTo(100, 9);
  });

  it('holds across sizes, and scales linearly', () => {
    const face = synthFace();
    for (const mm of [1, 25.4, 100, 250, 1200]) {
      const { runs } = outlineTextToRuns({ face, text: 'H', capHeightMM: mm });
      const b = bboxOf(runs);
      expect(b.maxY - b.minY).toBeCloseTo(mm, 8);
    }
  });

  it('is the MEASURED H, not units-per-em times a guess', () => {
    // The synthetic H is 660/1000 em. A scale derived from the common
    // 0.7-of-em assumption would render it 660/700 = 0.943x — i.e. 94 mm
    // when the operator asked for 100. That is Bug #13's exact shape.
    const face = synthFace();
    expect(face.capHeight.source).toBe('measured-H');
    expect(face.capHeight.capHeightUnits).toBe(SYNTH_CAP_UNITS);
    const { runs, mmPerFontUnit } = outlineTextToRuns({
      face,
      text: 'H',
      capHeightMM: 100,
    });
    expect(mmPerFontUnit).toBeCloseTo(100 / SYNTH_CAP_UNITS, 12);
    expect(mmPerFontUnit).not.toBeCloseTo(100 / (SYNTH_UPM * 0.7), 6);
    const b = bboxOf(runs);
    expect(b.maxY - b.minY).not.toBeCloseTo(94.28, 1);
  });

  it('puts the cap line one cap height above the baseline', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({
      face,
      text: 'H',
      capHeightMM: 100,
      originY: 500,
    });
    const b = bboxOf(runs);
    // originY IS the baseline for outline text (unlike the Hershey path,
    // whose origin is a JHF anchor that is not the baseline).
    expect(b.maxY).toBeCloseTo(500, 9);
    expect(b.minY).toBeCloseTo(400, 9);
  });

  it('emits width in the same scale as height', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'H', capHeightMM: 100 });
    const b = bboxOf(runs);
    // Synthetic H ink spans x 0..400 font units.
    expect(b.maxX - b.minX).toBeCloseTo((400 * 100) / SYNTH_CAP_UNITS, 8);
  });
});

describe('counters', () => {
  it('emits an O as two closed contours, one outer and one counter', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'O', capHeightMM: 100 });
    expect(runs).toHaveLength(2);
    expect(runs.map((r) => r.role)).toEqual(['outer', 'counter']);
    expect(runs.map((r) => r.contourIndex)).toEqual([0, 1]);
  });

  it('gives the counter the opposite winding, as signedArea reads it', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'O', capHeightMM: 100 });
    const outer = runs.find((r) => r.role === 'outer')!;
    const counter = runs.find((r) => r.role === 'counter')!;
    // The run's own report and an independent recomputation from the
    // points agree — the offset code will see what we claim it sees.
    expect(signedArea(outer.points)).toBeCloseTo(outer.areaSigned, 6);
    expect(signedArea(counter.points)).toBeCloseTo(counter.areaSigned, 6);
    expect(Math.sign(signedArea(outer.points))).toBe(-Math.sign(signedArea(counter.points)));
  });

  it('nests the counter strictly inside the outer contour', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'O', capHeightMM: 100 });
    const outer = runs.find((r) => r.role === 'outer')!;
    const counter = runs.find((r) => r.role === 'counter')!;
    const ob = bboxOf([outer]);
    const cb = bboxOf([counter]);
    expect(cb.minX).toBeGreaterThan(ob.minX);
    expect(cb.maxX).toBeLessThan(ob.maxX);
    expect(cb.minY).toBeGreaterThan(ob.minY);
    expect(cb.maxY).toBeLessThan(ob.maxY);
  });

  it('emits every contour closed with first === last', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'HOI', capHeightMM: 100 });
    expect(runs.length).toBeGreaterThan(3);
    for (const r of runs) {
      expect(r.points.length).toBeGreaterThanOrEqual(4);
      expect(r.points[0]).toEqual(r.points[r.points.length - 1]);
    }
  });
});

describe('layout', () => {
  it('advances the pen by the glyph advance width, scaled', () => {
    const face = synthFace();
    const scale = 100 / SYNTH_CAP_UNITS;
    const { runs } = outlineTextToRuns({
      face,
      text: 'II',
      capHeightMM: 100,
      applyKerning: false,
    });
    expect(runs).toHaveLength(2);
    const first = bboxOf([runs[0]]);
    const second = bboxOf([runs[1]]);
    expect(second.minX - first.minX).toBeCloseTo(SYNTH_ADVANCE.I * scale, 8);
  });

  it('adds letterSpacingMM on top of the advance', () => {
    const face = synthFace();
    const scale = 100 / SYNTH_CAP_UNITS;
    const { runs } = outlineTextToRuns({
      face,
      text: 'II',
      capHeightMM: 100,
      letterSpacingMM: 13,
      applyKerning: false,
    });
    const first = bboxOf([runs[0]]);
    const second = bboxOf([runs[1]]);
    expect(second.minX - first.minX).toBeCloseTo(SYNTH_ADVANCE.I * scale + 13, 8);
  });

  it('advances across a space even though it emits no contour', () => {
    const face = synthFace();
    const scale = 100 / SYNTH_CAP_UNITS;
    const { runs } = outlineTextToRuns({
      face,
      text: 'I I',
      capHeightMM: 100,
      applyKerning: false,
    });
    expect(runs).toHaveLength(2);
    const gap = bboxOf([runs[1]]).minX - bboxOf([runs[0]]).minX;
    expect(gap).toBeCloseTo((SYNTH_ADVANCE.I + SYNTH_ADVANCE.space) * scale, 8);
    // The space consumed a glyph index, so the second I is index 2.
    expect(runs[1].glyphIndex).toBe(2);
  });

  it('starts a new baseline at each newline and resets the pen', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({
      face,
      text: 'I\nI',
      capHeightMM: 100,
      lineHeight: 1.5,
    });
    expect(runs.map((r) => r.lineIndex)).toEqual([0, 1]);
    const a = bboxOf([runs[0]]);
    const b = bboxOf([runs[1]]);
    expect(b.minX).toBeCloseTo(a.minX, 9);
    expect(b.maxY - a.maxY).toBeCloseTo(150, 9);
  });

  it('tags each run with its source character and glyph index', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'HO', capHeightMM: 100 });
    expect(runs.map((r) => r.char)).toEqual(['H', 'O', 'O']);
    expect(runs.map((r) => r.glyphIndex)).toEqual([0, 1, 1]);
  });

  it('reports characters the face cannot set instead of emitting .notdef', () => {
    const face = synthFace();
    const { runs, missing, warnings } = outlineTextToRuns({
      face,
      text: 'HщO',
      capHeightMM: 100,
    });
    expect(missing).toEqual(['щ']);
    expect(warnings.join(' ')).toContain('щ');
    // .notdef is empty in this face, so only H and O produced contours.
    expect(runs.every((r) => r.char === 'H' || r.char === 'O')).toBe(true);
  });

  it('refuses a non-positive cap height rather than emitting garbage', () => {
    const face = synthFace();
    for (const bad of [0, -5, Number.NaN]) {
      const res = outlineTextToRuns({ face, text: 'H', capHeightMM: bad });
      expect(res.runs).toEqual([]);
      expect(res.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe('kerning', () => {
  // The synthetic face carries no kern table (opentype.js's writer emits
  // none), so the wiring is pinned against a face whose getKerningValue
  // we control. The values below are the real ones this face's live
  // counterpart reports: Arial.ttf, opentype.js 2.0.0, 'AV' = -152 and
  // 'To' = -227 units of 2048.
  //
  // A fresh face per call, with the one method overridden as an own
  // property. Spreading the Font would drop every method it inherits
  // from its prototype, which is a whole class of test that passes
  // against a stub bearing no resemblance to the real object.
  function kerningFace(unitsPerPair: number): LoadedFace {
    const face = synthFace();
    face.font.getKerningValue = () => unitsPerPair;
    return face;
  }

  it('applies the face own kern value between a pair', () => {
    const scale = 100 / SYNTH_CAP_UNITS;
    const kern = -152;
    const { runs } = outlineTextToRuns({
      face: kerningFace(kern),
      text: 'II',
      capHeightMM: 100,
      applyKerning: true,
    });
    const delta = bboxOf([runs[1]]).minX - bboxOf([runs[0]]).minX;
    expect(delta).toBeCloseTo((SYNTH_ADVANCE.I + kern) * scale, 8);
  });

  it('ignores kerning when the operator turns it off', () => {
    const scale = 100 / SYNTH_CAP_UNITS;
    const { runs } = outlineTextToRuns({
      face: kerningFace(-152),
      text: 'II',
      capHeightMM: 100,
      applyKerning: false,
    });
    const delta = bboxOf([runs[1]]).minX - bboxOf([runs[0]]).minX;
    expect(delta).toBeCloseTo(SYNTH_ADVANCE.I * scale, 8);
  });

  it('does not kern across a line break', () => {
    const { runs } = outlineTextToRuns({
      face: kerningFace(-400),
      text: 'I\nI',
      capHeightMM: 100,
      applyKerning: true,
    });
    expect(bboxOf([runs[1]]).minX).toBeCloseTo(bboxOf([runs[0]]).minX, 9);
  });
});

describe('bbox and translate', () => {
  it('returns null for an empty run set', () => {
    expect(outlineRunsBBox([])).toBeNull();
  });

  it('translates every point and leaves the run tags alone', () => {
    const face = synthFace();
    const { runs } = outlineTextToRuns({ face, text: 'O', capHeightMM: 100 });
    const before = bboxOf(runs);
    const moved = translateOutlineRuns(runs, 7, -3);
    const after = bboxOf(moved);
    expect(after.minX - before.minX).toBeCloseTo(7, 9);
    expect(after.minY - before.minY).toBeCloseTo(-3, 9);
    expect(moved.map((r) => r.role)).toEqual(runs.map((r) => r.role));
  });
});
