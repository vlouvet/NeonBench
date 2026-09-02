import { describe, expect, it } from 'vitest';
import type { DesignDoc, Guideline } from '../api';
import { MM_PER_INCH } from './units';
import {
  MIN_LABEL_SPACING_IN_PX,
  MIN_LABEL_SPACING_PX,
  MIN_MINOR_SPACING_PX,
  TICK_LADDER_IN_MM,
  TICK_LADDER_MM,
  addConstructionGuide,
  chooseTickSteps,
  constructionGuides,
  findGuide,
  formatTickLabel,
  guidePositionMM,
  hitTestGuides,
  isRacewayGuideline,
  isVerticalGuide,
  moveGuide,
  racewayGuidelines,
  rulerTicks,
  snapGuidesForDoc,
} from './guides';

const doc = (guidelines?: Guideline[]): DesignDoc => ({
  version: 1,
  view_box_mm: [0, 0, 200, 100],
  runs: [],
  ...(guidelines ? { guidelines } : {}),
});

// ---------------------------------------------------------------------------
// Tick ladder
// ---------------------------------------------------------------------------

describe('chooseTickSteps', () => {
  // The zoom range the editor actually allows is 0.05 … 200 px/mm; sample it
  // at the decades an operator lives at plus both extremes.
  const scales = [0.05, 0.1, 0.25, 0.5, 1, 2, 4, 10, 25, 100, 200];

  it('never returns a zero or negative step at any zoom', () => {
    for (const scale of scales) {
      const { majorMM, minorMM } = chooseTickSteps(scale);
      expect(majorMM).toBeGreaterThan(0);
      expect(minorMM).toBeGreaterThan(0);
    }
  });

  it('keeps labelled ticks far enough apart to never collide', () => {
    for (const scale of scales) {
      const { majorMM } = chooseTickSteps(scale);
      // The only case allowed to fall short is the top of the ladder — past
      // that there is no coarser step to escape to.
      if (majorMM === TICK_LADDER_MM[TICK_LADDER_MM.length - 1]) continue;
      expect(majorMM * scale).toBeGreaterThanOrEqual(MIN_LABEL_SPACING_PX);
    }
  });

  it('picks the SMALLEST qualifying step, not just any qualifying one', () => {
    for (const scale of scales) {
      const { majorMM } = chooseTickSteps(scale);
      const idx = TICK_LADDER_MM.indexOf(majorMM as (typeof TICK_LADDER_MM)[number]);
      expect(idx).toBeGreaterThanOrEqual(0);
      if (idx > 0) {
        // The next rung down must NOT have qualified.
        expect(TICK_LADDER_MM[idx - 1] * scale).toBeLessThan(MIN_LABEL_SPACING_PX);
      }
    }
  });

  it('keeps minor ticks below major and above the legibility floor', () => {
    for (const scale of scales) {
      const { majorMM, minorMM } = chooseTickSteps(scale);
      expect(minorMM).toBeLessThanOrEqual(majorMM);
      if (minorMM !== majorMM) {
        expect(minorMM * scale).toBeGreaterThanOrEqual(MIN_MINOR_SPACING_PX);
      }
    }
  });

  it('gets coarser as you zoom out and finer as you zoom in', () => {
    let prev = Infinity;
    for (const scale of [...scales].sort((a, b) => a - b)) {
      const { majorMM } = chooseTickSteps(scale);
      expect(majorMM).toBeLessThanOrEqual(prev);
      prev = majorMM;
    }
  });

  it('survives a degenerate scale instead of emitting a 0mm step', () => {
    for (const bad of [0, -1, NaN, Infinity]) {
      const { majorMM, minorMM } = chooseTickSteps(bad);
      expect(majorMM).toBeGreaterThan(0);
      expect(minorMM).toBeGreaterThan(0);
    }
  });
});

