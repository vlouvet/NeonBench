import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  DEFAULT_CHANNEL_LETTER_DEPTH_MM,
  DEFAULT_TUBE_END_GAP_MM,
  derivedMinBendRadiusMM,
  parseReport,
  type Asset,
  type BendTechnique,
  type DesignVersion,
  type Project,
  type TubeSpec,
  type UpdateTubeSpecBody,
} from '../api';
import VectorizePanel from '../components/VectorizePanel';
import ValidationReportView from '../components/ValidationReportView';
import PrintPanel from '../components/PrintPanel';
import { humanizeDueDate, isOverdue } from '../lib/dueDate';

export default function ProjectDetail() {
  const { id } = useParams();
  const projectId = Number(id);
  const navigate = useNavigate();
  const [project, setProject] = useState<Project | null>(null);
  const [allSpecs, setAllSpecs] = useState<TubeSpec[]>([]);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [latest, setLatest] = useState<DesignVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);
  const [creatingBlank, setCreatingBlank] = useState(false);
  // Transient banner shown after a tube-spec edit fans out validation
  // across every affected design version. Auto-clears on a 4-second
  // timer (set in handleTubeSpecEdit). Tier 3 #18.
  const [tubeSpecToast, setTubeSpecToast] = useState<string | null>(null);

  async function startBlankDesign() {
    if (creatingBlank) return;
    setCreatingBlank(true);
    setError(null);
    try {
      const dv = await api.createBlankDesignVersion(projectId);
      navigate(`/projects/${projectId}/edit/${dv.id}`);
    } catch (e) {
      setError(`start blank design: ${(e as Error).message}`);
    } finally {
      setCreatingBlank(false);
    }
  }

  // Load (or reload) the page's data. Used by handleUpload and other
  // handlers that need to refresh after a mutation. The mount / projectId
  // effect below has its own cancellable copy so a stale request from a
  // previous projectId can't race with the current one — calling this
  // function directly skips that guard, which is fine because the
  // handlers are user-driven (one in flight at a time).
  async function reload() {
    try {
      const [p, a, specs, vs, lat] = await Promise.all([
        api.getProject(projectId),
        api.listAssets(projectId),
        api.listTubeSpecs(),
        api.listDesignVersions(projectId),
        api.latestDesignVersion(projectId),
      ]);
      setProject(p);
      setAssets(a);
      setAllSpecs(specs);
      setVersions(vs);
      setLatest(lat);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // Initial load + reload-on-projectId-change. Folded inline in the effect
  // (rather than calling reload()) so the cancelled flag can suppress a
  // stale Promise resolving after the user navigates to a different
  // project — that would otherwise call setState on an unmounted /
  // re-keyed component.
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.getProject(projectId),
      api.listAssets(projectId),
      api.listTubeSpecs(),
      api.listDesignVersions(projectId),
      api.latestDesignVersion(projectId),
    ])
      .then(([p, a, specs, vs, lat]) => {
        if (cancelled) return;
        setProject(p);
        setAssets(a);
        setAllSpecs(specs);
        setVersions(vs);
        setLatest(lat);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setError((e as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadAsset(projectId, file);
      await reload();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  }

  async function showVersion(v: DesignVersion) {
    if (v.svg_data) {
      setLatest(v);
      return;
    }
    try {
      const full = await api.getDesignVersion(projectId, v.id);
      setLatest(full);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function handleDeleteVersion(v: DesignVersion) {
    if (!window.confirm(`Delete v${v.version_no} permanently? This cannot be undone.`)) {
      return;
    }
    try {
      await api.deleteDesignVersion(projectId, v.id);
      const vs = await api.listDesignVersions(projectId);
      setVersions(vs);
      if (latest?.id === v.id) {
        if (vs.length === 0) {
          setLatest(null);
        } else {
          const fresh = await api.latestDesignVersion(projectId);
          setLatest(fresh);
        }
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // handleTubeSpecEdit pushes a partial PATCH to /api/tube_specs/{id}
  // and surfaces the server's fan-out summary as a transient banner.
  // The fan-out itself is server-side: every design version in every
  // project that references this spec is re-validated atomically, so
  // older versions in the history list reflect the new spec without a
  // manual click. After a successful PATCH we re-fetch the spec list,
  // any version reports that may have been refreshed, and the active
  // version so the on-screen badges update too. Tier 3 #18.
  async function handleTubeSpecEdit(specID: number, body: UpdateTubeSpecBody) {
    try {
      const out = await api.updateTubeSpec(specID, body);
      // Refresh derived state: the spec list (so the dropdown's
      // labels show the new diameter/limit), the current project's
      // active version (so its validation badges update), and the
      // version history list (so older rows reflect their new
      // reports the moment the user clicks them).
      const [specs, vs, lat] = await Promise.all([
        api.listTubeSpecs(),
        api.listDesignVersions(projectId),
        api.latestDesignVersion(projectId),
      ]);
      setAllSpecs(specs);
      setVersions(vs);
      // If we have an active version on screen, swap it for the
      // freshly-validated copy. The fan-out has already updated the
      // stored validation_report_json server-side; re-fetching is
      // the simplest way to pick that up.
      if (latest) {
        if (lat && lat.id === latest.id) {
          setLatest(lat);
        } else {
          try {
            const refreshed = await api.getDesignVersion(projectId, latest.id);
            setLatest(refreshed);
          } catch {
            // If the active version is no longer reachable (e.g.
            // it was deleted in another tab), keep the existing
            // copy on screen rather than blanking the panel.
          }
        }
      }
      const { project_count, version_count, failed_count } = out.revalidated;
      if (version_count > 0) {
        let msg = `Re-validated ${version_count} version${version_count === 1 ? '' : 's'} across ${project_count} project${project_count === 1 ? '' : 's'}.`;
        if (failed_count > 0) {
          msg += ` ${failed_count} skipped (corrupt SVG).`;
        }
        setTubeSpecToast(msg);
        // Auto-dismiss the banner. The 4 s window matches the spec's
        // "transient" requirement and is long enough to read at a
        // glance without burying the editor.
        window.setTimeout(() => setTubeSpecToast(null), 4000);
      } else if (project_count > 0 && failed_count > 0) {
        // Edge case: every affected version was unparseable. Surface
        // the failure so the operator notices instead of assuming a
        // silent success.
        setTubeSpecToast(`Spec saved, but ${failed_count} version${failed_count === 1 ? '' : 's'} could not be re-validated (corrupt SVG).`);
        window.setTimeout(() => setTubeSpecToast(null), 4000);
      }
    } catch (e) {
      setError(`Tube spec edit: ${(e as Error).message}`);
    }
  }

  if (error) return <p className="error">{error}</p>;
  if (!project) return <p className="meta">Loading…</p>;

  const sourceAssets = assets.filter((a) => a.kind === 'source_image');
  const mostRecentSource = sourceAssets[0];
  const isSVG = mostRecentSource?.mime === 'image/svg+xml';

  return (
    <section>
      <p>
        <Link to="/">&larr; All projects</Link>
      </p>
      <div className="row" style={{ alignItems: 'baseline', gap: '1rem' }}>
        <h1>{project.name}</h1>
        {project.due_date && (
          <span className="meta" title="Due date for this project">
            Due {humanizeDueDate(project.due_date)}
            {isOverdue(project.due_date) && (
              <>
                {' '}
                <span className="badge-overdue">Overdue</span>
              </>
            )}
          </span>
        )}
        <button
          type="button"
          className="btn-secondary"
          onClick={startBlankDesign}
          disabled={creatingBlank}
          title="Open the editor with an empty 1000×500mm canvas. Use the pen, rect, circle, arc, and Add text tools to draw a design from scratch."
        >
          {creatingBlank ? 'Creating…' : 'New blank design'}
        </button>
        <a
          href={api.exportBundleURL(projectId)}
          className="btn-secondary"
          download
          title="Download a portable .neonbench archive of this project (all design versions, SVG + design doc + validation report, plus a manifest)"
        >
          Export bundle
        </a>
      </div>
      {tubeSpecToast && (
        <p className="meta" role="status" aria-live="polite">
          {tubeSpecToast}
        </p>
      )}
      <div className="meta project-settings">
        <label>
          Tube spec:{' '}
          <select
            value={project.tube_spec_id}
            onChange={async (e) => {
              const next = Number(e.target.value);
              try {
                const updated = await api.updateProject(projectId, { tube_spec_id: next });
                setProject(updated);
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            {allSpecs.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name} — Ø{s.diameter_mm}mm, min bend {s.min_bend_radius_mm}mm
              </option>
            ))}
          </select>
        </label>
        {' '}
        <TubeSpecEditor
          spec={allSpecs.find((s) => s.id === project.tube_spec_id) ?? null}
          onSave={(body) => handleTubeSpecEdit(project.tube_spec_id, body)}
        />
        {' · '}
        <TubeEndGapField
          value={project.tube_end_gap_mm}
          onSave={async (next) => {
            const updated = await api.updateProject(projectId, { tube_end_gap_mm: next });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        {' · '}
        <ChannelLetterDepthField
          value={project.channel_letter_depth_mm}
          onSave={async (next) => {
            const updated = await api.updateProject(projectId, {
              channel_letter_depth_mm: next,
            });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        {' · Units: '}
        {project.units}
        {' · Created '}
        {new Date(project.created_at).toLocaleString()}
      </div>
      <div className="meta project-settings job-fields">
        <ProjectMetaField
          label="Customer"
          value={project.customer}
          maxLength={200}
          placeholder="(none)"
          onSave={async (v) => {
            const updated = await api.updateProject(projectId, { customer: v });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        <ProjectMetaField
          label="Designer"
          value={project.designer}
          maxLength={100}
          placeholder="(none)"
          onSave={async (v) => {
            const updated = await api.updateProject(projectId, { designer: v });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        <ProjectMetaField
          label="Due date"
          value={project.due_date}
          inputType="date"
          placeholder="(none)"
          onSave={async (v) => {
            const updated = await api.updateProject(projectId, { due_date: v });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        <ProjectMetaField
          label="Job number"
          value={project.job_number}
          maxLength={50}
          placeholder="(none)"
          onSave={async (v) => {
            const updated = await api.updateProject(projectId, { job_number: v });
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
      </div>

      <h2>Source image</h2>
      {sourceAssets.length === 0 ? (
        <p className="empty">No source image yet. Upload a PNG, JPG, or SVG to start.</p>
      ) : (
        <ul className="asset-list">
          {sourceAssets.map((a) => (
            <li key={a.id}>
              <img
                src={api.assetURL(projectId, a.id)}
                alt={a.filename}
                className="asset-thumb"
              />
              <span className="meta">
                {a.mime} · {(a.size_bytes / 1024).toFixed(1)} KB ·{' '}
                {new Date(a.created_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <label className="upload">
        <input
          type="file"
          accept="image/png,image/jpeg,image/svg+xml,.png,.jpg,.jpeg,.svg"
          onChange={handleUpload}
          disabled={uploading}
        />
        {uploading ? 'Uploading…' : 'Upload image (PNG, JPG, or SVG)'}
      </label>

      {mostRecentSource && (
        <VectorizePanel
          projectId={projectId}
          assetId={mostRecentSource.id}
          isSVG={isSVG}
          onCreated={async (dv) => {
            setLatest(dv);
            const vs = await api.listDesignVersions(projectId);
            setVersions(vs);
          }}
        />
      )}

      {latest && (
        <>
          <div className="row">
            <h2>
              Design v{latest.version_no}
              {latest.label ? ` — ${latest.label}` : ''}
            </h2>
            {latest.design_doc_json && (
              <Link to={`/projects/${projectId}/edit/${latest.id}`} className="btn-secondary">
                Open in editor
              </Link>
            )}
          </div>
          <div
            className="svg-preview"
            dangerouslySetInnerHTML={{ __html: latest.svg_data }}
          />
          {parseReport(latest) && (
            <ValidationReportView
              report={parseReport(latest)!}
              revalidating={revalidating}
              onRevalidate={async () => {
                setRevalidating(true);
                try {
                  const updated = await api.revalidate(projectId, latest.id);
                  setLatest(updated);
                } catch (e) {
                  setError((e as Error).message);
                } finally {
                  setRevalidating(false);
                }
              }}
            />
          )}
          <PrintPanel
            projectId={projectId}
            versionId={latest.id}
            report={parseReport(latest)}
          />
        </>
      )}

      {versions.length > 0 && (
        <>
          <h2>Versions</h2>
          <ul className="version-list">
            {versions.map((v) => (
              <li key={v.id}>
                <button
                  type="button"
                  className={`version-row ${latest?.id === v.id ? 'active' : ''}`}
                  onClick={() => showVersion(v)}
                >
                  <strong>v{v.version_no}</strong>
                  <span>{v.label || '(no label)'}</span>
                  <span className="meta">{new Date(v.created_at).toLocaleString()}</span>
                </button>
                <button
                  type="button"
                  className="btn-danger"
                  onClick={() => handleDeleteVersion(v)}
                  title={`Delete v${v.version_no} permanently`}
                >
                  Delete
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ProjectMetaField is a small inline editor for the four optional Job
// Manager fields. The visible label + value behave like a "click to edit"
// affordance: pressing the value swaps it for an input, and the input
// commits on blur or Enter (Escape cancels). The save call only fires if
// the value actually changed; an HTTP error rolls the input back to the
// last server-acknowledged value.
function ProjectMetaField({
  label,
  value,
  placeholder,
  maxLength,
  inputType = 'text',
  onSave,
  onError,
}: {
  label: string;
  value: string;
  placeholder: string;
  maxLength?: number;
  inputType?: 'text' | 'date';
  onSave: (next: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  // React's "reset state from props" idiom: stash the prop's last seen
  // value, and if it changes while we're not editing, snap the draft to
  // it. Avoids the setState-in-effect lint and the extra render that
  // would come with it.
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue && !editing) {
    setLastValue(value);
    setDraft(value);
  }

  async function commit() {
    if (busy) return;
    const next = inputType === 'date' ? draft : draft.trim();
    if (next === value) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      onError(`${label}: ${(e as Error).message}`);
      setDraft(value);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <span className="job-field">
        <strong>{label}:</strong>{' '}
        <button
          type="button"
          className="job-field-value"
          onClick={() => setEditing(true)}
          title={`Edit ${label.toLowerCase()}`}
        >
          {value || <em>{placeholder}</em>}
        </button>
      </span>
    );
  }

  return (
    <span className="job-field">
      <strong>{label}:</strong>{' '}
      <input
        autoFocus
        type={inputType}
        value={draft}
        maxLength={maxLength}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(value);
            setEditing(false);
          }
        }}
      />
    </span>
  );
}

// TubeEndGapField is the inline editor for the optional per-project
// tube-end-gap setting (NW #135). The display shows either the
// project's explicit value or the shop default flagged with "(default)"
// so the bender always sees the active target. Editing is the same
// click-to-edit pattern as ProjectMetaField, but the storage shape is
// number-or-null instead of string-or-empty:
//   - empty input on commit → null on the wire (clear the override).
//   - any in-range number → that number on the wire.
//   - parse failure or out-of-range → onError + revert (no PATCH).
function TubeEndGapField({
  value,
  onSave,
  onError,
}: {
  value: number | undefined;
  onSave: (next: number | null) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const initialDraft = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  // Snap the draft to the latest server-acknowledged value when it
  // changes outside our control (e.g. another field's PATCH refreshes
  // the project).
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue && !editing) {
    setLastValue(value);
    setDraft(value === undefined ? '' : String(value));
  }

  async function commit() {
    if (busy) return;
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === '') {
      next = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        onError('Tube end gap: must be a number between 0 and 100 mm.');
        setDraft(initialDraft);
        setEditing(false);
        return;
      }
      next = parsed;
    }
    if (next === (value ?? null)) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      onError(`Tube end gap: ${(e as Error).message}`);
      setDraft(initialDraft);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const display =
      value === undefined ? `${DEFAULT_TUBE_END_GAP_MM} (default)` : `${value}`;
    return (
      <span className="job-field">
        <strong>Tube end gap (mm):</strong>{' '}
        <button
          type="button"
          className="job-field-value"
          onClick={() => setEditing(true)}
          title="Distance from the tube's actual endpoint to the inside edge of the channel letter or substrate (NW #135). Empty = use shop default of 6.35 mm (¼ in)."
        >
          {display}
        </button>
      </span>
    );
  }

  return (
    <span className="job-field">
      <strong>Tube end gap (mm):</strong>{' '}
      <input
        autoFocus
        type="number"
        min={0}
        max={100}
        step={0.05}
        value={draft}
        disabled={busy}
        placeholder={`${DEFAULT_TUBE_END_GAP_MM} (default)`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(initialDraft);
            setEditing(false);
          }
        }}
      />
    </span>
  );
}

// ChannelLetterDepthField is the inline editor for the optional
// per-project channel-letter depth setting (NW #106). The display
// shows either the project's explicit value or the shop default
// flagged with "(default)" so the operator always sees the active
// target. Same click-to-edit pattern as TubeEndGapField, but the
// validation range is [10, 500] mm instead of [0, 100].
function ChannelLetterDepthField({
  value,
  onSave,
  onError,
}: {
  value: number | undefined;
  onSave: (next: number | null) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const initialDraft = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue && !editing) {
    setLastValue(value);
    setDraft(value === undefined ? '' : String(value));
  }

  async function commit() {
    if (busy) return;
    const trimmed = draft.trim();
    let next: number | null;
    if (trimmed === '') {
      next = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || parsed < 10 || parsed > 500) {
        onError('Channel letter depth: must be a number between 10 and 500 mm.');
        setDraft(initialDraft);
        setEditing(false);
        return;
      }
      next = parsed;
    }
    if (next === (value ?? null)) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      await onSave(next);
      setEditing(false);
    } catch (e) {
      onError(`Channel letter depth: ${(e as Error).message}`);
      setDraft(initialDraft);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const display =
      value === undefined
        ? `${DEFAULT_CHANNEL_LETTER_DEPTH_MM} (default)`
        : `${value}`;
    return (
      <span className="job-field">
        <strong>Channel letter depth (mm):</strong>{' '}
        <button
          type="button"
          className="job-field-value"
          onClick={() => setEditing(true)}
          title="Height of the U-channel sheet-metal box around each face (NW #106). Drives the height of the unfolded return-strip page on the print PDF. Empty = use shop default of 100 mm (≈ 4 in)."
        >
          {display}
        </button>
      </span>
    );
  }

  return (
    <span className="job-field">
      <strong>Channel letter depth (mm):</strong>{' '}
      <input
        autoFocus
        type="number"
        min={10}
        max={500}
        step={1}
        value={draft}
        disabled={busy}
        placeholder={`${DEFAULT_CHANNEL_LETTER_DEPTH_MM} (default)`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setDraft(initialDraft);
            setEditing(false);
          }
        }}
      />
    </span>
  );
}

// TubeSpecEditor is the inline form for editing the active tube spec's
// dimensional fields (diameter, min_bend_radius, max_segment_length,
// min_spacing). Saving fans validation out across every design version
// in every project that uses this spec — Tier 3 #18. The button stays
// dormant until the user clicks "Edit spec"; the form pre-fills from
// the current row, validates client-side mostly to mirror the server's
// 400s, and only PATCHes fields whose value actually changed.
function TubeSpecEditor({
  spec,
  onSave,
}: {
  spec: TubeSpec | null;
  onSave: (body: UpdateTubeSpecBody) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Drafts mirror the spec's four primary numerical fields. Stored as
  // strings so the user can briefly hold an empty input mid-typing
  // without React forcing a NaN through the controlled-input contract.
  const [diameter, setDiameter] = useState('');
  const [bend, setBend] = useState('');
  const [segment, setSegment] = useState('');
  const [spacing, setSpacing] = useState('');
  const [localError, setLocalError] = useState<string | null>(null);

  if (!spec) {
    return null;
  }

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          setDiameter(String(spec.diameter_mm));
          setBend(String(spec.min_bend_radius_mm));
          setSegment(String(spec.max_segment_length_mm));
          setSpacing(String(spec.min_spacing_mm));
          setLocalError(null);
          setOpen(true);
        }}
        title="Edit this tube spec's diameter, bend radius, and segment limits. Saving will re-validate every design version that uses this spec."
      >
        Edit spec
      </button>
    );
  }

  async function commit() {
    if (busy || !spec) return;
    // Build a partial PATCH containing only fields the user actually
    // changed. Sending an unchanged value is harmless on the server
    // but dirties the diff for nothing — the fan-out still runs the
    // same way either way.
    const body: UpdateTubeSpecBody = {};
    const errors: string[] = [];
    const checks: Array<{
      label: string;
      raw: string;
      current: number;
      min: number;
      max: number;
      key: keyof UpdateTubeSpecBody;
    }> = [
      { label: 'Diameter', raw: diameter, current: spec.diameter_mm, min: 5, max: 30, key: 'diameter_mm' },
      { label: 'Min bend radius', raw: bend, current: spec.min_bend_radius_mm, min: 1, max: 200, key: 'min_bend_radius_mm' },
      { label: 'Max segment length', raw: segment, current: spec.max_segment_length_mm, min: 100, max: 5000, key: 'max_segment_length_mm' },
      { label: 'Min spacing', raw: spacing, current: spec.min_spacing_mm, min: 1, max: 100, key: 'min_spacing_mm' },
    ];
    for (const c of checks) {
      const parsed = Number(c.raw);
      if (!Number.isFinite(parsed)) {
        errors.push(`${c.label} must be a number.`);
        continue;
      }
      if (parsed < c.min || parsed > c.max) {
        errors.push(`${c.label} must be between ${c.min} and ${c.max}.`);
        continue;
      }
      if (parsed !== c.current) {
        // The cast is safe: every key in the table maps to a numeric
        // field on UpdateTubeSpecBody.
        (body as Record<string, number>)[c.key] = parsed;
      }
    }
    if (errors.length > 0) {
      setLocalError(errors.join(' '));
      return;
    }
    if (Object.keys(body).length === 0) {
      setOpen(false);
      return;
    }
    if (
      body.min_bend_radius_mm !== undefined &&
      body.diameter_mm !== undefined &&
      body.min_bend_radius_mm < body.diameter_mm
    ) {
      setLocalError('Min bend radius must be at least the diameter.');
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await onSave(body);
      setOpen(false);
    } catch (e) {
      setLocalError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className="tube-spec-editor"
      style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
    >
      <strong>Spec:</strong>
      <label>
        Ø{' '}
        <input
          type="number"
          step={0.1}
          min={5}
          max={30}
          value={diameter}
          disabled={busy}
          onChange={(e) => setDiameter(e.target.value)}
          style={{ width: '5rem' }}
          aria-label="diameter mm"
        />
        mm
      </label>
      <label>
        bend{' '}
        <input
          type="number"
          step={0.5}
          min={1}
          max={200}
          value={bend}
          disabled={busy}
          onChange={(e) => setBend(e.target.value)}
          style={{ width: '5rem' }}
          aria-label="min bend radius mm"
        />
        mm
      </label>
      <BendDerivationFields
        spec={spec}
        diameterDraft={diameter}
        onUseDerived={(r) => setBend(r.toFixed(1))}
        busy={busy}
      />

      <label>
        seg{' '}
        <input
          type="number"
          step={10}
          min={100}
          max={5000}
          value={segment}
          disabled={busy}
          onChange={(e) => setSegment(e.target.value)}
          style={{ width: '5rem' }}
          aria-label="max segment length mm"
        />
        mm
      </label>
      <label>
        spacing{' '}
        <input
          type="number"
          step={0.5}
          min={1}
          max={100}
          value={spacing}
          disabled={busy}
          onChange={(e) => setSpacing(e.target.value)}
          style={{ width: '5rem' }}
          aria-label="min spacing mm"
        />
        mm
      </label>
      <button type="button" className="btn-secondary" onClick={commit} disabled={busy}>
        {busy ? 'Saving…' : 'Save spec'}
      </button>
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setLocalError(null);
        }}
        disabled={busy}
      >
        Cancel
      </button>
      {localError && <span className="error">{localError}</span>}
    </span>
  );
}

// BendDerivationFields surfaces the spec's wall_thickness_mm and
// bend_technique metadata alongside a live "Derived: NN.N mm" indicator
// computed from the diameter the user is currently editing. The "Use
// derived" button populates the manual `bend` input so the operator can
// review the value before saving — this preserves the existing PATCH
// semantics (the manual override is what gets persisted) while making
// the wall-thinning derivation visible in the UI.
//
// Tier 3 #31. The wall-thickness and technique fields are display-only
// in this PR — they're seeded by migration 0010 and will become
// editable in a follow-up that extends the PATCH /api/tube_specs/{id}
// route. See follow-ups in the PR body for tracking.
function BendDerivationFields({
  spec,
  diameterDraft,
  onUseDerived,
  busy,
}: {
  spec: TubeSpec;
  diameterDraft: string;
  onUseDerived: (radiusMM: number) => void;
  busy: boolean;
}) {
  const liveDiameter = Number(diameterDraft);
  const D = Number.isFinite(liveDiameter) && liveDiameter > 0 ? liveDiameter : spec.diameter_mm;
  const wall = spec.wall_thickness_mm;
  const technique = spec.bend_technique as BendTechnique | undefined;
  const derived = derivedMinBendRadiusMM(D, wall, technique);
  const wallLabel = wall === undefined ? '(unset)' : `${wall.toFixed(2)} mm`;
  const techLabel = technique ?? '(unset)';
  const derivedSourceTitle =
    wall !== undefined && technique
      ? `K * D² / t = ${
          technique === 'ribbon' ? '0.20' : technique === 'crossfire' ? '0.225' : '0.275'
        } * ${D}² / ${wall.toFixed(2)} = ${derived.toFixed(2)} mm`
      : `Diameter-only fall-back: 2.25 * D = ${derived.toFixed(2)} mm. Add wall thickness + technique to the spec for a tighter derivation.`;
  return (
    <span
      style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      title="Inputs to the wall-thinning bend-radius derivation (Tier 3 #31). Saved by migration; PATCH support coming in a follow-up."
    >
      <span style={{ opacity: 0.75 }}>
        wall <strong>{wallLabel}</strong>, technique <strong>{techLabel}</strong>
      </span>
      <span style={{ opacity: 0.75 }} title={derivedSourceTitle}>
        derived <strong>{derived > 0 ? `${derived.toFixed(1)} mm` : '—'}</strong>
      </span>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || derived <= 0}
        onClick={() => {
          if (derived > 0) onUseDerived(derived);
        }}
        title="Copy the derived radius into the bend field above. Review and click Save spec to persist."
      >
        Use derived
      </button>
    </span>
  );
}

