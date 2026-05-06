import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, type Asset, type Project, type TubeSpec } from '../api';

export default function ProjectDetail() {
  const { id } = useParams();
  const projectId = Number(id);
  const [project, setProject] = useState<Project | null>(null);
  const [tubeSpec, setTubeSpec] = useState<TubeSpec | null>(null);
  const [assets, setAssets] = useState<Asset[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const load = useCallback(async () => {
    try {
      const [p, a, specs] = await Promise.all([
        api.getProject(projectId),
        api.listAssets(projectId),
        api.listTubeSpecs(),
      ]);
      setProject(p);
      setAssets(a);
      setTubeSpec(specs.find((s) => s.id === p.tube_spec_id) ?? null);
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

  if (error) return <p className="error">{error}</p>;
  if (!project) return <p className="meta">Loading…</p>;

  const sourceAssets = assets.filter((a) => a.kind === 'source_image');

  return (
    <section>
      <p>
        <Link to="/">&larr; All projects</Link>
      </p>
      <h1>{project.name}</h1>
      <p className="meta">
        Tube spec:{' '}
        {tubeSpec ? `${tubeSpec.name} (Ø ${tubeSpec.diameter_mm}mm, min bend ${tubeSpec.min_bend_radius_mm}mm)` : `#${project.tube_spec_id}`}
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
    </section>
  );
}
