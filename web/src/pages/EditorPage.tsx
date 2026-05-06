import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, parseDoc, type DesignDoc, type DesignVersion, type Project } from '../api';
import EditorCanvas from '../components/EditorCanvas';

export default function EditorPage() {
  const { id, vid } = useParams();
  const projectId = Number(id);
  const versionId = Number(vid);

  const [project, setProject] = useState<Project | null>(null);
  const [version, setVersion] = useState<DesignVersion | null>(null);
  const [doc, setDoc] = useState<DesignDoc | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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

  const selectedRun = doc.runs.find((r) => r.id === selected) ?? null;

  return (
    <section className="editor-section">
      <header className="editor-header">
        <p>
          <Link to={`/projects/${projectId}`}>&larr; {project.name}</Link>
        </p>
        <h1>
          Editor — v{version.version_no}
          {version.label ? ` · ${version.label}` : ''}
        </h1>
        <p className="meta">
          {doc.runs.length} tube run{doc.runs.length === 1 ? '' : 's'} · canvas in millimeters · drag to pan, wheel to zoom · click a run to select
        </p>
      </header>
      <div className="editor-layout">
        <EditorCanvas doc={doc} selectedRunId={selected} onSelectRun={setSelected} />
        <aside className="editor-sidebar">
          <h3>Runs</h3>
          <ul className="run-list">
            {doc.runs.map((run) => (
              <li
                key={run.id}
                className={`run-row ${run.id === selected ? 'active' : ''}`}
                onClick={() => setSelected(run.id)}
              >
                <strong>{run.id}</strong>
                <span className="meta">
                  {run.polyline.points.length} pts · {run.polyline.closed ? 'closed' : 'open'} · ø {run.tube_diameter_mm ?? '?'}mm
                </span>
              </li>
            ))}
          </ul>
          {selectedRun && (
            <div className="run-detail">
              <h4>{selectedRun.id}</h4>
              <p className="meta">
                points: {selectedRun.polyline.points.length}
                <br />
                closed: {String(selectedRun.polyline.closed)}
                <br />
                electrodes: {selectedRun.electrodes?.length ?? 0}
              </p>
              <p className="meta">
                Editing operations (move nodes, place electrodes, mark blockouts) coming next.
              </p>
            </div>
          )}
        </aside>
      </div>
    </section>
  );
}
