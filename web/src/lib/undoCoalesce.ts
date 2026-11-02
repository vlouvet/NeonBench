// Tier 3 #162 — which edits share an undo step.
//
// The clock alone cannot answer this: a delete 400 ms after inserting text is
// two actions, while a drag lasting ten seconds is one. So an edit joins the
// previous step only if it came from the same event, or continues the same
// named gesture without a pause.

export const COALESCE_MS = 500;

export interface EditStamp {
  // Edits queued from one event share this, so a handler that makes two
  // edits still undoes as one action.
  action: number;
  // Names a gesture, e.g. a drag or typing in one field. Absent otherwise.
  group?: string;
  at: number;
}

export function startsNewStep(last: EditStamp | null, next: EditStamp): boolean {
  if (!last) return true;
  if (next.action === last.action) return false;
  if (!next.group || next.group !== last.group) return true;
  return next.at - last.at >= COALESCE_MS;
}