describe('rulerTicks', () => {
  it('maps mm to px with the same formula the canvas transform uses', () => {
    // px = offset + mm * scale. At scale 2 and tx 100, 50mm sits at 200px.
    const { ticks } = rulerTicks({ scale: 2, offsetPx: 100, startPx: 0, endPx: 400 });
    const at50 = ticks.find((t) => t.mm === 50);
    expect(at50).toBeDefined();
    expect(at50!.px).toBeCloseTo(200, 9);
  });

  it('covers the visible span and nothing far outside it', () => {
    const { ticks } = rulerTicks({ scale: 1, offsetPx: 0, startPx: 0, endPx: 500 });
    expect(ticks.length).toBeGreaterThan(0);
    for (const t of ticks) {
      expect(t.px).toBeGreaterThanOrEqual(-1e-6);
      expect(t.px).toBeLessThanOrEqual(500 + 1e-6);
    }
  });

  it('handles a negative-mm span (panned past the origin)', () => {
    const { ticks } = rulerTicks({ scale: 1, offsetPx: 300, startPx: 0, endPx: 400 });
    expect(ticks.some((t) => t.mm < 0)).toBe(true);
    expect(ticks.some((t) => t.mm > 0)).toBe(true);
    const zero = ticks.find((t) => t.mm === 0);
    expect(zero?.px).toBeCloseTo(300, 9);
  });

  it('emits ticks in ascending px order with no duplicates', () => {
    const { ticks } = rulerTicks({ scale: 3.7, offsetPx: -412, startPx: 0, endPx: 900 });
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].px).toBeGreaterThan(ticks[i - 1].px);
    }
    expect(new Set(ticks.map((t) => t.mm)).size).toBe(ticks.length);
  });

  it('marks every major-step multiple as major, even where a minor coincides', () => {
    const { ticks, majorMM } = rulerTicks({ scale: 1, offsetPx: 0, startPx: 0, endPx: 500 });
    for (const t of ticks) {
      const onMajor = Math.abs(t.mm / majorMM - Math.round(t.mm / majorMM)) < 1e-9;
      expect(t.major).toBe(onMajor);
    }
  });

  it('returns no ticks (but still a valid step) for a degenerate span', () => {
    expect(rulerTicks({ scale: 1, offsetPx: 0, startPx: 100, endPx: 100 }).ticks).toEqual([]);
    const bad = rulerTicks({ scale: 0, offsetPx: 0, startPx: 0, endPx: 500 });
    expect(bad.ticks).toEqual([]);
    expect(bad.majorMM).toBeGreaterThan(0);
  });

  it('stays bounded at extreme zoom-out', () => {
    const { ticks } = rulerTicks({ scale: 0.05, offsetPx: 0, startPx: 0, endPx: 2000 });
    expect(ticks.length).toBeLessThan(1000);
  });
});

describe('formatTickLabel', () => {
  it('drops decimals for whole-mm steps', () => {
    expect(formatTickLabel(100, 10)).toBe('100');
    expect(formatTickLabel(-50, 50)).toBe('-50');
  });

  it('keeps one decimal for sub-mm steps', () => {
    expect(formatTickLabel(10.5, 0.5)).toBe('10.5');
  });

  it('never prints a negative zero', () => {
    expect(formatTickLabel(-0, 1)).toBe('0');
    expect(formatTickLabel(-0, 0.5)).toBe('0.0');
  });
});

// ---------------------------------------------------------------------------
// Guide CRUD
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Tier 1 #130 — inch ruler
// ---------------------------------------------------------------------------

