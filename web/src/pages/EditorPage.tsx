import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  parseDoc,
  parseReport,
  type DesignDoc,
  type DesignVersion,
  type Project,
  type ValidationReport,
} from '../api';
import EditorCanvas, { type EditorTool } from '../components/EditorCanvas';
import { defaultDirection } from '../lib/runArcs';
import { NEON_COLORS, colorHex } from '../lib/neonColors';

export default function EditorPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);
  const navigate = useNavigate();

  const [project, setProject] = useState<Project | null>(null);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [tool, setTool] = useState<EditorTool>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [label, setLabel] = useState('');
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const validateAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    Promise.all([api.getProject(projectId), api.getDesignVersion(projectId, versionId)])
      .then(([p, v]) => {
        setProject(p);
        setVersion(v);
        setDoc(parseDoc(v));
        setReport(parseReport(v));
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, versionId]);

  // Debounced live validation: every meaningful edit kicks a 500ms timer;
  // when it fires we submit the current doc to the server. In-flight calls
  // are aborted on the next tick so the user only ever sees the result of
  // their latest state. Skipped when the doc is clean (the saved report is
  // already authoritative).
  useEffect(() => {
    if (!doc || !dirty) return;
    const handle = window.setTimeout(() => {
      validateAbortRef.current?.abort();
      const ctrl = new AbortController();
      validateAbortRef.current = ctrl;
      setValidating(true);
      api
        .validateDoc(projectId, doc, ctrl.signal)
        .then((rep) => {
          if (!ctrl.signal.aborted) setReport(rep);
        })
        .catch((e: Error) => {
          if (!ctrl.signal.aborted) {
            // Surface but don't crash the editor — validation is advisory.
            setError(`live validate: ${e.message}`);
          }
        })
        .finally(() => {
          if (!ctrl.signal.aborted) setValidating(false);
        });
    }, 500);
    return () => {
      window.clearTimeout(handle);
    };
  }, [doc, dirty, projectId]);

  if (error) return <p className="error">{error}</p>;
  if (!project || !version) return <p className="meta">Loading…</p>;
  if (!doc) {
    return (
      <section>
        <p>
          <Link to={`/projects/${projectId}`}>&larr; {project.name}</Link>
        </p>
        <h1>Editor — v{version.version_no}</h1>
        <p className="error">
          This version was created before the editor schema existed. Re-vectorize on
          the project page to generate an editable design doc.
        </p>
      </section>
    );
  }

  function placeElectrode(runId: string, pointIndex: number) {
    if (!doc) return;
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const existing = run.electrodes ?? [];
        let nextElectrodes;
        if (existing.length >= 2) {
          // Replace the closer of the two existing electrodes.
          const dist = (idx: number) => Math.abs(idx - pointIndex);
          const replaceIdx = dist(existing[0].point_index) < dist(existing[1].point_index) ? 0 : 1;
          nextElectrodes = [...existing];
          nextElectrodes[replaceIdx] = { point_index: pointIndex };
        } else {
          nextElectrodes = [...existing, { point_index: pointIndex }];
        }
        const next = { ...run, electrodes: nextElectrodes };
        // When we just gave a closed run its second electrode, default the
        // direction to whichever arc is longer (typically the visible part
        // of a glyph perimeter).
        if (run.polyline.closed && nextElectrodes.length === 2 && !run.direction) {
          next.direction = defaultDirection(next);
        }
        return next;
      });
      return { ...prev, runs };
    });
    setSelected(runId);
    setDirty(true);
  }

  function flipDirection(runId: string) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const cur = run.direction ?? defaultDirection(run);
        const next: 'forward' | 'backward' = cur === 'forward' ? 'backward' : 'forward';
        return { ...run, direction: next };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  function deleteElectrode(runId: string, electrodeIndex: number) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const electrodes = (run.electrodes ?? []).filter((_, i) => i !== electrodeIndex);
        return { ...run, electrodes };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  function clearElectrodesOnSelected() {
    if (!selected) return;
    setDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        runs: prev.runs.map((r) => (r.id === selected ? { ...r, electrodes: [] } : r)),
      };
    });
    setDirty(true);
  }

  function placeBlockout(runId: string, startLiveIndex: number, endLiveIndex: number) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // Normalize so start <= end for non-wrapping intent. (For closed runs
        // the renderer will still walk the live arc the right way around.)
        const s = Math.min(startLiveIndex, endLiveIndex);
        const e = Math.max(startLiveIndex, endLiveIndex);
        const blockouts = [...(run.blockouts ?? []), { start_live_index: s, end_live_index: e }];
        return { ...run, blockouts };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
    setDirty(true);
  }

  function deleteBlockout(runId: string, blockoutIndex: number) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const blockouts = (run.blockouts ?? []).filter((_, i) => i !== blockoutIndex);
        return { ...run, blockouts };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  function clearBlockoutsOnSelected() {
    if (!selected) return;
    setDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        runs: prev.runs.map((r) => (r.id === selected ? { ...r, blockouts: [] } : r)),
      };
    });
    setDirty(true);
  }

  function setRunColor(runId: string, color: string) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        // Empty value collapses to omitted field so the JSON stays clean.
        if (color === '') {
          const { color: _drop, ...rest } = run;
          return rest;
        }
        return { ...run, color };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  function placeAnnotation(runId: string, kind: 'jump' | 'support' | 'doubleback', liveIndex: number) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const annotations = [...(run.annotations ?? []), { kind, live_index: liveIndex }];
        return { ...run, annotations };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
    setDirty(true);
  }

  function deleteAnnotation(runId: string, annotationIndex: number) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        const annotations = (run.annotations ?? []).filter((_, i) => i !== annotationIndex);
        return { ...run, annotations };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  function clearAnnotationsOnSelected() {
    if (!selected) return;
    setDoc((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        runs: prev.runs.map((r) => (r.id === selected ? { ...r, annotations: [] } : r)),
      };
    });
    setDirty(true);
  }

  function setRunDiameter(runId: string, diameterMM: number | null) {
    setDoc((prev) => {
      if (!prev) return prev;
      const runs = prev.runs.map((run) => {
        if (run.id !== runId) return run;
        if (diameterMM == null || Number.isNaN(diameterMM) || diameterMM <= 0) {
          const { tube_diameter_mm: _drop, ...rest } = run;
          return rest;
        }
        return { ...run, tube_diameter_mm: diameterMM };
      });
      return { ...prev, runs };
    });
    setDirty(true);
  }

  async function save() {
    if (!doc) return;
    setSaving(true);
    setError(null);
    try {
      const newVersion = await api.saveDesignVersion(projectId, {
        based_on_vid: versionId,
        label: label.trim() || undefined,
        design_doc: doc,
      });
      navigate(`/projects/${projectId}/edit/${newVersion.id}`, { replace: true });
      setDirty(false);
      setLabel('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const selectedRun = doc.runs.find((r) => r.id === selected) ?? null;
  const totalElectrodes = doc.runs.reduce((acc, r) => acc + (r.electrodes?.length ?? 0), 0);

  return (
    <section className="editor-section">
      <header className="editor-header">
        <p>
          <Link to={`/projects/${projectId}`}>&larr; {project.name}</Link>
        </p>
        <div className="row">
          <h1>
            Editor — v{version.version_no}
            {version.label ? ` · ${version.label}` : ''}
            {dirty && <span className="dirty-dot" title="Unsaved changes" />}
          </h1>
          <div className="editor-toolbar">
            <button
              type="button"
              className={tool === 'select' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('select')}
              title="Select tool (click runs to highlight)"
            >Select</button>
            <button
              type="button"
              className={tool === 'electrode' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('electrode')}
              title="Place electrode (click on a path)"
            >Place electrode</button>
            <button
              type="button"
              className={tool === 'blockout' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('blockout')}
              title="Mark blockout (click two points on the same run)"
            >Mark blockout</button>
            <button
              type="button"
              className={tool === 'jump' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('jump')}
              title="Mark a jump-over (tube lifts to clear another tube)"
            >Mark jump</button>
            <button
              type="button"
              className={tool === 'support' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('support')}
              title="Mark a support point (chassis-mount)"
            >Mark support</button>
            <button
              type="button"
              className={tool === 'doubleback' ? 'tool-btn active' : 'tool-btn'}
              onClick={() => setTool('doubleback')}
              title="Mark a hairpin as an intentional double-back (suppresses bend-radius warning)"
            >Mark double-back</button>
          </div>
        </div>
        <p className="meta">
          {doc.runs.length} runs · {totalElectrodes} electrodes placed · drag to pan, wheel to zoom · shift+click an electrode to delete
        </p>
        <ValidationBadge report={report} validating={validating} />
      </header>
      <div className="editor-layout">
        <EditorCanvas
          doc={doc}
          tool={tool}
          selectedRunId={selected}
          onSelectRun={setSelected}
          onPlaceElectrode={placeElectrode}
          onDeleteElectrode={deleteElectrode}
          onPlaceBlockout={placeBlockout}
          onPlaceAnnotation={placeAnnotation}
          onDeleteAnnotation={deleteAnnotation}
        />
        <aside className="editor-sidebar">
          <h3>Runs</h3>
          <ul className="run-list">
            {doc.runs.map((run) => {
              const ne = run.electrodes?.length ?? 0;
              return (
                <li
                  key={run.id}
                  className={`run-row ${run.id === selected ? 'active' : ''}`}
                  onClick={() => setSelected(run.id)}
                >
                  <div className="run-row-head">
                    <span
                      className="color-swatch"
                      style={{ background: colorHex(run.color) }}
                      title={run.color || 'unassigned'}
                    />
                    <strong>{run.id}</strong>
                  </div>
                  <span className="meta">
                    {run.polyline.points.length} pts · {ne}/2 ⬥ · ø {run.tube_diameter_mm ?? '?'}mm
                  </span>
                </li>
              );
            })}
          </ul>
          {selectedRun && (
            <div className="run-detail">
              <h4>{selectedRun.id}</h4>
              <p className="meta">
                {selectedRun.polyline.points.length} pts ·{' '}
                {selectedRun.polyline.closed ? 'closed' : 'open'} ·{' '}
                {selectedRun.electrodes?.length ?? 0} electrodes
              </p>
              <label className="color-picker">
                Color
                <select
                  value={selectedRun.color ?? ''}
                  onChange={(e) => setRunColor(selectedRun.id, e.target.value)}
                >
                  {NEON_COLORS.map((c) => (
                    <option key={c.value || 'unset'} value={c.value}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <span
                  className="color-swatch lg"
                  style={{ background: colorHex(selectedRun.color) }}
                />
              </label>
              <label className="diameter-picker">
                Diameter (mm)
                <input
                  type="number"
                  step="0.5"
                  min="1"
                  value={selectedRun.tube_diameter_mm ?? ''}
                  placeholder="project default"
                  onChange={(e) => {
                    const raw = e.target.value.trim();
                    setRunDiameter(selectedRun.id, raw === '' ? null : Number(raw));
                  }}
                />
              </label>
              <p className="meta hint-line">
                Editor-only override. Validation still uses the project tube spec.
              </p>
              {selectedRun.polyline.closed && (selectedRun.electrodes?.length ?? 0) === 2 && (
                <button type="button" className="btn-secondary" onClick={() => flipDirection(selectedRun.id)}>
                  Switch live arc ({selectedRun.direction ?? 'forward'})
                </button>
              )}
              {(selectedRun.electrodes?.length ?? 0) > 0 && (
                <button type="button" className="btn-secondary" onClick={clearElectrodesOnSelected}>
                  Clear electrodes
                </button>
              )}
              {(selectedRun.blockouts?.length ?? 0) > 0 && (
                <>
                  <h5 className="meta">Blockouts</h5>
                  <ul className="blockout-list">
                    {selectedRun.blockouts!.map((b, bi) => (
                      <li key={bi}>
                        <span className="meta">[{b.start_live_index}, {b.end_live_index}]</span>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => deleteBlockout(selectedRun.id, bi)}
                        >Remove</button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn-secondary" onClick={clearBlockoutsOnSelected}>
                    Clear blockouts
                  </button>
                </>
              )}
              {(selectedRun.annotations?.length ?? 0) > 0 && (
                <>
                  <h5 className="meta">Annotations</h5>
                  <ul className="blockout-list">
                    {selectedRun.annotations!.map((a, ai) => (
                      <li key={ai}>
                        <span className="meta">{a.kind} @ live {a.live_index}</span>
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => deleteAnnotation(selectedRun.id, ai)}
                        >Remove</button>
                      </li>
                    ))}
                  </ul>
                  <button type="button" className="btn-secondary" onClick={clearAnnotationsOnSelected}>
                    Clear annotations
                  </button>
                </>
              )}
            </div>
          )}
          <div className="save-section">
            <label>
              New version label
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. 'electrodes placed'"
              />
            </label>
            <button
              type="button"
              className={`btn-primary ${dirty ? '' : 'disabled'}`}
              onClick={save}
              disabled={!dirty || saving}
            >
              {saving ? 'Saving…' : dirty ? 'Save as new version' : 'No changes'}
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function ValidationBadge({
  report,
  validating,
}: {
  report: ValidationReport | null;
  validating: boolean;
}) {
  if (!report) {
    return (
      <p className="meta validation-badge">
        {validating ? 'Validating…' : 'No validation report yet — edit to trigger live validation.'}
      </p>
    );
  }
  const errors = report.issues.filter((i) => i.severity === 'error').length;
  const warnings = report.issues.filter((i) => i.severity === 'warning').length;
  const cls = errors > 0 ? 'err' : warnings > 0 ? 'warn' : 'ok';
  const summary =
    errors === 0 && warnings === 0
      ? 'All rules pass'
      : `${errors} error${errors === 1 ? '' : 's'} · ${warnings} warning${warnings === 1 ? '' : 's'}`;
  return (
    <p className={`meta validation-badge ${cls}`}>
      {validating ? 'Re-validating… ' : ''}
      {summary} · {report.tube_runs} runs · {(report.total_length_mm / 1000).toFixed(2)}m total tube
    </p>
  );
}
