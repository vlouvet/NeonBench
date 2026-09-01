// Tier 2 #104 / NW #133 — the raceway as a modelled hardware object.
//
// The invariants worth pinning here are the ones that are invisible in the
// UI: that auto-fit is arc-aware, that the box is flush by DECISION rather
// than by accident, and that deleting a guideline takes its box with it —
// because a Raceway whose id names no guideline is rejected by the Go
// decoder, which turns every subsequent save into a 400 with no visible
// cause.

import { describe, expect, it } from 'vitest';
import {
  RACEWAY_DEFAULT_DEPTH_MM,
  RACEWAY_DEFAULT_HEIGHT_MM,
  RACEWAY_END_MARGIN_MM,
  RACEWAY_SPLICE_MM,
  TRANSFORMER_LENGTH_MM,
  type DesignDoc,
  type DesignRun,
} from '../api';
import * as ops from './docOps';
import { flatRunPoints } from './arcGeom';

const letter = (id: string, x0: number, x1: number, raceway?: string): DesignRun => ({
  id,
  polyline: {
    points: [
      [x0, 0],
      [x1, 0],
      [x1, 50],
      [x0, 50],
    ],
    closed: true,
  },
  is_channel_letter_face: true,
  ...(raceway ? { raceway_id: raceway } : {}),
});

function docWithRaceway(runs: DesignRun[]): DesignDoc {
  return {
    version: 1,
    view_box_mm: [0, 0, 400, 200],
    runs,
    guidelines: [{ id: 'rw1', kind: 'raceway', y_mm: 50 }],
  };
}

describe('raceway model — identity', () => {
  it('hangs the box off its guideline and refuses any other id', () => {
    const doc = docWithRaceway([letter('a', 0, 50, 'rw1')]);
    const withBox = ops.createRaceway(doc, 'rw1');
    expect(ops.findRaceway(withBox, 'rw1')?.id).toBe('rw1');

    // Not a guideline at all.
    expect(ops.createRaceway(doc, 'nope')).toBe(doc);
    // A CONSTRUCTION guide is layout scaffolding; it mounts nothing.
    const constructionOnly: DesignDoc = {
      ...doc,
      guidelines: [{ id: 'g1', kind: 'construction', y_mm: 10 }],
    };
    expect(ops.createRaceway(constructionOnly, 'g1')).toBe(constructionOnly);
    // Idempotent: a guideline carries at most one box.
    expect(ops.createRaceway(withBox, 'rw1')).toBe(withBox);
  });

  it('takes the box with the guideline when the guideline is deleted', () => {
    const doc = ops.createRaceway(docWithRaceway([letter('a', 0, 50, 'rw1')]), 'rw1');
    expect(doc.raceways).toHaveLength(1);
    const after = ops.removeGuideline(doc, 'rw1');
    expect(after.guidelines).toBeUndefined();
    // The dangling box is what the Go decoder rejects — leaving one behind
    // makes every later save 400 with nothing on screen to explain it.
    expect(after.raceways).toBeUndefined();
    // The glass keeps its tag: un-modelling the hardware does not un-cut it.
    expect(after.runs[0].raceway_id).toBe('rw1');
  });

  it('removes the box on its own without touching the guideline or the tags', () => {
    const doc = ops.createRaceway(docWithRaceway([letter('a', 0, 50, 'rw1')]), 'rw1');
    const after = ops.removeRaceway(doc, 'rw1');
    expect(after.raceways).toBeUndefined();
    expect(after.guidelines).toHaveLength(1);
    expect(after.runs[0].raceway_id).toBe('rw1');
  });
});

