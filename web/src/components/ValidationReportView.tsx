import { useState } from 'react';
import type { ValidationIssue, ValidationReport } from '../api';

const RULE_LABELS: Record<ValidationIssue['rule'], string> = {
  min_bend_radius: 'Bend radius',
  max_segment_length: 'Segment length',
  min_spacing: 'Tube spacing',
  crossing_needs_blockout: 'Crossings (block-out paint needed)',
  splice_recommended: 'Multi-blank splice recommended',
  min_lead_in: 'Electrode lead-in',
  sharp_bend_angle: 'Sharp bend angle',
  face_perimeter_exceeds_blank: 'Face perimeter exceeds blank',
  raceway_span: 'Raceway does not span its runs',
  raceway_transformer_fit: 'Transformers do not fit the raceway',
  unsupported_path: 'Unsupported',
};

// Tier 3 #47 — sidebar↔canvas hover-link plumbing. The hover/click
// callbacks carry the issue's index INTO `report.issues` (the unfiltered
// array) so the parent can address the same issue both in the sidebar
// and on the canvas without re-implementing index translation. The
// severity filter, when supplied, renders two checkboxes above the
// rule list and limits which rows + canvas markers stay visible.
export type SeverityFilter = { errors: boolean; warnings: boolean };

export default function ValidationReportView({
  report,
  onRevalidate,
  revalidating,
  hoveredIssueIndex,
  onIssueHover,
  onIssueClick,
  selectedIssueIndex,
  severityFilter,
  onSeverityFilterChange,
}: {
  report: ValidationReport;
  onRevalidate?: () => void;
  revalidating?: boolean;
  // Index INTO `report.issues`. When set, the matching row gets the
  // `.issue-hovered` highlight class. The parent reflects canvas marker
  // hovers into this prop and vice versa.
  hoveredIssueIndex?: number | null;
  // Emitted on row mouse-enter / mouse-leave. The leave variant
  // passes `null` so the parent can clear the highlight unambiguously.
  onIssueHover?: (idx: number | null) => void;
  // Emitted on row click; the parent runs nearestRunId selection +
  // sets the active-issue cursor used by j/k keyboard nav.
  onIssueClick?: (idx: number) => void;
  // Index INTO `report.issues` of the active issue (the j/k cursor).
  // Distinct from `hoveredIssueIndex` so a user can hover one row to
  // peek and still have a separate "currently selected" row that the
  // next j keystroke advances from.
  selectedIssueIndex?: number | null;
  // When provided, two checkboxes appear above the rule list. Both
  // checked = same behavior as today. State lives in the parent so
  // it can also filter canvas markers.
  severityFilter?: SeverityFilter;
  onSeverityFilterChange?: (next: SeverityFilter) => void;
}) {
  const errors = report.issues.filter((i) => i.severity === 'error');
  const warnings = report.issues.filter((i) => i.severity === 'warning');

  // Decorate each issue with its global index BEFORE filtering so
  // hover/click props can refer to the same index space the canvas
  // uses (post-filter, but still 0..N-1 over the FILTERED list).
  // Sidebar rows show their global-issue index too — operators can
  // tell which one j/k will land on next.
  const showErrors = severityFilter?.errors ?? true;
  const showWarnings = severityFilter?.warnings ?? true;
  const filtered = report.issues
    .map((iss, idx) => ({ iss, idx }))
    .filter(({ iss }) =>
      iss.severity === 'error' ? showErrors : showWarnings,
    );
  const grouped = groupBy(filtered, ({ iss }) => iss.rule);
  const ruleOrder: ValidationIssue['rule'][] = [
    'min_bend_radius',
    'min_spacing',
    'max_segment_length',
    'crossing_needs_blockout',
    'splice_recommended',
    'min_lead_in',
    'sharp_bend_angle',
    'face_perimeter_exceeds_blank',
    // Tier 2 #104. This array is a WHITELIST, not a sort order: the render
    // below maps over it, so a rule that is missing here never reaches the
    // sidebar however loudly the backend reports it. Any new
    // ValidationIssue['rule'] member has to be added in both places.
    'raceway_span',
    'raceway_transformer_fit',
    'unsupported_path',
  ];

  const bbox = report.bounding_box_mm;
  const widthMM = bbox[2] - bbox[0];
  const heightMM = bbox[3] - bbox[1];

  const filterControls = severityFilter && onSeverityFilterChange ? (
    <div
      className="report-severity-filter"
      title="Hide warnings or errors from both the sidebar and the canvas markers. Component-local state — not persisted."
    >
      <label>
        <input
          type="checkbox"
          checked={severityFilter.errors}
          onChange={(e) =>
            onSeverityFilterChange({
              ...severityFilter,
              errors: e.target.checked,
            })
          }
        />
        {' '}Show errors ({errors.length})
      </label>
      <label>
        <input
          type="checkbox"
          checked={severityFilter.warnings}
          onChange={(e) =>
            onSeverityFilterChange({
              ...severityFilter,
              warnings: e.target.checked,
            })
          }
        />
        {' '}Show warnings ({warnings.length})
      </label>
    </div>
  ) : null;

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
      {filterControls}

      {report.issues.length === 0 ? (
        <p className="empty">No validation issues. Send to printer when ready.</p>
      ) : filtered.length === 0 ? (
        <p className="empty">All issues hidden by the severity filter.</p>
      ) : (
        <div className="report-rules">
          {ruleOrder.map((rule) => {
            const items = grouped.get(rule);
            if (!items || items.length === 0) return null;
            return (
              <RuleGroup
                key={rule}
                rule={rule}
                items={items}
                hoveredIssueIndex={hoveredIssueIndex ?? null}
                selectedIssueIndex={selectedIssueIndex ?? null}
                onIssueHover={onIssueHover}
                onIssueClick={onIssueClick}
              />
            );
          })}
        </div>
      )}
    </section>
  );
}

