import { describe, expect, it } from 'vitest';
import type { PathCommand } from 'opentype.js';
import {
  MIN_CHORD_TOLERANCE_MM,
  classifyContours,
  contoursFromCommands,
  glyphContours,
  pointInPolygon,
  type GlyphPlacement,
} from './outline';
import { signedArea } from '../shapes/offset';
import { distanceToPolyline, quadraticAt, type Pt } from './flatten';
import { synthFace } from './synthFont';
import { mmPerUnit } from './metrics';

const UNIT: GlyphPlacement = { scale: 1, originXMM: 0, baselineYMM: 0 };

function box(x1: number, y1: number, x2: number, y2: number): PathCommand[] {
  return [
    { type: 'M', x: x1, y: y1 },
    { type: 'L', x: x2, y: y1 },
    { type: 'L', x: x2, y: y2 },
    { type: 'L', x: x1, y: y2 },
    { type: 'Z' },
  ];
}

describe('contoursFromCommands', () => {
  it('closes each contour with an exact copy of its first point', () => {
    const [c] = contoursFromCommands(box(0, 0, 10, 10), UNIT);
    expect(c[0]).toEqual(c[c.length - 1]);
    expect(c[0]).not.toBe(c[c.length - 1]);
    expect(c.length).toBe(5);
  });

  it('flips y so font units (y-up) become doc millimetres (y-down)', () => {
    // Font-unit y = 100 is 100 units ABOVE the baseline, so in the doc
    // it must land 100 mm ABOVE the baseline — a SMALLER y.
    const [c] = contoursFromCommands(box(0, 0, 10, 100), UNIT);
    const ys = c.map((p) => p[1]);
    expect(Math.min(...ys)).toBe(-100);
    expect(Math.max(...ys)).toBe(0);
  });

  it('applies scale and pen offset before flattening', () => {
    const placement: GlyphPlacement = { scale: 0.5, originXMM: 20, baselineYMM: 7 };
    const [c] = contoursFromCommands(box(0, 0, 10, 100), placement);
    const xs = c.map((p) => p[0]);
    const ys = c.map((p) => p[1]);
    expect(Math.min(...xs)).toBe(20);
    expect(Math.max(...xs)).toBe(25);
    expect(Math.max(...ys)).toBe(7);
    expect(Math.min(...ys)).toBe(7 - 50);
  });

  it('splits a multi-contour glyph at each M', () => {
    const cmds = [...box(0, 0, 100, 100), ...box(20, 20, 80, 80)];
    expect(contoursFromCommands(cmds, UNIT)).toHaveLength(2);
  });

  it('closes a contour left open at the end of the command list', () => {
    const cmds: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
    ];
    const [c] = contoursFromCommands(cmds, UNIT);
    expect(c[0]).toEqual(c[c.length - 1]);
  });

  it('drops coincident vertices, which would be zero-length segments', () => {
    const cmds: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'Z' },
    ];
    const [c] = contoursFromCommands(cmds, UNIT);
    for (let i = 0; i + 1 < c.length; i++) {
      expect(Math.hypot(c[i + 1][0] - c[i][0], c[i + 1][1] - c[i][1])).toBeGreaterThan(0);
    }
  });

  // Real TrueType faces emit quadratics: Arial, Georgia, Times New Roman,
  // Verdana, SFNS and Geneva all return 'Q' for 'o' (measured with
  // opentype.js 2.0.0). The synthetic test font is CFF/cubic, so the
  // quadratic branch is pinned here with hand-written commands.
  it('flattens quadratic commands within the chord tolerance', () => {
    const tol = 0.25;
    const cmds: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 50, y1: 200, x: 100, y: 0 },
      { type: 'Z' },
    ];
    const [c] = contoursFromCommands(cmds, UNIT, tol);
    // Points come back y-flipped, so compare against a y-flipped curve.
    const p0: Pt = [0, 0];
    const cp: Pt = [50, -200];
    const p1: Pt = [100, 0];
    for (let i = 0; i <= 500; i++) {
      expect(distanceToPolyline(quadraticAt(p0, cp, p1, i / 500), c)).toBeLessThanOrEqual(tol);
    }
    expect(c.length).toBeGreaterThan(4);
  });

  it('clamps an absurdly tight tolerance instead of subdividing forever', () => {
    const cmds: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'C', x1: 0, y1: 200, x2: 100, y2: 200, x: 100, y: 0 },
      { type: 'Z' },
    ];
    const tiny = contoursFromCommands(cmds, UNIT, 1e-12);
    const floor = contoursFromCommands(cmds, UNIT, MIN_CHORD_TOLERANCE_MM);
    expect(tiny).toEqual(floor);
    expect(tiny[0].length).toBeLessThan(5000);
  });
});

