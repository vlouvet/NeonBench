import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  DEFAULT_CHANNEL_LETTER_DEPTH_MM,
  DEFAULT_TUBE_END_GAP_MM,
  parseReport,
  type Asset,
  type DesignVersion,
  type Project,
  type TubeSpec,
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

  const load = useCallback(async () => {
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
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setError(null);
    try {
      await api.uploadAsset(projectId, file);
      await load();
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