describe('inch tick ladder', () => {
  // The ladder is in MILLIMETRES so rulerTicks keeps one copy of the
  // px = offset + mm * scale formula. If an entry ever stops being an exact
  // inch fraction, ticks stop landing on tape-measure marks.
  it('is exactly the tape-measure rungs, expressed in mm', () => {
    // Asserted as mm, which is what the ladder actually holds and what the
    // ticks are computed from. Dividing back out by 25.4 is NOT exact in
    // binary float (76.2 / 25.4 is 2.9999999999999996), so a round-trip
    // comparison would be testing IEEE 754 rather than the ladder.
    expect([...TICK_LADDER_IN_MM]).toEqual([
      1.5875, 3.175, 6.35, 12.7, 25.4, 50.8, 76.2, 152.4, 304.8, 609.6, 1524,
      3048, 6096, 15240, 30480,
    ]);
    const inches = [1 / 16, 1 / 8, 1 / 4, 1 / 2, 1, 2, 3, 6, 12, 24, 60, 120, 240, 600, 1200];
    TICK_LADDER_IN_MM.forEach((mm, i) => {
      expect(mm / MM_PER_INCH).toBeCloseTo(inches[i], 9);
    });
  });

  it('rises monotonically, like the mm ladder', () => {
    for (let i = 1; i < TICK_LADDER_IN_MM.length; i++) {
      expect(TICK_LADDER_IN_MM[i]).toBeGreaterThan(TICK_LADDER_IN_MM[i - 1]);
    }
  });

  it('picks a rung off the inch ladder, never the mm one', () => {
    for (const scale of [0.05, 0.2, 1, 3, 10, 40, 200]) {
      const { majorMM, minorMM } = chooseTickSteps(scale, undefined, 'in');
      expect(TICK_LADDER_IN_MM).toContain(majorMM);
      expect(TICK_LADDER_IN_MM).toContain(minorMM);
    }
  });

  it('clears the wider inch label spacing at every zoom', () => {
    for (const scale of [0.05, 0.2, 1, 3, 10, 40, 200]) {
      const { majorMM } = chooseTickSteps(scale, undefined, 'in');
      const coarsest = TICK_LADDER_IN_MM[TICK_LADDER_IN_MM.length - 1];
      if (majorMM !== coarsest) {
        expect(majorMM * scale).toBeGreaterThanOrEqual(MIN_LABEL_SPACING_IN_PX);
      }
    }
  });

  it('leaves mm callers on the mm ladder and the narrower spacing', () => {
    expect(MIN_LABEL_SPACING_IN_PX).toBeGreaterThan(MIN_LABEL_SPACING_PX);
    for (const scale of [0.05, 1, 10, 200]) {
      expect(TICK_LADDER_MM).toContain(chooseTickSteps(scale).majorMM);
      expect(TICK_LADDER_MM).toContain(chooseTickSteps(scale, undefined, 'mm').majorMM);
    }
  });

  // At one inch per ~76px the rung is 1", so ticks land on whole inches and
  // the geometry at 4" sits under the tick labelled 4.
  it('puts ticks on whole inches at a one-inch rung', () => {
    const scale = MIN_LABEL_SPACING_IN_PX / MM_PER_INCH; // just clears 1"
    const { ticks, majorMM } = rulerTicks({
      scale,
      offsetPx: 0,
      startPx: 0,
      endPx: 800,
      units: 'in',
    });
    expect(majorMM).toBeCloseTo(MM_PER_INCH, 9);
    const majors = ticks.filter((t) => t.major).slice(0, 5);
    majors.forEach((t, i) => {
      expect(t.mm / MM_PER_INCH).toBeCloseTo(i, 6);
      expect(t.px).toBeCloseTo(i * MM_PER_INCH * scale, 6);
    });
  });
});

