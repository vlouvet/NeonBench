// Bug #13 — `capHeightMM` must mean what it says.
//
// `fonts.ts` declares `capHeightUnits` per face and `hersheyTextToRuns`
// scales every glyph by `capHeightMM / capHeightUnits`. That constant is
// a CLAIM ABOUT THE BUNDLED DATA, and it was wrong: it said 12 while
// every bundled face measures 21 JHF units from cap top to baseline, so
// all single-stroke text came out 21/12 = 1.75× the requested height.
//
// This suite pins the claim to the data. Every expected number is
// MEASURED from the glyph JSON at test time — there is deliberately no
// second hard-coded "21" for the declaration to be checked against, so
// this cannot rot into agreeing with a future wrong constant the way an
// `expect(capHeightUnits).toBe(21)` assertion would.

import { describe, expect, it } from 'vitest';
import { FONTS, type FontEntry, type FontKey } from './fonts';
import { hersheyRunsBBox, hersheyTextToRuns, type HersheyRun } from './text';

const FACES = Object.keys(FONTS) as FontKey[];

/** Capitals with flat tops and flat bottoms: no round-letter overshoot
 *  (O, S, C sit a hair above the cap line and below the baseline) and no
 *  descending tail. Their y-extent IS the cap height, exactly.
 *
 *  'Z' is deliberately absent: it qualifies in the three Roman/sans
 *  faces but the cursive face gives it a descending swash tail (JHF
 *  y=+21 against a baseline of +9). Same for Q and J everywhere. The
 *  "every flat capital measures that same span" test below is the guard
 *  that caught it. */
const FLAT_CAPS = ['H', 'E', 'X', 'I', 'T', 'L', 'F'];

/** Y-extent of a set of characters in RAW JHF source units, read
 *  straight out of the bundled font data. */
function jhfYExtent(face: FontEntry, chars: string[]): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const ch of chars) {
    const glyph = face.data.glyphs[String(ch.charCodeAt(0))];
    if (!glyph) continue;
    for (const stroke of glyph.strokes) {
      for (const [, y] of stroke) {
        if (y < min) min = y;
        if (y > max) max = y;
      }
    }
  }
  expect(Number.isFinite(min) && Number.isFinite(max)).toBe(true);
  return { min, max };
}

/** Cap height of a face, MEASURED in JHF units from its own glyph data. */
function measuredCapHeightUnits(face: FontEntry): number {
  const { min, max } = jhfYExtent(face, FLAT_CAPS);
  return max - min;
}

function inkBox(runs: HersheyRun[]) {
  const box = hersheyRunsBBox(runs);
  expect(box).not.toBeNull();
  return box!;
}

function inkHeight(runs: HersheyRun[]): number {
  const box = inkBox(runs);
  return box.maxY - box.minY;
}

function render(
  font: FontKey,
  text: string,
  capHeightMM: number,
  extra: Record<string, unknown> = {},
): HersheyRun[] {
  return hersheyTextToRuns({ text, font, capHeightMM, originX: 0, originY: 0, ...extra });
}

// Bug #07 densifies curved strokes along a Catmull-Rom spline, which
// passes THROUGH every source vertex but can bow a hair outside the
// polygon between them. So a rendered capital is never SHORTER than the
// cap height, and never more than a fraction of a percent taller. The
// three Roman/sans faces draw their flat capitals with straight strokes
// (bow = 0 exactly); only the cursive script face has curved capitals.
//
// The bug this file exists for produced a 75% excess, so a 2.5% ceiling
// separates the two cases by more than an order of magnitude — and the
// "excess scales linearly with size" assertion below proves whatever is
// left is a fixed fraction of the glyph (a spline artefact) rather than
// a metric error.
const MAX_SMOOTHING_BOW_FRACTION = 0.025;

/** Assert `measured` is one cap height, allowing only the outward spline
 *  bow described above. */
function expectOneCapHeight(measured: number, capHeightMM: number) {
  expect(measured).toBeGreaterThanOrEqual(capHeightMM - 1e-6);
  expect(measured - capHeightMM).toBeLessThan(capHeightMM * MAX_SMOOTHING_BOW_FRACTION);
}

describe('capHeightUnits matches the bundled glyph data (Bug #13)', () => {
  it.each(FACES)('%s: the declared constant equals the measured cap span', (key) => {
    const face = FONTS[key];
    expect(face.capHeightUnits).toBe(measuredCapHeightUnits(face));
  });

  it.each(FACES)('%s: every flat capital measures that same span', (key) => {
    // Guards the helper above: if one of FLAT_CAPS is not actually flat
    // in some face, `measuredCapHeightUnits` would be measuring the union
    // of two different metrics rather than the cap height.
    const face = FONTS[key];
    const whole = measuredCapHeightUnits(face);
    for (const ch of FLAT_CAPS) {
      const { min, max } = jhfYExtent(face, [ch]);
      expect(`${ch}=${max - min}`).toBe(`${ch}=${whole}`);
    }
  });

  it.each(FACES)('%s: the declared baseline is where the flat capitals sit', (key) => {
    const face = FONTS[key];
    expect(face.baselineUnits).toBe(jhfYExtent(face, FLAT_CAPS).max);
  });
});

