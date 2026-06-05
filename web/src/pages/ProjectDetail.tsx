import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  api,
  BEND_TECHNIQUES,
  DEFAULT_CHANNEL_LETTER_DEPTH_MM,
  DEFAULT_STRIP_OVERLAP_MM,
  DEFAULT_TUBE_END_GAP_MM,
  derivedMinBendRadiusMM,
  parseReport,
  TubeSpecInUseError,
  type Asset,
  type BendTechnique,
  type CreateTubeSpecBody,
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
  // Tier 3 #33a — drag-drop image upload onto the project page.
  // Mirrors Tier 3 #22's depth-counter + pointer-events:none overlay
  // pattern from ProjectList. The toast shows "Uploaded foo.png" for
  // 4 s after a successful drop so the operator gets visual feedback
  // even when the assets list is below the fold.
  const [dragActive, setDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const [uploadToast, setUploadToast] = useState<string | null>(null);

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
    await uploadFile(file);
    e.target.value = '';
  }

  // Tier 3 #33a — shared upload entry point. The hidden file input's
  // onChange handler funnels through here, as does the drop handler
  // below. Keeping it as one function means the two entry points
  // can never drift on error handling, the uploading flag, or the
  // post-upload reload + toast.
  async function uploadFile(file: File) {
    setUploading(true);
    setError(null);
    try {
      await api.uploadAsset(projectId, file);
      await reload();
      setUploadToast(`Uploaded ${file.name}`);
      // 4 s auto-dismiss matches the existing tube-spec-edit toast so
      // the two transient banners feel consistent.
      window.setTimeout(() => setUploadToast(null), 4000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  // Tier 3 #33a — drag-drop file upload on the project page. Same
  // depth-counter pattern Tier 3 #22 uses on the project list (a child
  // dragenter would otherwise flip dragActive off mid-drag). Validation
  // is filename-extension-based (case-insensitive) — sniffing the bytes
  // would be more robust but the backend's vectorize pipeline already
  // handles the bad-mime case, and the .png/.jpg/.svg test is the same
  // contract the file picker advertises via its `accept` attribute.
  function isImageFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return (
      name.endsWith('.png') ||
      name.endsWith('.jpg') ||
      name.endsWith('.jpeg') ||
      name.endsWith('.svg')
    );
  }

  function onDragEnter(e: React.DragEvent<HTMLElement>) {
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
      // Multi-file drops aren't supported in V1 — uploading more than
      // one source image at once doesn't have an obvious flow yet
      // (which one becomes the active image for vectorize?). Surface
      // the rest as a console hint rather than silently importing
      // whichever file lands at index 0.
      console.warn(
        `Drop one image at a time; ignoring ${files.length - 1} additional file(s).`,
      );
    }
    const file = files[0];
    if (!isImageFile(file)) {
      const ext = file.name.includes('.')
        ? file.name.slice(file.name.lastIndexOf('.'))
        : '';
      setError(
        `Drop a .png / .jpg / .jpeg / .svg image. That looked like a ${ext || file.type || 'non-image file'}.`,
      );
      return;
    }
    void uploadFile(file);
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
    <section
      className={dragActive ? 'project-detail-section drag-active' : 'project-detail-section'}
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragActive && (
        // pointer-events: none is non-negotiable: without it, releasing
        // the mouse on the overlay's text won't fire `drop` on the
        // section. The styling lives in App.css under the Tier 3 #33a
        // block (mirrors the Tier 3 #22 .drop-overlay pattern).
        <div className="drop-overlay" aria-hidden="true">
          <span>Drop a PNG / JPG / SVG to upload</span>
        </div>
      )}
      {uploadToast && (
        <p className="meta upload-toast" role="status" aria-live="polite">
          {uploadToast}
        </p>
      )}
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
        {/* Tier 3 #80 — Vector-graphics "Export as…" dropdown for the
          * latest design version. Only renders when there's a version
          * available with a structured design_doc (the backend
          * gracefully 422s otherwise, but disabling the dropdown
          * upfront avoids surfacing the error to the operator).
          * DXF lives here too so the four CAM-targeted formats are
          * grouped in one menu — symmetry with the existing
          * PrintPanel that handles the human-readable PDF. */}
        {latest?.design_doc_json && (
          <ExportAsMenu projectId={projectId} versionId={latest.id} />
        )}
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
        <NewTubeSpecButton
          onCreated={async (created) => {
            // Refresh the spec list and switch the project to the
            // freshly created spec — matches the Tier 3 #51 spec's
            // "form submit → dropdown gains entry → project switches"
            // flow without a manual click on the dropdown.
            const [specs, updated] = await Promise.all([
              api.listTubeSpecs(),
              api.updateProject(projectId, { tube_spec_id: created.id }),
            ]);
            setAllSpecs(specs);
            setProject(updated);
          }}
          onError={(msg) => setError(msg)}
        />
        {' '}
        <DeleteTubeSpecButton
          spec={allSpecs.find((s) => s.id === project.tube_spec_id) ?? null}
          onDeleted={async () => {
            // The deleted spec was the project's active spec, so the
            // backend already 409'd — which is why this button is
            // disabled in that branch. We still reload defensively in
            // case another tab / process did the delete first.
            const specs = await api.listTubeSpecs();
            setAllSpecs(specs);
          }}
          onError={(msg) => setError(msg)}
        />
        {' '}
        <TubeSpecEditor
          spec={allSpecs.find((s) => s.id === project.tube_spec_id) ?? null}
          onSave={(body) => handleTubeSpecEdit(project.tube_spec_id, body)}
        />
        {' · Units: '}
        {project.units}
        {' · Created '}
        {new Date(project.created_at).toLocaleString()}
        {/* Bug #04: the production defaults are rarely touched, so tuck them
            behind a collapsed disclosure instead of crowding the header. The
            tube spec + units/created stay visible above. */}
        <details className="production-defaults">
          <summary>Production defaults</summary>
          <div className="production-defaults-body">
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
            {' · '}
            <StripOverlapField
              value={project.strip_overlap_mm}
              onSave={async (next) => {
                const updated = await api.updateProject(projectId, {
                  strip_overlap_mm: next,
                });
                setProject(updated);
              }}
              onError={(msg) => setError(msg)}
            />
            {' · '}
            <FacePerimeterStrictModeField
              value={project.face_perimeter_strict_mode}
              onSave={async (next) => {
                const updated = await api.updateProject(projectId, {
                  face_perimeter_strict_mode: next,
                });
                setProject(updated);
              }}
              onError={(msg) => setError(msg)}
            />
          </div>
        </details>
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
            {/* Phase 3 #1 — read-only 3D preview. Available on every
              * version regardless of design_doc_json (the preview falls
              * back to a placeholder if the doc fails to parse). */}
            <Link
              to={`/projects/${projectId}/versions/${latest.id}/preview`}
              className="btn-secondary"
              title="Open the read-only 3D preview for this design version"
            >
              3D preview
            </Link>
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
                <Link
                  to={`/projects/${projectId}/versions/${v.id}/preview`}
                  className="btn-secondary"
                  title={`Open the read-only 3D preview for v${v.version_no}`}
                >
                  3D preview
                </Link>
                <VersionLabelEditor
                  version={v}
                  projectId={projectId}
                  onRenamed={(updated) =>
                    setVersions((vs) =>
                      vs.map((x) => (x.id === updated.id ? updated : x)),
                    )
                  }
                  onError={(msg) => setError(msg)}
                />
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

// ExportAsMenu renders the Tier 3 #80 vector-graphics format picker
// (DXF / SVG / EPS / AI) as a native <select> that, on change,
// dispatches to a hidden <a download> click. Native <select> keeps
// keyboard accessibility free, avoids a popover state machine, and
// the format-picker is small enough that a heavyweight menu component
// would be overkill.
//
// The four entries cover the CAM-targeted vector exports. The
// human-readable PDF lives on PrintPanel below the design preview —
// kept separate because the PDF has paper / landscape / strips-only
// options that the four vector formats don't need (they're vector-
// only with no page layout).
//
// AI is documented inline as "EPS-compatible" because the true Adobe
// binary format is closed and the .ai bytes we emit are EPS — modern
// Illustrator opens them natively (the historical format converged),
// but downstream tools that strictly require the AI8 / AI9 magic-byte
// format would reject the file. Operators reading the tooltip know to
// pick SVG instead if they hit that edge case.
function ExportAsMenu({
  projectId,
  versionId,
}: {
  projectId: number;
  versionId: number;
}) {
  const linkRef = useRef<HTMLAnchorElement | null>(null);
  const [href, setHref] = useState<string>('');

  function pick(value: string) {
    if (!value) return;
    let url: string;
    switch (value) {
      case 'dxf':
        url = api.dxfURL(projectId, versionId);
        break;
      case 'svg':
        url = api.exportSVGURL(projectId, versionId);
        break;
      case 'eps':
        url = api.exportEPSURL(projectId, versionId);
        break;
      case 'ai':
        url = api.exportAIURL(projectId, versionId);
        break;
      default:
        return;
    }
    // Set the hidden <a>'s href then trigger the click. Browsers
    // respect the <a download> attribute and save the response with
    // the server-supplied filename (the handler sets a
    // content-disposition header).
    setHref(url);
    // Defer the click to the next microtask so React has flushed the
    // href update onto the DOM. setHref → click on the same synchronous
    // tick fires the click against the prior href (or empty string)
    // and the download misses.
    queueMicrotask(() => {
      linkRef.current?.click();
    });
  }

  return (
    <span className="export-as-menu" style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'baseline' }}>
      <label>
        <strong>Export as:</strong>{' '}
        <select
          defaultValue=""
          onChange={(e) => {
            const value = e.target.value;
            pick(value);
            // Reset to the placeholder so picking the same value
            // again re-triggers the download (otherwise the second
            // pick is a no-op because onChange doesn't fire when the
            // value doesn't change).
            e.target.value = '';
          }}
          title="Download the latest design version as a vector-graphics file. DXF feeds CNC tube benders; SVG/EPS/AI feed graphic-design suites (Illustrator, CorelDRAW, Inkscape)."
          aria-label="Export latest design as vector graphics"
        >
          <option value="" disabled>
            (pick format…)
          </option>
          <option value="dxf">DXF (CNC tube bender)</option>
          <option value="svg">SVG (Inkscape / Illustrator / browser)</option>
          <option value="eps">EPS (legacy graphic-design suites)</option>
          <option value="ai">AI (EPS-compatible — opens in Illustrator)</option>
        </select>
      </label>
      {/* Hidden anchor — its href is set imperatively on each pick.
        * download attribute tells the browser "save the response,
        * don't navigate"; the server-supplied
        * content-disposition: attachment header is the actual
        * filename source so we don't need to specify a name here. */}
      <a
        ref={linkRef}
        href={href}
        download=""
        style={{ display: 'none' }}
        aria-hidden="true"
      />
    </span>
  );
}

