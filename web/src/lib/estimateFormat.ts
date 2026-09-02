import type { Estimate, RateCardItemPatch, TakeoffSummary } from '../api';

/**
 * Presentation logic for the estimate route, kept out of the components so it
 * can be tested. This repo has no React component-test harness (no
 * @testing-library/react, no jsdom) and adding one means new dependencies, so
 * the convention here — as with every other test in web/ — is to put the logic
 * worth asserting in lib/ and test it directly.
 */

/**
 * Decide what a unit-cost edit should send.
 *
 * This is the single most consequential piece of UI logic in the feature. An
 * empty box means "nobody has priced this", which must reach the server as an
 * explicit null so the line is reported unpriced and excluded from the total.
 * A typed 0 means "free", which is a real price. If the two ever collapse, a
 * quote silently loses its most expensive line and still looks complete.
 *
 * Returns null when nothing should be sent — no change, or unparseable input.
 */
export function unitCostPatch(raw: string, current: number | null): RateCardItemPatch | null {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return current === null ? null : { unit_cost: null };
  }
  const v = Number(trimmed);
  if (Number.isNaN(v) || v < 0) return null;
  if (v === current) return null;
  return { unit_cost: v };
}

/** Formats the quantity table. Returned as pairs so the component stays dumb. */
export function quantityRows(s: TakeoffSummary): [string, string][] {
  const rows: [string, string][] = [
    ['Net tube (lit)', `${s.net_tube_ft.toFixed(2)} ft`],
    [
      'Gross glass (ordered)',
      `${s.gross_glass_ft.toFixed(2)} ft in ${s.stick_count} ${plural(s.stick_count, 'stick')}`,
    ],
    ['Runs / bends / splices', `${s.run_count} / ${s.bend_count} / ${s.splice_count}`],
    ['Electrodes', `${s.electrode_count} (${s.electrode_pairs} pair)`],
    ['Pumped sections', String(s.pumped_sections)],
  ];
  // Tier 2 #136 — only shown once the doc models circuits. Absent (not 0) on
  // every pre-#136 takeoff, so the table is unchanged for them. It sits next
  // to the electrode row on purpose: when circuits exist, THEY are what the
  // pairs and transformers were derived from, not the run count.
  if (s.circuit_count) {
    rows.push([
      'Circuits',
      `${s.circuit_count} (one transformer each)`,
    ]);
  }
  if (s.jumper_ft > 0) {
    rows.push(['Jumpers', `${s.jumper_ft.toFixed(2)} ft in ${s.jumper_count}`]);
  }
  if (s.blockout_ft > 0) {
    rows.push(['Blockout', `${s.blockout_ft.toFixed(2)} ft`]);
  }
  if (s.backing_bbox_sq_ft > 0) {
    rows.push([
      // Never present a bounding box as a cut area. A panel cut to the sign's
      // silhouette is smaller, and quoting the box overcharges the customer.
      s.backing_is_bbox ? 'Backing (bounding box)' : 'Backing',
      `${s.backing_bbox_sq_ft.toFixed(2)} sq ft — ${s.backing_sheets} ${plural(
        s.backing_sheets,
        'sheet',
      )}`,
    ]);
  }
  rows.push(['Fabrication', `${s.fabrication_hours.toFixed(2)} h`]);
  return rows;
}

/**
 * The provisional warning. Says explicitly that unpriced lines are excluded
 * rather than free, because "provisional" alone does not tell a reader which
 * direction the number is wrong in.
 */
export function provisionalMessage(e: Estimate): string | null {
  if (!e.is_provisional) return null;
  const n = e.unpriced_count;
  const kinds = e.unpriced_kinds?.length ? ` (${e.unpriced_kinds.join(', ')})` : '';
  // A wrong-unit rate is called out separately. Saying "no rate yet" about a
  // line that already has one sends the reader hunting for the wrong thing.
  const mismatch = e.unit_mismatch_kinds?.length
    ? ` Rates for ${e.unit_mismatch_kinds.join(', ')} are quoted in the wrong unit — a price ` +
      'exists but cannot be applied until it is converted to the unit the line is measured in.'
    : '';
  return (
    `${n} ${plural(n, 'line')} ${n === 1 ? 'is' : 'are'} excluded${kinds}. ` +
    'Excluded lines are not counted as free — so the real cost is higher than the figure ' +
    `shown.${mismatch}`
  );
}

function plural(n: number, word: string): string {
  return n === 1 ? word : `${word}s`;
}
