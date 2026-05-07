import { describe, expect, it } from 'vitest';
import { humanizeDueDate, isOverdue } from './dueDate';

describe('humanizeDueDate', () => {
  it('renders a parseable ISO date with year and month', () => {
    // We avoid asserting an exact locale string — the formatted output
    // varies by environment. A locale-agnostic substring check covers
    // both the en-US case ("May 15, 2026") and the few-locales-rotate
    // word order without coupling the test to any specific locale.
    const out = humanizeDueDate('2026-05-15');
    expect(out).toContain('2026');
    expect(out).toContain('May');
  });

  it('returns empty string for empty input', () => {
    expect(humanizeDueDate('')).toBe('');
  });

  it('falls back to the raw string when parsing fails', () => {
    expect(humanizeDueDate('garbage')).toBe('garbage');
  });
});

describe('isOverdue', () => {
  it('returns true for a date strictly before today', () => {
    expect(isOverdue('2026-05-06', new Date('2026-05-07T10:00:00'))).toBe(true);
  });

  it('returns false for a date matching today (not overdue)', () => {
    expect(isOverdue('2026-05-07', new Date('2026-05-07T10:00:00'))).toBe(false);
  });

  it('returns false for a date in the future', () => {
    expect(isOverdue('2026-05-08', new Date('2026-05-07T10:00:00'))).toBe(false);
  });

  it('returns false for empty input', () => {
    expect(isOverdue('', new Date())).toBe(false);
  });

  it('returns false for unparseable input', () => {
    expect(isOverdue('not-a-date', new Date())).toBe(false);
  });

  it('treats a yesterday-due project as overdue exactly at midnight today', () => {
    // Boundary: when "now" is local midnight today, a due date of
    // yesterday is still strictly less than the normalized today and
    // therefore overdue.
    expect(isOverdue('2026-05-06', new Date('2026-05-07T00:00:00'))).toBe(true);
  });
});
