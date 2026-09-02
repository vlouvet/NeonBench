import { describe, expect, it } from 'vitest';
import { provisionalMessage, quantityRows, unitCostPatch } from './estimateFormat';
import type { Estimate, TakeoffSummary } from '../api';

describe('unitCostPatch', () => {
  // The distinction this whole feature turns on.
  it('sends an explicit null for an emptied box', () => {
    expect(unitCostPatch('', 0.5962)).toEqual({ unit_cost: null });
  });

  it('sends 0 for a typed zero — free is a price, not the absence of one', () => {
    expect(unitCostPatch('0', null)).toEqual({ unit_cost: 0 });
    expect(unitCostPatch('0', 1.5)).toEqual({ unit_cost: 0 });
  });

  it('does not confuse an emptied box with a typed zero', () => {
    const cleared = unitCostPatch('', 1);
    const zeroed = unitCostPatch('0', 1);
    expect(cleared).not.toEqual(zeroed);
    expect(cleared?.unit_cost).toBeNull();
    expect(zeroed?.unit_cost).toBe(0);
  });

  it('sends nothing when the value is unchanged', () => {
    expect(unitCostPatch('0.5962', 0.5962)).toBeNull();
    expect(unitCostPatch('', null)).toBeNull();
  });

  it('ignores garbage and negatives rather than sending them', () => {
    expect(unitCostPatch('abc', 1)).toBeNull();
    expect(unitCostPatch('-2', 1)).toBeNull();
  });

  it('tolerates surrounding whitespace', () => {
    expect(unitCostPatch('  ', 1)).toEqual({ unit_cost: null });
    expect(unitCostPatch(' 2.5 ', 1)).toEqual({ unit_cost: 2.5 });
  });
});

function summary(over: Partial<TakeoffSummary> = {}): TakeoffSummary {
  return {
    run_count: 2,
    jumper_count: 0,
    bend_count: 4,
    splice_count: 1,
    stick_count: 3,
    electrode_count: 4,
    electrode_pairs: 2,
    pumped_sections: 2,
    housing_count: 0,
    support_count: 0,
    jump_count: 0,
    net_tube_ft: 11,
    gross_glass_ft: 15,
    jumper_ft: 0,
    blockout_ft: 0,
    return_strip_ft: 0,
    backing_bbox_sq_ft: 6,
    backing_sheets: 1,
    backing_is_bbox: true,
    fabrication_hours: 6,
    ...over,
  };
}

describe('quantityRows circuits row (Tier 2 #136)', () => {
  it('is absent on a takeoff that models no circuits', () => {
    const keys = quantityRows(summary()).map(([k]) => k);
    expect(keys).not.toContain('Circuits');
  });

  it('appears once circuits exist', () => {
    const rows = quantityRows(summary({ circuit_count: 3 }));
    const row = rows.find(([k]) => k === 'Circuits');
    expect(row?.[1]).toContain('3');
  });
});

describe('quantityRows', () => {
  it('labels a derived backing area as a bounding box', () => {
    const rows = quantityRows(summary());
    expect(rows.find(([k]) => k.startsWith('Backing'))?.[0]).toBe('Backing (bounding box)');
  });

  it('drops the qualifier once the operator supplies a real area', () => {
    const rows = quantityRows(summary({ backing_is_bbox: false }));
    expect(rows.find(([k]) => k.startsWith('Backing'))?.[0]).toBe('Backing');
  });

  it('reports gross glass alongside its stick count', () => {
    const [, gross] = quantityRows(summary())[1];
    expect(gross).toBe('15.00 ft in 3 sticks');
    expect(quantityRows(summary({ stick_count: 1 }))[1][1]).toContain('1 stick');
  });

  it('omits jumper and blockout rows when there are none', () => {
    const keys = quantityRows(summary()).map(([k]) => k);
    expect(keys).not.toContain('Jumpers');
    expect(keys).not.toContain('Blockout');
    const withBoth = quantityRows(summary({ jumper_ft: 2, jumper_count: 1, blockout_ft: 3 })).map(
      ([k]) => k,
    );
    expect(withBoth).toContain('Jumpers');
    expect(withBoth).toContain('Blockout');
  });
});

function estimate(over: Partial<Estimate> = {}): Estimate {
  return {
    lines: [],
    material_cost: 0,
    labour_cost: 288,
    cost_subtotal: 288,
    markup_multiplier: 2.22,
    price: 639.36,
    implied_margin_pct: 54.95,
    purchase_cost: 0,
    unpriced_count: 0,
    is_provisional: false,
    min_order_dominates: false,
    rate_card_id: 1,
    rate_card_name: 'Default (provisional)',
    currency: 'USD',
    ...over,
  };
}

describe('provisionalMessage', () => {
  it('is silent when everything is priced', () => {
    expect(provisionalMessage(estimate())).toBeNull();
  });

  it('says which direction the number is wrong in', () => {
    const msg = provisionalMessage(
      estimate({ is_provisional: true, unpriced_count: 3, unpriced_kinds: ['tube', 'electrode'] }),
    );
    // "Provisional" alone does not tell a reader whether the total is high or
    // low. Excluded-not-free is the whole point of the warning.
    expect(msg).toContain('not counted as free');
    expect(msg).toContain('higher than the figure shown');
    expect(msg).toContain('tube, electrode');
  });

  it('agrees with itself on one unpriced line', () => {
    const msg = provisionalMessage(estimate({ is_provisional: true, unpriced_count: 1 }));
    expect(msg).toContain('1 line is excluded');
  });

  // A wrong-unit rate needs converting, not entering. Calling it "no rate yet"
  // sends the reader looking for a price that is already on the card.
  it('names a wrong-unit rate as its own problem', () => {
    const msg = provisionalMessage(
      estimate({
        is_provisional: true,
        unpriced_count: 1,
        unpriced_kinds: ['blockout_paint'],
        unit_mismatch_kinds: ['blockout_paint'],
      }),
    );
    expect(msg).toContain('quoted in the wrong unit');
    expect(msg).toContain('a price exists');
  });
});
