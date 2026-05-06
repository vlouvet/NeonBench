import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, parseDoc, type DesignDoc, type DesignVersion, type Project } from '../api';
import EditorCanvas, { type EditorTool } from '../components/EditorCanvas';

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

  useEffect(() => {
    Promise.all([api.getProject(projectId), api.getDesignVersion(projectId, versionId)])
      .then(([p, v]) => {
        setProject(p);
        setVersion(v);
        setDoc(parseDoc(v));
      })
      .catch((e: Error) => setError(e.message));
  }, [projectId, versionId]);

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
        if (existing.length >= 2) {
          // Replace the closer of the two existing electrodes.
          const dist = (idx: number) => Math.abs(idx - pointIndex);
          const replaceIdx = dist(existing[0].point_index) < dist(existing[1].point_index) ? 0 : 1;
          const newEl = [...existing];
          newEl[replaceIdx] = { point_index: pointIndex };
          return { ...run, electrodes: newEl };
        }
        return { ...run, electrodes: [...existing, { point_index: pointIndex }] };
      });
      return { ...prev, runs };
    });
    setSelected(runId);
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
          </div>
        </div>
        <p className="meta">
          {doc.runs.length} runs · {totalElectrodes} electrodes placed · drag to pan, wheel to zoom · shift+click an electrode to delete
        </p>
      </header>
      <div className="editor-layout">
        <EditorCanvas
          doc={doc}
          tool={tool}
          selectedRunId={selected}
          onSelectRun={setSelected}
          onPlaceElectrode={placeElectrode}
          onDeleteElectrode={deleteElectrode}
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
                  <strong>{run.id}</strong>
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
              {(selectedRun.electrodes?.length ?? 0) > 0 && (
                <button type="button" className="btn-secondary" onClick={clearElectrodesOnSelected}>
                  Clear electrodes
                </button>
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
