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
  // Optional Job Manager fields. The server returns empty string when the
  // column is NULL, so consumers can treat falsy as "unset" uniformly.
  customer: string;
  designer: string;
  due_date: string;
  job_number: string;
  // Optional tube end gap in millimeters (NW #135). Server omits the
  // field entirely when the column is NULL; the UI falls back to the
  // shop default of 6.35 mm at render time.
  tube_end_gap_mm?: number;
  // Optional channel-letter depth in millimeters (NW #106). Drives
  // the height of the unfolded "return strip" page emitted on the
  // print PDF for runs flagged as channel-letter faces. Server
  // omits the field when NULL; renderers fall back to the 100 mm
  // (≈ 4 in) shop default.
  channel_letter_depth_mm?: number;
  created_at: string;
  updated_at: string;
};

// Default tube end gap, in millimeters. ¼ in (6.35 mm) is the most-cited
// shop convention (Miller App I §126 — UL minimum tube-to-grounded-metal
// clearance). Used wherever the project hasn't set its own override.
export const DEFAULT_TUBE_END_GAP_MM = 6.35;

// Default channel-letter depth, in millimeters. 100 mm (≈ 4 in) is
// the standard industry depth for channel letters (Strattman NT
// Ch.5; Miller p.88). Used wherever the project hasn't set its own
// override.
export const DEFAULT_CHANNEL_LETTER_DEPTH_MM = 100;

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
  // When true, this run's polyline is the silhouette of a
  // channel-letter face: the print PDF emits an extra "return
  // strip" page so the operator can fold a metal strip around
  // the perimeter to form the side wall (NW #106).
  is_channel_letter_face?: boolean;
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

// Response shape for PATCH /api/tube_specs/{id}. The server commits the
// spec edit, then fans out validation across every design version that
// belongs to a project referencing this spec, and reports the counts so
// the editor can show a transient toast ("Re-validated N versions across
// M projects"). Tier 3 #18.
export type UpdateTubeSpecResponse = {
  tube_spec: TubeSpec;
  revalidated: {
    project_count: number;
    version_count: number;
    failed_count: number;
  };
};

export type UpdateTubeSpecBody = {
  name?: string;
  diameter_mm?: number;
  min_bend_radius_mm?: number;
  max_segment_length_mm?: number;
  min_spacing_mm?: number;
};

export type VectorizeCrop = { x: number; y: number; w: number; h: number };

export type VectorizeRequest = {
  asset_id: number;
  target_width_mm: number;
  threshold?: number;
  smoothing_mm?: number; // RDP epsilon override; blank → auto from tube diameter
  min_spur_mm?: number;  // skeleton spur prune length; blank → auto from tube diameter
  label?: string;
  // Pre-binarize bitmap adjustments. Apply order on the server is:
  // rotate → crop → brightness → contrast → luminance → threshold.
  rotation_deg?: number; // -45..+45 (positive = counter-clockwise)
  crop?: VectorizeCrop;  // source-pixel rectangle, post-rotation
  brightness?: number;   // -100..+100, channel offset
  contrast?: number;     // 0.5..2.0, multiplicative around mid-128
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
  // PATCH the tube spec's dimensional fields (Tier 3 #18). The
  // response carries the updated row plus a fan-out summary; the
  // caller surfaces a transient toast when version_count > 0.
  updateTubeSpec: (id: number, body: UpdateTubeSpecBody) =>
    req<UpdateTubeSpecResponse>(`/api/tube_specs/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  listProjects: () => req<Project[]>('/api/projects'),
  getProject: (id: number) => req<Project>(`/api/projects/${id}`),
  createProject: (body: {
    name: string;
    tube_spec_id: number;
    units?: string;
    customer?: string;
    designer?: string;
    due_date?: string;
    job_number?: string;
    tube_end_gap_mm?: number;
    channel_letter_depth_mm?: number;
  }) =>
    req<Project>('/api/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  deleteProject: (id: number) => req<void>(`/api/projects/${id}`, { method: 'DELETE' }),
  updateProject: (
    id: number,
    body: {
      name?: string;
      tube_spec_id?: number;
      units?: 'mm' | 'in';
      customer?: string;
      designer?: string;
      due_date?: string;
      job_number?: string;
      // number to write a new value, null to clear (fall back to
      // shop default), undefined / omitted to leave it untouched.
      tube_end_gap_mm?: number | null;
      // Same three-state semantics as tube_end_gap_mm.
      channel_letter_depth_mm?: number | null;
    },
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
  deleteDesignVersion: (projectId: number, versionId: number) =>
    req<void>(`/api/projects/${projectId}/design_versions/${versionId}`, { method: 'DELETE' }),
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
  createBlankDesignVersion: (projectId: number, label?: string) =>
    req<DesignVersion>(`/api/projects/${projectId}/design_versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        label: label ?? 'blank',
        design_doc: {
          version: 1,
          view_box_mm: [0, 0, 1000, 500],
          runs: [],
          labels: [],
          dimensions: [],
        } as DesignDoc,
      }),
    }),
  validateDoc: (projectId: number, doc: DesignDoc, signal?: AbortSignal) =>
    req<ValidationReport>(`/api/projects/${projectId}/validate_doc`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ design_doc: doc }),
      signal,
    }),
  exportBundleURL: (projectId: number) => `/api/projects/${projectId}/export.neonbench`,
  importBundle: async (file: File): Promise<Project> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/projects/import', { method: 'POST', body: fd });
    if (!res.ok) {
      let msg = res.statusText;
      try {
        const body = (await res.json()) as { error?: string };
        if (body?.error) msg = body.error;
      } catch {
        // server returned non-JSON; fall back to status text
      }
      throw new Error(`${res.status} ${msg}`);
    }
    return (await res.json()) as Project;
  },
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
  // dxfURL points at the geometry-only DXF export (Tier 2 #11) — for
  // CNC tube benders. No paper/landscape options: DXF is just polylines
  // in millimeters, no page layout.
  dxfURL: (projectId: number, versionId: number) =>
    `/api/projects/${projectId}/design_versions/${versionId}/print.dxf`,
};

export const PAPER_OPTIONS = [
  { value: 'letter', label: 'US Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'US Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'US Tabloid (11 × 17 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'a2', label: 'A2 (420 × 594 mm)' },
] as const;
