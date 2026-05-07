import { useState } from 'react';
import { api, PAPER_OPTIONS, type ValidationReport } from '../api';

export default function PrintPanel({
  projectId,
  versionId,
  report,
}: {
  projectId: number;
  versionId: number;
  report: ValidationReport | null;
}) {
  const [paper, setPaper] = useState<string>('letter');
  const [landscape, setLandscape] = useState(false);

  const errors = report?.issues.filter((i) => i.severity === 'error') ?? [];
  const blocked = errors.length > 0;
  const url = api.printPDFURL(projectId, versionId, { paper, landscape });
  const dxfUrl = api.dxfURL(projectId, versionId);

  return (
    <section className="print-panel">
      <h3>Print pattern (1:1)</h3>
      <div className="print-controls">
        <label>
          Paper
          <select value={paper} onChange={(e) => setPaper(e.target.value)}>
            {PAPER_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </label>
        <label className="checkbox">
          <input type="checkbox" checked={landscape} onChange={(e) => setLandscape(e.target.checked)} />
          Landscape
        </label>
        <a
          href={blocked ? undefined : url}
          download
          className={`btn-primary ${blocked ? 'disabled' : ''}`}
          aria-disabled={blocked}
          onClick={(e) => {
            if (blocked) e.preventDefault();
          }}
        >
          {blocked ? `Blocked — fix ${errors.length} error${errors.length === 1 ? '' : 's'}` : 'Download PDF'}
        </a>
        {/* DXF is geometry-only — no paper/landscape — but we keep the
            same validation gate as PDF so a known-bad design can't be
            fabricated by accident. */}
        <a
          href={blocked ? undefined : dxfUrl}
          download
          className={`btn-secondary ${blocked ? 'disabled' : ''}`}
          aria-disabled={blocked}
          title="Geometry only (no annotations) — for CNC tube benders."
          onClick={(e) => {
            if (blocked) e.preventDefault();
          }}
        >
          Download DXF
        </a>
      </div>
      <p className="meta">
        Output is tiled across pages for designs larger than the paper, with
        registration crosses at the corners and a 100mm scale bar — verify the
        bar measures 100mm before bending against the pattern. The DXF is an
        AutoCAD R12 ASCII file with one polyline per run (millimeters, layered
        per run id) for CNC tube benders; annotations are PDF-only.
      </p>
    </section>
  );
}
