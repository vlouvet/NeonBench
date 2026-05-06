export type TubeSpec = {
  id: number;
  name: string;
  diameter_mm: number;
  min_bend_radius_mm: number;
  max_segment_length_mm: number;
  min_spacing_mm: number;
  is_default: boolean;
  created_at: string;
};

export type Project = {
  id: number;
  name: string;
  tube_spec_id: number;
  units: 'mm' | 'in';
  created_at: string;
  updated_at: string;
};

export type AssetKind = 'source_image' | 'vector' | 'print_output';

export type Asset = {
  id: number;
  project_id: number;
  kind: AssetKind;
  filename: string;
  mime: string;
  size_bytes: number;
  created_at: string;
};

export type DesignVersion = {
  id: number;
  project_id: number;
  version_no: number;
  label?: string | null;
  svg_data: string;
  validation_report_json?: string | null;
  created_at: string;
};

export type VectorizeRequest = {
  asset_id: number;
  target_width_mm: number;
  threshold?: number;
  turn_policy?: string;
  turdsize?: number;
  alphamax?: number;
  opttolerance?: number;
  label?: string;
};

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const body = await res.json();
      if (body?.error) msg = body.error;
    } catch {
      // fall through with statusText
    }
    throw new Error(`${res.status} ${msg}`);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  listTubeSpecs: () => req<TubeSpec[]>('/api/tube_specs'),
  listProjects: () => req<Project[]>('/api/projects'),
  getProject: (id: number) => req<Project>(`/api/projects/${id}`),
  createProject: (body: { name: string; tube_spec_id: number; units?: string }) =>
    req<Project>('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteProject: (id: number) => req<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  listAssets: (projectId: number) => req<Asset[]>(`/api/projects/${projectId}/assets`),
  uploadAsset: (projectId: number, file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return req<Asset>(`/api/projects/${projectId}/assets`, { method: 'POST', body: fd });
  },
  assetURL: (projectId: number, assetId: number) =>
    `/api/projects/${projectId}/assets/${assetId}`,
  vectorize: (projectId: number, body: VectorizeRequest) =>
    req<DesignVersion>(`/api/projects/${projectId}/vectorize`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  listDesignVersions: (projectId: number) =>
    req<DesignVersion[]>(`/api/projects/${projectId}/design_versions`),
  latestDesignVersion: (projectId: number) =>
    req<DesignVersion | null>(`/api/projects/${projectId}/design_versions/latest`),
  getDesignVersion: (projectId: number, versionId: number) =>
    req<DesignVersion>(`/api/projects/${projectId}/design_versions/${versionId}`),
};
