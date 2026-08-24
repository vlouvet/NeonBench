export type TubeSpec = {
  id: number;
  name: string;
  diameter_mm: number;
  min_bend_radius_mm: number;
  max_segment_length_mm: number;
  min_spacing_mm: number;
  // Optional bend-radius derivation inputs (Tier 3 #31). When the
  // project leaves min_bend_radius_mm blank, the validator computes
  // r_min = K * D² / t where K is a per-technique constant and t is
  // wall_thickness_mm. The fields are nullable on the server; the JSON
  // omits them entirely when the column is NULL, so consumers should
  // treat undefined as "no spec metadata; the validator will fall
  // through to the diameter-only 2.25·D bound". See
  // docs/neon-rules/bend-radius.md and internal/validate/rules.go's
  // derivedMinBendRadius helper for provenance and the K table.
  wall_thickness_mm?: number;
  bend_technique?: 'ribbon' | 'crossfire' | 'hand_torch';
  // Optional per-spec lead-in / sharp-bend overrides (Tier 3 #29 added
  // the columns; Tier 3 #41 wires them into the editor). Both are
  // nullable on the server — the JSON omits the field entirely when
  // the column is NULL. Consumers should treat undefined as "no
  // override; the validator falls back to a derived default" (2 ×
  // diameter for lead-in, 85° for the sharp-bend threshold).
  min_lead_in_mm?: number;
  sharp_bend_angle_deg?: number;
  is_default: boolean;
  created_at: string;
};

// Bend technique vocabulary, surfaced to the editor's <select>. Order
// is "tightest bend → loosest", matching the K-constant table:
//
//   ribbon     — uniform ribbon-burner heat, K = 0.20 (tightest bend)
//   crossfire  — concentrated crossfire heat, K = 0.225 (typical)
//   hand_torch — hand-aimed flame, K = 0.275 (loosest)
//
// When the spec has no technique set the editor shows "(unset)" and
// the derived radius computation falls back to the diameter-only 2.25·D
// bound.
export const BEND_TECHNIQUES = [
  { value: 'ribbon', label: 'Ribbon burner (K=0.20, tightest)' },
  { value: 'crossfire', label: 'Crossfire (K=0.225, typical)' },
  { value: 'hand_torch', label: 'Hand torch (K=0.275, loosest)' },
] as const;

export type BendTechnique = (typeof BEND_TECHNIQUES)[number]['value'];

// K constants for derivedMinBendRadiusMM, kept in lock-step with the
// Go-side derivedMinBendRadius helper so the editor's "Derived: …"
// indicator matches what the validator will compute.
const BEND_TECHNIQUE_K: Record<BendTechnique, number> = {
  ribbon: 0.20,
  crossfire: 0.225,
  hand_torch: 0.275,
};

// derivedMinBendRadiusMM mirrors the Go-side helper for editor preview.
// Returns 0 when the diameter is missing; falls back to the
// diameter-only 2.25·D bound when wall thickness or technique is
// missing/unknown.
export function derivedMinBendRadiusMM(
  diameterMM: number,
  wallThicknessMM: number | null | undefined,
  technique: BendTechnique | null | undefined,
): number {
  if (!Number.isFinite(diameterMM) || diameterMM <= 0) return 0;
  if (!wallThicknessMM || wallThicknessMM <= 0) return 2.25 * diameterMM;
  if (!technique || !(technique in BEND_TECHNIQUE_K)) return 2.25 * diameterMM;
  const k = BEND_TECHNIQUE_K[technique];
  return (k * diameterMM * diameterMM) / wallThicknessMM;
}

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
  // Optional channel-letter strip-overlap allowance in millimeters
  // (Tier 3 #26). Drawn as a dashed shear line on each unfolded
  // return-strip page so the fabricator knows where to cut for the
  // doubled-back seam. Server omits the field when NULL; renderers
  // fall back to the 12.7 mm (½ in) shop default.
  strip_overlap_mm?: number;
  // When true, the validator escalates RuleFacePerimeterExceedsBlank
  // from severity "warning" to severity "error" — Tier 3 #46. The
  // column is NOT NULL DEFAULT 0 on the server; the field is always
  // present (boolean, never undefined). Default false matches the
  // historical behaviour so warnings stay warnings unless the shop
  // opts in.
  face_perimeter_strict_mode: boolean;
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

