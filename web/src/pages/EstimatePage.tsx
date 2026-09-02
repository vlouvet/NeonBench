import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  api,
  type EstimateInputs,
  type EstimateResponse,
  type PricedLine,
  type RateCard,
  type TakeoffSummary,
} from '../api';
import RateCardEditor from '../components/RateCardEditor';
import { provisionalMessage, quantityRows } from '../lib/estimateFormat';
import './estimate.css';
import { NumericField } from '../components/NumericField';

/**
 * Estimate route — quantities derived from the drawing, priced against a rate
 * card.
 *
 * It lives on its own route rather than as an editor panel. That keeps this
 * feature out of EditorCanvas.tsx and EditorPage.tsx, the two highest-coupling
 * files in the repo, and it matches how the work is actually done: a takeoff
 * is read once when quoting, not while bending.
 *
 * No pricing arithmetic happens here. Every number is computed server-side and
 * rendered as given, so the figure on screen and the figure on the PDF cannot
 * disagree.
 */
export default function EstimatePage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);

  const [cards, setCards] = useState<RateCard[]>([]);
  const [cardId, setCardId] = useState<number | undefined>(undefined);
  const [data, setData] = useState<EstimateResponse | null>(null);
  const [inputs, setInputs] = useState<EstimateInputs>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingInputs, setSavingInputs] = useState(false);
  const [showRates, setShowRates] = useState(false);

  const reload = useCallback(
    async (rcId?: number) => {
      try {
        setData(await api.getEstimate(projectId, versionId, rcId));
      } catch (e) {
        setError(`estimate: ${(e as Error).message}`);
      }
    },
    [projectId, versionId],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [cs, est] = await Promise.all([
          api.listRateCards(),
          api.getEstimate(projectId, versionId),
        ]);
        if (cancelled) return;
        setCards(cs);
        setData(est);
        setCardId(est.estimate.rate_card_id || cs[0]?.id);
      } catch (e) {
        if (!cancelled) setError(`load: ${(e as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, versionId]);

  async function saveInputs(next: EstimateInputs) {
    setInputs(next);
    setSavingInputs(true);
    setError(null);
    try {
      await api.saveEstimateInputs(projectId, versionId, next);
      await reload(cardId);
    } catch (e) {
      setError(`inputs: ${(e as Error).message}`);
    } finally {
      setSavingInputs(false);
    }
  }

  if (loading) return <p className="est-muted">Loading estimate…</p>;
  if (!data) return <p className="error">{error ?? 'No estimate available.'}</p>;

  const { takeoff, estimate } = data;
  const activeCard = cards.find((c) => c.id === (cardId ?? estimate.rate_card_id));
  const money = (v: number) => `${estimate.currency} ${v.toFixed(2)}`;

  return (
    <div className="est-page">
      <div className="row">
        <h1>Estimate</h1>
        <Link to={`/projects/${projectId}`} className="btn-secondary">
          Back to project
        </Link>
        <a
          className="btn-secondary"
          href={api.estimatePDFURL(projectId, versionId, cardId)}
          target="_blank"
          rel="noreferrer"
        >
          Quote sheet (PDF)
        </a>
        {cards.length > 0 && (
          <label className="est-card-picker">
            Rates:{' '}
            <select
              value={cardId ?? ''}
              onChange={(e) => {
                const next = Number(e.currentTarget.value);
                setCardId(next);
                void reload(next);
              }}
            >
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>

      {error && <p className="error">{error}</p>}

      {provisionalMessage(estimate) && (
        <div className="est-banner" role="status">
          <strong>Provisional</strong> — {provisionalMessage(estimate)}
        </div>
      )}

      <Quantities summary={takeoff.summary} />

      {takeoff.circuits && takeoff.circuits.length > 0 && (
        <>
          <h2>Circuits</h2>
          <table className="est-table">
            <thead>
              <tr>
                <th>Circuit</th>
                <th className="est-num">Runs</th>
                <th className="est-num">Pairs</th>
                <th className="est-num">Net</th>
                <th className="est-num">Gross</th>
              </tr>
            </thead>
            <tbody>
              {takeoff.circuits.map((c) => (
                <tr key={c.id}>
                  <td>{c.name || c.id}</td>
                  <td className="est-num">{c.run_count}</td>
                  <td className="est-num">{c.electrode_pairs}</td>
                  <td className="est-num">{c.net_tube_ft.toFixed(2)} ft</td>
                  {/* Gross is the sum of the member runs' sticks, NOT
                      ceil(circuit glass / stick). Two separate runs are two
                      pieces of bent glass; ceiling the total would order
                      three sticks for four letters that need four. */}
                  <td className="est-num">
                    {c.gross_glass_ft.toFixed(2)} ft in {c.stick_count}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <h2>Lines</h2>
      <table className="est-table">
        <thead>
          <tr>
            <th>Item</th>
            <th className="est-num">Qty</th>
            <th className="est-num">Rate</th>
            <th className="est-num">Cost</th>
            <th className="est-num">To buy</th>
          </tr>
        </thead>
        <tbody>
          {estimate.lines.map((l, i) => (
            <LineRow key={`${l.kind}-${l.qualifier ?? ''}-${i}`} line={l} currency={estimate.currency} />
          ))}
        </tbody>
      </table>

      <div className="est-totals">
        <Row label="Materials" value={money(estimate.material_cost)} />
        <Row label="Labour" value={money(estimate.labour_cost)} />
        <Row label="Cost subtotal" value={money(estimate.cost_subtotal)} strong />
        <Row label={`Markup ×${estimate.markup_multiplier.toFixed(2)}`} value="" />
        <Row label="Price" value={money(estimate.price)} big />
        {/* The cost side is deliberately visible: a shop that can only see the
          * sell price cannot tell when a job has gone underwater. */}
        <Row label="Implied margin" value={`${estimate.implied_margin_pct.toFixed(1)}%`} />
      </div>

      {estimate.min_order_dominates && (
        <p className="est-note">
          One or more lines cost more than twice as much to <em>buy</em> as this job consumes,
          because of supplier minimum orders — {money(estimate.purchase_cost)} of materials to
          purchase against {money(estimate.material_cost)} drawn. The purchase figure is
          advisory and is not part of the price.
        </p>
      )}

      <ManualInputs inputs={inputs} saving={savingInputs} onSave={saveInputs} />

      <h2>
        <button type="button" className="btn-link" onClick={() => setShowRates((v) => !v)}>
          {showRates ? 'Hide' : 'Show'} rate card
        </button>
      </h2>
      {showRates && activeCard && (
        <RateCardEditor
          card={activeCard}
          onChange={(updated) => {
            setCards((cs) => cs.map((c) => (c.id === updated.id ? updated : c)));
            void reload(updated.id);
          }}
          onError={setError}
        />
      )}
    </div>
  );
}

function Row({
  label,
  value,
  strong,
  big,
}: {
  label: string;
  value: string;
  strong?: boolean;
  big?: boolean;
}) {
  return (
    <div className={`est-total-row${big ? ' est-total-big' : ''}`}>
      <span>{strong ? <strong>{label}</strong> : label}</span>
      <span>{strong ? <strong>{value}</strong> : value}</span>
    </div>
  );
}

/** Exported for testing — rendered in isolation via renderToStaticMarkup. */
export function LineRow({ line, currency }: { line: PricedLine; currency: string }) {
  const desc =
    line.label + (line.qualifier ? ` (${line.qualifier})` : '') + (line.sku ? ` · ${line.sku}` : '');
  return (
    <tr className={line.unpriced ? 'est-row-unpriced' : undefined}>
      <td>
        {desc}
        {line.source === 'manual' && <span className="est-chip">manual</span>}
      </td>
      <td className="est-num">
        {line.qty.toFixed(2)} {line.unit}
        {line.purchase_qty ? (
          <span className="est-muted">
            {' '}
            ({line.purchase_qty} {line.purchase_unit})
          </span>
        ) : null}
      </td>
      {line.unpriced ? (
        // Spelled out rather than dashed. A dash reads as "no charge" at a
        // glance, which is exactly the wrong inference to invite. A wrong-unit
        // rate is named separately — it needs converting, not entering.
        <>
          <td className="est-num est-unpriced">
            {line.unit_mismatch ? 'wrong unit' : 'unpriced'}
          </td>
          <td className="est-num est-unpriced">excluded</td>
        </>
      ) : (
        <>
          <td className="est-num">{line.unit_cost?.toFixed(4) ?? '—'}</td>
          <td className="est-num">{line.draw_cost.toFixed(2)}</td>
        </>
      )}
      <td className="est-num">
        {line.order_qty && line.order_qty > line.qty
          ? `${line.order_qty} ${line.unit} = ${currency} ${(line.purchase_cost ?? 0).toFixed(2)}`
          : ''}
      </td>
    </tr>
  );
}

/** Exported for testing — see LineRow. */
export function Quantities({ summary }: { summary: TakeoffSummary }) {
  return (
    <>
      <h2>Quantities</h2>
      <dl className="est-quantities">
        {quantityRows(summary).map(([k, v]) => (
          <div key={k}>
            <dt>{k}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/**
 * The quantities a drawing cannot imply. A design does not say whether the
 * wall is brick or drywall, so install hours are typed in.
 */
// `integer` marks the fields that really are counts of discrete things, and
// so can safely carry NumericField's step={1} lattice. Everything else is a
// measurement, a duration or a money amount — 25.5 ft of GTO, 3.75 sq ft of
// backing, $412.60 of freight are all legitimate — and those take the
// default step="any". See NumericField.tsx and todo.md row 105: a numeric
// step here would make `min={0}` a lattice base and silently reject them.
const INPUT_FIELDS: {
  key: keyof EstimateInputs & string;
  label: string;
  integer?: boolean;
}[] = [
  { key: 'transformer_count', label: 'Transformers', integer: true },
  { key: 'gto_cable_ft', label: 'GTO cable (ft)' },
  { key: 'standoff_set_count', label: 'Standoff sets', integer: true },
  { key: 'backing_sq_ft', label: 'Backing (sq ft, overrides bbox)' },
  { key: 'install_hours', label: 'Install hours' },
  { key: 'design_hours', label: 'Design hours' },
  { key: 'freight', label: 'Freight' },
];

function ManualInputs({
  inputs,
  saving,
  onSave,
}: {
  inputs: EstimateInputs;
  saving: boolean;
  onSave: (next: EstimateInputs) => void;
}) {
  const [draft, setDraft] = useState<Record<string, string>>({});

  function commit() {
    const next: EstimateInputs = { ...inputs };
    for (const f of INPUT_FIELDS) {
      const raw = draft[f.key];
      if (raw === undefined) continue;
      const v = Number(raw);
      if (raw === '' || Number.isNaN(v)) delete (next as Record<string, unknown>)[f.key];
      else (next as Record<string, unknown>)[f.key] = v;
    }
    const q = draft.transformer_qualifier;
    if (q !== undefined) next.transformer_qualifier = q || undefined;
    onSave(next);
  }

  return (
    <>
      <h2>Manual quantities</h2>
      <div className="est-scalars">
        {INPUT_FIELDS.map((f) => (
          <label key={f.key} className="est-scalar">
            <span>{f.label}</span>
            <NumericField
              integer={f.integer}
              min={0}
              defaultValue={(inputs as Record<string, number | undefined>)[f.key] ?? ''}
              onChange={(e) => setDraft((d) => ({ ...d, [f.key]: e.currentTarget.value }))}
            />
          </label>
        ))}
        <label className="est-scalar">
          <span>Transformer spec</span>
          <input
            type="text"
            placeholder="12kv-30ma"
            defaultValue={inputs.transformer_qualifier ?? ''}
            onChange={(e) =>
              setDraft((d) => ({ ...d, transformer_qualifier: e.currentTarget.value }))
            }
          />
        </label>
      </div>
      <button type="button" className="btn-primary" onClick={commit} disabled={saving}>
        {saving ? 'Saving…' : 'Save quantities'}
      </button>
    </>
  );
}
