import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project, type TubeSpec } from '../api';
import { isOverdue } from '../lib/dueDate';
import BundlePreviewModal from '../components/BundlePreviewModal';
import {
  DEFAULT_FILTERS,
  filtersToSearchParams,
  resolveInitialFilters,
  saveStoredFilters,
  type ListFilters,
  type SortMode,
} from '../lib/listFilters';
import { NumericField } from '../components/NumericField';

// Search-debounce window for URL + localStorage writes. Matches the
// "type, pause briefly, then commit" feel users get from native search
// fields. The state itself updates on every keystroke (so filtering
// stays live); only the persisted copy is debounced.
const SEARCH_PERSIST_DEBOUNCE_MS = 250;

// "Hide completed" checkbox is deferred. Tier 3 #38c originally
// asked for one alongside the sort/search persistence, but the
// Project type (web/src/api.ts) has no is_completed / completed_at
// flag yet, and CLAUDE.md routes new schema columns through the
// user. Once a flag exists, wire it through listFilters.ts (add
// ?completed=hide and a corresponding storage field) and add the
// checkbox here. Until then the URL/localStorage shape only carries
// sort + q, so future readers can extend without a migration.

// parseDueKey turns a project's due_date into a sortable number. Empty /
// unparseable values map to +Infinity so they sink to the end of the
// ascending sort. We don't use isOverdue here — the sort key needs the
// actual chronological order, not just the past/future bucket.
function parseDueKey(iso: string): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  const d = new Date(iso + 'T00:00:00');
  const t = d.getTime();
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return t;
}

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
  // Tier 3 #38c: client-side sort + search state, persisted to URL +
  // localStorage. Initial values are resolved on first render: URL >
  // localStorage > defaults. SSR-safe initialiser (window guards for
  // `typeof`) so vitest / Node imports don't crash. Computed once on
  // mount; subsequent navigations stay in-tab because we never
  // unmount this page within a session, so we don't track
  // window.location.search as a dep (the same reason useState's lazy
  // initialiser would be appropriate here).
  const initialFilters = useMemo<ListFilters>(() => {
    if (typeof window === 'undefined') return { ...DEFAULT_FILTERS };
    return resolveInitialFilters(window.location.search, window.localStorage);
  }, []);
  const [query, setQuery] = useState(initialFilters.q);
  const [sortMode, setSortMode] = useState<SortMode>(initialFilters.sort);
  // Pre-import preview file. Set when a drop / file-picker hands us a
  // bundle; the modal owns the Cancel/Confirm handoff. Importing only
  // starts when the user clicks Import in the modal.
  const [pendingBundle, setPendingBundle] = useState<File | null>(null);
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

  // Persist filter state. URL updates immediately on sort change but
  // is debounced for query keystrokes — otherwise every character
  // would push a new history entry (or, with replaceState, thrash the
  // History API). LocalStorage is written on the same cadence so the
  // two stay in lockstep.
  //
  // The dependency array intentionally lists `query` and `sortMode`
  // (not `initialFilters`) because we want this to run on every user
  // edit, not just on mount.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const filters: ListFilters = { sort: sortMode, q: query };
    const handle = window.setTimeout(() => {
      const params = filtersToSearchParams(filters);
      const search = params.toString();
      // Use replaceState so the browser back-button still walks
      // between PROJECTS the user actually visited, not every typed
      // character of a search query. Path stays put (no hash either),
      // so deep-linking from elsewhere keeps working.
      const next = search ? `${window.location.pathname}?${search}` : window.location.pathname;
      const current = `${window.location.pathname}${window.location.search}`;
      if (next !== current) {
        window.history.replaceState(null, '', next);
      }
      saveStoredFilters(window.localStorage, filters);
    }, SEARCH_PERSIST_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [query, sortMode]);

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

  function handleImport(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input straight away so picking the same file twice in a
    // row still fires onChange. Otherwise React drops the second pick.
    e.target.value = '';
    if (!file) return;
    // Route through the preview modal — same path as the drop handler
    // — so both entry points get the cancel-before-import gate.
    setError(null);
    setPendingBundle(file);
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
    // Hand off to the preview modal; the actual POST waits for the
    // user to confirm. Cancel disposes the file (a fresh drop
    // re-opens the modal with the new selection).
    setError(null);
    setPendingBundle(file);
  }

  // Tier 3 #23: derive the visible list. Filter first, then sort. The
  // memo runs whenever the raw list, query, or sort mode change; that
  // covers every keystroke without recomputing on unrelated re-renders
  // (drag overlay toggles, modal open/close, etc.).
  const displayedProjects = useMemo(() => {
    if (!projects) return null;
    const q = query.trim().toLowerCase();
    const filtered = q
      ? projects.filter((p) => {
          const name = p.name.toLowerCase();
          if (name.includes(q)) return true;
          const customer = (p.customer || '').toLowerCase();
          if (customer.includes(q)) return true;
          const job = (p.job_number || '').toLowerCase();
          if (job.includes(q)) return true;
          return false;
        })
      : projects.slice();
    if (sortMode === 'updated') {
      // Make the default deterministic regardless of server order.
      filtered.sort(
        (a, b) =>
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
      );
    } else if (sortMode === 'due') {
      // Empty / invalid due dates land at +Infinity so they sink to the
      // bottom; ties (including the all-empty tail) break by recency so
      // the bottom block still mirrors the default sort.
      filtered.sort((a, b) => {
        const ka = parseDueKey(a.due_date);
        const kb = parseDueKey(b.due_date);
        if (ka !== kb) return ka - kb;
        return (
          new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
        );
      });
    } else {
      // 'name' — case-insensitive ascending.
      filtered.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
      );
    }
    return filtered;
  }, [projects, query, sortMode]);

  if (error && !projects) return <p className="error">{error}</p>;
  if (!projects || !tubeSpecs || !displayedProjects)
    return <p className="meta">Loading…</p>;

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
      {projects.length > 0 && (
        // Tier 3 #23: search + sort controls. Sit directly above the
        // list so the relationship is obvious and they stay below the
        // page title + import/new buttons. The <input type="search">
        // gets a built-in clear-X in most browsers; no debouncing
        // because the in-memory list is small enough to recompute on
        // every keystroke.
        <div className="project-list-controls">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by name, customer, or job number"
            aria-label="Search projects"
          />
          <label>
            Sort:{' '}
            <select
              value={sortMode}
              onChange={(e) => setSortMode(e.target.value as SortMode)}
              aria-label="Sort projects"
            >
              <option value="updated">Recently updated</option>
              <option value="due">Due date (next first)</option>
              <option value="name">Name (A–Z)</option>
            </select>
          </label>
        </div>
      )}
      {projects.length === 0 ? (
        <p className="empty">No projects yet. Create one to start.</p>
      ) : displayedProjects.length === 0 ? (
        <p className="empty">No projects match this search.</p>
      ) : (
        <ul className="project-list">
          {displayedProjects.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>
                <strong>
                  {p.name}
                  {p.customer ? ` — ${p.customer}` : ''}
                </strong>
                <span className="meta">
                  {tubeSpecById.get(p.tube_spec_id)?.name ?? `tube #${p.tube_spec_id}`}
                  {p.due_date ? ` · due ${p.due_date}` : ''}
                  {p.due_date && isOverdue(p.due_date) && (
                    <>
                      {' '}
                      <span className="badge-overdue">Overdue</span>
                    </>
                  )}
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
      {pendingBundle && (
        <BundlePreviewModal
          file={pendingBundle}
          onCancel={() => setPendingBundle(null)}
          onConfirm={(file) => {
            // Drop the modal first so the importing-state spinner on
            // the page is visible — the modal would otherwise sit on
            // top of it while the POST runs.
            setPendingBundle(null);
            void runImport(file);
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
            <NumericField
              min={0}
              max={100}
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