// VersionLabelEditor is the per-row rename affordance for a design version
// (Bug #05). Labels were previously settable only at save time, so versions
// piled up as "(no label)" with no way to fix them. "Rename" swaps in an
// input that commits on blur / Enter (Escape cancels); an empty value clears
// the label. The PATCH returns the updated version, which the parent splices
// back into its list.
function VersionLabelEditor({
  version,
  projectId,
  onRenamed,
  onError,
}: {
  version: DesignVersion;
  projectId: number;
  onRenamed: (updated: DesignVersion) => void;
  onError: (msg: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(version.label ?? '');
  const [busy, setBusy] = useState(false);
  const current = version.label ?? '';

  async function commit() {
    if (busy) return;
    const next = draft.trim();
    if (next === current) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const updated = await api.updateDesignVersionLabel(projectId, version.id, next);
      onRenamed(updated);
      setEditing(false);
    } catch (e) {
      onError(`Rename v${version.version_no}: ${(e as Error).message}`);
      setDraft(current);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          setDraft(current);
          setEditing(true);
        }}
        title={`Rename v${version.version_no}`}
      >
        Rename
      </button>
    );
  }

  return (
    <input
      autoFocus
      type="text"
      value={draft}
      maxLength={120}
      disabled={busy}
      placeholder="(no label)"
      aria-label={`Label for v${version.version_no}`}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setDraft(current);
          setEditing(false);
        }
      }}
    />
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

