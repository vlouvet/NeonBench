import { describe, expect, it, vi } from 'vitest';
import type { DesignRun, Group } from '../api';
import { filterVisibleRuns } from './Scene';

// Tier 3 #63 — `filterVisibleRuns` is the pure heart of the new
// "preview a single group" feature. It composes two filters:
//
//   1. Group visibility (carried over from Tier 3 #33c's deferred
//      3D-side bit): a run whose owning group has `visible === false`
//      is hidden globally; `undefined` → visible (back-compat).
//   2. Group focus (this spec): when a `selectedGroupId` is provided,
//      only runs in that group render.
//
// Testing the helper directly (rather than mounting Scene under
// react-three-fiber, which would need a WebGL canvas this repo's
// vitest setup doesn't ship) gives the tightest coverage of the
// composition rules. The integration smoke is handled manually via
// the live preview route.

function makeRun(id: string, groupId?: string): DesignRun {
  return {
    id,
    polyline: {
      points: [
        [0, 0],
        [10, 0],
      ],
      closed: false,
    },
    group_id: groupId,
  };
}

const runs: DesignRun[] = [
  makeRun('a-1', 'A'),
  makeRun('a-2', 'A'),
  makeRun('b-1', 'B'),
  makeRun('ungrouped'),
];

const groups: Group[] = [
  { id: 'A', name: 'Group A' },
  { id: 'B', name: 'Group B' },
];

describe('filterVisibleRuns — group focus', () => {
  it('returns every run when no filter is active', () => {
    const out = filterVisibleRuns(runs, groups, null);
    expect(out.map((r) => r.id)).toEqual(['a-1', 'a-2', 'b-1', 'ungrouped']);
  });

  it('treats empty string the same as null (URL `?groupId=` round-trip)', () => {
    const out = filterVisibleRuns(runs, groups, '');
    expect(out).toHaveLength(4);
  });

  it('treats undefined the same as null', () => {
    const out = filterVisibleRuns(runs, groups, undefined);
    expect(out).toHaveLength(4);
  });

  it('keeps only the focused group when selectedGroupId is set', () => {
    expect(filterVisibleRuns(runs, groups, 'A').map((r) => r.id)).toEqual([
      'a-1',
      'a-2',
    ]);
    expect(filterVisibleRuns(runs, groups, 'B').map((r) => r.id)).toEqual([
      'b-1',
    ]);
  });

  it('drops ungrouped runs when a focus is active', () => {
    const out = filterVisibleRuns(runs, groups, 'A');
    expect(out.find((r) => r.id === 'ungrouped')).toBeUndefined();
  });

  it('returns an empty array when no run matches the focused id', () => {
    const out = filterVisibleRuns(runs, groups, 'nonexistent');
    expect(out).toEqual([]);
  });
});

describe('filterVisibleRuns — group visibility', () => {
  it('hides runs in groups where visible === false', () => {
    const hidden: Group[] = [
      { id: 'A', name: 'Group A', visible: false },
      { id: 'B', name: 'Group B' },
    ];
    expect(filterVisibleRuns(runs, hidden, null).map((r) => r.id)).toEqual([
      'b-1',
      'ungrouped',
    ]);
  });

  it('treats visible === undefined as visible (pre-33c back-compat)', () => {
    // Same group set as the default `groups` constant — neither group
    // declares `visible`, so both are visible.
    expect(filterVisibleRuns(runs, groups, null)).toHaveLength(4);
  });

  it('treats visible === true the same as undefined', () => {
    const explicit: Group[] = [
      { id: 'A', name: 'Group A', visible: true },
      { id: 'B', name: 'Group B', visible: true },
    ];
    expect(filterVisibleRuns(runs, explicit, null)).toHaveLength(4);
  });

  it('does not hide ungrouped runs (they have no group to flag)', () => {
    const allHidden: Group[] = [
      { id: 'A', name: 'Group A', visible: false },
      { id: 'B', name: 'Group B', visible: false },
    ];
    expect(
      filterVisibleRuns(runs, allHidden, null).map((r) => r.id),
    ).toEqual(['ungrouped']);
  });

  it('returns runs unchanged when groups slice is undefined / empty', () => {
    expect(filterVisibleRuns(runs, undefined, null)).toHaveLength(4);
    expect(filterVisibleRuns(runs, [], null)).toHaveLength(4);
  });
});

describe('filterVisibleRuns — visibility + focus compose', () => {
  it('returns no runs when the focused group is hidden', () => {
    const hidden: Group[] = [
      { id: 'A', name: 'Group A', visible: false },
      { id: 'B', name: 'Group B' },
    ];
    // Focus on A but A is hidden — composition wins, A's runs stay
    // hidden, ungrouped is still excluded by the focus filter.
    expect(filterVisibleRuns(runs, hidden, 'A')).toEqual([]);
  });

  it('focuses on a visible group while a sibling is hidden', () => {
    const hidden: Group[] = [
      { id: 'A', name: 'Group A', visible: false },
      { id: 'B', name: 'Group B' },
    ];
    expect(filterVisibleRuns(runs, hidden, 'B').map((r) => r.id)).toEqual([
      'b-1',
    ]);
  });

  it('only B remains when focus is unset and A is hidden', () => {
    const hidden: Group[] = [
      { id: 'A', name: 'Group A', visible: false },
      { id: 'B', name: 'Group B' },
    ];
    expect(filterVisibleRuns(runs, hidden, null).map((r) => r.id)).toEqual([
      'b-1',
      'ungrouped',
    ]);
  });
});

// Smoke: confirm the helper doesn't accidentally `console.warn` for
// the well-behaved paths. The unknown-id warning lives in Scene
// (effectiveGroupId memo), not in this pure helper, so the helper
// should be silent here.
describe('filterVisibleRuns — silence', () => {
  it('does not warn or error on any of the standard inputs', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    filterVisibleRuns(runs, groups, null);
    filterVisibleRuns(runs, groups, 'A');
    filterVisibleRuns(runs, groups, 'nonexistent');
    expect(warn).not.toHaveBeenCalled();
    expect(err).not.toHaveBeenCalled();
    warn.mockRestore();
    err.mockRestore();
  });
});
