import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import RateCardEditor from './RateCardEditor';
import type { RateCard, RateCardItem } from '../api';

// Static-markup rendering only (RTL isn't wired up here — see
// PanelSection.test.tsx). The logic behind the inputs is covered in
// lib/estimateFormat.test.ts; what these assert is the other half of the same
// rule — that an unpriced rate LOOKS unpriced rather than looking like zero.

function item(over: Partial<RateCardItem> = {}): RateCardItem {
  return { id: 1, kind: 'tube', label: 'Glass tubing', unit: 'ft', unit_cost: null, ...over };
}

function card(items: RateCardItem[]): RateCard {
  return {
    id: 1,
    name: 'Default (provisional)',
    currency: 'USD',
    markup_multiplier: 2.22,
    labour_rate_per_hour: 48,
    labour_setup_minutes: 30,
    labour_minutes_per_foot: 30,
    stick_length_mm: 1524,
    stick_waste_mm: 305,
    sheet_area_sq_ft: 32,
    items,
  };
}

const render = (c: RateCard) =>
  renderToStaticMarkup(<RateCardEditor card={c} onChange={() => {}} onError={() => {}} />);

/**
 * Pull out just the unit-cost input. Asserting on the whole document would
 * catch the min-qty and pack-fee boxes, which legitimately default to 0 — and
 * that is precisely the confusion these tests exist to rule out.
 */
function unitCostInput(html: string): string {
  const m = html.match(/<input[^>]*placeholder="unpriced"[^>]*>/);
  if (!m) throw new Error('no unit-cost input found in markup');
  return m[0];
}

describe('RateCardEditor', () => {
  it('renders an unpriced rate as an empty box labelled "unpriced"', () => {
    const html = render(card([item({ unit_cost: null })]));
    const input = unitCostInput(html);
    // Empty, NOT "0" — a blank box and a zero must not look alike, because
    // they mean opposite things on the finished quote.
    expect(input).toContain('value=""');
    expect(input).not.toContain('value="0"');
    expect(html).toContain('est-row-unpriced');
  });

  it('renders a deliberate zero as an actual 0, not as unpriced', () => {
    const html = render(card([item({ unit_cost: 0 })]));
    expect(unitCostInput(html)).toContain('value="0"');
    expect(html).not.toContain('est-row-unpriced');
  });

  it('renders a real rate at full precision', () => {
    expect(unitCostInput(render(card([item({ unit_cost: 0.5962 })])))).toContain('value="0.5962"');
  });

  it('explains the blank-versus-zero rule in the UI, not just in the code', () => {
    const html = render(card([item()]));
    expect(html).toContain('unpriced');
    expect(html).toContain('free');
  });

  it('surfaces the stock geometry as editable fields', () => {
    const html = render(card([item()]));
    // Stick length is data, not a constant — the operator has to be able to
    // see and change it, because the supplier and the trade docs disagree.
    expect(html).toContain('Stick length (mm)');
    expect(html).toContain('value="1524"');
    expect(html).toContain('Handling waste (mm)');
  });

  it('shows the SKU so a rate can be traced to a supplier line', () => {
    expect(render(card([item({ sku: 'MAT-M53' })]))).toContain('MAT-M53');
  });
});
