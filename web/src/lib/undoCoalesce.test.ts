import { describe, expect, it } from 'vitest';
import { COALESCE_MS, startsNewStep } from './undoCoalesce';

describe('startsNewStep', () => {
  it('starts a step when there is no previous edit', () => {
    expect(startsNewStep(null, { action: 1, at: 0 })).toBe(true);
  });

  it('keeps unrelated actions apart however close together they are', () => {
    expect(startsNewStep({ action: 1, at: 0 }, { action: 2, at: 1 })).toBe(true);
  });

  it('joins edits from one event, even with different groups', () => {
    expect(
      startsNewStep({ action: 1, group: 'a', at: 0 }, { action: 1, group: 'b', at: 0 }),
    ).toBe(false);
    expect(startsNewStep({ action: 1, at: 0 }, { action: 1, at: 0 })).toBe(false);
  });

  it('joins a gesture while it keeps going', () => {
    const last = { action: 1, group: 'drag', at: 1000 };
    const next = { action: 2, group: 'drag', at: 1000 + COALESCE_MS - 1 };
    expect(startsNewStep(last, next)).toBe(false);
  });

  it('splits a gesture after a pause', () => {
    const last = { action: 1, group: 'drag', at: 1000 };
    const next = { action: 2, group: 'drag', at: 1000 + COALESCE_MS };
    expect(startsNewStep(last, next)).toBe(true);
  });

  it('splits when the gesture changes', () => {
    expect(
      startsNewStep(
        { action: 1, group: 'notes:a', at: 0 },
        { action: 2, group: 'notes:b', at: 1 },
      ),
    ).toBe(true);
  });

  it('does not let an ungrouped edit join a gesture, or the reverse', () => {
    expect(startsNewStep({ action: 1, group: 'drag', at: 0 }, { action: 2, at: 1 })).toBe(true);
    expect(startsNewStep({ action: 1, at: 0 }, { action: 2, group: 'drag', at: 1 })).toBe(true);
  });
});