// Default strip-overlap allowance, in millimeters. ½ in (12.7 mm) is
// the trade-typical doubled-seam allowance (Strattman NT Ch.5). Used
// wherever the project hasn't set its own override.
export const DEFAULT_STRIP_OVERLAP_MM = 12.7;

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
  // Tier 3 #33b / NW #139 — named bindings of two-or-more runs.
  // Membership lives on the Run side (`group_id`); this slice is
  // the source-of-truth for display names. Optional / omitted on
  // pre-33b docs — consumers should treat `undefined` and `[]` as
  // equivalent ("no groups defined").
  groups?: Group[];
};

// Tier 3 #33b — display-name + identity for one group of runs.
// Mirrors `internal/designdoc.Group` byte-for-byte. A run is bound
// to this group when its `group_id` matches `id`. The data model
// is one-to-many (one group, many runs) but one-to-one in the run
// model (a run is in zero or one groups); re-grouping replaces the
// prior FK rather than introducing M:N membership.
//
// Tier 3 #33c — `visible` and `locked` are display-only Layers panel
// flags. `visible: undefined` is interpreted as "visible" by every
// consumer (back-compat invariant for pre-33c persisted docs that
// have no `visible` field at all); `visible: false` hides the group's
// runs from the canvas. `visible: true` is functionally identical to
// `undefined` but lets a caller emit an explicit value if it wants
// to. `locked: undefined` and `locked: false` both mean "unlocked";
// `locked: true` blocks click-selection on canvas members (the
// Layers sidebar bypasses the lock — clicking a row body still
// selects the group's runs as the deliberate escape hatch). Both
// flags are *display* filters: validation, save, PDF, DXF all see
// every run regardless of these flags. See `Group` in
// `internal/designdoc/types.go` for the Go-side mirror.
export type Group = {
  id: string;
  name: string;
  visible?: boolean;
  locked?: boolean;
};

// isGroupVisible centralizes the "undefined → visible" interpretation
// so consumers can ask the question once instead of duplicating the
// `g.visible !== false` pattern at every call site. Returns true for
// undefined / true; false only for an explicit false.
export function isGroupVisible(group: Group | undefined | null): boolean {
  if (!group) return true;
  return group.visible !== false;
}

export type Blockout = {
  start_live_index: number;
  end_live_index: number;
};

