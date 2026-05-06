import { useState } from 'react';
import type { ValidationIssue, ValidationReport } from '../api';

const RULE_LABELS: Record<ValidationIssue['rule'], string> = {
  min_bend_radius: 'Bend radius',
  max_segment_length: 'Segment length',
  min_spacing: 'Tube spacing',
  crossing_needs_blockout: 'Crossings (block-out paint needed)',
  splice_recommended: 'Multi-blank splice recommended',
  unsupported_path: 'Unsupported',
};

export default function ValidationReportView({
  report,
  onRevalidate,
  revalidating,
}: {
  report: ValidationReport;
  onRevalidate?: () => void;
  revalidating?: boolean;
}) {
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');
  const grouped = groupBy(report.issues, (i) => i.rule);
  const ruleOrder: ValidationIssue['rule'][] = [
    'min_bend_radius',
    'min_spacing',
    'max_segment_length',
    'crossing_needs_blockout',
    'splice_recommended',
    'unsupported_path',
  ];

  const bbox = report.bounding_box_mm;
  const widthMM = bbox[2] - bbox[0];
  const heightMM = bbox[3] - bbox[1];

  return (
    <section className="report">
      <div className="report-summary">
        <Chip
          tone={errors.length === 0 ? 'ok' : 'error'}
          label={errors.length === 0 ? 'Ready to print' : `${errors.length} error${errors.length === 1 ? '' : 's'}`}
        />
        {warnings.length > 0 && (
          <Chip tone="warning" label={`${warnings.length} warning${warnings.length === 1 ? '' : 's'}`} />
        )}
        <Chip tone="info" label={`${report.tube_runs} tube run${report.tube_runs === 1 ? '' : 's'}`} />
        <Chip tone="info" label={`${Math.round(report.total_length_mm)}mm total length`} />
        <Chip
          tone="info"
          label={`${Math.round(widthMM)} × ${Math.round(heightMM)}mm`}
        />
        {onRevalidate && (
          <button type="button" onClick={onRevalidate} disabled={revalidating} className="report-revalidate">
            {revalidating ? 'Re-validating…' : 'Re-validate'}
          </button>
        )}
      </div>

      {report.issues.length === 0 ? (
        <p className="empty">No validation issues. Send to printer when ready.</p>
      ) : (
        <div className="report-rules">
          {ruleOrder.map((rule) => {
            const items = grouped.get(rule);
            if (!items || items.length === 0) return null;
            return <RuleGroup key={rule} rule={rule} items={items} />;
          })}
        </div>
      )}
    </section>
  );
}

function RuleGroup({ rule, items }: { rule: ValidationIssue['rule']; items: ValidationIssue[] }) {
  const [open, setOpen] = useState(false);
  const errors = items.filter((i) => i.severity === 'error').length;
  const warnings = items.length - errors;
  const sample = items.slice(0, open ? items.length : 5);
  return (
    <details className="rule-group" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary>
        <span className={`rule-dot ${errors > 0 ? 'error' : 'warning'}`} />
        <span className="rule-name">{RULE_LABELS[rule]}</span>
        <span className="meta">
          {errors > 0 && `${errors} error${errors === 1 ? '' : 's'}`}
          {errors > 0 && warnings > 0 && ', '}
          {warnings > 0 && `${warnings} warning${warnings === 1 ? '' : 's'}`}
        </span>
      </summary>
      <ul className="issue-list">
        {sample.map((iss, i) => (
          <li key={i} className={`issue ${iss.severity}`}>
            <span className="issue-msg">{iss.message}</span>
            {(iss.x_mm !== undefined && iss.y_mm !== undefined) && (
              <span className="issue-loc meta">
                ({Math.round(iss.x_mm)}, {Math.round(iss.y_mm)})mm
              </span>
            )}
          </li>
        ))}
        {!open && items.length > sample.length && (
          <li className="meta issue-more">+ {items.length - sample.length} more — click to expand</li>
        )}
      </ul>
    </details>
  );
}

function Chip({ tone, label }: { tone: 'ok' | 'error' | 'warning' | 'info'; label: string }) {
  return <span className={`chip chip-${tone}`}>{label}</span>;
}

function groupBy<T, K>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
