import { describe, expect, it } from 'vitest';
import type { DesignRun } from '../api';
import {
  HOP_CORRIDOR_DIAMETERS,
  HOP_CORRIDOR_MAX_DIAMETERS,
  HOP_FALLBACK_DIAMETER_MM,
  HOP_SAMPLE_DIAMETERS,
  artworkFromRuns,
  effectiveTubeDiameterMM,
  hopStaysOnArtwork,
} from './onArtwork';

const line = (id: string, pts: [number, number][]): DesignRun => ({
  id,
  polyline: { points: pts, closed: false },
});

const arcRun = (id: string, pts: [number, number][], types: string[]): DesignRun => ({
  id,
  polyline: { points: pts, closed: false, segment_types: types as DesignRun['polyline']['segment_types'] },
});

describe('hopStaysOnArtwork', () => {
  it('accepts a hop that runs along a stroke', () => {
    const art = artworkFromRuns([line('a', [[0, 0], [300, 0]])]);
    const v = hopStaysOnArtwork([50, 0], [250, 0], art, 10, 5);
    expect(v.onArtwork).toBe(true);
    expect(v.gapMM).toBeCloseTo(200, 9);
    expect(v.worstOffsetMM).toBeLessThanOrEqual(10);
  });

  it('refuses a hop across blank face, and says how far off it strayed', () => {
    // Two collinear strokes, 90mm of nothing between them.
    const art = artworkFromRuns([
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
    ]);
    const v = hopStaysOnArtwork([100, 0], [190, 0], art, 10, 5);
    expect(v.onArtwork).toBe(false);
    // The mid-gap sample is 45mm from either stroke's nearer end.
    expect(v.worstOffsetMM).toBeCloseTo(45, 6);
    expect(v.worstPoint[0]).toBeCloseTo(145, 6);
  });

  it('refuses a diagonal shortcut even though both ends sit on glass', () => {
    // The exact cheat: two parallel strokes, and a diagonal between their far
    // ends. Both endpoints are on the artwork; everything between is not.
    const art = artworkFromRuns([
      line('a', [[0, 0], [200, 0]]),
      line('b', [[0, 150], [200, 150]]),
    ]);
    const v = hopStaysOnArtwork([200, 0], [0, 150], art, 10, 5);
    expect(v.onArtwork).toBe(false);
    expect(v.worstOffsetMM).toBeGreaterThan(50);
  });

  it('is not fooled by a stroke that only brackets the gap', () => {
    // A stroke parallel to the hop but 40mm off it. Nothing is under the hop.
    const art = artworkFromRuns([
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
      line('bracket', [[100, 40], [190, 40]]),
    ]);
    expect(hopStaysOnArtwork([100, 0], [190, 0], art, 10, 5).onArtwork).toBe(false);
  });

  it('accepts once a third stroke actually covers the gap', () => {
    const art = artworkFromRuns([
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
      line('bridge', [[95, 0], [195, 0]]),
    ]);
    const v = hopStaysOnArtwork([100, 0], [190, 0], art, 10, 5);
    expect(v.onArtwork).toBe(true);
    expect(v.worstOffsetMM).toBeCloseTo(0, 6);
  });

  it('measures against the flattened arc, not its chord', () => {
    // A single arc segment bows ~a quarter of its chord off the chord. A hop
    // straight down the chord is therefore OFF the glass by that much — the
    // chord-based answer would wave it through.
    const art = artworkFromRuns([arcRun('a', [[0, 0], [200, 0]], ['arc'])]);
    const v = hopStaysOnArtwork([0, 0], [200, 0], art, 10, 5);
    expect(v.onArtwork).toBe(false);
    expect(v.worstOffsetMM).toBeGreaterThan(40);

    // A chord-measured control: the same points with no arc marked. Same two
    // vertices, opposite verdict — which is what makes the assertion above
    // mean something.
    const flat = artworkFromRuns([line('a', [[0, 0], [200, 0]])]);
    expect(hopStaysOnArtwork([0, 0], [200, 0], flat, 10, 5).onArtwork).toBe(true);
  });

  it('a zero-length hop is trivially on the artwork', () => {
    const art = artworkFromRuns([line('a', [[0, 0], [100, 0]])]);
    const v = hopStaysOnArtwork([100, 0], [100, 0], art, 10, 5);
    expect(v.onArtwork).toBe(true);
    expect(v.samples).toBe(2);
  });

  it('samples the interior, not just the endpoints', () => {
    const art = artworkFromRuns([
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
    ]);
    // 90mm hop at 5mm spacing.
    expect(hopStaysOnArtwork([100, 0], [190, 0], art, 10, 5).samples).toBe(19);
  });

  it('refuses rather than waves through on a NaN corridor', () => {
    const art = artworkFromRuns([line('a', [[0, 0], [300, 0]])]);
    expect(hopStaysOnArtwork([0, 0], [300, 0], art, NaN, 5).onArtwork).toBe(false);
    expect(hopStaysOnArtwork([0, 0], [300, 0], art, 0, 5).onArtwork).toBe(false);
    expect(hopStaysOnArtwork([0, 0], [300, 0], art, -1, 5).onArtwork).toBe(false);
  });

  it('an empty artwork accepts nothing but a degenerate hop', () => {
    expect(hopStaysOnArtwork([0, 0], [100, 0], [], 10, 5).onArtwork).toBe(false);
    // Even a zero-length hop is off the artwork when there is no artwork.
    expect(hopStaysOnArtwork([0, 0], [0, 0], [], 10, 5).onArtwork).toBe(false);
  });

  it('a non-positive sample interval still tests both endpoints', () => {
    const art = artworkFromRuns([
      line('a', [[0, 0], [100, 0]]),
      line('b', [[190, 0], [290, 0]]),
    ]);
    // Degenerate spacing collapses to endpoints-only, which BOTH pass. This is
    // the one input shape where the predicate is blind, so the op derives the
    // interval from the tube diameter and never lets a caller pass 0.
    expect(hopStaysOnArtwork([100, 0], [190, 0], art, 10, 0).samples).toBe(2);
    expect(hopStaysOnArtwork([100, 0], [190, 0], art, 10, 0).onArtwork).toBe(true);
  });
});