describe('formatTickLabel in inches', () => {
  it('reduces to whole inches on a coarse rung', () => {
    expect(formatTickLabel(MM_PER_INCH * 4, MM_PER_INCH, 'in')).toBe('4');
    expect(formatTickLabel(MM_PER_INCH * 48, MM_PER_INCH * 12, 'in')).toBe('48');
  });

  // A fixed sixteenth denominator plus reduction replaces the mm
  // decimals-per-step rule: no rung needs its own case.
  it('reduces sub-inch rungs to their own fraction', () => {
    expect(formatTickLabel(MM_PER_INCH / 4, MM_PER_INCH / 4, 'in')).toBe('1/4');
    expect(formatTickLabel(MM_PER_INCH / 2, MM_PER_INCH / 4, 'in')).toBe('1/2');
    expect(formatTickLabel((MM_PER_INCH * 3) / 4, MM_PER_INCH / 4, 'in')).toBe('3/4');
    expect(formatTickLabel(MM_PER_INCH, MM_PER_INCH / 4, 'in')).toBe('1');
    expect(formatTickLabel(MM_PER_INCH * 2.0625, MM_PER_INCH / 16, 'in')).toBe('2 1/16');
  });

  it('shows negative ticks without a negative zero', () => {
    expect(formatTickLabel(-MM_PER_INCH * 2, MM_PER_INCH, 'in')).toBe('-2');
    expect(formatTickLabel(-0, MM_PER_INCH, 'in')).toBe('0');
  });

  // Feet are a deliberate non-goal: one unit on one rule.
  it('never prints feet, however coarse the rung', () => {
    const label = formatTickLabel(MM_PER_INCH * 120, MM_PER_INCH * 120, 'in');
    expect(label).toBe('120');
    expect(label).not.toContain("'");
  });

  it('leaves the mm form untouched when units are omitted', () => {
    expect(formatTickLabel(100, 10)).toBe('100');
    expect(formatTickLabel(10.5, 0.5)).toBe('10.5');
  });
});