describe('classifyContours', () => {
  it('labels an o-shape as one outer and one counter with opposite winding', () => {
    // Outer CCW, inner CW — the convention a filled outline relies on.
    const outer = box(0, 0, 100, 100);
    const inner: PathCommand[] = [
      { type: 'M', x: 20, y: 20 },
      { type: 'L', x: 20, y: 80 },
      { type: 'L', x: 80, y: 80 },
      { type: 'L', x: 80, y: 20 },
      { type: 'Z' },
    ];
    const res = glyphContours([...outer, ...inner], UNIT);
    expect(res.contours).toHaveLength(2);
    expect(res.contours[0].role).toBe('outer');
    expect(res.contours[1].role).toBe('counter');
    expect(res.contours[0].nestingDepth).toBe(0);
    expect(res.contours[1].nestingDepth).toBe(1);
    expect(Math.sign(res.contours[0].areaSigned)).toBe(-Math.sign(res.contours[1].areaSigned));
    expect(res.windingAgreesWithNesting).toBe(true);
  });

  it('reports areaSigned that signedArea() recomputes from the points', () => {
    const res = glyphContours(box(0, 0, 100, 50), UNIT);
    expect(res.contours[0].areaSigned).toBeCloseTo(signedArea(res.contours[0].points), 9);
  });

  it('treats two disjoint contours as two outers (the dot on an i)', () => {
    const res = glyphContours([...box(0, 0, 10, 10), ...box(50, 50, 60, 60)], UNIT);
    expect(res.contours.map((c) => c.role)).toEqual(['outer', 'outer']);
  });

  it('labels both counters of a two-hole glyph (the 8 / % case)', () => {
    const cmds = [
      ...box(0, 0, 100, 200),
      ...[
        { type: 'M', x: 20, y: 20 },
        { type: 'L', x: 20, y: 80 },
        { type: 'L', x: 80, y: 80 },
        { type: 'L', x: 80, y: 20 },
        { type: 'Z' },
      ],
      ...[
        { type: 'M', x: 20, y: 120 },
        { type: 'L', x: 20, y: 180 },
        { type: 'L', x: 80, y: 180 },
        { type: 'L', x: 80, y: 120 },
        { type: 'Z' },
      ],
    ] as PathCommand[];
    const res = glyphContours(cmds, UNIT);
    expect(res.contours.map((c) => c.role)).toEqual(['outer', 'counter', 'counter']);
  });

  it('flags a face that winds its counter the same way as its outer', () => {
    // Both CCW. Nesting still gets the role right; the winding claim is
    // reported as unreliable rather than silently trusted.
    const res = glyphContours([...box(0, 0, 100, 100), ...box(20, 20, 80, 80)], UNIT);
    expect(res.contours.map((c) => c.role)).toEqual(['outer', 'counter']);
    expect(res.windingAgreesWithNesting).toBe(false);
  });

  it('drops contours with fewer than three distinct points and counts them', () => {
    const cmds: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'Z' },
      ...box(0, 0, 50, 50),
    ];
    const res = classifyContours(contoursFromCommands(cmds, UNIT));
    expect(res.degenerateDropped).toBe(1);
    expect(res.contours).toHaveLength(1);
  });
});

describe('pointInPolygon', () => {
  it('agrees with the obvious answer on a square, closed or not', () => {
    const closed: Pt[] = [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ];
    const open = closed.slice(0, -1);
    for (const poly of [closed, open]) {
      expect(pointInPolygon([5, 5], poly)).toBe(true);
      expect(pointInPolygon([15, 5], poly)).toBe(false);
      expect(pointInPolygon([5, -1], poly)).toBe(false);
    }
  });
});

describe('a real parsed glyph', () => {
  it('gives an O two contours of opposite winding, outer then counter', () => {
    const face = synthFace();
    const glyph = face.font.charToGlyph('O');
    const scale = mmPerUnit(face.capHeight, 100);
    const res = glyphContours(glyph.path.commands, {
      scale,
      originXMM: 0,
      baselineYMM: 0,
    });
    expect(res.contours).toHaveLength(2);
    expect(res.contours.map((c) => c.role)).toEqual(['outer', 'counter']);
    expect(Math.sign(res.contours[0].areaSigned)).toBe(-Math.sign(res.contours[1].areaSigned));
    expect(Math.abs(res.contours[0].areaSigned)).toBeGreaterThan(
      Math.abs(res.contours[1].areaSigned),
    );
    expect(res.windingAgreesWithNesting).toBe(true);
  });
});
