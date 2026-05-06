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
  design_doc_json?: string | null;
  validation_report_json?: string | null;
  created_at: string;
};

export type Label = {
  x: number;
  y: number;
  text: string;
};

export type Dimension = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  note?: string;
};

export type DesignDoc = {
  version: number;
  view_box_mm: [number, number, number, number]; // [x, y, w, h]
  runs: DesignRun[];
  labels?: Label[];
  dimensions?: Dimension[];
};

export type Blockout = {
  start_live_index: number;
  end_live_index: number;
};

export type Annotation = {
  kind: 'jump' | 'support' | 'doubleback';
  live_index: number;
};

export type Bend = {
  live_index: number;
};

export type DesignRun = {
  id: string;
  polyline: { points: [number, number][]; closed: boolean };
  tube_diameter_mm?: number;
  color?: string;
  electrodes?: { point_index: number }[];
  direction?: 'forward' | 'backward';
  blockouts?: Blockout[];
  annotations?: Annotation[];
  bends?: Bend[];
  notes?: string;
};

export function parseDoc(dv: DesignVersion | null | undefined): DesignDoc | null {
  if (!dv?.design_doc_json) return null;
  try {
    return JSON.parse(dv.design_doc_json) as DesignDoc;
  } catch {
    return null;
  }
}

export type ValidationIssue = {
  rule:
    | 'min_bend_radius'
    | 'max_segment_length'
    | 'min_spacing'
    | 'crossing_needs_blockout'
    | 'splice_recommended'
    | 'unsupported_path';
  severity: 'error' | 'warning';
  message: string;
  x_mm?: number;
  y_mm?: number;
};

export type ValidationReport = {
  issues: ValidationIssue[];
  tube_runs: number;
  total_length_mm: number;
  bounding_box_mm: [number, number, number, number];
  generated_at: string;
};

export function parseReport(dv: DesignVersion | null | undefined): ValidationReport | null {
  if (!dv?.validation_report_json) return null;
  try {
    return JSON.parse(dv.validation_report_json) as ValidationReport;
  } catch {
    return null;
  }
}

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
  updateProject: (
    id: number,
    body: { name?: string; tube_spec_id?: number; units?: 'mm' | 'in' },
  ) =>
    req<Project>(`/api/projects/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
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
  revalidate: (projectId: number, versionId: number) =>
    req<DesignVersion>(`/api/projects/${projectId}/design_versions/${versionId}/validate`, {
      method: 'POST',
    }),
  saveDesignVersion: (
    projectId: number,
    body: { based_on_vid?: number; label?: string; design_doc: DesignDoc },
  ) =>
    req<DesignVersion>(`/api/projects/${projectId}/design_versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  validateDoc: (projectId: number, doc: DesignDoc, signal?: AbortSignal) =>
    req<ValidationReport>(`/api/projects/${projectId}/validate_doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ design_doc: doc }),
      signal,
    }),
  exportBundleURL: (projectId: number) => `/api/projects/${projectId}/export.neonbench`,
  printPDFURL: (
    projectId: number,
    versionId: number,
    opts: { paper?: string; landscape?: boolean } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.paper) params.set('paper', opts.paper);
    if (opts.landscape) params.set('landscape', '1');
    const qs = params.toString();
    return `/api/projects/${projectId}/design_versions/${versionId}/print.pdf${qs ? `?${qs}` : ''}`;
  },
};

export const PAPER_OPTIONS = [
  { value: 'letter', label: 'US Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'US Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'US Tabloid (11 × 17 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'a2', label: 'A2 (420 × 594 mm)' },
] as const;
