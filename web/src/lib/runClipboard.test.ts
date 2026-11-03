import { describe, expect, it } from 'vitest';
import type { DesignDoc, DesignRun } from '../api';
import { flatRunPoints } from './arcGeom';
import { copySelection, nudgeSelection, pasteRuns } from './runClipboard';

const line = (id: string, extra: Partial<DesignRun> = {}): DesignRun =>
  ({ id, polyline: { points: [[0, 0], [100, 0], [100, 50]], closed: false }, ...extra }) as DesignRun;

const arc = (id: string): DesignRun =>
  ({
    id,
    polyline: { points: [[0, 0], [100, 0], [200, 40]], closed: false, segment_types: ['arc', 'line'] },
  }) as DesignRun;

const docOf = (...runs: DesignRun[]): DesignDoc =>
  ({ version: 1, view_box_mm: [0, 0, 1000, 500], runs }) as unknown as DesignDoc;

const shifted = (run: DesignRun, dx: number, dy: number) =>
  flatRunPoints(run).map(([x, y]) => [x + dx, y + dy]);

const expectClose = (actual: number[][], expected: number[][]) => {
  expect(actual).toHaveLength(expected.length);
  actual.forEach(([x, y], i) => {
    expect(x).toBeCloseTo(expected[i][0], 9);
    expect(y).toBeCloseTo(expected[i][1], 9);
  });
};

describe('nudgeSelection', () => {
  it('translates the drawn shape, arcs included', () => {
    const doc = docOf(arc('a'));
    const next = nudgeSelection(doc, ['a'], 7, -3);
    expectClose(flatRunPoints(next.runs[0]), shifted(doc.runs[0], 7, -3));
  });

  it('leaves unselected runs alone, by identity', () => {
    const doc = docOf(line('a'), line('b'));
    const next = nudgeSelection(doc, ['a'], 1, 0);
    expect(next.runs[1]).toBe(doc.runs[1]);
  });

  it('skips a locked group, and returns the same doc when nothing moved', () => {
    const doc = {
      ...docOf(line('a', { group_id: 'g1' })),
      groups: [{ id: 'g1', name: 'L', locked: true }],
    } as DesignDoc;
    expect(nudgeSelection(doc, ['a'], 1, 0)).toBe(doc);
    expect(nudgeSelection(doc, [], 1, 0)).toBe(doc);
    expect(nudgeSelection(docOf(line('b')), ['b'], 0, 0).runs[0].polyline.points[1]).toEqual([100, 0]);
  });
});

