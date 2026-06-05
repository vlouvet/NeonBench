// Tier 2 #71 — channelLetterFromText geometry pins.
//
// What we lock here is the user-visible CONTRACT: one face + two tubes
// per glyph, face flag set, optional raceway split. The exact stroke
// vertex coordinates of the Hershey skeleton flow through and would
// drift if the bundled font data changed, so we don't test pixel-perfect
// stroke positions — only the count + structure + flags + relative
// positions.

import { describe, expect, it } from 'vitest';
import {
  channelLetterFromText,
  glyphOutlineFromHersheyRuns,
  splitClosedAtY,
} from './channelLetter';
import { hersheyTextToRuns } from './hershey/text';

describe('glyphOutlineFromHersheyRuns', () => {
  it('returns a closed CCW rectangle around the input strokes', () => {
    const runs = hersheyTextToRuns({
      text: 'O',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
    });
    const rect = glyphOutlineFromHersheyRuns(runs);
    expect(rect).not.toBeNull();
    expect(rect!.length).toBe(4);
    // All four vertices distinct.
    const xs = new Set(rect!.map((p) => p[0]));
    const ys = new Set(rect!.map((p) => p[1]));
    expect(xs.size).toBe(2);
    expect(ys.size).toBe(2);
  });

  it('honors padding by expanding the rectangle on every side', () => {
    const runs = hersheyTextToRuns({
      text: 'O',
      capHeightMM: 100,
      originX: 0,
      originY: 0,
    });
    const a = glyphOutlineFromHersheyRuns(runs, 0)!;
    const b = glyphOutlineFromHersheyRuns(runs, 5)!;
    const widthA = Math.max(...a.map((p) => p[0])) - Math.min(...a.map((p) => p[0]));
    const widthB = Math.max(...b.map((p) => p[0])) - Math.min(...b.map((p) => p[0]));
    expect(widthB - widthA).toBeCloseTo(10, 6); // 5mm on each side
  });

  it('returns null for an empty input', () => {
    expect(glyphOutlineFromHersheyRuns([])).toBeNull();
  });
});

describe('splitClosedAtY', () => {
  // 100×100 axis-aligned square centred on the origin (a rectangle in
  // design space is exactly what a glyph face outline looks like).
  function square(): [number, number][] {
    return [
      [-50, -50],
      [50, -50],
      [50, 50],
      [-50, 50],
    ];
  }

  it('returns the input unchanged when the line misses the polygon', () => {
    const pieces = splitClosedAtY(square(), 1000);
    expect(pieces.length).toBe(1);
  });

  it('splits a rectangle straddling y=0 into 2 arcs that share endpoints on the line', () => {
    const pieces = splitClosedAtY(square(), 0);
    expect(pieces.length).toBe(2);
    // Every arc starts and ends on y=0.
    for (const arc of pieces) {
      expect(arc[0][1]).toBeCloseTo(0, 6);
      expect(arc[arc.length - 1][1]).toBeCloseTo(0, 6);
    }
    // Combined vertex count = original 4 corners + 2 cuts each duplicated
    // into 2 arcs = 4 + 4 = 8.
    const total = pieces.reduce((acc, a) => acc + a.length, 0);
    expect(total).toBe(8);
  });

  it('returns the input unchanged when the line is tangent to a corner', () => {
    // y=50 passes through two vertices but doesn't cross any edges.
    const pieces = splitClosedAtY(square(), 50);
    expect(pieces.length).toBe(1);
  });
});