function RuleGroup({
  rule,
  items,
  hoveredIssueIndex,
  selectedIssueIndex,
  onIssueHover,
  onIssueClick,
}: {
  rule: ValidationIssue['rule'];
  items: { iss: ValidationIssue; idx: number }[];
  hoveredIssueIndex: number | null;
  selectedIssueIndex: number | null;
  onIssueHover?: (idx: number | null) => void;
  onIssueClick?: (idx: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const errors = items.filter(({ iss }) => iss.severity === 'error').length;
  const warnings = items.length - errors;
  // Force the group open when the hovered or selected issue lives
  // inside it — otherwise hover from the canvas to a collapsed group
  // can't surface a row at all. The user can still re-collapse later.
  const containsActive =
    (hoveredIssueIndex !== null &&
      items.some(({ idx }) => idx === hoveredIssueIndex)) ||
    (selectedIssueIndex !== null &&
      items.some(({ idx }) => idx === selectedIssueIndex));
  const effectiveOpen = open || containsActive;
  const sample = items.slice(0, effectiveOpen ? items.length : 5);
  return (
    <details
      className="rule-group"
      open={effectiveOpen}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
    >
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
        {sample.map(({ iss, idx }) => {
          const classes = ['issue', iss.severity];
          if (idx === hoveredIssueIndex) classes.push('issue-hovered');
          if (idx === selectedIssueIndex) classes.push('issue-selected');
          const interactive = Boolean(onIssueHover || onIssueClick);
          return (
            <li
              // Use the global index so the key is stable across
              // filter / open-state changes (the previous "i" was the
              // local-loop index; tasks adjacent to filter toggles
              // would shift keys and force remount).
              key={idx}
              className={classes.join(' ')}
              onMouseEnter={onIssueHover ? () => onIssueHover(idx) : undefined}
              onMouseLeave={onIssueHover ? () => onIssueHover(null) : undefined}
              onClick={onIssueClick ? () => onIssueClick(idx) : undefined}
              style={interactive ? { cursor: 'pointer' } : undefined}
            >
              <span className="issue-msg">{iss.message}</span>
              {(iss.x_mm !== undefined && iss.y_mm !== undefined) && (
                <span className="issue-loc meta">
                  ({Math.round(iss.x_mm)}, {Math.round(iss.y_mm)})mm
                </span>
              )}
            </li>
          );
        })}
        {!effectiveOpen && items.length > sample.length && (
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
