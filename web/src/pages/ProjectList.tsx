import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project, type TubeSpec } from '../api';

export default function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tubeSpecs, setTubeSpecs] = useState<TubeSpec[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    Promise.all([api.listProjects(), api.listTubeSpecs()])
      .then(([p, t]) => {
        setProjects(p);
        setTubeSpecs(t);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function handleDelete(p: Project) {
    const ok = window.confirm(
      `Delete project '${p.name}' permanently? This will erase all assets and design versions and cannot be undone.`,
    );
    if (!ok) return;
    try {
      await api.deleteProject(p.id);
      const fresh = await api.listProjects();
      setProjects(fresh);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input straight away so picking the same file twice in a
    // row still fires onChange. Otherwise React drops the second pick.
    e.target.value = '';
    if (!file) return;
    setError(null);
    setImporting(true);
    try {
      const imported = await api.importBundle(file);
      const fresh = await api.listProjects();
      setProjects(fresh);
      // Drop the user straight into the imported project so the import
      // result is obviously visible (and matches the post-create flow
      // most users expect).
      navigate(`/projects/${imported.id}`);
    } catch (err) {
      setError(`Import failed: ${(err as Error).message}`);
    } finally {
      setImporting(false);
    }
  }

  if (error && !projects) return <p className="error">{error}</p>;
  if (!projects || !tubeSpecs) return <p className="meta">Loading…</p>;

  const tubeSpecById = new Map(tubeSpecs.map((t) => [t.id, t]));

  return (
    <section>
      <div className="row">
        <h1>Projects</h1>
        <div className="row" style={{ gap: '0.5rem' }}>
          <input
            ref={importInputRef}
            type="file"
            accept=".neonbench,application/zip"
            onChange={handleImport}
            style={{ display: 'none' }}
          />
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            disabled={importing}
            title="Import a .neonbench bundle exported from another install"
          >
            {importing ? 'Importing…' : 'Import .neonbench'}
          </button>
          <button onClick={() => setCreating(true)}>New project</button>
        </div>
      </div>
      {error && projects && <p className="error">{error}</p>}
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Create one to start.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>
                <strong>{p.name}</strong>
                <span className="meta">
                  {tubeSpecById.get(p.tube_spec_id)?.name ?? `tube #${p.tube_spec_id}`}
                  {' · updated '}
                  {new Date(p.updated_at).toLocaleString()}
                </span>
              </Link>
              <button
                type="button"
                className="btn-danger"
                onClick={() => handleDelete(p)}
                title={`Delete project '${p.name}'`}
              >
                Delete project
              </button>
            </li>
          ))}
        </ul>
      )}
      {creating && (
        <NewProjectModal
          tubeSpecs={tubeSpecs}
          onCancel={() => setCreating(false)}
          onCreated={(p) => {
            setCreating(false);
            setProjects((prev) => (prev ? [p, ...prev] : [p]));
          }}
        />
      )}
    </section>
  );
}

function NewProjectModal({
  tubeSpecs,
  onCancel,
  onCreated,
}: {
  tubeSpecs: TubeSpec[];
  onCancel: () => void;
  onCreated: (p: Project) => void;
}) {
  const defaultSpec = tubeSpecs.find((t) => t.is_default) ?? tubeSpecs[0];
  const [name, setName] = useState('');
  const [tubeSpecId, setTubeSpecId] = useState<number>(defaultSpec?.id ?? 0);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const p = await api.createProject({ name: name.trim(), tube_spec_id: tubeSpecId });
      onCreated(p);
    } catch (err) {
      setError((err as Error).message);
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New project</h2>
        <form onSubmit={submit}>
          <label>
            Name
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              minLength={1}
            />
          </label>
          <label>
            Tube spec
            <select
              value={tubeSpecId}
              onChange={(e) => setTubeSpecId(Number(e.target.value))}
            >
              {tubeSpecs.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.is_default ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          {error && <p className="error">{error}</p>}
          <div className="actions">
            <button type="button" onClick={onCancel} disabled={submitting}>
              Cancel
            </button>
            <button type="submit" disabled={submitting || !name.trim()}>
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