describe('artworkFromRuns', () => {
  it('keeps a closed run closed so the closing chord is glass too', () => {
    const square: DesignRun = {
      id: 'sq',
      polyline: { points: [[0, 0], [100, 0], [100, 100], [0, 100]], closed: true },
    };
    const art = artworkFromRuns([square]);
    expect(art[0].flat.polyline.closed).toBe(true);
    // A hop down the closing edge (x=0, from y=100 back to y=0) is on glass
    // only because the run is closed.
    expect(hopStaysOnArtwork([0, 100], [0, 0], art, 5, 2).onArtwork).toBe(true);
  });

  it('drops the segment_types so nothing re-flattens the flattened points', () => {
    const art = artworkFromRuns([arcRun('a', [[0, 0], [200, 0]], ['arc'])]);
    expect(art[0].flat.polyline.segment_types).toBeUndefined();
    expect(art[0].flat.polyline.points.length).toBeGreaterThan(2);
  });

  it('skips a run with no points', () => {
    expect(artworkFromRuns([line('empty', [])])).toHaveLength(0);
  });
});

describe('the tuning constants', () => {
  it('derive from the tube, not from absolute millimetres', () => {
    expect(effectiveTubeDiameterMM({ id: 'x', polyline: { points: [], closed: false }, tube_diameter_mm: 15 })).toBe(15);
    expect(effectiveTubeDiameterMM(undefined, 13)).toBe(13);
    expect(effectiveTubeDiameterMM(undefined)).toBe(HOP_FALLBACK_DIAMETER_MM);
  });

  it('sample at least twice per corridor width', () => {
    // Otherwise a gap narrower than the sampling could slip between samples.
    expect(HOP_SAMPLE_DIAMETERS).toBeLessThanOrEqual(HOP_CORRIDOR_DIAMETERS);
  });

  it('cap the corridor well below any stroke this tool draws', () => {
    expect(HOP_CORRIDOR_MAX_DIAMETERS).toBeGreaterThan(HOP_CORRIDOR_DIAMETERS);
    expect(HOP_CORRIDOR_MAX_DIAMETERS).toBeLessThanOrEqual(4);
  });
});
