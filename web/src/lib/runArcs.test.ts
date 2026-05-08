import { describe, expect, it } from 'vitest';
import { blockoutSegments } from './runArcs';

// Tier 3 #59 — closed-loop seam continuity. When a closed live arc
// has a blockout that straddles index 0, `blockoutSegments` used to
// emit two separate blockout segments (one at the head of the live
// arc, one at the tail). The fix recognizes wrap-straddle on a closed
// loop and merges first+last when they're BOTH blockouts. The merged
// `liveIndices` walks the polyline in traversal order through the
// wrap edge (n-1 -> 0), so the renderer draws one continuous painted
// arc, including the wrap edge that the pre-fix code dropped.
//
// The merge guard is conservative: only fires when both first and
// last are blockouts. A closed live loop with mid-loop blockouts
// (where first/last are both live) is left unchanged so existing docs
// render byte-identically — the latent wrap-edge gap between two
// adjacent live segments is not visible at the seam-share point and
// changing the segment count would break the identity invariant.

describe('blockoutSegments', () => {
  it('closed live arc with blockout straddling index 0 merges to 2 segments', () => {
    // 10-point closed live arc, blockout walks 8 -> 9 -> 0 -> 1 -> 2.
    // Without the fix: 3 segments (blockout [0..2], live [2..7],
    // blockout [7..9]) — the wrap edge 9 -> 0 is missing entirely.
    // With the fix: 2 segments. The merged blockout walks 7 -> 8 ->
    // 9 -> 0 -> 1 -> 2, including the wrap edge.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 8, end_live_index: 2 }],
      true,
    );
    expect(segs).toHaveLength(2);
    // Merged blockout is emitted first (the wrap-merge consumes both
    // ends and reinserts the merged result at position 0). Live
    // segment follows.
    expect(segs[0].isBlockout).toBe(true);
    expect(segs[0].liveIndices).toEqual([7, 8, 9, 0, 1, 2]);
    expect(segs[1].isBlockout).toBe(false);
    expect(segs[1].liveIndices).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('closed live arc with no blockouts is a single segment (unchanged)', () => {
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(liveIndices, [], true);
    expect(segs).toHaveLength(1);
    expect(segs[0].isBlockout).toBe(false);
    expect(segs[0].liveIndices).toEqual(liveIndices);
  });

  it('closed live arc with one mid-loop blockout (no wrap) is unchanged', () => {
    // Blockout at [3..5] doesn't wrap. First and last segments are
    // both live; the merge guard short-circuits (only fires when both
    // ends are blockouts) so the 3-segment shape is preserved. This
    // is the identity invariant: closed loops without wrap-straddle
    // render byte-identically pre- and post-fix.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 3, end_live_index: 5 }],
      true,
    );
    expect(segs).toHaveLength(3);
    expect(segs.map((s) => s.isBlockout)).toEqual([false, true, false]);
  });

  it('open live arc with a blockout near the start does not merge', () => {
    // Open arc: even though first segment is blockout, `liveClosed`
    // is false so the merge guard short-circuits and the 2-segment
    // shape is preserved (open polylines never wrap).
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [{ start_live_index: 0, end_live_index: 2 }],
      false,
    );
    expect(segs).toHaveLength(2);
    expect(segs.map((s) => s.isBlockout)).toEqual([true, false]);
  });

  it('closed live arc with two non-adjacent blockouts does not false-merge', () => {
    // Blockouts at [3..5] and [7..8] — neither wraps. First and last
    // segments are both LIVE, so the merge guard short-circuits (only
    // fires when both ends are blockouts). The 5-segment shape is
    // preserved.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [
        { start_live_index: 3, end_live_index: 5 },
        { start_live_index: 7, end_live_index: 8 },
      ],
      true,
    );
    expect(segs.map((s) => s.isBlockout)).toEqual([
      false,
      true,
      false,
      true,
      false,
    ]);
  });

  it('closed live arc with wrap-blockout AND mid-loop blockout merges only the wrap pair', () => {
    // Blockouts: wrap-straddle [8..2] AND mid-loop [4..5]. Pre-merge
    // emits 5 segments [block[0,1,2], live[2,3], block[3,4,5],
    // live[5,6,7], block[7,8,9]]. The wrap-merge collapses the two
    // end blockouts (both isBlockout=true) into one segment that
    // walks 7 -> 8 -> 9 -> 0 -> 1 -> 2. The mid-loop blockout is
    // left alone. Result: 4 segments, pattern T,F,T,F.
    const liveIndices = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
    const segs = blockoutSegments(
      liveIndices,
      [
        { start_live_index: 8, end_live_index: 2 },
        { start_live_index: 4, end_live_index: 5 },
      ],
      true,
    );
    expect(segs).toHaveLength(4);
    expect(segs.map((s) => s.isBlockout)).toEqual([true, false, true, false]);
    expect(segs[0].liveIndices).toEqual([7, 8, 9, 0, 1, 2]);
  });
});