describe('rendered cap height equals capHeightMM (Bug #13)', () => {
  it.each(FACES)("%s: an 'H' at capHeightMM=100 measures 100mm tall", (key) => {
    expectOneCapHeight(inkHeight(render(key, 'H', 100)), 100);
  });

  it.each(FACES)('%s: the tallest capital sets the height of a whole word', (key) => {
    // 'HEX' — flat capitals only, so the word's ink height is the cap
    // height and nothing else.
    expectOneCapHeight(inkHeight(render(key, 'HEX', 100)), 100);
  });

  it.each(FACES)('%s: any residual excess is spline bow, not a metric error', (key) => {
    // A wrong `capHeightUnits` also scales linearly with size, so this is
    // not on its own a proof — it is the companion to the 2.5% ceiling
    // above. Together: whatever excess remains is both tiny AND a fixed
    // fraction of the glyph, which is what a spline artefact looks like.
    const excess1 = inkHeight(render(key, 'H', 100)) - 100;
    const excess10 = inkHeight(render(key, 'H', 1000)) - 1000;
    expect(excess10).toBeCloseTo(excess1 * 10, 6);
  });

  it.each(FACES)('%s: cap height tracks capHeightMM at every size', (key) => {
    for (const cap of [12.7, 100, 250, 1000]) {
      expectOneCapHeight(inkHeight(render(key, 'H', cap)), cap);
    }
  });

  it.each(FACES)('%s: a descender extends BELOW the baseline', (key) => {
    // Guards against "fixing" this by normalising the whole ink box:
    // 'Hg' must be TALLER than one cap height, because g drops below the
    // baseline that H sits on.
    const capOnly = inkHeight(render(key, 'H', 100));
    const withDescender = inkHeight(render(key, 'Hg', 100));
    expect(withDescender).toBeGreaterThan(capOnly + 1);
    expectOneCapHeight(capOnly, 100);
  });

  it.each(FACES)('%s: the ink sits between the declared cap line and baseline', (key) => {
    // `originY` anchors JHF y=0, which is NOT the typographic baseline —
    // the baseline lands at `originY + baselineUnits * scale` and the cap
    // line one cap height above it. Assert the rendered 'H' actually
    // reaches both, so the two declared metrics describe real ink.
    const face = FONTS[key];
    const scale = 100 / face.capHeightUnits;
    const originY = 200;
    const box = inkBox(
      hersheyTextToRuns({ text: 'H', font: key, capHeightMM: 100, originX: 0, originY }),
    );
    const baseline = originY + face.baselineUnits * scale;
    const capLine = baseline - 100;
    const bow = 100 * MAX_SMOOTHING_BOW_FRACTION;
    expect(box.maxY).toBeGreaterThanOrEqual(baseline - 1e-6);
    expect(box.maxY).toBeLessThan(baseline + bow);
    expect(box.minY).toBeLessThanOrEqual(capLine + 1e-6);
    expect(box.minY).toBeGreaterThan(capLine - bow);
  });
});

describe('multi-line pitch is lineHeight × capHeightMM (Bug #13)', () => {
  // Both lines render the same glyph, so any spline bow is identical on
  // each and cancels out of the difference — these stay exact.
  it.each(FACES)('%s: two lines at lineHeight 1.2 sit 120mm apart at cap 100', (key) => {
    const runs = render(key, 'H\nH', 100, { lineHeight: 1.2 });
    const a = inkBox(runs.filter((r) => r.lineIndex === 0));
    const b = inkBox(runs.filter((r) => r.lineIndex === 1));
    expect(Math.abs(b.minY - a.minY - 120)).toBeLessThan(1e-6);
  });

  it.each(FACES)('%s: line pitch scales with lineHeight', (key) => {
    for (const lh of [1, 1.2, 2]) {
      const runs = render(key, 'H\nH', 100, { lineHeight: lh });
      const a = inkBox(runs.filter((r) => r.lineIndex === 0));
      const b = inkBox(runs.filter((r) => r.lineIndex === 1));
      expect(Math.abs(b.minY - a.minY - 100 * lh)).toBeLessThan(1e-6);
    }
  });

  it.each(FACES)('%s: capital-only lines clear each other at the default 1.2', (key) => {
    // Before the fix this was NOT true: the pitch was 1.2 × capHeightMM
    // while a capital was 1.75 × capHeightMM tall, so consecutive lines
    // of plain capitals overlapped by half a letter.
    const runs = render(key, 'H\nH', 100, { lineHeight: 1.2 });
    const a = inkBox(runs.filter((r) => r.lineIndex === 0));
    const b = inkBox(runs.filter((r) => r.lineIndex === 1));
    expect(b.minY).toBeGreaterThan(a.maxY);
  });

  it.each(FACES)('%s: a descender still collides at the default 1.2', (key) => {
    // Documented consequence of the corrected metric, NOT an endorsement
    // of 1.2 as a default: 1.2 cap heights of pitch clears capitals but
    // not a descender sitting above the next line's cap. Recorded here so
    // that changing `lineHeight` is a deliberate, visible edit rather
    // than a silent drift. See the Bug #13 PR body.
    const runs = render(key, 'g\nH', 100, { lineHeight: 1.2 });
    const g = inkBox(runs.filter((r) => r.lineIndex === 0));
    const h = inkBox(runs.filter((r) => r.lineIndex === 1));
    expect(h.minY).toBeLessThan(g.maxY);
  });
});