// StripOverlapField is the inline editor for the optional per-project
// strip-overlap allowance (Tier 3 #26). Same click-to-edit pattern as
// ChannelLetterDepthField, but the validation range is [0, 100] mm and
// the placeholder cites the ½ in shop default.
function StripOverlapField({
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
      if (!Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
        onError('Strip overlap: must be a number between 0 and 100 mm.');
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
      onError(`Strip overlap: ${(e as Error).message}`);
      setDraft(initialDraft);
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    const display =
      value === undefined ? `${DEFAULT_STRIP_OVERLAP_MM} (default)` : `${value}`;
    return (
      <span className="job-field">
        <strong>Strip overlap (mm):</strong>{' '}
        <button
          type="button"
          className="job-field-value"
          onClick={() => setEditing(true)}
          title="Allowance the fabricator leaves at one end of the unfolded return strip so the seam can be doubled-back welded or pop-riveted (Tier 3 #26). Drawn as a dashed shear line on the print PDF. Empty = use shop default of 12.7 mm (½ in)."
        >
          {display}
        </button>
      </span>
    );
  }

  return (
    <span className="job-field">
      <strong>Strip overlap (mm):</strong>{' '}
      <input
        autoFocus
        type="number"
        min={0}
        max={100}
        step={0.5}
        value={draft}
        disabled={busy}
        placeholder={`${DEFAULT_STRIP_OVERLAP_MM} (default)`}
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

// FacePerimeterStrictModeField is the inline checkbox toggle for the
// per-project face_perimeter_strict_mode boolean (Tier 3 #46). When
// checked, the validator escalates RuleFacePerimeterExceedsBlank from
// warning to error so the marker overlay shows red and acceptance
// flows that key off Report.HasErrors() block the design.
//
// The control intentionally lives next to the channel-letter depth /
// strip overlap fields because all three are knobs the operator twiddles
// when planning a channel-letter face — depth + overlap shape the
// return-strip emission, strict mode shapes the validation severity
// for the same construction.
function FacePerimeterStrictModeField({
  value,
  onSave,
  onError,
}: {
  value: boolean;
  onSave: (next: boolean) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <span
      className="job-field face-strict-toggle"
      title="When checked, a channel-letter face whose perimeter exceeds the standard 1168 mm blank length is flagged as an ERROR (red marker, blocks acceptance). Default: warning-level so the shop can splice through documented seams (Tier 3 #46)."
    >
      <label className="strict-mode-checkbox">
        <input
          type="checkbox"
          checked={value}
          disabled={busy}
          onChange={async (e) => {
            const next = e.target.checked;
            setBusy(true);
            try {
              await onSave(next);
            } catch (err) {
              onError(`Strict mode: ${(err as Error).message}`);
            } finally {
              setBusy(false);
            }
          }}
        />
        {' '}
        <strong>Strict mode</strong>
        <span className="meta">{' '}(face perimeter &gt; blank → error)</span>
      </label>
    </span>
  );
}

// NewTubeSpecButton renders a tiny inline form that POSTs a new tube
// spec to /api/tube_specs (Tier 3 #51). Closed by default to avoid
// crowding the project header; one click opens the four-input form
// (name + diameter + bend radius + segment length + spacing). Submit
// hands control back to the parent so it can refresh the spec list
// and switch the project to the freshly-created entry. Server errors
// (uniqueness collision, range failure) surface inline so the user
// can fix the value without scrolling up.
function NewTubeSpecButton({
  onCreated,
  onError,
}: {
  onCreated: (created: TubeSpec) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [diameter, setDiameter] = useState('12');
  const [bend, setBend] = useState('27');
  const [segment, setSegment] = useState('2500');
  const [spacing, setSpacing] = useState('14');
  const [localError, setLocalError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="btn-secondary"
        onClick={() => {
          setName('');
          setDiameter('12');
          setBend('27');
          setSegment('2500');
          setSpacing('14');
          setLocalError(null);
          setOpen(true);
        }}
        title="Add a new tube spec to the library (e.g. a custom diameter or unusual glass). Newly created specs appear in the dropdown immediately and can be edited or deleted afterward."
      >
        + New tube spec
      </button>
    );
  }

  async function commit() {
    if (busy) return;
    const trimmedName = name.trim();
    const errors: string[] = [];
    if (trimmedName === '') errors.push('Name is required.');
    const checks: { label: string; raw: string; min: number; max: number }[] = [
      { label: 'Diameter', raw: diameter, min: 5, max: 30 },
      { label: 'Min bend radius', raw: bend, min: 1, max: 200 },
      { label: 'Max segment length', raw: segment, min: 100, max: 5000 },
      { label: 'Min spacing', raw: spacing, min: 1, max: 100 },
    ];
    const parsed: Record<string, number> = {};
    for (const c of checks) {
      const n = Number(c.raw);
      if (!Number.isFinite(n)) {
        errors.push(`${c.label} must be a number.`);
        continue;
      }
      if (n < c.min || n > c.max) {
        errors.push(`${c.label} must be between ${c.min} and ${c.max}.`);
        continue;
      }
      parsed[c.label] = n;
    }
    if (
      parsed['Min bend radius'] !== undefined &&
      parsed['Diameter'] !== undefined &&
      parsed['Min bend radius'] < parsed['Diameter']
    ) {
      errors.push('Min bend radius must be at least the diameter.');
    }
    if (errors.length > 0) {
      setLocalError(errors.join(' '));
      return;
    }
    const body: CreateTubeSpecBody = {
      name: trimmedName,
      diameter_mm: parsed['Diameter'],
      min_bend_radius_mm: parsed['Min bend radius'],
      max_segment_length_mm: parsed['Max segment length'],
      min_spacing_mm: parsed['Min spacing'],
    };
    setBusy(true);
    setLocalError(null);
    try {
      const created = await api.createTubeSpec(body);
      await onCreated(created);
      setOpen(false);
    } catch (e) {
      // Server errors (409 uniqueness, 400 range, etc.) surface
      // inline so the user can edit and retry without scrolling up
      // to the page-level error banner.
      const msg = (e as Error).message;
      setLocalError(msg);
      onError(`New tube spec: ${msg}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span
      className="new-tube-spec-form"
      style={{ display: 'inline-flex', gap: '0.5rem', alignItems: 'baseline', flexWrap: 'wrap' }}
    >
      <strong>New spec:</strong>
      <label>
        name{' '}
        <input
          type="text"
          value={name}
          disabled={busy}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          style={{ width: '10rem' }}
          aria-label="new tube spec name"
        />
      </label>
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
          aria-label="new diameter mm"
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
          aria-label="new min bend radius mm"
        />
        mm
      </label>
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
          aria-label="new max segment length mm"
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
          aria-label="new min spacing mm"
        />
        mm
      </label>
      <button type="button" className="btn-secondary" onClick={commit} disabled={busy}>
        {busy ? 'Saving…' : 'Create'}
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

// DeleteTubeSpecButton renders a "Delete spec" action for the active
// tube spec. Tier 3 #51 V1 deliberately matches the server's strict
// "any-reference blocks" rule: clicking Delete on a spec that's still
// referenced by this (or any other) project surfaces a 409 with the
// referencing project names so the user knows which to migrate first.
// The button is always enabled — it's safe because the server is the
// final gate and the confirm() prompt prevents accidental clicks.
//
// V2 work could pre-flight by reading the project list and disabling
// the button until refs == 0; we defer that because the dropdown
// already shows only the active spec, so the V1 flow naturally walks
// the user through "switch → delete" anyway.
function DeleteTubeSpecButton({
  spec,
  onDeleted,
  onError,
}: {
  spec: TubeSpec | null;
  onDeleted: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!spec) return null;

  async function commit() {
    if (busy || !spec) return;
    if (
      !window.confirm(
        `Delete tube spec "${spec.name}"? This cannot be undone. Seeded specs will be re-created on a fresh database.`,
      )
    ) {
      return;
    }
    setBusy(true);
    try {
      await api.deleteTubeSpec(spec.id);
      await onDeleted();
    } catch (e) {
      if (e instanceof TubeSpecInUseError) {
        const names = e.conflict.projects.map((p) => p.name).join(', ');
        onError(
          `Tube spec "${spec.name}" is in use by ${e.conflict.project_count} project(s): ${names}. Switch them first.`,
        );
      } else {
        onError(`Delete tube spec: ${(e as Error).message}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      className="btn-secondary"
      onClick={commit}
      disabled={busy}
      title="Delete this tube spec from the library. Refused if any project still references it; switch those projects to a different spec first."
    >
      {busy ? 'Deleting…' : 'Delete spec'}
    </button>
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
  // Wall thickness + technique drafts (Tier 3 #43). Wall is a string for
  // the same controlled-input reason as the four primary fields; an empty
  // string maps to "clear" on save. Technique is the union of BendTechnique
  // | '' (the "(unset)" option clears the column).
  const [wall, setWall] = useState('');
  const [technique, setTechnique] = useState<BendTechnique | ''>('');
  // Lead-in / sharp-bend drafts (Tier 3 #41). Both stored as strings;
  // empty maps to "clear" on save (revert to derived default). The
  // validator's effective defaults are 2 × diameter for lead-in and
  // 85° for sharp-bend; the inputs surface those as inline hints when
  // the field is blank so the operator sees what the rule will use.
  const [leadIn, setLeadIn] = useState('');
  const [sharpBend, setSharpBend] = useState('');
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
          setWall(spec.wall_thickness_mm === undefined ? '' : String(spec.wall_thickness_mm));
          setTechnique(spec.bend_technique ?? '');
          setLeadIn(spec.min_lead_in_mm === undefined ? '' : String(spec.min_lead_in_mm));
          setSharpBend(
            spec.sharp_bend_angle_deg === undefined ? '' : String(spec.sharp_bend_angle_deg),
          );
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
    // Wall thickness: empty string ⇒ clear (null), otherwise parse to
    // a number in [0.1, 10.0]. Skip the field entirely when the draft
    // matches the persisted value to keep the PATCH minimal.
    const currentWall = spec.wall_thickness_mm;
    const wallTrimmed = wall.trim();
    if (wallTrimmed === '') {
      if (currentWall !== undefined) {
        body.wall_thickness_mm = null;
      }
    } else {
      const parsedWall = Number(wallTrimmed);
      if (!Number.isFinite(parsedWall)) {
        errors.push('Wall thickness must be a number.');
      } else if (parsedWall < 0.1 || parsedWall > 10.0) {
        errors.push('Wall thickness must be between 0.1 and 10.0 mm.');
      } else if (parsedWall !== currentWall) {
        body.wall_thickness_mm = parsedWall;
      }
    }
    // Technique: '' is the "(unset)" option which maps to a server-side
    // clear. Skip the field when unchanged.
    const currentTech = spec.bend_technique ?? '';
    if (technique !== currentTech) {
      body.bend_technique = technique === '' ? null : technique;
    }
    // Lead-in / sharp-bend: same three-state shape as wall_thickness_mm.
    // Empty string ⇒ clear (null) only when there's a persisted value to
    // clear; otherwise skip the field (avoids a no-op PATCH).
    const currentLeadIn = spec.min_lead_in_mm;
    const leadInTrimmed = leadIn.trim();
    if (leadInTrimmed === '') {
      if (currentLeadIn !== undefined) {
        body.min_lead_in_mm = null;
      }
    } else {
      const parsedLeadIn = Number(leadInTrimmed);
      if (!Number.isFinite(parsedLeadIn)) {
        errors.push('Min lead-in must be a number.');
      } else if (parsedLeadIn < 0 || parsedLeadIn > 50) {
        errors.push('Min lead-in must be between 0 and 50 mm.');
      } else if (parsedLeadIn !== currentLeadIn) {
        body.min_lead_in_mm = parsedLeadIn;
      }
    }
    const currentSharpBend = spec.sharp_bend_angle_deg;
    const sharpBendTrimmed = sharpBend.trim();
    if (sharpBendTrimmed === '') {
      if (currentSharpBend !== undefined) {
        body.sharp_bend_angle_deg = null;
      }
    } else {
      const parsedSharpBend = Number(sharpBendTrimmed);
      if (!Number.isFinite(parsedSharpBend)) {
        errors.push('Sharp bend angle must be a number.');
      } else if (parsedSharpBend < 0 || parsedSharpBend > 90) {
        errors.push('Sharp bend angle must be between 0 and 90 degrees.');
      } else if (parsedSharpBend !== currentSharpBend) {
        body.sharp_bend_angle_deg = parsedSharpBend;
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
        diameterDraft={diameter}
        wallDraft={wall}
        onWallChange={setWall}
        techniqueDraft={technique}
        onTechniqueChange={setTechnique}
        onUseDerived={(r) => setBend(r.toFixed(1))}
        busy={busy}
      />
      <LeadInSharpBendFields
        diameterDraft={diameter}
        leadInDraft={leadIn}
        onLeadInChange={setLeadIn}
        sharpBendDraft={sharpBend}
        onSharpBendChange={setSharpBend}
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

// BendDerivationFields renders the editable wall_thickness_mm number
// input + bend_technique dropdown alongside a live "Derived: NN.N mm"
// indicator computed from the diameter, wall, and technique drafts the
// user is currently editing. The "Use derived" button copies that radius
// into the manual `bend` input so the operator can review it before
// saving — the persisted min_bend_radius_mm is still the manual override.
//
// Tier 3 #31 added the columns + derivation; Tier 3 #43 promoted these
// fields from read-only display to editable. Drafts live in the parent
// TubeSpecEditor so the existing dirty-tracking + auto-save pattern
// applies uniformly across all six dimensional fields.
function BendDerivationFields({
  diameterDraft,
  wallDraft,
  onWallChange,
  techniqueDraft,
  onTechniqueChange,
  onUseDerived,
  busy,
}: {
  diameterDraft: string;
  wallDraft: string;
  onWallChange: (next: string) => void;
  techniqueDraft: BendTechnique | '';
  onTechniqueChange: (next: BendTechnique | '') => void;
  onUseDerived: (radiusMM: number) => void;
  busy: boolean;
}) {
  const liveDiameter = Number(diameterDraft);
  const D = Number.isFinite(liveDiameter) && liveDiameter > 0 ? liveDiameter : 0;
  const wallNum = Number(wallDraft);
  const wallForCalc = wallDraft.trim() !== '' && Number.isFinite(wallNum) ? wallNum : undefined;
  const techForCalc = techniqueDraft === '' ? undefined : techniqueDraft;
  const derived = derivedMinBendRadiusMM(D, wallForCalc, techForCalc);
  const derivedSourceTitle =
    wallForCalc !== undefined && techForCalc
      ? `K * D² / t = ${
          techForCalc === 'ribbon' ? '0.20' : techForCalc === 'crossfire' ? '0.225' : '0.275'
        } * ${D}² / ${wallForCalc.toFixed(2)} = ${derived.toFixed(2)} mm`
      : `Diameter-only fall-back: 2.25 * D = ${derived.toFixed(2)} mm. Set wall thickness and technique for a tighter derivation.`;
  return (
    <span
      style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      title="Wall-thinning bend-radius derivation inputs (Tier 3 #31, editable per Tier 3 #43)."
    >
      <label>
        wall{' '}
        <input
          type="number"
          step={0.05}
          min={0.1}
          max={10.0}
          value={wallDraft}
          disabled={busy}
          onChange={(e) => onWallChange(e.target.value)}
          placeholder="(unset)"
          style={{ width: '5rem' }}
          aria-label="wall thickness mm"
        />
        mm
      </label>
      <label>
        technique{' '}
        <select
          value={techniqueDraft}
          disabled={busy}
          onChange={(e) => onTechniqueChange(e.target.value as BendTechnique | '')}
          aria-label="bend technique"
        >
          <option value="">(unset)</option>
          {BEND_TECHNIQUES.map((t) => (
            <option key={t.value} value={t.value}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
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

// LeadInSharpBendFields renders the editable min_lead_in_mm + sharp-
// bend angle inputs alongside an inline "(default: NN)" hint when the
// field is empty so the operator can see what the validator will fall
// back to. The lead-in default tracks the diameter draft (2 × D, per
// internal/validate/rules.go's effectiveMinLeadInMM) so the hint stays
// accurate as the user retypes the diameter; the sharp-bend default is
// the trade-standard 85° threshold (effectiveSharpBendAngleDeg).
//
// Drafts live in the parent TubeSpecEditor so the existing dirty-
// tracking + commit / auto-save pattern applies uniformly. Tier 3 #41
// added the editor inputs; the columns themselves were added in
// migration 0009 and the validator already consults them.
function LeadInSharpBendFields({
  diameterDraft,
  leadInDraft,
  onLeadInChange,
  sharpBendDraft,
  onSharpBendChange,
  busy,
}: {
  diameterDraft: string;
  leadInDraft: string;
  onLeadInChange: (next: string) => void;
  sharpBendDraft: string;
  onSharpBendChange: (next: string) => void;
  busy: boolean;
}) {
  const liveDiameter = Number(diameterDraft);
  const D = Number.isFinite(liveDiameter) && liveDiameter > 0 ? liveDiameter : 0;
  const leadInDefaultMM = D > 0 ? 2 * D : 0;
  const leadInHint =
    leadInDraft.trim() === '' && leadInDefaultMM > 0
      ? `(default: ${leadInDefaultMM.toFixed(1)} mm)`
      : '';
  const sharpBendHint = sharpBendDraft.trim() === '' ? '(default: 85°)' : '';
  return (
    <span
      style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'baseline', flexWrap: 'wrap' }}
      title="Per-spec lead-in / sharp-bend overrides (Tier 3 #41). Leave blank to fall back to the validator's derived defaults (2 × diameter for lead-in, 85° for sharp-bend)."
    >
      <label>
        lead-in{' '}
        <input
          type="number"
          step={0.5}
          min={0}
          max={50}
          value={leadInDraft}
          disabled={busy}
          onChange={(e) => onLeadInChange(e.target.value)}
          placeholder="(unset)"
          style={{ width: '5rem' }}
          aria-label="min lead-in mm"
        />
        mm
        {leadInHint && (
          <span style={{ opacity: 0.6, marginLeft: '0.25rem' }}>{leadInHint}</span>
        )}
      </label>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || leadInDraft.trim() === ''}
        onClick={() => onLeadInChange('')}
        title="Clear the per-spec lead-in override (revert to derived 2 × diameter default)."
      >
        Clear
      </button>
      <label>
        sharp bend{' '}
        <input
          type="number"
          step={1}
          min={0}
          max={90}
          value={sharpBendDraft}
          disabled={busy}
          onChange={(e) => onSharpBendChange(e.target.value)}
          placeholder="(unset)"
          style={{ width: '5rem' }}
          aria-label="sharp bend angle deg"
        />
        °
        {sharpBendHint && (
          <span style={{ opacity: 0.6, marginLeft: '0.25rem' }}>{sharpBendHint}</span>
        )}
      </label>
      <button
        type="button"
        className="btn-secondary"
        disabled={busy || sharpBendDraft.trim() === ''}
        onClick={() => onSharpBendChange('')}
        title="Clear the per-spec sharp-bend override (revert to 85° default)."
      >
        Clear
      </button>
    </span>
  );
}