describe('channelLetterFromText', () => {
  it('returns an empty array for empty / whitespace input', () => {
    expect(channelLetterFromText({ text: '', capHeightMM: 100, clearanceMM: 18 })).toEqual([]);
    expect(channelLetterFromText({ text: '   ', capHeightMM: 100, clearanceMM: 18 })).toEqual([]);
  });

  it('returns 1 face + 2 tube runs for a single-letter input (no raceway)', () => {
    const runs = channelLetterFromText({
      text: 'O',
      capHeightMM: 100,
      clearanceMM: 18,
    });
    expect(runs.length).toBe(3);
    const faces = runs.filter((r) => r.is_channel_letter_face);
    const tubes = runs.filter((r) => !r.is_channel_letter_face);
    expect(faces.length).toBe(1);
    expect(tubes.length).toBe(2);
    // Face is closed; tubes are closed (no raceway).
    expect(faces[0].polyline.closed).toBe(true);
    for (const t of tubes) expect(t.polyline.closed).toBe(true);
    // No raceway_id when racewayY is unset.
    for (const r of runs) expect(r.raceway_id).toBeUndefined();
  });

  it('emits 9 runs for 3 letters (3 faces + 6 tube outlines)', () => {
    const runs = channelLetterFromText({
      text: 'ABC',
      capHeightMM: 100,
      clearanceMM: 18,
    });
    expect(runs.length).toBe(9);
    expect(runs.filter((r) => r.is_channel_letter_face).length).toBe(3);
  });

  it('cap-height scales the face bbox linearly', () => {
    const at100 = channelLetterFromText({ text: 'I', capHeightMM: 100, clearanceMM: 0 });
    const at200 = channelLetterFromText({ text: 'I', capHeightMM: 200, clearanceMM: 0 });
    const heightOf = (run: { polyline: { points: [number, number][] } }) => {
      const ys = run.polyline.points.map((p) => p[1]);
      return Math.max(...ys) - Math.min(...ys);
    };
    const face100 = at100.find((r) => r.is_channel_letter_face)!;
    const face200 = at200.find((r) => r.is_channel_letter_face)!;
    // 200/100 = 2× the bbox height (within float noise).
    expect(heightOf(face200) / heightOf(face100)).toBeCloseTo(2, 1);
  });

  it('writes is_channel_letter_face=true only on the face run, not the tube runs', () => {
    const runs = channelLetterFromText({
      text: 'X',
      capHeightMM: 100,
      clearanceMM: 18,
    });
    const flags = runs.map((r) => Boolean(r.is_channel_letter_face));
    // Exactly one face flag set.
    expect(flags.filter(Boolean).length).toBe(1);
  });

  it('inherits tube color + diameter onto every emitted run', () => {
    const runs = channelLetterFromText({
      text: 'A',
      capHeightMM: 100,
      clearanceMM: 18,
      tubeColor: '#ff00ff',
      tubeDiameterMM: 12,
    });
    for (const r of runs) {
      expect(r.color).toBe('#ff00ff');
      expect(r.tube_diameter_mm).toBe(12);
    }
  });

  it('with racewayY set, splits every tube run that crosses Y and tags both pieces with the raceway_id', () => {
    // capHeightMM=100 → the face rectangle spans roughly y=-100 (top)
    // to y=0 (baseline). A raceway at y=-50 cuts through every glyph.
    const runs = channelLetterFromText({
      text: 'ABC',
      capHeightMM: 100,
      clearanceMM: 18,
      racewayY: -50,
      racewayId: 'open-raceway',
    });
    const faces = runs.filter((r) => r.is_channel_letter_face);
    const tubes = runs.filter((r) => !r.is_channel_letter_face);
    expect(faces.length).toBe(3);
    // Each of 3 glyphs contributes 2 tubes × 2 pieces = 4 tube pieces.
    // 3 glyphs × 4 = 12 tube runs.
    expect(tubes.length).toBe(12);
    // Every emitted run has the raceway_id.
    for (const r of runs) expect(r.raceway_id).toBe('open-raceway');
    // Tube pieces are open polylines (the closed loop was cut).
    for (const t of tubes) expect(t.polyline.closed).toBe(false);
  });

  it('clearance=0 collapses the two tubes into a single coincident run', () => {
    const runs = channelLetterFromText({
      text: 'O',
      capHeightMM: 100,
      clearanceMM: 0,
    });
    // 1 face + 1 collapsed tube run (we don't ship two zero-thickness
    // duplicates — the dialog UI ought to prevent this, but the pure
    // function still produces sane output).
    expect(runs.length).toBe(2);
  });

  it('respects originX/originY by translating the entire emission', () => {
    const a = channelLetterFromText({
      text: 'O',
      capHeightMM: 100,
      clearanceMM: 18,
      originX: 0,
      originY: 0,
    });
    const b = channelLetterFromText({
      text: 'O',
      capHeightMM: 100,
      clearanceMM: 18,
      originX: 500,
      originY: 200,
    });
    const minX = (run: { polyline: { points: [number, number][] } }) =>
      Math.min(...run.polyline.points.map((p) => p[0]));
    const minY = (run: { polyline: { points: [number, number][] } }) =>
      Math.min(...run.polyline.points.map((p) => p[1]));
    const fa = a.find((r) => r.is_channel_letter_face)!;
    const fb = b.find((r) => r.is_channel_letter_face)!;
    expect(minX(fb) - minX(fa)).toBeCloseTo(500, 6);
    expect(minY(fb) - minY(fa)).toBeCloseTo(200, 6);
  });
});