describe('copy and paste', () => {
  it('pastes the same drawn shape, offset, for an arc run', () => {
    const doc = docOf(arc('a'));
    const { doc: next, newIds } = pasteRuns(doc, copySelection(doc, ['a'])!, 20, 10);
    expect(next.runs).toHaveLength(2);
    expect(newIds).toHaveLength(1);
    expectClose(flatRunPoints(next.runs[1]), shifted(doc.runs[0], 20, 10));
    expect(next.runs[1].polyline.segment_types).toEqual(['arc', 'line']);
  });

  it('gives every copy a new, unique id', () => {
    const doc = docOf(line('r1'), line('r2'));
    const { doc: next, newIds } = pasteRuns(doc, copySelection(doc, ['r1', 'r2'])!, 0, 0);
    const ids = next.runs.map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
    expect(newIds.every((id) => id !== 'r1' && id !== 'r2')).toBe(true);
  });

  it('keeps classification and construction marks', () => {
    const src = line('a', {
      is_channel_letter_face: true,
      channel_letter_depth_mm: 120,
      kind: 'jumper',
      electrodes: [{ point_index: 0 }, { point_index: 2 }],
    } as Partial<DesignRun>);
    const doc = docOf(src);
    const { doc: next } = pasteRuns(doc, copySelection(doc, ['a'])!, 5, 5);
    const copy = next.runs[1];
    expect(copy.is_channel_letter_face).toBe(true);
    expect(copy.channel_letter_depth_mm).toBe(120);
    expect(copy.kind).toBe('jumper');
    expect(copy.electrodes).toEqual(src.electrodes);
    expect(copy.electrodes).not.toBe(src.electrodes);
  });

  it('gives runs from one source circuit one shared, new circuit in another doc', () => {
    const doc = {
      ...docOf(line('a', { circuit_id: 'c-1' }), line('b', { circuit_id: 'c-1' })),
      circuits: [{ id: 'c-1' }],
    } as DesignDoc;
    const clip = copySelection(doc, ['a', 'b'])!;
    const elsewhere = docOf(line('z'));
    const { doc: next } = pasteRuns(elsewhere, clip, 0, 0);
    const [ca, cb] = next.runs.slice(1);
    expect(ca.circuit_id).toBeTruthy();
    expect(ca.circuit_id).toBe(cb.circuit_id);
    expect(ca.circuit_id).not.toBe('c-1');
    expect(next.circuits?.some((c) => c.id === ca.circuit_id)).toBe(true);
    expect('raceway_id' in ca).toBe(false);
  });

  it('makes a different new circuit on each paste into the same doc', () => {
    const doc = {
      ...docOf(line('a', { circuit_id: 'c-1' })),
      circuits: [{ id: 'c-1' }],
    } as DesignDoc;
    const clip = copySelection(doc, ['a'])!;
    const { doc: first } = pasteRuns(docOf(line('z')), clip, 0, 0);
    const { doc: second } = pasteRuns(first, clip, 0, 0);
    expect(second.runs[2].circuit_id).toBeTruthy();
    expect(second.runs[2].circuit_id).not.toBe(first.runs[1].circuit_id);
  });

  it('gives runs from different source circuits different new circuits', () => {
    const doc = {
      ...docOf(line('a', { circuit_id: 'c-1' }), line('b', { circuit_id: 'c-2' })),
      circuits: [{ id: 'c-1' }, { id: 'c-2' }],
    } as DesignDoc;
    const { doc: next } = pasteRuns(docOf(), copySelection(doc, ['a', 'b'])!, 0, 0);
    const [ca, cb] = next.runs.slice(0, 2);
    expect(ca.circuit_id).toBeTruthy();
    expect(cb.circuit_id).toBeTruthy();
    expect(ca.circuit_id).not.toBe(cb.circuit_id);
  });

  it('names a new circuit `<name> copy`, or leaves it unnamed otherwise', () => {
    const named = {
      ...docOf(line('a', { circuit_id: 'c-1' })),
      circuits: [{ id: 'c-1', name: 'Zone A' }],
    } as DesignDoc;
    const { doc: fromNamed } = pasteRuns(docOf(), copySelection(named, ['a'])!, 0, 0);
    expect(fromNamed.circuits?.[0].name).toBe('Zone A copy');
    expect(fromNamed.runs[0].circuit_id).toBe(fromNamed.circuits?.[0].id);

    const unnamed = {
      ...docOf(line('b', { circuit_id: 'c-2' })),
      circuits: [{ id: 'c-2' }],
    } as DesignDoc;
    const { doc: fromUnnamed } = pasteRuns(docOf(), copySelection(unnamed, ['b'])!, 0, 0);
    expect('name' in (fromUnnamed.circuits?.[0] ?? {})).toBe(false);
  });

  it('does not grow a circuits key when running had no circuit', () => {
    const doc = docOf(line('a'));
    expect('circuits' in pasteRuns(docOf(), copySelection(doc, ['a'])!, 0, 0).doc).toBe(false);
  });

  it('does not reuse a circuit that already exists in the target', () => {
    const src = {
      ...docOf(line('a', { circuit_id: 's1' })),
      circuits: [{ id: 's1', name: 'Zone' }],
    } as DesignDoc;
    const target = {
      ...docOf(line('z')),
      circuits: [{ id: 'c1' }],
    } as DesignDoc;
    const { doc: next } = pasteRuns(target, copySelection(src, ['a'])!, 0, 0);
    expect(next.runs[1].circuit_id).toBeTruthy();
    expect(next.runs[1].circuit_id).not.toBe('c1');
  });

  it('copies a group as a new group, keeping the unit together', () => {
    const doc = {
      ...docOf(line('a', { group_id: 'g1' }), line('b', { group_id: 'g1' })),
      groups: [{ id: 'g1', name: 'E' }],
    } as DesignDoc;
    const { doc: next } = pasteRuns(doc, copySelection(doc, ['a', 'b'])!, 0, 0);
    const [c1, c2] = next.runs.slice(2);
    expect(c1.group_id).toBeTruthy();
    expect(c1.group_id).toBe(c2.group_id);
    expect(c1.group_id).not.toBe('g1');
    expect(next.groups?.find((g) => g.id === c1.group_id)?.name).toBe('E copy');
  });

  it('brings a group into a doc that had none', () => {
    const doc = { ...docOf(line('a', { group_id: 'g1' })), groups: [{ id: 'g1', name: 'E' }] } as DesignDoc;
    const { doc: next } = pasteRuns(docOf(), copySelection(doc, ['a'])!, 0, 0);
    expect(next.groups).toHaveLength(1);
    expect(next.groups?.[0].id).toBe(next.runs[0].group_id);
  });

  it('does not grow an empty groups key', () => {
    const doc = docOf(line('a'));
    expect('groups' in pasteRuns(doc, copySelection(doc, ['a'])!, 0, 0).doc).toBe(false);
  });

  it('is a snapshot: later edits to the source do not reach the clipboard', () => {
    const doc = docOf(line('a'));
    const clip = copySelection(doc, ['a'])!;
    doc.runs[0].polyline.points[0][0] = 999;
    expect(clip.runs[0].polyline.points[0][0]).toBe(0);
  });

  it('copies nothing from an empty or fully locked selection', () => {
    const locked = {
      ...docOf(line('a', { group_id: 'g1' })),
      groups: [{ id: 'g1', name: 'L', locked: true }],
    } as DesignDoc;
    expect(copySelection(locked, ['a'])).toBeNull();
    expect(copySelection(docOf(line('a')), [])).toBeNull();
  });
});
