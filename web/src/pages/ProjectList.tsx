import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project, type TubeSpec } from '../api';

// isBundleFile decides whether a dropped file looks like a .neonbench
// bundle. Filename test catches the canonical case; the application/zip
// MIME fallback catches users who renamed `.neonbench` to `.zip` (or
// browsers that report the renamed-zip MIME). We deliberately don't
// peek the magic bytes here — the server validates the zip on POST,
// and a client-side false positive just produces the same server error
// the existing button path would.
function isBundleFile(file: File): boolean {
  const name = file.name.toLowerCase();
  if (name.endsWith('.neonbench')) return true;
  if (file.type === 'application/zip') return true;
  return false;
}

export default function ProjectList() {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [tubeSpecs, setTubeSpecs] = useState<TubeSpec[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // dragenter fires on the parent AND on each child as the cursor
  // crosses it; without a counter, dragleave from the parent flips
  // dragActive off the moment the cursor enters a child element. The
  // ref approach pins the depth across renders (state would batch).
  const dragDepthRef = useRef(0);
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

  // runImport is the shared post-File flow used by both the hidden
  // file input and the drag-drop handler. Keeping it as one function
  // means the two entry points can never drift on error handling,
  // navigation, or the importing flag.
  async function runImport(file: File) {
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

  async function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input straight away so picking the same file twice in a
    // row still fires onChange. Otherwise React drops the second pick.
    e.target.value = '';
    if (!file) return;
    await runImport(file);
  }

  function onDragEnter(e: React.DragEvent<HTMLElement>) {
    // Only react to drags carrying files; ignore link/text drags so
    // we don't show the overlay for someone dragging selected text.
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    dragDepthRef.current += 1;
    if (dragDepthRef.current === 1) setDragActive(true);
  }

  function onDragOver(e: React.DragEvent<HTMLElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    // preventDefault is mandatory; without it the browser refuses to
    // fire the subsequent drop event at all.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }

  function onDragLeave(e: React.DragEvent<HTMLElement>) {
    if (!e.dataTransfer.types.includes('Files')) return;
    dragDepthRef.current -= 1;
    if (dragDepthRef.current <= 0) {
      dragDepthRef.current = 0;
      setDragActive(false);
    }
  }

  function onDrop(e: React.DragEvent<HTMLElement>) {
    e.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    if (files.length > 1) {
      // Bundle import is single-file by design; surface the rest as a
      // console hint rather than silently importing whichever file
      // lands at index 0.
      console.warn(
        `Bundle import takes one file; ignoring ${files.length - 1} additional file(s).`,
      );
    }
    const file = files[0];
    if (!isBundleFile(file)) {
      const ext = file.name.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '';
      setError(`Drop a .neonbench file. That looked like a ${ext || file.type || 'non-bundle file'}.`);
      return;
    }
    void runImport(file);
  }

  if (error && !projects) return <p className="error">{error}</p>;
  if (!projects || !tubeSpecs) return <p className="meta">Loading…</p>;

  const tubeSpecById = new Map(tubeSpecs.map((t) => [t.id, t]));

  return (
    <section
      className={dragActive ? 'project-list-section drag-active' : 'project-list-section'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
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
            title="Import a .neonbench bundle exported from another install (or drop one anywhere on this page)"
          >
            {importing ? 'Importing…' : 'Import .neonbench'}
          </button>
          <button onClick={() => setCreating(true)}>New project</button>
        </div>
      </div>
      {dragActive && (
        // pointer-events: none is non-negotiable: without it, releasing
        // the mouse on the overlay's text won't fire `drop` on the
        // section. The styling is in index.css under `/* Tier 3 #22 */`.
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop a .neonbench bundle to import</span>
        </div>
      )}
      {error && projects && <p className="error">{error}</p>}
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Create one to start.</p>
      ) : (
        <ul className="project-list">
          {projects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>
                <strong>
                  {p.name}
                  {p.customer ? ` — ${p.customer}` : ''}
                </strong>
                <span className="meta">
                  {tubeSpecById.get(p.tube_spec_id)?.name ?? `tube #${p.tube_spec_id}`}
                  {p.due_date ? ` · due ${p.due_date}` : ''}
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
  const [customer, setCustomer] = useState('');
  const [designer, setDesigner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [jobNumber, setJobNumber] = useState('');
  // Tube end gap (NW #135). Empty string means "unset; use the shop
  // default of 6.35 mm at render-time". We only forward a value to the
  // server when the user typed something — that way the column stays
  // NULL for default-only projects, matching how existing rows survive
  // the migration.
  const [tubeEndGap, setTubeEndGap] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    let gapMM: number | undefined;
    const trimmedGap = tubeEndGap.trim();
    if (trimmedGap !== '') {
      const parsed = Number(trimmedGap);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        setError('Tube end gap must be a number between 0 and 100 mm.');
        setSubmitting(false);
        return;
      }
      gapMM = parsed;
    }
    try {
      const p = await api.createProject({
        name: name.trim(),
        tube_spec_id: tubeSpecId,
        customer: customer.trim() || undefined,
        designer: designer.trim() || undefined,
        due_date: dueDate || undefined,
        job_number: jobNumber.trim() || undefined,
        tube_end_gap_mm: gapMM,
      });
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
          <label>
            Tube end gap (mm) (optional)
            <input
              type="number"
              min={0}
              max={100}
              step={0.05}
              value={tubeEndGap}
              onChange={(e) => setTubeEndGap(e.target.value)}
              placeholder="6.35 (default)"
            />
          </label>
          <label>
            Customer (optional)
            <input
              value={customer}
              onChange={(e) => setCustomer(e.target.value)}
              maxLength={200}
              placeholder="End client / business name"
            />
          </label>
          <label>
            Designer (optional)
            <input
              value={designer}
              onChange={(e) => setDesigner(e.target.value)}
              maxLength={100}
              placeholder="Who at the shop is responsible"
            />
          </label>
          <label>
            Due date (optional)
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
            />
          </label>
          <label>
            Job number (optional)
            <input
              value={jobNumber}
              onChange={(e) => setJobNumber(e.target.value)}
              maxLength={50}
              placeholder="Shop's invoice / work-order ID"
            />
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