describe('guide CRUD', () => {
  it('adds a horizontal guide with no x_mm or axis key at all', () => {
    const out = addConstructionGuide(doc(), 'h', 42.5);
    expect(out.guidelines).toHaveLength(1);
    const g = out.guidelines![0];
    expect(g).toEqual({ id: 'rw1', kind: 'construction', y_mm: 42.5 });
    // The back-compat invariant: no key means no bytes. A stray `x_mm: 0`
    // or `axis: 'h'` here would change every saved doc's JSON.
    expect('x_mm' in g).toBe(false);
    expect('axis' in g).toBe(false);
  });

  it('adds a vertical guide carrying its position in x_mm', () => {
    const out = addConstructionGuide(doc(), 'v', 75);
    expect(out.guidelines![0]).toEqual({
      id: 'rw1',
      kind: 'construction',
      y_mm: 0,
      x_mm: 75,
      axis: 'v',
    });
  });

  it('shares the raceway id space so raceway_id FKs stay unambiguous', () => {
    const withRaceway = doc([{ id: 'rw1', kind: 'raceway', y_mm: 10 }]);
    const out = addConstructionGuide(withRaceway, 'v', 5);
    expect(out.guidelines!.map((g) => g.id)).toEqual(['rw1', 'rw2']);
  });

  it('refuses a non-finite position rather than writing NaN into the doc', () => {
    const d = doc();
    expect(addConstructionGuide(d, 'h', NaN)).toBe(d);
    expect(moveGuide(doc([{ id: 'rw1', kind: 'raceway', y_mm: 1 }]), 'rw1', NaN).guidelines![0].y_mm)
      .toBe(1);
  });

  it('moves each guide along its own axis, never the other one', () => {
    const d = doc([
      { id: 'rw1', kind: 'raceway', y_mm: 10 },
      { id: 'rw2', kind: 'construction', y_mm: 0, x_mm: 20, axis: 'v' },
    ]);
    const movedH = moveGuide(d, 'rw1', 33);
    expect(movedH.guidelines![0]).toEqual({ id: 'rw1', kind: 'raceway', y_mm: 33 });
    const movedV = moveGuide(d, 'rw2', 44);
    expect(movedV.guidelines![1]).toEqual({
      id: 'rw2',
      kind: 'construction',
      y_mm: 0,
      x_mm: 44,
      axis: 'v',
    });
  });

  it('is referentially stable when nothing changes', () => {
    const d = doc([{ id: 'rw1', kind: 'raceway', y_mm: 10 }]);
    expect(moveGuide(d, 'rw1', 10)).toBe(d);
    expect(moveGuide(d, 'nope', 10)).toBe(d);
  });

  it('separates the cut line from the layout scaffolding', () => {
    const d = doc([
      { id: 'rw1', kind: 'raceway', y_mm: 10 },
      { id: 'rw2', kind: 'construction', y_mm: 20 },
      { id: 'rw3', kind: 'construction', y_mm: 0, x_mm: 30, axis: 'v' },
    ]);
    expect(racewayGuidelines(d).map((g) => g.id)).toEqual(['rw1']);
    expect(constructionGuides(d).map((g) => g.id)).toEqual(['rw2', 'rw3']);
    expect(isRacewayGuideline(findGuide(d, 'rw1'))).toBe(true);
    expect(isRacewayGuideline(findGuide(d, 'rw2'))).toBe(false);
    expect(isRacewayGuideline(findGuide(d, 'missing'))).toBe(false);
  });

  it('reads axis and position the same way the Go side does', () => {
    const h: Guideline = { id: 'rw1', kind: 'construction', y_mm: 12 };
    const explicitH: Guideline = { id: 'rw2', kind: 'construction', y_mm: 12, axis: 'h' };
    const v: Guideline = { id: 'rw3', kind: 'construction', y_mm: 0, x_mm: 9, axis: 'v' };
    expect(isVerticalGuide(h)).toBe(false);
    expect(isVerticalGuide(explicitH)).toBe(false);
    expect(isVerticalGuide(v)).toBe(true);
    expect(guidePositionMM(h)).toBe(12);
    expect(guidePositionMM(v)).toBe(9);
    // A vertical guide with no x_mm at all reads as 0, not undefined.
    expect(guidePositionMM({ id: 'x', kind: 'construction', y_mm: 0, axis: 'v' })).toBe(0);
  });

  it('offers every guide as a snap target, raceway included', () => {
    const d = doc([
      { id: 'rw1', kind: 'raceway', y_mm: 10 },
      { id: 'rw2', kind: 'construction', y_mm: 0, x_mm: 30, axis: 'v' },
    ]);
    expect(snapGuidesForDoc(d)).toEqual([
      { id: 'rw1', axis: 'h', posMM: 10 },
      { id: 'rw2', axis: 'v', posMM: 30 },
    ]);
    expect(snapGuidesForDoc(doc())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Hit-testing
// ---------------------------------------------------------------------------

describe('hitTestGuides', () => {
  const list: Guideline[] = [
    { id: 'rw1', kind: 'raceway', y_mm: 50 },
    { id: 'rw2', kind: 'construction', y_mm: 0, x_mm: 20, axis: 'v' },
  ];

  it('measures the grab radius in screen px, not mm', () => {
    // 1mm off the guide. At 1 px/mm that is 1px — a hit inside a 6px
    // tolerance. At 0.1 px/mm the same 1mm is 0.1px, still a hit; at
    // 20 px/mm it is 20px, a miss. That zoom-invariance is the point.
    expect(hitTestGuides(list, [0, 51], 1)?.id).toBe('rw1');
    expect(hitTestGuides(list, [0, 51], 0.1)?.id).toBe('rw1');
    expect(hitTestGuides(list, [0, 51], 20)).toBeNull();
  });

  it('hits a vertical guide on x', () => {
    const hit = hitTestGuides(list, [20.2, 0], 4);
    expect(hit?.id).toBe('rw2');
    expect(hit?.axis).toBe('v');
    expect(hit?.posMM).toBe(20);
  });

  it('returns the closest when both are in range', () => {
    // Cursor near the crossing: 0.1mm from the v-guide, 2mm from the h.
    expect(hitTestGuides(list, [20.1, 48], 1)?.id).toBe('rw2');
    expect(hitTestGuides(list, [22, 50.1], 1)?.id).toBe('rw1');
  });

  it('reports the distance in px so callers can rank against other hits', () => {
    const hit = hitTestGuides(list, [0, 52], 1);
    expect(hit?.distancePx).toBeCloseTo(2, 9);
  });

  it('misses cleanly on an empty list or a degenerate scale', () => {
    expect(hitTestGuides([], [0, 50], 1)).toBeNull();
    expect(hitTestGuides(list, [0, 50], 0)).toBeNull();
    expect(hitTestGuides(list, [0, 50], NaN)).toBeNull();
  });
});
