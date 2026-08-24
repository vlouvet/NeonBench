import { useState } from 'react';
import { api, type RateCard, type RateCardItem, type RateCardItemPatch } from '../api';
import { unitCostPatch } from '../lib/estimateFormat';

type Props = {
  card: RateCard;
  onChange: (card: RateCard) => void;
  onError: (msg: string) => void;
};

/**
 * The scalar fields, with the provenance of each default. These are shop
 * calibration, not trade rules, which is why they are editable at all.
 */
const SCALARS: {
  key: keyof RateCard & string;
  label: string;
  step: number;
  hint: string;
}[] = [
  {
    key: 'labour_rate_per_hour',
    label: 'Labour ($/h)',
    step: 0.5,
    hint: 'Shop cost per bench hour.',
  },
  {
    key: 'labour_setup_minutes',
    label: 'Setup (min)',
    step: 5,
    hint: 'Fixed minutes per sign, before any footage.',
  },
  {
    key: 'labour_minutes_per_foot',
    label: 'Minutes / ft',
    step: 5,
    hint: 'Fabrication minutes per foot of net tube.',
  },
  {
    key: 'markup_multiplier',
    label: 'Markup (×)',
    step: 0.01,
    hint: 'Cost × this = price. An input, not a law — check the implied margin.',
  },
  {
    key: 'stick_length_mm',
    label: 'Stick length (mm)',
    step: 1,
    hint: 'What the supplier ships. 1524 = 5 ft.',
  },
  {
    key: 'stick_waste_mm',
    label: 'Handling waste (mm)',
    step: 1,
    hint: 'Unusable glass per stick. Miller reserves 6 in total.',
  },
  {
    key: 'sheet_area_sq_ft',
    label: 'Sheet area (sq ft)',
    step: 1,
    hint: 'Backing stock. 32 = a 4×8 sheet.',
  },
];

export default function RateCardEditor({ card, onChange, onError }: Props) {
  const [busy, setBusy] = useState(false);

  async function patchScalar(key: string, raw: string) {
    const value = Number(raw);
    if (raw === '' || Number.isNaN(value)) return;
    if (value === (card as unknown as Record<string, number>)[key]) return;
    setBusy(true);
    try {
      onChange(await api.patchRateCard(card.id, { [key]: value }));
    } catch (e) {
      onError(`rate card: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function patchItem(item: RateCardItem, body: RateCardItemPatch) {
    setBusy(true);
    try {
      onChange(await api.patchRateCardItem(card.id, item.id, body));
    } catch (e) {
      onError(`rate: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="est-ratecard">
      <div className="est-ratecard-head">
        <strong>{card.name}</strong>
        {card.updated_at && (
          <span className="est-muted">updated {new Date(card.updated_at).toLocaleString()}</span>
        )}
        {busy && <span className="est-muted">saving…</span>}
      </div>

      <div className="est-scalars">
        {SCALARS.map((f) => (
          <label key={f.key} className="est-scalar" title={f.hint}>
            <span>{f.label}</span>
            <input
              type="number"
              step={f.step}
              defaultValue={(card as unknown as Record<string, number>)[f.key]}
              onBlur={(e) => patchScalar(f.key, e.currentTarget.value)}
            />
          </label>
        ))}
      </div>

      <table className="est-table">
        <thead>
          <tr>
            <th>Item</th>
            <th>SKU</th>
            <th>Unit</th>
            <th className="est-num">Cost / unit</th>
            <th className="est-num">Min qty</th>
            <th className="est-num">Pack fee</th>
          </tr>
        </thead>
        <tbody>
          {card.items.map((it) => (
            <tr key={it.id} className={it.unit_cost === null ? 'est-row-unpriced' : undefined}>
              <td>
                {it.label}
                {it.qualifier ? <span className="est-muted"> {it.qualifier}</span> : null}
              </td>
              <td className="est-muted">{it.sku || '—'}</td>
              <td className="est-muted">{it.unit}</td>
              <td className="est-num">
                <UnitCostInput item={it} onCommit={(body) => patchItem(it, body)} />
              </td>
              <td className="est-num">
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="est-input-sm"
                  defaultValue={it.min_qty ?? 0}
                  onBlur={(e) => {
                    const v = Number(e.currentTarget.value);
                    if (!Number.isNaN(v) && v !== (it.min_qty ?? 0)) patchItem(it, { min_qty: v });
                  }}
                />
              </td>
              <td className="est-num">
                <input
                  type="number"
                  min={0}
                  step={1}
                  className="est-input-sm"
                  defaultValue={it.pack_fee ?? 0}
                  onBlur={(e) => {
                    const v = Number(e.currentTarget.value);
                    if (!Number.isNaN(v) && v !== (it.pack_fee ?? 0)) patchItem(it, { pack_fee: v });
                  }}
                />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="est-note">
        Leave a cost <strong>blank</strong> to mark it unpriced — that line is then excluded
        from the estimate and the quote is flagged provisional. A typed <strong>0</strong> is a
        real price meaning free. The two are different on purpose.
      </p>
    </div>
  );
}

/**
 * The empty-vs-zero distinction is the whole point of this control, so it gets
 * its own component rather than an inline onBlur.
 *
 * An empty input sends `unit_cost: null`, which clears the rate. A typed 0
 * sends `0`, which prices the line at nothing. Collapsing them would make a
 * missing price indistinguishable from a free one on the finished quote.
 */
function UnitCostInput({
  item,
  onCommit,
}: {
  item: RateCardItem;
  onCommit: (body: RateCardItemPatch) => void;
}) {
  const stored = item.unit_cost === null ? '' : String(item.unit_cost);
  return (
    <input
      type="number"
      min={0}
      step={0.0001}
      className="est-input-sm"
      placeholder="unpriced"
      defaultValue={stored}
      key={stored}
      onBlur={(e) => {
        const patch = unitCostPatch(e.currentTarget.value, item.unit_cost);
        if (patch) onCommit(patch);
      }}
    />
  );
}