describe('raceway model — auto-fit', () => {
  it('spans its member runs exactly, flush at both ends', () => {
    expect(RACEWAY_END_MARGIN_MM).toBe(0);
    const doc = ops.createRaceway(
      docWithRaceway([letter('a', 10, 60, 'rw1'), letter('b', 80, 130, 'rw1')]),
      'rw1',
    );
    const rw = ops.findRaceway(doc, 'rw1');
    expect(rw?.x_mm).toBe(10);
    expect(rw?.length_mm).toBe(120);
  });

  it('ignores runs that belong to another raceway or to none', () => {
    const doc = ops.createRaceway(
      docWithRaceway([
        letter('a', 10, 60, 'rw1'),
        letter('other', 900, 950, 'rw2'),
        letter('loose', 500, 550),
      ]),
      'rw1',
    );
    const rw = ops.findRaceway(doc, 'rw1');
    expect(rw?.x_mm).toBe(10);
    expect(rw?.length_mm).toBe(50);
  });

  it('is ARC-AWARE: a bow past the vertices widens the box', () => {
    // A vertical chord travelling +Y. 'arc_r' bows to the RIGHT of travel,
    // i.e. toward +X, past both of its own vertices.
    const bowed: DesignRun = {
      id: 'bow',
      polyline: {
        points: [
          [100, 0],
          [100, 100],
        ],
        closed: false,
        segment_types: ['arc_r'],
      },
      raceway_id: 'rw1',
    };
    const doc = ops.createRaceway(docWithRaceway([letter('a', 0, 50, 'rw1'), bowed]), 'rw1');
    const rw = ops.findRaceway(doc, 'rw1');

    // The negative control. A fit built from raw polyline.points would stop
    // at x=100; the flattened arc reaches ~125 (sagitta = 0.5 * half-chord).
    const rawMaxX = Math.max(...bowed.polyline.points.map((p) => p[0]));
    const flatMaxX = Math.max(...flatRunPoints(bowed).map((p) => p[0]));
    expect(rawMaxX).toBe(100);
    expect(flatMaxX).toBeGreaterThan(120);
    expect(rw!.x_mm + rw!.length_mm).toBeCloseTo(flatMaxX, 6);
    expect(rw!.x_mm + rw!.length_mm).toBeGreaterThan(rawMaxX);
  });

  it('re-fits a stale box after the letters move, and keeps the stock dimensions', () => {
    let doc = ops.createRaceway(docWithRaceway([letter('a', 0, 50, 'rw1')]), 'rw1');
    doc = ops.setRacewayGeometry(doc, 'rw1', { height_mm: 150, depth_mm: 180 });
    // The letter moves right; the box is now stale.
    doc = { ...doc, runs: [letter('a', 200, 260, 'rw1')] };
    const fitted = ops.fitRacewayToRuns(doc, 'rw1');
    const rw = ops.findRaceway(fitted, 'rw1')!;
    expect(rw.x_mm).toBe(200);
    expect(rw.length_mm).toBe(60);
    // Auto-fit answers "where and how long", never "made of what stock".
    expect(rw.height_mm).toBe(150);
    expect(rw.depth_mm).toBe(180);
  });

  it('leaves a box with no member runs alone rather than collapsing it', () => {
    const doc = ops.createRaceway(docWithRaceway([]), 'rw1');
    // No members: the box spans the view box so the operator has something
    // to see and drag.
    expect(ops.findRaceway(doc, 'rw1')).toEqual({ id: 'rw1', x_mm: 0, length_mm: 400 });
    expect(ops.fitRacewayToRuns(doc, 'rw1')).toBe(doc);
  });
});

