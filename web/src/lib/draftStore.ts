/**
 * draftStore — a browser-side copy of the design being edited, so a reload,
 * a crash or a closed tab costs at most a second of work (Tier 3 #149).
 *
 * A draft is NOT a design version. Versions are what the operator chose to
 * keep, and they print and export; writing one on a timer would fill the
 * version list with half-finished states. A draft is one slot per version,
 * replaced in place, and it only ever comes back through an explicit restore.
 *
 * Storage key: `nb.draft.v1.<projectId>.<versionId>`. Scoped to the version
 * because that is what the edits were made against: restoring onto a
 * different version would silently throw away the difference between the two.
 *
 * Never throws. Safari in private browsing refuses `setItem`, and a large doc
 * can exceed the origin's quota. `saveDraft` reports that by returning false;
 * the page's unsaved-changes warning still protects the work.
 */
import type { DesignDoc } from '../api';

export type Draft = {
  doc: DesignDoc;
  /** Epoch milliseconds, for "from 3:14 PM" in the restore prompt. */
  savedAt: number;
};

function keyFor(projectId: number, versionId: number): string {
  return `nb.draft.v1.${projectId}.${versionId}`;
}

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function saveDraft(
  projectId: number,
  versionId: number,
  doc: DesignDoc,
  now: number = Date.now(),
): boolean {
  const store = storage();
  if (!store) return false;
  try {
    const draft: Draft = { doc, savedAt: now };
    store.setItem(keyFor(projectId, versionId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** Returns null for a missing, corrupt or wrong-shaped draft. */
export function loadDraft(projectId: number, versionId: number): Draft | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(keyFor(projectId, versionId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft> | null;
    if (
      !parsed ||
      typeof parsed.savedAt !== 'number' ||
      !parsed.doc ||
      !Array.isArray(parsed.doc.runs)
    ) {
      return null;
    }
    return { doc: parsed.doc, savedAt: parsed.savedAt };
  } catch {
    return null;
  }
}

export function clearDraft(projectId: number, versionId: number): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(keyFor(projectId, versionId));
  } catch {
    // Nothing useful to do: a stale draft only means one extra prompt.
  }
}

/**
 * A draft identical to the saved version has nothing to restore. Offering it
 * anyway would train the operator to dismiss the prompt.
 */
export function draftDiffersFrom(draft: Draft, saved: DesignDoc): boolean {
  return JSON.stringify(draft.doc) !== JSON.stringify(saved);
}
