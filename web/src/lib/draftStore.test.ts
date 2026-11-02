import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DesignDoc } from '../api';
import { clearDraft, draftDiffersFrom, loadDraft, saveDraft } from './draftStore';

// Vitest runs in plain node here, so `window.localStorage` is an in-memory
// shim, the same pattern printPrefs.test.ts and scenePrefs.test.ts use.
function makeStorage(failWrites = false) {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (failWrites) throw new DOMException('full', 'QuotaExceededError');
      data.set(k, v);
    },
    removeItem: (k: string) => void data.delete(k),
  };
}

function installWindow(localStorage: unknown) {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
}

const doc = (runCount: number) =>
  ({ version: 1, runs: Array.from({ length: runCount }, (_, i) => ({ id: `r${i}` })) }) as unknown as DesignDoc;

beforeEach(() => installWindow(makeStorage()));
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('draftStore', () => {
  it('round-trips a draft with its timestamp', () => {
    expect(saveDraft(1, 2, doc(3), 1234)).toBe(true);
    expect(loadDraft(1, 2)).toEqual({ doc: doc(3), savedAt: 1234 });
  });

  it('keeps one slot per version, so a draft cannot land on the wrong one', () => {
    saveDraft(1, 2, doc(3));
    expect(loadDraft(1, 3)).toBeNull();
    expect(loadDraft(2, 2)).toBeNull();
    saveDraft(1, 2, doc(5), 99);
    expect(loadDraft(1, 2)?.doc.runs).toHaveLength(5);
  });

  it('clears a draft', () => {
    saveDraft(1, 2, doc(3));
    clearDraft(1, 2);
    expect(loadDraft(1, 2)).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['null', 'null'],
    ['no timestamp', JSON.stringify({ doc: doc(1) })],
    ['no doc', JSON.stringify({ savedAt: 1 })],
    ['runs not an array', JSON.stringify({ doc: { runs: 'x' }, savedAt: 1 })],
  ])('treats a stored value that is %s as no draft', (_name, raw) => {
    const store = makeStorage();
    store.setItem('nb.draft.v1.1.2', raw);
    installWindow(store);
    expect(loadDraft(1, 2)).toBeNull();
  });

  it('reports a full store instead of throwing', () => {
    installWindow(makeStorage(true));
    expect(saveDraft(1, 2, doc(1))).toBe(false);
  });

  it('survives having no storage at all', () => {
    delete (globalThis as { window?: unknown }).window;
    expect(saveDraft(1, 2, doc(1))).toBe(false);
    expect(loadDraft(1, 2)).toBeNull();
    expect(() => clearDraft(1, 2)).not.toThrow();
  });

  it('detects whether a draft has anything to restore', () => {
    saveDraft(1, 2, doc(3));
    const draft = loadDraft(1, 2)!;
    expect(draftDiffersFrom(draft, doc(3))).toBe(false);
    expect(draftDiffersFrom(draft, doc(4))).toBe(true);
  });
});
