import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LineRow, Quantities } from './EstimatePage';
import type { PricedLine, TakeoffSummary } from '../api';

// RTL isn't wired up in this repo (see PanelSection.test.tsx), so these render
// to static markup and assert on the HTML string. That is enough for what
// matters here: whether a line that carries no usable price SAYS SO, or shows
// a dash that a reader will take for "no charge".

function line(over: Partial<PricedLine> = {}): PricedLine {
  return {
    kind: 'tube',
    qualifier: '12mm/green',
    label: 'Tube',
    qty: 5,
    unit: 'ft',
    source: 'derived',
    unit_cost: 0.5962,
    unpriced: false,
    draw_cost: 2.98,
    ...over,
  };
}

const render = (l: PricedLine) =>
  renderToStaticMarkup(
    <table>
      <tbody>
        <LineRow line={l} currency="USD" />
      </tbody>
    </table>,
  );

describe('LineRow', () => {
  it('shows the rate and cost for a priced line', () => {
    const html = render(line());
    expect(html).toContain('0.5962');
    expect(html).toContain('2.98');
    expect(html).not.toContain('unpriced');
  });

  // The core failure this feature exists to prevent: a quote that silently
  // omits its most expensive line and still looks complete.
  it('says "unpriced" and "excluded" in words, never a bare dash', () => {
    const html = render(line({ unpriced: true, unit_cost: null, draw_cost: 0 }));
    expect(html).toContain('unpriced');
    expect(html).toContain('excluded');
    expect(html).toContain('est-row-unpriced');
    // A dash would read as "no charge" at a glance.
    expect(html).not.toContain('>—<');
  });

  // A wrong-unit rate needs converting, not entering. Calling it "unpriced"
  // sends the reader hunting for a price that is already on the card.
  it('distinguishes a wrong-unit rate from a missing one', () => {
    const html = render(
      line({ kind: 'blockout_paint', unpriced: true, unit_mismatch: true, unit_cost: null, draw_cost: 0 }),
    );
    expect(html).toContain('wrong unit');
    expect(html).toContain('excluded');
    expect(html).not.toContain('>unpriced<');
  });

  it('marks an operator-entered quantity as manual', () => {
    expect(render(line({ source: 'manual' }))).toContain('manual');
    expect(render(line({ source: 'derived' }))).not.toContain('>manual<');
  });

  it('shows the purchase quantity only when a minimum exceeds what is drawn', () => {
    expect(render(line({ qty: 3, order_qty: 50, purchase_cost: 65.7, unit: 'pair' }))).toContain(
      '65.70',
    );
    // Equal order and draw quantities are not a minimum-order situation.
    expect(render(line({ qty: 50, order_qty: 50, purchase_cost: 65.7 }))).not.toContain('65.70');
  });

  it('renders whole purchasable units alongside the consumed quantity', () => {
    const html = render(line({ purchase_qty: 2, purchase_unit: 'stick' }));
    expect(html).toContain('2 stick');
  });
});

function summary(over: Partial<TakeoffSummary> = {}): TakeoffSummary {
  return {
    run_count: 2,
    jumper_count: 0,
    bend_count: 4,
    splice_count: 0,
    stick_count: 2,
    electrode_count: 4,
    electrode_pairs: 2,
    pumped_sections: 2,
    housing_count: 0,
    support_count: 0,
    jump_count: 0,
    net_tube_ft: 4.98,
    gross_glass_ft: 10,
    jumper_ft: 0,
    blockout_ft: 0.91,
    return_strip_ft: 0,
    backing_bbox_sq_ft: 6,
    backing_sheets: 1,
    backing_is_bbox: true,
    fabrication_hours: 2.99,
    ...over,
  };
}

describe('Quantities', () => {
  it('says "bounding box" when the backing area is derived', () => {
    const html = renderToStaticMarkup(<Quantities summary={summary()} />);
    // Quoting a bounding box as if it were the cut area overcharges the
    // customer, so the label has to carry the caveat.
    expect(html).toContain('Backing (bounding box)');
  });

  it('drops the caveat once a real area is supplied', () => {
    const html = renderToStaticMarkup(<Quantities summary={summary({ backing_is_bbox: false })} />);
    expect(html).toContain('Backing');
    expect(html).not.toContain('bounding box');
  });

  it('separates net tube from gross glass ordered', () => {
    const html = renderToStaticMarkup(<Quantities summary={summary()} />);
    expect(html).toContain('Net tube (lit)');
    expect(html).toContain('4.98 ft');
    expect(html).toContain('Gross glass (ordered)');
    expect(html).toContain('10.00 ft in 2 sticks');
  });
});