export type Annotation = {
  // Tier 3 #77 — `drop_bend` is the fourth annotation kind: a localized
  // out-of-plane offset where the tube dips slightly behind the
  // substrate (NW's "drop bend" — distinct trade vocabulary from a
  // jump's horseshoe-over-an-obstacle). The 3D preview lifts the tube
  // by 0.5× diameter at drop-bend points vs. 2.5× for jumps so the
  // visual reads as a subtle dip rather than a clear bridge. Pure-
  // additive JSON; old design blobs without this value deserialize
  // cleanly to one of the three pre-existing kinds.
  kind: 'jump' | 'support' | 'doubleback' | 'drop_bend';
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
  // Optional per-run channel-letter depth override in millimeters
  // (Tier 3 #26). When set, the run's return strip is emitted at
  // this depth instead of the project default. Only meaningful
  // when is_channel_letter_face is true. Lets one project mix
  // tall and shallow returns.
  channel_letter_depth_mm?: number;
  // Optional raceway grouping label (Tier 3 #26). Runs sharing
  // the same non-empty raceway_id are emitted as ONE combined
  // unfolded return strip in declaration order — Strattman
  // raceway construction (e.g. all letters in "OPEN" share one
  // continuous back-channel). Empty / missing = ungrouped.
  raceway_id?: string;
  // Tier 3 #60 / NW #125 — classifies the run for downstream
  // rendering. "" (default / missing) is a primary tube run;
  // "jumper" is a short splice tube between two primary runs
  // (Strattman Fig.11.3 10–11 mm OD glass with a flared end, or
  // Miller p.204–205 16 mm OD glass-sleeved twisted lead-wire).
  // Jumpers render dashed on the 2D pattern, thinner / dimmer in
  // the 3D preview, and are skipped by the bend-list summary
  // page (a 2-vertex polyline has no bends). Old design blobs
  // without this field deserialize cleanly to "" — flows through
  // the existing design_doc JSON blob (no migration needed).
  kind?: '' | 'jumper';
  // Tier 3 #33b / NW #139 — foreign key into `DesignDoc.groups`.
  // Empty / missing = ungrouped; non-empty = bound to the group
  // with that ID (selecting any sibling extends to all members).
  // Old design blobs without this field deserialize cleanly to ""
  // — additive, no migration. A run can only be in one group at a
  // time; re-grouping replaces the prior value (see groupRuns in
  // lib/docOps.ts for the canonical "replace" semantic).
  group_id?: string;
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
    | 'min_lead_in'
    | 'sharp_bend_angle'
    | 'face_perimeter_exceeds_blank'
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

// Normalize a report parsed from JSON. Older rows in the database
// (and any backend regression) can serialize `issues` as null instead
// of `[]` — coerce it here so every consumer can rely on the array
// shape its TypeScript signature promises.
function normalizeReport(r: ValidationReport): ValidationReport {
  if (r.issues == null) r.issues = [];
  return r;
}

export function parseReport(dv: DesignVersion | null | undefined): ValidationReport | null {
  if (!dv?.validation_report_json) return null;
  try {
    return normalizeReport(JSON.parse(dv.validation_report_json) as ValidationReport);
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

// Body for POST /api/tube_specs (Tier 3 #51). The four primary
// dimensional fields are required; the four optional override columns
// are nilable. Server enforces the same bounds as the PATCH validator
// (diameter 5..30, bend radius 1..200, segment 100..5000, spacing
// 1..100, plus the cross-field rule min_bend_radius_mm >= diameter_mm)
// and adds a case-insensitive uniqueness check on `name` so visually-
// indistinguishable specs ("12mm clear" vs "12MM Clear") cannot land
// side-by-side in the dropdown.
export type CreateTubeSpecBody = {
  name: string;
  diameter_mm: number;
  min_bend_radius_mm: number;
  max_segment_length_mm: number;
  min_spacing_mm: number;
  wall_thickness_mm?: number | null;
  bend_technique?: BendTechnique | null;
  min_lead_in_mm?: number | null;
  sharp_bend_angle_deg?: number | null;
};

// Response shape for DELETE /api/tube_specs/{id} when the spec is in
// use by one or more projects (Tier 3 #51). The frontend renders the
// project list verbatim so the operator knows which projects to
// migrate first.
export type DeleteTubeSpecConflict = {
  error: string;
  project_count: number;
  projects: { id: number; name: string }[];
};

// TubeSpecInUseError is thrown by api.deleteTubeSpec when the server
// refuses with 409 because one or more projects still reference the
// spec. Carries the conflict body so callers can render the project
// list (rather than asking the user to spelunk through the project
// list themselves). instanceof is the discriminator — the caller
// catches `Error`, narrows to TubeSpecInUseError, and falls back to
// `error.message` for everything else.
export class TubeSpecInUseError extends Error {
  readonly conflict: DeleteTubeSpecConflict;
  constructor(conflict: DeleteTubeSpecConflict) {
    super(conflict.error);
    this.name = 'TubeSpecInUseError';
    this.conflict = conflict;
  }
}

export type UpdateTubeSpecBody = {
  name?: string;
  diameter_mm?: number;
  min_bend_radius_mm?: number;
  max_segment_length_mm?: number;
  min_spacing_mm?: number;
  // Three-state PATCH fields (Tier 3 #43). Omit the key entirely to
  // preserve the current value. Send `null` (or, for the technique, an
  // empty string) to clear the column. Send a number / one of the
  // BEND_TECHNIQUES values to write through. The server validates the
  // wall-thickness range [0.1, 10.0] mm and the technique whitelist;
  // out-of-range / unknown values surface as 422.
  wall_thickness_mm?: number | null;
  bend_technique?: BendTechnique | '' | null;
  // Three-state PATCH fields for the lead-in and sharp-bend overrides
  // (Tier 3 #41). Same semantics as wall_thickness_mm: omit to
  // preserve, null to clear (revert to derived default), number to
  // write through. Server validates min_lead_in_mm in [0, 50] mm and
  // sharp_bend_angle_deg in [0, 90] degrees; out-of-range surfaces as
  // 422.
  min_lead_in_mm?: number | null;
  sharp_bend_angle_deg?: number | null;
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
  // POST a new tube spec (Tier 3 #51). Server returns the persisted row
  // with its assigned id; uniqueness collisions surface as a thrown
  // Error with the server's "...already exists..." message.
  createTubeSpec: (body: CreateTubeSpecBody) =>
    req<TubeSpec>('/api/tube_specs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // DELETE a tube spec (Tier 3 #51). Resolves to undefined on success
  // (204). When the spec is still referenced by one or more projects
  // the server responds with 409 + a conflict body; we surface that
  // by rejecting with a TubeSpecInUseError so the caller can render
  // the project list inline rather than trying to JSON-parse a generic
  // Error message.
  deleteTubeSpec: async (id: number): Promise<void> => {
    const res = await fetch(`/api/tube_specs/${id}`, { method: 'DELETE' });
    if (res.status === 204) return;
    if (res.status === 409) {
      try {
        const body = (await res.json()) as DeleteTubeSpecConflict;
        throw new TubeSpecInUseError(body);
      } catch (err) {
        if (err instanceof TubeSpecInUseError) throw err;
        throw new Error(`409 ${res.statusText}`, { cause: err });
      }
    }
    let msg = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) msg = body.error;
    } catch {
      // fall through with statusText
    }
    throw new Error(`${res.status} ${msg}`);
  },
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
    strip_overlap_mm?: number;
    face_perimeter_strict_mode?: boolean;
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
      // Same three-state semantics as the two above (Tier 3 #26).
      strip_overlap_mm?: number | null;
      // Two-state PATCH (Tier 3 #46): omit to leave the column alone,
      // boolean to write the value. The column is NOT NULL DEFAULT 0
      // server-side, so there's no `null` "clear → default" semantic.
      face_perimeter_strict_mode?: boolean;
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
  // Bug #05: rename an existing version. Empty string clears the label.
  updateDesignVersionLabel: (projectId: number, versionId: number, label: string) =>
    req<DesignVersion>(`/api/projects/${projectId}/design_versions/${versionId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ label }),
    }),
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
    }).then(normalizeReport),
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
  // Build the print-PDF URL. The second arg is optional so the
  // single-arg call shape (the existing Print button on EditorPage)
  // keeps working unchanged. Tier 3 #50 added the `strips_only`
  // backend toggle (PR #51); the popover wires it up here so the
  // operator can request a returns-only PDF without the main pattern
  // pages.
  //
  // Tier 2 #73 adds the `mirror` option. The trade default is
  // MIRRORED (operators bend against the back of the glass tube
  // while reading the pattern), so the URL omits the `mirror` param
  // when the option is undefined OR true — the server's default is
  // mirrored, and emitting `?mirror=1` would just duplicate that
  // intent. Only an explicit `mirror: false` adds `?mirror=0`, which
  // tells the server to skip the horizontal flip and emit a
  // front-facing pattern (for marketing renders or design review).
  printPDFURL: (
    projectId: number,
    versionId: number,
    opts: {
      paper?: string;
      landscape?: boolean;
      stripsOnly?: boolean;
      // When undefined or true, the URL omits the mirror param and
      // the server's trade-default mirror engages. When explicitly
      // false, the URL adds `?mirror=0` and the server emits the
      // front-facing pattern. See internal/printpdf/render.go's
      // Options.Mirror for the trade-default rationale.
      mirror?: boolean;
    } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.paper) params.set('paper', opts.paper);
    if (opts.landscape) params.set('landscape', '1');
    if (opts.stripsOnly) params.set('strips_only', '1');
    if (opts.mirror === false) params.set('mirror', '0');
    const qs = params.toString();
    return `/api/projects/${projectId}/design_versions/${versionId}/print.pdf${qs ? `?${qs}` : ''}`;
  },
  // dxfURL points at the geometry-only DXF export (Tier 2 #11) — for
  // CNC tube benders. No paper/landscape options: DXF is just polylines
  // in millimeters, no page layout.
  dxfURL: (projectId: number, versionId: number) =>
    `/api/projects/${projectId}/design_versions/${versionId}/print.dxf`,
  // Vector-graphics export URLs (Tier 3 #80). SVG / EPS / AI are
  // sibling formats: SVG is the richest (per-run groups, dedicated
  // annotation layers); EPS is the procedural PostScript flavour;
  // AI is the EPS bytes served at .ai (Illustrator opens it
  // natively — the file format converged historically). All three
  // accept the same `?mirror=1` flag as the PDF / DXF exports so the
  // backside view round-trips through any of the four CAM targets.
  exportSVGURL: (
    projectId: number,
    versionId: number,
    opts: { mirror?: boolean } = {},
  ) => buildExportURL(projectId, versionId, 'svg', opts),
  exportEPSURL: (
    projectId: number,
    versionId: number,
    opts: { mirror?: boolean } = {},
  ) => buildExportURL(projectId, versionId, 'eps', opts),
  exportAIURL: (
    projectId: number,
    versionId: number,
    opts: { mirror?: boolean } = {},
  ) => buildExportURL(projectId, versionId, 'ai', opts),

  // Tier 2 #81 — takeoff + estimate.
  //
  // The takeoff carries no rates, so it resolves for a shop that has never
  // filled in a rate card: "how much 12mm do I order" does not need a price.
  getTakeoff: (projectId: number, versionId: number, rateCardId?: number) =>
    req<Takeoff>(
      `/api/projects/${projectId}/design_versions/${versionId}/takeoff` +
        (rateCardId ? `?rate_card_id=${rateCardId}` : ''),
    ),
  getEstimate: (projectId: number, versionId: number, rateCardId?: number) =>
    req<EstimateResponse>(
      `/api/projects/${projectId}/design_versions/${versionId}/estimate` +
        (rateCardId ? `?rate_card_id=${rateCardId}` : ''),
    ),
  saveEstimateInputs: (projectId: number, versionId: number, body: EstimateInputs) =>
    req<EstimateInputs>(
      `/api/projects/${projectId}/design_versions/${versionId}/estimate_inputs`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    ),
  estimatePDFURL: (projectId: number, versionId: number, rateCardId?: number) =>
    `/api/projects/${projectId}/design_versions/${versionId}/estimate.pdf` +
    (rateCardId ? `?rate_card_id=${rateCardId}` : ''),

  listRateCards: () => req<RateCard[]>('/api/rate_cards'),
  getRateCard: (id: number) => req<RateCard>(`/api/rate_cards/${id}`),
  patchRateCard: (id: number, body: Partial<RateCardScalars>) =>
    req<RateCard>(`/api/rate_cards/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  // `unit_cost: null` CLEARS a rate back to unpriced; omitting the key leaves
  // it alone. The server distinguishes the two, and so must every caller —
  // sending `undefined` where `null` was meant silently keeps a wrong price.
  patchRateCardItem: (cardId: number, itemId: number, body: RateCardItemPatch) =>
    req<RateCard>(`/api/rate_cards/${cardId}/items/${itemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
};

// buildExportURL — shared helper for the three vector-graphics URL
// builders (SVG / EPS / AI). Keeps the call sites tiny and ensures the
// three formats encode the `mirror` flag identically.
function buildExportURL(
  projectId: number,
  versionId: number,
  ext: 'svg' | 'eps' | 'ai',
  opts: { mirror?: boolean },
): string {
  const params = new URLSearchParams();
  if (opts.mirror) params.set('mirror', '1');
  const qs = params.toString();
  return `/api/projects/${projectId}/design_versions/${versionId}/export.${ext}${qs ? `?${qs}` : ''}`;
}

export const PAPER_OPTIONS = [
  { value: 'letter', label: 'US Letter (8.5 × 11 in)' },
  { value: 'legal', label: 'US Legal (8.5 × 14 in)' },
  { value: 'tabloid', label: 'US Tabloid (11 × 17 in)' },
  { value: 'a4', label: 'A4 (210 × 297 mm)' },
  { value: 'a3', label: 'A3 (297 × 420 mm)' },
  { value: 'a2', label: 'A2 (420 × 594 mm)' },
] as const;


// ---------------------------------------------------------------------------
// Tier 2 #81 — takeoff + estimate types
//
// These mirror internal/takeoff and internal/estimate. All pricing arithmetic
// lives on the server; the frontend renders what it is given. The repo already
// pays for one duplicated algorithm (bends.ts <-> bends.go) and a second one
// here would let a quote on screen disagree with the quote on the PDF.
// ---------------------------------------------------------------------------

export type TakeoffLine = {
  kind: string;
  qualifier?: string;
  label: string;
  qty: number;
  unit: string;
  /** 'derived' from the drawing, or 'manual' from the inputs form. */
  source: 'derived' | 'manual';
  /** Whole purchasable units (sticks, sheets) where stock is indivisible. */
  purchase_qty?: number;
  purchase_unit?: string;
};

export type TakeoffSummary = {
  run_count: number;
  jumper_count: number;
  bend_count: number;
  splice_count: number;
  stick_count: number;
  electrode_count: number;
  electrode_pairs: number;
  pumped_sections: number;
  housing_count: number;
  support_count: number;
  jump_count: number;
  net_tube_ft: number;
  gross_glass_ft: number;
  jumper_ft: number;
  blockout_ft: number;
  return_strip_ft: number;
  backing_bbox_sq_ft: number;
  backing_sheets: number;
  /** True when the backing area is the design's bounding box, which
   *  overestimates a panel cut to the sign's silhouette. Say so in the UI. */
  backing_is_bbox: boolean;
  fabrication_hours: number;
};

export type Takeoff = {
  summary: TakeoffSummary;
  lines: TakeoffLine[];
  yield: { stick_length_mm: number; stick_waste_mm: number; sheet_area_sq_ft: number };
  lead_in_mm: number;
};

export type PricedLine = TakeoffLine & {
  sku?: string;
  /** null means no rate exists yet. Never render this as zero. */
  unit_cost: number | null;
  unpriced: boolean;
  /** A rate exists but is quoted in a unit the line is not measured in. */
  unit_mismatch?: boolean;
  draw_cost: number;
  order_qty?: number;
  purchase_cost?: number;
  min_order_dominates?: boolean;
};

export type Estimate = {
  lines: PricedLine[];
  material_cost: number;
  labour_cost: number;
  cost_subtotal: number;
  markup_multiplier: number;
  price: number;
  implied_margin_pct: number;
  purchase_cost: number;
  unpriced_count: number;
  unpriced_kinds?: string[];
  unit_mismatch_kinds?: string[];
  is_provisional: boolean;
  min_order_dominates: boolean;
  rate_card_id: number;
  rate_card_name: string;
  rate_card_updated_at?: string;
  currency: string;
};

export type EstimateResponse = { takeoff: Takeoff; estimate: Estimate };

export type RateCardItem = {
  id: number;
  kind: string;
  qualifier?: string;
  sku?: string;
  label: string;
  unit: string;
  /** null = unpriced. Distinct from 0, which means deliberately free. */
  unit_cost: number | null;
  min_qty?: number;
  pack_fee?: number;
};

export type RateCardScalars = {
  name: string;
  currency: string;
  markup_multiplier: number;
  labour_rate_per_hour: number;
  labour_setup_minutes: number;
  labour_minutes_per_foot: number;
  stick_length_mm: number;
  stick_waste_mm: number;
  sheet_area_sq_ft: number;
};

export type RateCard = RateCardScalars & {
  id: number;
  source?: string;
  synced_at?: string;
  updated_at?: string;
  items: RateCardItem[];
};

export type RateCardItemPatch = {
  label?: string;
  sku?: string;
  unit?: string;
  /** null clears the rate; omit the key to leave it unchanged. */
  unit_cost?: number | null;
  min_qty?: number;
  pack_fee?: number;
};

export type EstimateMiscLine = { label: string; qty: number; unit: string };

export type EstimateInputs = {
  transformer_count?: number;
  transformer_qualifier?: string;
  gas_qualifier?: string;
  gas_fill_sections?: number;
  gto_cable_ft?: number;
  tube_support_count?: number;
  boot_endcap_count?: number;
  standoff_set_count?: number;
  backing_sq_ft?: number;
  install_hours?: number;
  design_hours?: number;
  freight?: number;
  misc?: EstimateMiscLine[];
};
