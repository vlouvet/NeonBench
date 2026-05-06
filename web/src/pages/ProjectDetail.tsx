import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, parseReport, type Asset, type DesignVersion, type Project, type TubeSpec } from '../api';
import VectorizePanel from '../components/VectorizePanel';
import ValidationReportView from '../components/ValidationReportView';
import PrintPanel from '../components/PrintPanel';

export default function ProjectDetail() {
  const { id } = useParams();
  const projectId = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [tubeSpec, setTubeSpec] = useState<TubeSpec | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [versions, setVersions] = useState<DesignVersion[]>([]);
  const [latest, setLatest] = useState<DesignVersion | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [revalidating, setRevalidating] = useState(false);

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
      setTubeSpec(specs.find((s) => s.id === p.tube_spec_id) ?? null);
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
      <h1>{project.name}</h1>
      <p className="meta">
        Tube spec:{' '}
        {tubeSpec
          ? `${tubeSpec.name} (Ø ${tubeSpec.diameter_mm}mm, min bend ${tubeSpec.min_bend_radius_mm}mm)`
          : `#${project.tube_spec_id}`}
        {' · Units: '}
        {project.units}
        {' · Created '}
        {new Date(project.created_at).toLocaleString()}
      </p>

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
          <h2>
            Design v{latest.version_no}
            {latest.label ? ` — ${latest.label}` : ''}
          </h2>
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
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
