import { describe, it, expect } from 'vitest';

import type { DesignRun } from '../api';
import { groupByBaseline } from './raceway';

// Build a closed rectangular face run with the given bbox. Channel-letter
// face runs are typically closed silhouettes, so a 4-point rect is a fair
// stand-in for the test fixtures.
function rectFace(
  id: string,
  left: number,
  bottom: number,
  width: number,
  height: number,
  opts: { face?: boolean; raceway?: string } = {},
): DesignRun {
  const top = bottom - height;
  const right = left + width;
  return {
    id,
    polyline: {
      points: [
        [left, top],
        [right, top],
        [right, bottom],
        [left, bottom],
      ],
      closed: true,
    },
    is_channel_letter_face: opts.face ?? true,
    ...(opts.raceway !== undefined ? { raceway_id: opts.raceway } : {}),
  };
}

describe('groupByBaseline', () => {
  it('returns an empty map when no runs have face flags', () => {
    const runs: DesignRun[] = [
      rectFace('r1', 0, 100, 80, 100, { face: false }),
      rectFace('r2', 100, 100, 80, 100, { face: false }),
    ];
    const out = groupByBaseline(runs);
    expect(out.size).toBe(0);
  });

  it('returns an empty map when given no runs at all', () => {
    expect(groupByBaseline([]).size).toBe(0);
  });

  it('clusters a single line of letters into one raceway', () => {
    // 5 letters, 80mm wide × 100mm tall, baseline at y=100, gap 20mm.
    // 20mm gap is well below 2 × H = 200mm so they all stay together.
    const letters = [0, 100, 200, 300, 400].map((x, i) =>
      rectFace(`L${i + 1}`, x, 100, 80, 100),
    );
    const out = groupByBaseline(letters);
    const ids = new Set(out.values());
    expect(out.size).toBe(5);
    expect(ids.size).toBe(1);
    expect([...ids][0]).toBe('raceway-1');
  });

  it('produces two raceways for a two-line sign', () => {
    // Top row baseline = 90, bottom row baseline = 200. Difference is
    // 110, well above 0.15 × H = 15.
    const top = [0, 100, 200].map((x, i) => rectFace(`T${i + 1}`, x, 90, 80, 100));
    const bottom = [0, 100, 200].map((x, i) => rectFace(`B${i + 1}`, x, 200, 80, 100));
    const out = groupByBaseline([...top, ...bottom]);
    expect(out.size).toBe(6);
    const topIds = new Set(top.map((r) => out.get(r.id)));
    const bottomIds = new Set(bottom.map((r) => out.get(r.id)));
    expect(topIds.size).toBe(1);
    expect(bottomIds.size).toBe(1);
    expect([...topIds][0]).not.toBe([...bottomIds][0]);
  });

  it('splits one baseline into two raceways at a wide gap', () => {
    // 5 letters, gap-of-5H between letter 3 and letter 4. H = 100,
    // so a 500mm gap exceeds 2H = 200mm and forces a split.
    // Letters 1..3 at left, letters 4..5 at right.
    // Letter widths 80; left edges 0, 100, 200, 800, 900.
    const xs = [0, 100, 200, 800, 900];
    const letters = xs.map((x, i) => rectFace(`L${i + 1}`, x, 100, 80, 100));
    const out = groupByBaseline(letters);
    expect(out.size).toBe(5);
    const leftIds = new Set([out.get('L1'), out.get('L2'), out.get('L3')]);
    const rightIds = new Set([out.get('L4'), out.get('L5')]);
    expect(leftIds.size).toBe(1);
    expect(rightIds.size).toBe(1);
    expect([...leftIds][0]).not.toBe([...rightIds][0]);
    // Left group should have the lower-numbered raceway id (left-to-right
    // ordering by leftmost X).
    expect([...leftIds][0]).toBe('raceway-1');
    expect([...rightIds][0]).toBe('raceway-2');
  });

  it('only labels face-flagged runs even when the design has non-face runs mixed in', () => {
    const faces = [0, 100].map((x, i) => rectFace(`F${i + 1}`, x, 100, 80, 100));
    const nonFaces = [200, 300].map((x, i) =>
      rectFace(`N${i + 1}`, x, 100, 80, 100, { face: false }),
    );
    const out = groupByBaseline([...faces, ...nonFaces]);
    expect(out.size).toBe(2);
    expect(out.get('F1')).toBeDefined();
    expect(out.get('F2')).toBeDefined();
    expect(out.get('N1')).toBeUndefined();
    expect(out.get('N2')).toBeUndefined();
  });

  it('preserves manually assigned raceway_ids when preserveExisting is true', () => {
    const r1 = rectFace('r1', 0, 100, 80, 100, { raceway: 'manual-1' });
    const r2 = rectFace('r2', 100, 100, 80, 100); // no manual id
    const r3 = rectFace('r3', 200, 100, 80, 100); // no manual id
    const out = groupByBaseline([r1, r2, r3], { preserveExisting: true });
    // r1 is skipped (preserveExisting + has existing value); r2 / r3 get
    // raceway-1 (the leftmost auto-group).
    expect(out.get('r1')).toBeUndefined();
    expect(out.get('r2')).toBe('raceway-1');
    expect(out.get('r3')).toBe('raceway-1');
  });

  it('overrides manually assigned raceway_ids when preserveExisting is false (default)', () => {
    const r1 = rectFace('r1', 0, 100, 80, 100, { raceway: 'manual-1' });
    const r2 = rectFace('r2', 100, 100, 80, 100);
    const out = groupByBaseline([r1, r2]);
    // Both end up in the same single auto-raceway.
    expect(out.get('r1')).toBe('raceway-1');
    expect(out.get('r2')).toBe('raceway-1');
  });

  it('produces deterministic ids regardless of input order', () => {
    // Build a two-line sign and shuffle the input order; the output
    // map must contain the same key→value pairs.
    const top = [0, 100, 200].map((x, i) => rectFace(`T${i + 1}`, x, 90, 80, 100));
    const bottom = [0, 100, 200].map((x, i) => rectFace(`B${i + 1}`, x, 200, 80, 100));
    const inOrder = groupByBaseline([...top, ...bottom]);
    const shuffled = groupByBaseline([
      bottom[2],
      top[0],
      bottom[0],
      top[2],
      bottom[1],
      top[1],
    ]);
    expect(shuffled.size).toBe(inOrder.size);
    for (const [key, val] of inOrder) {
      expect(shuffled.get(key)).toBe(val);
    }
  });

  it('assigns the leftmost group raceway-1 left-to-right', () => {
    // Three groups separated by wide gaps along one baseline.
    const groupA = [0, 100].map((x, i) => rectFace(`A${i + 1}`, x, 100, 80, 100));
    const groupB = [600, 700].map((x, i) => rectFace(`B${i + 1}`, x, 100, 80, 100));
    const groupC = [1200, 1300].map((x, i) => rectFace(`C${i + 1}`, x, 100, 80, 100));
    const out = groupByBaseline([...groupC, ...groupA, ...groupB]);
    expect(out.get('A1')).toBe('raceway-1');
    expect(out.get('B1')).toBe('raceway-2');
    expect(out.get('C1')).toBe('raceway-3');
  });
});