describe('raceway model — manual override', () => {
  const base = () => ops.createRaceway(docWithRaceway([letter('a', 0, 100, 'rw1')]), 'rw1');

  it('stores every dimension the operator types', () => {
    const doc = ops.setRacewayGeometry(base(), 'rw1', {
      x_mm: -25,
      length_mm: 3500,
      height_mm: 150,
      depth_mm: 110,
    });
    expect(ops.findRaceway(doc, 'rw1')).toEqual({
      id: 'rw1',
      x_mm: -25,
      length_mm: 3500,
      height_mm: 150,
      depth_mm: 110,
    });
  });

  it('treats a cleared height/depth as "shop default", not as zero', () => {
    let doc = ops.setRacewayGeometry(base(), 'rw1', { height_mm: 150 });
    doc = ops.setRacewayGeometry(doc, 'rw1', { height_mm: 0 });
    const rw = ops.findRaceway(doc, 'rw1')!;
    expect(rw.height_mm).toBeUndefined();
    expect(ops.racewayEffectiveHeightMM(rw)).toBe(RACEWAY_DEFAULT_HEIGHT_MM);
    expect(ops.racewayEffectiveDepthMM(rw)).toBe(RACEWAY_DEFAULT_DEPTH_MM);
  });

  it('drags either end, pinning the other, and never turns the box inside out', () => {
    const doc = base();
    const left = ops.dragRacewayEnd(doc, 'rw1', 'left', 40);
    expect(ops.findRaceway(left, 'rw1')).toMatchObject({ x_mm: 40, length_mm: 60 });

    const right = ops.dragRacewayEnd(doc, 'rw1', 'right', 250);
    expect(ops.findRaceway(right, 'rw1')).toMatchObject({ x_mm: 0, length_mm: 250 });

    // Dragging the left end past the right collapses to zero, it does not
    // produce a negative length the renderer would draw backwards.
    const crossed = ops.dragRacewayEnd(doc, 'rw1', 'left', 500);
    expect(ops.findRaceway(crossed, 'rw1')).toMatchObject({ x_mm: 100, length_mm: 0 });
    const crossedRight = ops.dragRacewayEnd(doc, 'rw1', 'right', -500);
    expect(ops.findRaceway(crossedRight, 'rw1')!.length_mm).toBe(0);
  });

  it('returns the same doc object when nothing changed', () => {
    const doc = base();
    expect(ops.setRacewayGeometry(doc, 'rw1', { x_mm: 0 })).toBe(doc);
    expect(ops.setRacewayGeometry(doc, 'nope', { x_mm: 5 })).toBe(doc);
  });
});

describe('raceway model — serialization and shop constants', () => {
  it('keeps a doc with no raceways byte-identical', () => {
    const doc = docWithRaceway([letter('a', 0, 50, 'rw1')]);
    const before = JSON.stringify(doc);
    const after = JSON.stringify(ops.removeRaceway(doc, 'rw1'));
    expect(after).toBe(before);
    expect(before).not.toContain('raceways');
  });

  it('round-trips a modelled box through JSON with the defaults omitted', () => {
    const doc = ops.createRaceway(docWithRaceway([letter('a', 0, 110, 'rw1')]), 'rw1');
    const json = JSON.stringify(doc);
    expect(json).toContain('"raceways":[{"id":"rw1","x_mm":0,"length_mm":110}]');
    // An unset height/depth must not serialize as 0 — the Go side reads 0 as
    // "use the shop default", but writing it would change every doc's bytes.
    expect(json).not.toContain('height_mm');
    expect(json).not.toContain('depth_mm');
    expect(JSON.parse(json)).toEqual(doc);
  });

  it('counts butt splices at the 10ft shipping length', () => {
    const at = (length_mm: number) => ops.racewaySpliceCount({ id: 'rw1', x_mm: 0, length_mm });
    expect(at(1000)).toBe(0);
    expect(at(RACEWAY_SPLICE_MM)).toBe(0);
    expect(at(RACEWAY_SPLICE_MM + 1)).toBe(1);
    expect(at(2 * RACEWAY_SPLICE_MM)).toBe(1);
    expect(at(7620)).toBe(2); // 25 ft
  });

  it('defaults to the 8in neon-era box, not the LED-era one', () => {
    // 203.2mm = 8in. The 4–5in figures the web quotes are LED-era: a 159mm
    // transformer cannot sit across a 127mm box. docs/neon-rules/raceway.md.
    expect(RACEWAY_DEFAULT_HEIGHT_MM).toBe(203.2);
    expect(RACEWAY_DEFAULT_DEPTH_MM).toBe(203.2);
    expect(TRANSFORMER_LENGTH_MM).toBeGreaterThan(127);
    expect(RACEWAY_SPLICE_MM).toBe(3048);
  });
});
