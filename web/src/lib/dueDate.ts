// Shared helpers for project due-date display and overdue detection.
// Extracted from ProjectDetail.tsx so ProjectList can reuse the same
// formatting + overdue rule without dragging the whole page into a
// circular import.

// humanizeDueDate renders "YYYY-MM-DD" against the user's locale, e.g.
// "May 15, 2026". Falls back to the raw string if parsing fails.
export function humanizeDueDate(iso: string): string {
  // YYYY-MM-DD as a "local" date — adding T00:00 keeps it from being
  // interpreted as UTC midnight and shifting a day west of UTC.
  const d = new Date(iso + 'T00:00:00');
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// isOverdue returns true when `iso` (a YYYY-MM-DD due date) names a
// calendar day strictly before today's local midnight. A project due
// today is NOT overdue; one due yesterday IS. Empty / unparseable
// strings return false so unset due dates never light up the badge.
//
// The optional `today` parameter exists so tests can pin a deterministic
// "now"; production callers omit it.
export function isOverdue(iso: string, today: Date = new Date()): boolean {
  if (!iso) return false;
  const due = new Date(iso + 'T00:00:00');
  if (Number.isNaN(due.getTime())) return false;
  const todayMidnight = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
  );
  return due < todayMidnight;
}
