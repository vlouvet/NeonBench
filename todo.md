# NeonBench — TODO

A modern, cross-platform replacement for NeonWizard. Web-browser based neon design and pattern planning tool.

## Stack & architecture

- **Backend:** Go, single static binary
- **Frontend:** React + TypeScript + Vite, built and embedded via `embed.FS`
- **Storage:** SQLite (one DB file per install, projects + assets + history + config)
- **Distribution:** Cross-platform Go binary; on launch, starts local HTTP server and opens default browser to `localhost:<port>`
- **Internal units:** millimeters everywhere; UI display unit configurable later
- **API:** JSON over HTTP between browser and Go server (single-user, no auth in v1)

## Phase 0 — Foundations

- [x] `go mod init`, repo layout (`cmd/neonbench`, `internal/{server,storage,appdata}`, `web/`)
- [x] HTTP server with graceful shutdown, dynamic free-port selection (bound to 127.0.0.1)
- [x] On startup: open default browser to server URL (`github.com/pkg/browser`)
- [x] SQLite via `modernc.org/sqlite` (pure-Go, CGO_ENABLED=0 cross-compile works)
- [x] Migrations system (`github.com/pressly/goose/v3` with `embed.FS`-loaded SQL files)
- [x] Vite + React + TS scaffold under `web/`; `web/web.go` embeds `dist/` via `//go:embed all:dist`
- [x] Dev mode (`--dev`): reverse-proxy `/` to `http://localhost:5173`; prod mode: serve embedded assets with SPA fallback
- [x] Cross-compile build script (`scripts/build.sh`): macOS arm64/amd64, Windows amd64, Linux amd64; ~11MB binaries with `-trimpath -ldflags="-s -w"`
- [x] Logging via `log/slog` text handler on stderr; errors wrapped with `fmt.Errorf("%w")`
- [x] App data directory helper (`internal/appdata`): macOS `~/Library/Application Support/NeonBench`, Windows `%APPDATA%\NeonBench`, Linux `$XDG_DATA_HOME/NeonBench` (default `~/.local/share/NeonBench`); `--data-dir` flag overrides

## Phase 1 — MVP: Bitmap → Vector → Validate → Print

### Project model

- [x] `projects` table: id, name, created_at, updated_at, tube_spec_id, units
- [x] `tube_specs` table: id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm, min_spacing_mm
- [x] Seed 3–5 default tube specs (common diameters: 8mm, 10mm, 12mm, 15mm)
- [x] `assets` table: project_id, kind (source_image | vector | print_output), blob/path, mime
- [x] `design_versions` table: project_id, version_no, label, svg_data, design_doc_json, validation_report_json, created_at — **enables cross-session undo & named versions** (key gap vs NeonWizard)

### Image input

- [x] Upload endpoint accepting PNG, JPG, SVG (max size guard, 50MB)
- [x] PNG/JPG: adjustable threshold preview before vectorize — live side-by-side Source/Binarized canvas in `VectorizePanel.tsx`, throttled with `useDeferredValue` (PR #5)
- [x] SVG: skip vectorization, persist as design_version pass-through
- [x] Store original asset on disk under `<data-dir>/assets/<project_id>/` with metadata in DB

### Vectorization

- [x] **Centerline extraction via skeleton-graph (replaces potrace).** Pipeline: Decode → Binarize → Zhang-Suen thin → classify (arc-count test) → merge thick junction clusters → walk graph into open + closed polylines → spur prune (iterate until stable) → mm conversion → Ramer-Douglas-Peucker simplify → emit SVG. Pure Go, no third-party deps. Produces one polyline per tube stroke (instead of potrace's outline pairs), so a 600mm "OPEN" with 12mm tube goes from 11+ outline-spacing errors to 0 spacing errors and ~7 polylines (one per stroke or letter loop). Validator gained a small junction-weld exemption so polylines meeting at a weld aren't flagged as "tubes 0mm apart".
- [x] Vectorize parameters: target_width_mm, threshold, smoothing_mm (RDP ε override), min_spur_mm, label. Smoothing/spur default to values derived from the project tube diameter when blank.
- [x] Normalize vectorize output to mm-canonical viewBox — emitted directly by the centerline pipeline; downstream validator/print/designdoc see identity-mapped paths.
- [x] Live before/after preview UI — shipped alongside the threshold slider (PR #5)

### Validation rules

- [x] **Min bend radius:** discrete 3-point circumradius along flattened polylines, with **double-back hairpin exemption** (Blazek "DB" construction)
- [x] **Connectivity / tube run count:** counted, exposed in report, no error raised (multi-run is normal)
- [x] **Max segment length:** total arc per subpath; flagged with arc-midpoint location
- [x] **Min spacing:** spatial-grid pairwise check with curvature-aware same-polyline filter
- [x] **Crossing detection:** demote perpendicular spacing flags to `crossing_needs_blockout` warning (Saving Neon p.19 — block-out paint exempts crossings)
- [x] **Splice recommended:** Miller p.125 — bbox height ≥ 305mm warns about multi-blank construction
- [x] Validation report: structured JSON (rule, severity, location, message) + grouped UI list with severity color coding
- [x] Block "Send to printer" until report has zero errors (warnings allowed) — wired in PrintPanel
- [ ] **Visual marker overlay on SVG preview** — deferred; needs SVG normalization (see Vectorization section)
- [ ] **Lead-in length / 90° angle** (Miller p.124, 50–254mm) — deferred until electrode placement model exists (potrace gives closed loops with no defined endpoints)
- [ ] **Glass-to-grounded-metal ≥6.35mm, HV-cable-to-metal ≥70mm** (Miller App I §126, p.202; Strattman updates HV to 63.5mm) — deferred until cabinet/substrate model exists
- [ ] Tighten bend-radius defaults to wall-thinning derivation (18/22/27/34mm for ø 8/10/12/15mm) — see `docs/neon-rules/bend-radius.md` derivation; currently still 16/20/25/30mm

### Print output (1:1 PDF)

- [x] PDF library — `github.com/phpdave11/gofpdf` (mature, mm-native, path-friendly)
- [x] Generate PDF at exact 1:1 scale, paths in mm, stroked outlines
- [x] Tiling for designs larger than paper: split across pages with configurable overlap (default 10mm)
- [x] Page setup: paper size selection (Letter, Legal, Tabloid, A4, A3, A2), orientation, margin
- [x] Registration crosses at tile corners + 100mm scale bar with mm tick marks (and "verify scale" callout)
- [x] Footer with project / version / tube spec / tile coords / date
- [x] Download PDF action; gated on no validation errors
- [ ] Send to printer (OS print dialog) — currently downloads only; "send to printer" via OS dialog is a polish item

### Frontend (Phase 1)

- [x] Project list / create modal with tube spec picker
- [x] Edit tube spec per project — project-detail dropdown shipped in 59fedea; editor-side switcher with auto-revalidate of the current version shipped in PR #6
- [x] Project detail with file upload (click to upload; drag-drop is a v1.x polish item)
- [x] Vectorize step with target width + threshold + smoothing/spur sliders
- [x] Validation results panel with grouped issue lists, severity colors, re-validate button
- [x] Version history list with click-to-switch preview
- [x] Print panel with paper picker + landscape toggle + download button
- [ ] Keyboard shortcuts (cmd/ctrl+Z, cmd+S) — placeholder behavior; real shortcuts in Phase 2 with the editor

### v1 release checklist

- [ ] Smoke test on macOS, Windows, Linux. CI now runs on Linux (`test` job) + Windows (`windows-smoke` job, PR #2). macOS is the dev platform. No CI runner on macOS yet — add if it becomes useful.
- [ ] Sample bitmaps + golden vectorized outputs in `testdata/`
- [ ] User-facing README with install + first-design walkthrough
- [x] Crash recovery: every vectorize creates a `design_versions` row before returning, so a mid-session crash leaves the last good state in SQLite

---

## Phase 2 — Editor + Neon-specific features

### Vector editor

- [x] Canvas: raw SVG + custom pointer/wheel pan-zoom (lighter than Konva/Fabric, good enough for this scope)
- [x] Node-level polyline editing: drag any vertex to reshape; shift-click to delete; alt-click empty segment to **insert vertex**; alt-click vertex to **split run**; sidebar "Join from head/tail" arms a two-click endpoint selector to **join runs**. Electrode / blockout / annotation / bend references shift correctly across all five operations (PR #23). Bezier-aware control-handle editing remains a Tier 3 follow-up.
- [x] Path operations: simplify (Douglas-Peucker, ε configurable in sidebar), reverse (flips polyline order, rewrites electrode anchors), split + join (PR #23), and Neonize (closed-polyline polygon offset → two parallel offset runs, PR #26).
- [x] Snap to grid (toolbar toggle + mm spacing input). Affects label/dimension placement and vertex drag; pan/zoom and run-path picks stay un-snapped. Snap-to-angle and snap-to-geometry still TODO.
- [ ] Multi-select, group, layers
- [x] Cross-session checkpoints: every Save writes a new `design_versions` row (history list lets you switch back). In-session undo/redo with coalescing also done — `editDoc()` records each mutation to an `undoStackRef`, 500ms coalescing collapses rapid sequential edits, Cmd/Ctrl+Z undoes and Cmd/Ctrl+Shift+Z redoes (`EditorPage.tsx:46-118`).

### Neon-specific features

- [x] **Electrodes:** click-to-place markers on any run; closed runs with 2 electrodes auto-pick the longer arc as live and expose a "Switch live arc" button (slice 2 + 3a)
- [x] **Blockout marking:** click two points on a run to mark a stretch as block-out paint; rendered dashed in editor and emitted as `data-kind="blockout"` in the saved SVG (slice 3b — backend 866ffde, frontend this slice). Validation spacing exemption for blockouts still TODO.
- [x] **Double-back hairpin annotation:** click-to-place at a hairpin apex; rides through the SVG as `data-doubleback-mm` and suppresses bend-radius errors within max(2D, 10mm) of the marked point. Geometric `isDoubleBackHairpin` heuristic still runs as auto-detect alongside.
- [x] **Jumps / supports:** click-to-place point annotations on the live arc; rendered as half-arch (jump) and downward triangle (support) glyphs. Informational only — bend-list export is a follow-up.
- [x] **Tube run assignment:** runs are auto-named (`run-1`, `run-2`, …) and editable as units in the sidebar. Per-run free-text Notes field captures transformer specs, voltage, gas, etc; prints italic on the bend-list page of the PDF.
- [x] **Per-run color (gas/phosphor):** sidebar dropdown + run-row swatch; canvas tints the live arc with the selected gas color while blockouts stay neutral. PDF stays B&W on purpose (1:1 trace pattern). (slice 3c)
- [x] **Per-run tube-diameter override:** sidebar number input on the selected run, round-trips through the design doc. Wired into validation: bend-radius limit scales linearly with the override per the wall-thinning derivation; spacing rule stays project-wide for now.
- [x] **Bend planning (auto-suggest + visualize):** `computeBends` walks the live arc, finds vertices whose smoothed turn-angle exceeds 20°, clusters apex points within 2× tube diameter, and emits one bend per cluster with its arc-length offset, approximate radius, and turn angle. Selected-run bends render as small orange discs on the canvas and a sorted list in the sidebar. Manual add/remove and PDF export are follow-ups.
- [x] **Live re-validation on edit:** 500ms debounce; in-flight requests are aborted on the next tick so the user only sees results for their latest state. Status badge in the editor header summarizes errors / warnings / total tube length.
- [x] Annotation layer: doc-level text labels (click → prompt → place) and dimension lines (click two points → measured line + label) render on canvas at fixed pixel size and survive into the print PDF. Per-run gas/color is the color picker; per-run free-text is Run.Notes.

### Phase 2 export

- [x] PDF includes: numbered bend apex markers per run on the tile pages, electrode markers (open circle + cross), blockout segments dashed, doc-level dimension lines + text labels, and a final "Bend list" page summarizing each run's geometry, color, diameter, notes, and bend table. Total-length-per-run and gas-color callouts are still future polish.
- [x] Export project as a `.neonbench` bundle (zip of SVG + design doc + validation report per version, plus a manifest with project metadata and tube-spec snapshot). Import shipped in PR #13 — `POST /api/projects/import` closes the round-trip with tube-spec dedup, name-collision suffixes, and transactional rollback.

---

## Phase 3 — 3D glow rendering

**Phase 3 implementation complete** — 7 specs shipped across PRs #57, #58, #59, #60, #61, #62, #63. Read-only `/projects/:projectId/versions/:versionId/preview` route renders extruded 3D tubes with emissive gas materials, bloom, electrode caps, per-segment blockouts, orbit camera with preset views, scene chrome controls, and PNG screenshot export.

- [x] **Decision resolved:** Three.js + react-three-fiber + drei + postprocessing.
- [x] Extrude vector paths into 3D tube geometry along path with correct diameter (PR #58 — `Run.Polyline → THREE.TubeGeometry` via `CatmullRomCurve3`, segment-count heuristic 1-per-5mm clamped `[16, 256]`, Y-flip on conversion).
- [x] Material: emissive glass shader with bloom/glow post-processing (PR #59 emissive `MeshStandardMaterial`; PR #63 `EffectComposer` + `<Bloom>` with `intensity=1.2`, `luminanceThreshold=0.4`, `mipmapBlur=true`, `radius=0.7`).
- [x] Per-run color matches gas/phosphor (PR #59 — ~20-entry `gasColors.ts` library covering NSI/Voltarc fills + pure gases, substring fallback ordered longest-first, warm-white fallback for unknown/empty).
- [x] Blockout sections render as opaque dark grey sleeves (PR #61 — per-segment split via shared `lib/runArcs.blockoutSegments`; live segments get emissive material, blockouts get `meshStandardMaterial color=#1a1a1a roughness=0.7`).
- [x] Electrodes rendered as small metallic cylinders + hemisphere caps (PR #61 — tangent computed from previous polyline neighbor, falls back to `+Y` for zero-length tangent).
- [x] Camera controls: orbit, pan, zoom; preset views Front / Iso / Top / Side; auto-fit-on-mount (PR #60 — drei `<OrbitControls>` + `cameraPositionForPreset` bbox math + `useFrame` cubic-ease over 600ms).
- [x] Adjustable scene: background color (4 options), wall backing toggle + color, ambient light slider (PR #62 — floating top-right sidebar; wall plane 1.5× bbox at -50mm Z; min wall size 100mm floor for empty docs).
- [x] Screenshot export (PR #62 — render-on-demand bridge calls `gl.render(scene, camera)` synchronously then `gl.domElement.toDataURL`; filename `<projectName>-preview-<ISO>.png`).
- [ ] Optional: animated "warm-up" or flicker effect (deferred — see Tier 3 Phase 3 follow-ups below).

---

## Cross-cutting / nice-to-haves (not blocking)

- [ ] Auto-update mechanism (check GitHub releases on launch, prompt to update)
- [ ] Telemetry opt-in for crash reports only
- [ ] Import from NeonWizard format (if file format is documented or reverse-engineerable) — eases migration story
- [x] DXF export for CNC tube benders — shipped in PR #12 as R12 ASCII LWPOLYLINE per run, mm units, layer-per-run.
- [ ] Multi-user / shop mode (auth, shared project library) — only if there's demand
- [ ] Localization scaffolding (en first, i18n-ready strings)

---

## Open decisions

These are flagged inline above; collected here so they don't get lost:

*(none open — `3D engine` resolved in favour of Three.js + react-three-fiber, see below)*

## Resolved decisions

- **Vectorization engine** → shell out to system `potrace`, bundle binary in releases per OS, fall back to install instructions if missing. Single-binary purity sacrificed for quality.
- **Inputs** → PNG, JPG, SVG. BMP deferred (add only if requested).
- **PDF library** → `github.com/phpdave11/gofpdf` (mm-native, path-friendly, mature).
- **2D editor canvas** → raw SVG with custom pointer/wheel pan-zoom. Lighter than Konva/Fabric and adequate for the run-level interactions Phase 2 needs.
- **App data directory** → OS-conventional paths via `internal/appdata` with `--data-dir` override.
- **3D engine** → Three.js + `@react-three/fiber` + `@react-three/drei` + `@react-three/postprocessing`. Boring-stack canonical react+three combo; alternatives don't meet the bar (Babylon has no React renderer; raw three.js requires reinventing fiber). Bundle delta from Phase 3 #1 + #4: +1009 KB raw / +310 KB gzipped — acceptable for the entire 3D surface; React.lazy code-splitting tracked as a follow-up.

---

## Appendix A — NeonWizard feature parity

Source: https://neonwizard.com/products/features.php?nw=1 (148 advertised features). Pulled 2026-05-07 to baseline the shop-readiness gap.

Legend: ✅ done · 🟡 partial · ❌ missing · 🚫 deliberately out of scope (NeonBench is a 1:1 production-pattern tool, not a vinyl-cutter / wide-format RIP / graphic-design suite).

### Tally

| Category | ✅ | 🟡 | ❌ | 🚫 |
|---|---|---|---|---|
| Neon Design Tools | 15 | 1 | 3 | 4 |
| Fonts & Text | 0 | 3 | 15 | 0 |
| Design Tools | 5 | 4 | 30 | 3 |
| Effects | 0 | 0 | 13 | 0 |
| Vector Graphics | 2 | 2 | 6 | 0 |
| Image Manipulation | 5 | 1 | 1 | 0 |
| Cutting/Plotting/Printing | 5 | 1 | 3 | 9 |
| Productivity | 4 | 1 | 5 | 0 |
| Wide Format | 0 | 0 | 4 | 3 |
| **Totals** | **36** | **13** | **80** | **19** |

Round F + G + sequential tail (#26 + #25) shipped 8 PRs (#37, #38, #39, #40, #41, #42, #43, #44). Most are polish that enriches already-✅ rows (DXF / bundle / job-tracking / channel-letter / Neonize / node-edit). The single tally movement was **#92 All Windows Printers** promoted 🟡 → ✅ — PR #38 wires the OS print dialog via a hidden iframe + `window.print()` against the existing `print.pdf`. **Phase 3 (3D glow rendering) shipped end-to-end across PRs #57–63** (foundation, tube extrusion, emissive material, bloom, orbit camera, electrodes/blockouts, scene chrome + screenshot), promoting **#139 Neon Preview (glow)** ❌ → ✅ and **#140 Neon Preview for Groups** ❌ → 🟡. The post-Phase 3 Neon Design Tools audit (Tier 3 #60–#63 spec drafts) reclassified four rows ❌ → 🚫 (Tier 4) — **#121 Mounting Holes**, **#134 Switch Drop / Flat Blend**, **#136 Tube Support Holes**, **#137 Auto Tube Count**, **#138 Auto Spacing** — as either out of NeonBench's scope or already covered by shipped functionality (Neonize / "support" annotations). May 2026 Tier 1 + Tier 3 rounds shipped four more Neon Design Tools rows ❌ → ✅: **#120 Add Common Housings** + **#126 Create Custom Housings** (combined in PR #77), **#125 Connect Tubes** (PR #79 — jumper runs), and **#130 Move Opening / Break Tube Open** (PR #78). Cumulative ✅ has gone **30 → 31 → 32 → 36** since the Tier 2 close-out; 🟡 sits at 13; ❌ shrank **84 → 80**; 🚫 sits at 19.

### Neon Design Tools (the core — 23 features)

| # | NeonWizard feature | Status | NeonBench equivalent |
|---|---|---|---|
| 119 | Add Blockouts | ✅ | blockout marking, dashed render, `data-kind="blockout"` |
| 120 | Add Common Housings | ✅ | shipped in PR #77 (Tier 3 #62, NW #120 + #126 combined): Electrode.HousingType + bore + elevation; Strattman 15-shell + 19-shell stock library; right-click on electrode pin opens picker; 3D preview renders housing cylinders with porcelain material |
| 121 | Add Mounting Holes | 🚫 | Tier 4 — substrate-fastening hardware, not neon-production. Move to graphic-design tooling if a shop ever asks |
| 122 | Add Tube Supports | ✅ | click-to-place support markers |
| 123 | Auto Tube Layout | ✅ | Neonize sidebar action emits inside + outside parallel offsets at user-set spacing (PR #26) |
| 124 | Change Neon Tube Diameter Only | ✅ | per-run diameter override, scales bend-radius validation |
| 125 | Connect Tubes | ✅ | shipped in PR #79 (Tier 3 #60): `Run.Kind="jumper"` flag + `connectTubes` op + `'connect'` editor tool with hot-key `C`; dashed JUMPER render on print PDF; thinner / non-emissive render in 3D preview matching trade convention for glass-sleeved twisted lead-wire |
| 126 | Create Custom Housings | ✅ | shipped in PR #77 alongside #120 — custom tab in the housing picker modal accepts any positive bore diameter |
| 127 | Current Tube / Total Length | ✅ | live status badge in editor header |
| 128 | Insert Doublebacks | ✅ | "Insert DB" tool splices 4 vertices for a hairpin U at click point; default 1.5× ø depth + 1.0× ø gap (PR #18) |
| 129 | Maximum Tube Length | ✅ | validation rule + arc-midpoint flag |
| 130 | Move Opening / Break Tube Open | ✅ | shipped in PR #78 (Tier 3 #61): `breakOpen(doc, runId, vertexIndex)` + `moveOpening(doc, runId, newStartVertexIndex)` docOps + `'break-open'` canvas tool with hot-key `O`; live-arc-relative index invariants from PR #44 keep blockouts / annotations / bends consistent |
| 131 | Neonize (outline → tube path) | ✅ | Closed-polyline angle-bisector offset with miter clamp; default spacing 2× tube diameter (PR #26) |
| 132 | Neon Summary | ✅ | bend-list PDF page per run |
| 133 | Raceway Support | ❌ | deferred — NW's intent is ambiguous (validation rule vs. hardware spec model). Revisit after gathering more trade context from a shop using NW today |
| 134 | Switch Drop / Flat Blend | 🚫 | Tier 4 — terminology not in any source PDF (Miller / Strattman / Saving Neon / Blazek). May be a NW-specific 3D bend-mode that NeonBench's 2D pattern model doesn't need |
| 135 | Tube End Gap | ✅ | Per-project optional setting, default 6.35mm; stored, displayed, in PDF footer (PR #19) |
| 136 | Tube Support Holes | 🚫 | Tier 4 — already-shipped "support" annotations (NW #122 ✅) cover the location need; per-hole hardware geometry is graphic-design polish, not production-blocking |
| 137 | Neon Auto Tube Count | 🚫 | Tier 4 — single vs. double-stroke is a design choice, not auto-detected. Trade docs are silent. Revisit if a shop specifically requests bitmap-inferred layout |
| 138 | Neon Auto Spacing | 🚫 | Tier 4 — already covered by Neonize's 2× ø default (PR #26). NW's auto-spacing likely a per-diameter table; revisit only if Neonize defaults prove insufficient |
| 139 | Neon Preview (glow) | ✅ | three.js + react-three-fiber preview route renders extruded tubes with emissive gas materials, bloom post-processing, electrode caps, blockout sleeves, orbit camera with preset views, scene chrome + screenshot export (PRs #57–63) |
| 140 | Neon Preview for Groups | 🟡 | whole-design preview ships in PRs #57–63; multi-select half of Tier 3 #33 (33a) shipped in PR #81; per-group scoped preview waits on Tier 3 #33b (groups model — `specs/active/tier3-33b-groups.md`) |
| 141 | Parallel Tube Layout | ✅ | Same op as Neonize — emits inside + outside runs from a closed source (PR #26) |

### Fonts & Text (18 features)

- 🟡 #1 Direct Text Entry — Hershey single-stroke text shipped via modal in PR #8 + multi-line + per-letter kerning in PR #31 (Roman Simplex / Roman Duplex / Sans Simplex bundled); inline-on-canvas typing remains the gap.
- 🟡 #15 Kerning — per-letter custom kerning shipped via draggable triangle handles in the Hershey modal (PR #31); inline-on-canvas kerning still ❌.
- ❌ #2–13, 16, 17: property bar, script fonts, spacing/slant/arc/rotate handles, spell-check, WYSIWYG font picker, vertical text, change case
- 🟡 #14 Text Notes — per-run free-text Notes field; doc-level text labels via annotation
- ❌ #18 Font Wizard (match scanned letter to digital font)

### Design Tools (42 features)

- ✅ #36 Grids · #37 Anti-aliased rendering · #53 Automatic Vectorizing · #54 Dimensioning
- 🟡 #30 Color Management (per-run gas color only) · #32 Common Shapes (rect / circle shipped in PR #10; rounded-rect still missing) · #40 Measure Tool (via dimension lines) · #52 Text Notes Enhanced (per-run notes)
- ✅ #38 History Window (cross-session via design_versions list + in-session undo/redo with coalescing in `EditorPage.tsx`)
- ❌ #19, 22–29, 31, 33–35, 39, 41–51, 55–58, 60: depth order, alignment, anchor points, arrow tool, auto-square, border tool, break-into-outer-loops, distribute, layers, mirror, move-to-layer, nested groups, redo, rounded rect, rulers, guidelines, snap-to-guides, stack, step-and-repeat, polygon/star, styles, hotkeys, soft-shadow opts
- ❌ #20 Type1/OpenType font support · #59 Color Vectorizing
- 🚫 #21, 34, 51 Drawing engine / refresh / streamlined UI (modern web stack) · #58 TWAIN (use OS-level scanning)

### Effects (13 features)

- ❌ #61–73: Weld, Common Weld, Contour, Warp, Cast/Drop/Soft/Extruded/Perspective Shadow, Inline/Outline, Knife, Text on Path, Clipping Paths
- Mostly cosmetic/marketing-render features. Low priority for shop production; revisit if doing client mockups in NeonBench rather than a separate tool.

### Vector Graphics Tools (10 features)

- ✅ #80 Optimize Vectors (Douglas-Peucker simplify in editor sidebar)
- ✅ #78 Node Edit Tools (drag + delete + insert + split + join, all shipped — PR #23 closed insert/split/join; PR #44 added straddling-blockout split + numeric IDs + snap-to-vertex hover ring)
- 🟡 #81 PDF Import + Export (export ✅, import ❌) · #83 Vector Filters (SVG only)
- ❌ #75 Bezier Tool (pen tool in PR #10 emits polylines only; bezier handles tracked in Tier 3 #20) · #74 Tangency indicator · #76 AI/EPS import · #77 AI multi-version filter · #79 On-Screen Digitizing · #82 Sharp-Corner Tool

### Image Manipulation (7 features)

- ✅ #85 Export Original Bitmap (source asset persisted under `assets/<project>/`) · #86 Bitmap Rotate · #87 Brightness · #88 Contrast · #90 Crop (all four shipped in PR #15)
- 🟡 #84 Bitmap Filters (PNG/JPG only)
- ❌ #89 Saturation (color saturation adjustment doesn't help binarize-into-tube-paths and was deliberately skipped)

### Cutting / Plotting / Printing (18 features)

- ✅ #93 Horizontal/Vertical Paneling (oversize tiling) · #96 Plot to File (1:1 PDF) · #108 DXF Routing/Engraving export (PR #12; annotations layer in PR #28)
- ✅ #92 All Windows Printers (download → OS print dialog via hidden iframe + `window.print()` — PR #38)
- 🟡 #97 Print Preview (PDF is the preview)
- ❌ #94 Mirror/Scale/Rotate at plot · #98 Quick Plot · #99 Plot Step-and-Repeat
- ✅ #106 Channel Letter Return Patterns (per-run face flag + per-project depth + PDF unfolded-strip pages — PR #25; per-run depth override + perimeter validator + raceway grouping + strip-overlap shear line in PR #43)
- 🚫 #91, 95, 100–105, 107: plotter/cutter drivers, network plot, plot manager, USB cutter, weed lines/borders, Windows print driver, pen fill — neon shops use a printed full-size pattern, not a vinyl cutter

### Productivity (10 features)

- ✅ #109 Auto Save (every save → design_version row) · #112 Job Manager (customer / designer / due_date / job_number shipped in PR #14; sort + search + Overdue badge in PR #33) · #117 Zooming (pointer/wheel)
- 🟡 #115 Tool Tips
- ✅ #116 Unlimited Undo (cross-session via version log + in-session undo/redo with 500ms coalescing in `EditorPage.tsx`)
- ❌ #110 Customizable toolbar · #111 Email Layout · #113 Online Help · #114 Spell Checker · #118 Programmable Hotkeys

### Wide Format Printing (7 features)

- ❌ / 🚫 #142–148 (CMYK/HSV, GIF/TIFF LZW, stroke support, image resampling, WIA, external image edit, photomask). NeonBench is not a wide-format RIP — out of scope.

---

## Appendix B — Re-ranked next-tasks list (post-parity audit)

This list collapses todo.md gaps + NW parity findings into a single shop-readiness backlog, ordered roughly by leverage-per-effort. Tier 1 unblocks daily shop use; Tier 2 closes the largest parity gaps; Tier 3 is polish; Tier 4 is bounded "no" decisions.

### Tier 1 — Shop-readiness blockers (do first)

1. ✅ **Delete a design version + delete project** (UI). Shipped in PR #3. `DELETE /api/projects/{id}/design_versions/{vid}` + per-row delete buttons with confirm dialogs.
2. ✅ **Hershey single-line text tool in the editor** (NW #1, #15, #16, #18). Shipped in PR #8. Roman Simplex (`rowmans`) bundled as 12.7 KB JSON with public-domain attribution; `hersheyTextToRuns` returns one run per disconnected stroke (multi-stroke glyphs like `E`, `N`, `i` correctly emit multiple runs — matches real channel-letter construction). Implemented as a modal/dialog rather than a canvas tool to avoid touching `EditorCanvas.tsx`.
3. ✅ **Pen tool + rect / circle / arc primitives** (NW #32, #56, #75). Shipped in PR #10. Four canvas tools (pen + rect + circle + arc) wired into `EditorCanvas.tsx` matching the existing `blockout` / `dimension` / `NodeHandle` patterns. Geometry helpers in `web/src/lib/shapes/` are unit-tested in isolation. Backend lifted the "has no runs" guard from `handleCreateDesignVersion` + `handleValidateDoc` so blank designs can be created and validated; **"New blank design"** button on `ProjectDetail` is the entry point. Regular polygon, bezier handles, rotation handles, and angular snap during draw deferred to Tier 3.
4. ✅ **Live before/after threshold preview for raster vectorize** (todo.md:40, 49). Shipped in PR #5. Side-by-side Source / Binarized canvases in `VectorizePanel.tsx`, throttled with React 19's `useDeferredValue`, source pixel buffer cached so re-binarize is just an RGBA pass.
5. ✅ **Edit tube spec per project mutation UI** (todo.md:80). Project-detail dropdown was already shipped in commit 59fedea; the actual gap was the editor itself. Shipped in PR #6: inline `<select>` in editor header that PATCHes the project, immediately re-validates the current version against the new spec, surfaces the fresh report. Regression test guards the silently-stale-report failure mode.
6. ✅ **Windows smoke test** (todo.md:90). Shipped in PR #2 as a separate `windows-smoke` CI job (not a matrix on `test` — preserves branch protection's required-context contract). Includes `.gitattributes` `eol=lf` pin so Git Bash on Windows runners doesn't break on CRLF line endings.

Tier 1 regressions surfaced during May 2026 smoke testing. Numbering jumps because rows 7–63 were already taken by Tier 2 / Tier 3 work.

64. ✅ **Validation report `issues: null` regression** — Shipped in PR #66. Empty validations were marshaling `Issues` as JSON `null` (`append([]Issue(nil), ...)` returns nil), which crashed the editor on every blank-design open and on every reload of any version persisted while the bug was live. Fixed at the source — `internal/validate/validate.go` initializes the slice as non-nil empty — plus `web/src/api.ts` normalizes `issues == null` → `[]` at the JSON-parse boundary so legacy DB rows recover without a migration. Spec: `specs/done/tier1-64-validate-null-issues.md`.
65. ✅ **Editor full-width layout + toolbar wrap** — Shipped in PR #67. Global `.app { max-width: 960px }` constrained the editor to a 960px column on 1080p+ displays and pushed the toolbar buttons off the right edge. `.app:has(.editor-section) { max-width: none; }` opts the editor route out (list/detail pages stay narrow); `.editor-toolbar { flex-wrap: wrap; }` lets buttons drop to a second row on narrower viewports. Spec: `specs/done/tier1-65-editor-fullwidth-toolbar-wrap.md`.
66. ✅ **3D preview camera frustum culling tubes** — Shipped in PR #68. three.js's PerspectiveCamera defaults to `near: 0.1, far: 1000`; units are millimeters and the preset framing parks the camera at bbox.diagonal × 1.5 mm, so any sign whose 3D diagonal exceeded ~660 mm fell beyond the far plane and the entire scene was culled (visible as "glimpse of light during transitions, then nothing"). New `PREVIEW_CAMERA_CONFIG` widens to `near=1, far=1_000_000`; `OrbitControls maxDistance` bumped from 5 m to 50 m so preset framing for large signs isn't silently clamped. Spec: `specs/done/tier1-66-preview-camera-frustum.md`.
67. ✅ **3D preview ignored editor-picker color** — Shipped in PR #70. Editor saves slug values (`ruby-red`, `classic-red`, `hot-pink`, …) but the preview's `gasToEmissiveColor` keys off gas-name strings (`ruby red`, `cobalt blue`, …); hyphen vs space killed both direct and substring lookup, so every run resolved to the warm-white fallback at 0.75 intensity. Only `white` accidentally hit. Added an `EDITOR_COLOR_TO_GAS` bridge inside `gasColors.ts` translating the ten editor slugs to their `GAS_COLORS` keys before the existing fallback chain. No DB migration. Reconciling editor + GAS_COLORS into a single calibrated palette deferred to a Phase 3 follow-up. (NB: row 135 / Phase 3 #3 had claimed "Per-run color matches gas/phosphor" as ✅ shipped from PR #59; the slug↔gas-name mismatch surfaced here was the regression Tier 1 #67 fixed end-to-end.)
68. ✅ **PNG screenshot bypassed bloom** — Shipped in PR #85. `screenshot.ts` called `gl.render(scene, camera)` directly, bypassing the `EffectComposer`. PNGs came out flat-emissive (no bloom halo) regardless of on-screen state — preview as customer-sign-off surface lost fidelity. Fix: bridged the live composer instance via `EffectComposerContext` (exported by `@react-three/postprocessing`) inside Scene, plumbed through the existing `onCaptureReady` callback into a new optional `composer` arg on `captureCanvasToPNG`. When present, calls `composer.render()`; when absent or `null` (the `?nobloom` debug path), falls back to the bare `gl.render`. No new deps. Spec: `specs/done/tier1-68-png-screenshot-bypasses-bloom.md`.
69. ✅ **Per-gas emissive intensity tuning** — Shipped in PR #84. The uniform `DEFAULT_INTENSITY = 1.5` made cool-spectrum gases (cobalt blue, lime green, royal purple) read as "dull" against the dark scene because bloom amplifies brighter base hexes preferentially; only rose-pink read as convincingly lit (user reference). Replaced with a per-gas `GAS_INTENSITY` table keyed by `GAS_COLORS`: warm gases stay 1.5–1.7, cool gases bumped progressively up to 2.8 for cobalt blue. Hex values unchanged (calibrated against trade refs); only the multiplier is tuned. Resolver still falls back to `DEFAULT_INTENSITY = 1.8` for unmapped keys; unknown-gas `FALLBACK_INTENSITY = 0.75` semantic preserved. Spec: `specs/done/tier1-69-per-gas-intensity-tuning.md`.

### Tier 2 — Largest NW parity gaps

7. ✅ **Neonize / Parallel-tube layout / Auto Double-Stroke** (NW #123, #131, #141). Shipped in PR #26. Angle-bisector polygon offset with miter clamping (default `miterLimit = 4.0` matching SVG); closed-polyline only in V1; default spacing `2 × tube_diameter_mm` per Strattman NT Ch.7. Source run is replaced by two new runs (`<id>-outer`, `<id>-inner`); color/diameter/notes inherit. Self-intersection at concave corners surfaces a warning but emits the geometry anyway. Sidebar action only — `EditorCanvas.tsx` was kept untouched. Open polylines, self-intersection cleanup, and end-stitching via U-bends deferred to Tier 3.
8. ✅ **In-session undo/redo with coalescing** (todo.md:106; NW #44, #116). Already shipped — `EditorPage.tsx:46-118` has `undoStackRef` / `redoStackRef`, 500ms coalescing of rapid sequential edits, Cmd/Ctrl+Z + Cmd/Ctrl+Shift+Z keyboard shortcuts. Phase 2 row 106 and Appendix A NW #38 / #116 stale claims fixed.
9. ✅ **Node insert / break / join** (todo.md:102, 104; NW #78). Shipped in PR #23. Three new helpers in `docOps.ts` — `insertVertex`, `splitRun`, `joinRuns` — wired into the existing `node` tool. UX: alt-click empty segment inserts; alt-click vertex splits; sidebar "Join from head/tail" arms a two-click endpoint selector with green pulse highlight. All operations route through `editDoc()` so undo/redo just works. Index-shifting unified across electrodes / blockouts / annotations / bends; 12 tests cover the boundary conditions.
10. ✅ **Channel letter return patterns** (NW #106). Shipped in PR #25. Per-run `IsChannelLetterFace` flag (design-doc) + per-project `ChannelLetterDepthMM` (migration `0007`, default 100mm). PDF emits one extra page per face-marked run with the unfolded return strip — rectangle perimeter × depth with a tick + cumulative arc length + signed turn angle (positive = bend inward) at every polyline vertex. Open polylines emit the strip with a red warning footer. Per-run depth override + perimeter-vs-blank-length validation deferred to Tier 3.
11. ✅ **DXF export for CNC tube benders** (todo.md:148; NW #108). Shipped in PR #12. R12 ASCII (lowest-common-denominator across CAM importers), `LWPOLYLINE` per run, mm units (`$INSUNITS=4`), layer-per-run (`RUN_<id>`) for filterable selection in CAD. No annotations in V1 (DXF is the bender geometry feed; PDF stays the human pattern). Same validation-error gate as PDF.
12. ✅ **Import the .neonbench bundle** (todo.md:124). Shipped in PR #13. Closes the export round-trip via `POST /api/projects/import`. Tube-spec dedup by **dimensions** (within 1µm) so re-importing reuses seeded specs instead of duplicating. Project name collision → `(imported)`/`(imported 2)` suffixes. Single transaction wraps project + all versions; rollback on any failure. Zip-bomb safe with per-entry size cap.
13. ✅ **Job Manager fields: customer, designer, due date, job number** (NW #112). Shipped in PR #14. Migration `0005_project_metadata.sql` (reversible Down test). All four optional, trim + length validation, strict `YYYY-MM-DD` format check. Click-to-edit pattern on detail page matches existing tube-spec dropdown's auto-save UX.
14. ✅ **Insert Doubleback tool** (NW #128). Shipped in PR #18. Click a polyline segment with the new "Insert DB" tool → 4 vertices spliced in to form a hairpin U-bend (default depth 1.5× tube ø, gap 1.0× tube ø per Strattman). Honors per-run tube_diameter override before falling back to project tube spec. Shift-click flips the hairpin to the opposite side. Index-shifting unified across electrodes / blockouts / annotations / bends with full test coverage of the boundary condition.
15. ✅ **Tube End Gap setting** (NW #135). Shipped in PR #19. Per-project optional value (default 6.35mm = 1/4 inch per Miller App I §126 / UL 1930). Stored via migration 0006, validated 0–100mm range, surfaced in project metadata + create modal + PDF footer. PATCH uses `json.RawMessage` to distinguish omitted / null / explicit number so users can clear an override back to default. V1 stores and displays only — actual frame/substrate-aware validation tracked under Tier 3 #27.
16. ✅ **Bitmap pre-vectorize adjustments: rotate / crop / brightness / contrast** (NW #86–90). Shipped in PR #15. Apply order: `rotate → crop → brightness → contrast → luminance → threshold`. Each adjustment is a no-op at zero so the existing fast path stays intact. Live preview chain extended from PR #5's cached pixel buffer through all four adjustments client-side BEFORE the threshold pass. UI in a collapsed `<details>` block (collapsed by default).

### Tier 3 — Polish & validator depth

17. ✅ **ESLint cleanup + flip CI to hard-gate.** Shipped in PR #37. All 10 pre-existing errors fixed at the pattern level (no targeted disables): `docOps.ts` unused `_drop`/`_closed` rewritten via shallow-copy + `delete`, `EditorCanvas.tsx` setState-in-effect converted to React's "previous prop in state" render-time pattern, `EditorPage.tsx` refs-during-render replaced by mirrored `undoLen`/`redoLen` state (vestigial `historyTick` removed entirely), `ProjectDetail.tsx` setState-in-effect folded inline with a `cancelled` flag. CI's lint step renamed from "ESLint (advisory)" to "ESLint" with `continue-on-error` removed — lint is now a **hard-gate** on every PR. Vestigial `shapeDragRef` write-only flagged as a follow-up; consolidating drawing-tool state under `useReducer` flagged as a larger refactor follow-up.
18. ✅ **Fan tube-spec change to revalidate every design version.** Shipped in PR #40. New `revalidateAllForTubeSpec(ctx, db, tubeSpecID)` walks `projects WHERE tube_spec_id = ?` → `ListDesignVersions` → `revalidateOne` (extracted from `handleRevalidate`). New `PATCH /api/tube_specs/{id}` route registered (the spec assumed `PUT` existed; reality only had GET, so an additive route landed instead). Response carries `{tube_spec, revalidated: {project_count, version_count, failed_count}}`. Frontend renders an inline `<TubeSpecEditor>` next to the existing dropdown plus a 4-second auto-dismissing toast banner. Per-version errors are logged + counted but never roll back the spec UPDATE — operator's primary action is the spec edit; one bad historical SVG should not veto a shop's bend-radius tightening.
19. ✅ **Hershey text — kerning / multi-line / additional faces** (NW #1, #15). Shipped in PR #31. Per-pair kerning via draggable triangle handles in the modal SVG preview (1 px screen = 1 mm design); multi-line `<textarea>` with configurable line-height (default 1.2× cap height); two new bundled faces — Roman Duplex (~21 KB, thicker channel-letter look) and Sans Simplex / Futural (~13 KB, geometric sans). Build script gains `--font <key>`. Newlines do NOT consume kerning slots so the array stays positionally stable across line edits. Optical-kerning auto-pairs, kerning preset library, and per-line baseline shift deferred to follow-up rows.
20. **Drawing-tool polish.** PR #10 ships pen + rect + circle + arc; deferred items are: regular-polygon tool (NW #56), bezier handles on pen finish (NW #75 — currently emits polylines only), rotation handle on rect (axis-aligned in V1), rounded-rectangle (closes NW #32 fully), and fixing the pen tool's hit-zone collision with existing runs (clicking on top of a run currently selects the run instead of dropping a new vertex — fine for blank designs, awkward when extending an existing one).
21. ✅ **DXF annotations layer** (NW #108 enrichment). Shipped in PR #28. Three new entity emitters layered on top of the geometry-only DXF: electrode `CIRCLE` entities (radius 3 mm) on a dedicated `ELECTRODES` layer; run labels (`Run N`) + free-form `Doc.Labels` as `TEXT` entities on `LABELS`; `Doc.Dimensions` as `LINE`+`TEXT` pairs (right-hand-normal offset by one text-height) on `DIMENSIONS`. Geometry-only docs produce byte-identical output (golden-test guarded). LINE+TEXT chosen over real R12 `DIMENSION` entities because every CAM importer renders it identically and `DIMENSION` requires BLOCK-reference plumbing for zero shop benefit. Annotation markers for jump/support, blockout shading, R2000+ dialect, and per-bender G-code post-processors deferred.
22. ✅ **Bundle-import polish: drag-drop + schema dispatcher** (NW #109 enrichment). Shipped in PR #29. `ProjectList` now accepts `.neonbench` files via drop (drag-depth-counter overlay, `pointer-events: none` on the hint, MIME fallback to `application/zip`). `handleImportBundle` split into a thin dispatcher + `importBundleV1` so future schema bumps (`manifest.schema > 1`) get a clean forward-migration switch — the dispatcher rejects newer schemas with HTTP 422 and a clear upgrade message, treats `schema == 0` as legacy v1, rejects negatives with 400. Multi-file drops keep file[0] and console-warn the rest. ProjectDetail-level drag-drop for raw images and bundle-contents preview deferred to follow-ups.
23. ✅ **Job-tracking polish: sort, search, overdue badge, .job-field CSS** (NW #112 enrichment). Shipped in PR #33. Project list gains a controls row above the list with a search input (case-insensitive substring across name / customer / job_number) and a sort `<select>` with `Recently updated` (default) / `Due date (next-first)` / `Name (A–Z)` modes. New `Overdue` red pill on rows whose `due_date < today` (and on the project-detail header). New shared `web/src/lib/dueDate.ts` exports `humanizeDueDate` + `isOverdue` with a 9-case test suite. `.job-field` and `.job-field-value` rules added to App.css so the click-to-edit affordance matches the muted `.meta` text style. URL/localStorage persistence, server-side filtering, "Hide completed" toggle, and calendar view deferred.
24. ✅ **Bitmap-adjustment polish: draggable crop + Hough auto-rotate** (NW #86–90 enrichment). Shipped in PR #30. New `web/src/lib/hough.ts` runs greyscale → downsample-to-512 → Sobel → Hough peak detection in two narrow theta windows (around 0° and 90° to catch tilted-vertical AND tilted-horizontal dominant lines symmetrically), with parabolic sub-bin refinement and a `peak / (median + 1)` confidence gate (default threshold 3.0). 7.5 ms median on a tilted-bars 1024×768 cache buffer; well under the 500 ms budget. Auto-rotate button next to the rotation slider sets the suggested angle with a 4 s confidence hint. Crop overlay supports rubber-band creation, body-translate, 4-corner + 4-edge handle resize (Shift on corners locks aspect), with mask quads dimming the area outside the crop. Aspect-lock on edges, persistent confidence badge, RGB-curve adjustments, and Hough peak-list mode deferred. **The pre-existing cache-pixel vs full-res crop coordinate mismatch was deliberately NOT fixed** — flagged as a Tier 3 follow-up.
25. ✅ **Node-edit polish: blockout split + numeric IDs + snap-to-vertex hover** (NW #78 enrichment). Shipped in PR #44. Straddling blockouts now split into two pieces instead of being dropped with `console.warn` (`[lo, point-1]` keeps run-A, `[0, hi-point]` becomes run-B's blockout — duplicated seam vertex excluded from both). New `nextRunId(doc, prefix='r')` returns the lowest-unused `${prefix}${n}` id; `splitRun` now allocates `r1`/`r2` instead of `<id>-a`/`<id>-b`. Alt-hover in node-edit mode renders a teal hover ring (#1aa37a, radius 8/k, stroke 6/k) above runs and below NodeHandles; alt-click within snap range is a no-op so accidental dedup-creation is impossible. 73 docOps tests pass (was 66). Multi-vertex select + drag, vertex-merge inverse op, and legacy `<id>-a`/`<id>-b` auto-rename deferred to follow-ups.
26. ✅ **Channel-letter return polish: per-run depth + perimeter validation + raceway grouping + strip overlap** (NW #106 enrichment). Shipped in PR #43. Migration `0011` (the spec reserved `0008` but `0009`/`0010` had already shipped) adds nullable `projects.strip_overlap_mm` (default 12.7 mm = ½ in). New per-run `Run.ChannelLetterDepthMM` overrides project default → 100 mm shop fallback. New `RuleFacePerimeterExceedsBlank` (warning, threshold 1168 mm = 46-in Strattman coil) flows through a new `data-channel-letter-face` SVG attribute and lands at the run centroid, so PR #41's marker overlay renders it without further plumbing. Strip-overlap shear line drawn at the right end of every per-run AND raceway strip (dashed, "shear here · N mm overlap" label). New `internal/printpdf/raceway.go` (281 lines) buckets face runs by non-empty `RacewayID` in declaration order, emits one combined page per group with heavy dashed boundaries between contributions and dotted depth indicators when group depths vary. Auto-raceway grouping by baseline + bbox proximity, severity escalation toggle, full-Limits forwarding in `handlers_vectorize.go`, and bundle round-trip of `strip_overlap_mm` deferred to follow-ups.
27. ✅ **Neonize polish: open polylines + stitch-ends + cap styles** (NW #123, #131, #141 enrichment). Shipped in PR #34. `offsetPolygon` extended with self-intersection-loop pruning + per-vertex cap-style support; new `offsetOpenPolyline` helper handles parallel offsets for non-closed sources. `neonize` accepts an optional `stitch: boolean` (default false → keep two-run output) and a `cornerStyles?: ('miter'|'round'|'bevel')[]` array per source vertex; stitched output is one continuous tube via U-bends at the ends (true single-tube double-stroke per Strattman combination-bend pattern). Sidebar Neonize button gains a small popover with the stitch toggle. Per-corner cap-style canvas UI deferred to a vertex-detail panel follow-up.
28. ✅ **Visual marker overlay on SVG preview** (todo.md:61). Shipped in PR #41. New `validationIssues?: ValidationIssue[]` prop on `EditorCanvas` renders a `<circle>` per issue with severity-driven stroke (`var(--error)` / `var(--warn)`) and ~45%-alpha fill. Radius `max(8/k, 4 mm)` mirrors snap-handle math so markers feel sized like the rest of the canvas chrome. Issues with non-finite or out-of-bbox coordinates are filtered before render; clicking a marker calls `onSelectRun` after a `nearestRunId` walk over polyline vertices. Native `<title>` element provides accessible tooltips. `@media print` rule hides markers from print output. Severity filter / toggle, keyboard-nav between markers, and sidebar↔canvas hover linking deferred.
29. ✅ **Lead-in length + sharp-bend angle validation** (todo.md:62). Shipped in PR #35. Two new validator rules: `RuleMinLeadIn` flags runs whose first/last segment falls below the tube spec's `MinLeadInMM` (defaults derived from tube diameter when unset); `RuleSharpBendAngle` flags interior vertex angles below `SharpBendAngleDeg`. Both limits surface on `tube_specs` (migration `0009`); rules emit issues with `x_mm`/`y_mm` for the eventual marker overlay (#28). Tube-spec UI for the new fields deferred to a follow-up row.
30. **Glass-to-grounded-metal / HV-cable spacing** (todo.md:63) — **BLOCKED** until the design doc gains a cabinet outline + transformer placement + HV cable routing model. Spec drafted under `specs/active/tier3-30-hv-cable-spacing.md` documents the prerequisite design contract. Do not dispatch as-is.
31. ✅ **Tighten bend-radius defaults to wall-thinning derivation** (todo.md:64). Shipped in PR #42. Migration `0010` adds nullable `wall_thickness_mm` + `bend_technique` columns to `tube_specs` (techniques: `ribbon` / `crossfire` / `hand_torch`) and reversibly backfills the four seeded rows. New `derivedMinBendRadius(D, t, technique) = K·D²/t` with K ∈ {ribbon=0.20, crossfire=0.225, hand_torch=0.275}; falls back to `2.25·D` when wall/technique is missing. `runBendLimitMM` consults the derivation when `MinBendRadiusMM = 0`. Editor (`<TubeSpecEditor>`) shows wall/technique read-only with a live "derived NN.N mm" indicator and a "Use derived" button that copies the value into the manual override input. K constants documented as a NeonBench-internal calibration (the trade literature does not tabulate this). Extending `PATCH /api/tube_specs/{id}` to accept wall_thickness/technique, per-glass-type presets, double-walled K constants, and full-Limits forwarding in `handlers_*` deferred.
32. ✅ **Send to printer via OS print dialog** (todo.md:75; NW #92 enrichment). Shipped in PR #38. Print button on the editor toolbar mounts a hidden iframe pointing at the existing `print.pdf` endpoint, then calls `iframe.contentWindow.print()` after `setTimeout(0)` (Safari needs the deferral; Chrome/Firefox tolerate it). New `PrintHost.tsx` (105 lines) owns the iframe lifecycle and uses parent-window `focus` as the close signal with a 60s fallback. Button is disabled while `dirty` (the print PDF reflects saved state, not in-memory edits). `@media print` block in `App.css` is a safety net for direct browser File→Print of the parent DOM. Paper-size + landscape selectors in toolbar, print-return-strip-only filter, and pre-dialog thumbnail preview deferred.
33. 🟡 **Drag-drop file upload + multi-select / group / layers** (todo.md:81, 105). 33a (multi-select + drag-drop image upload) shipped in PR #81 — `selectedRunIds: string[]` replaces the legacy `selectedRunId` everywhere; Shift/Cmd-click toggles, Cmd-A selects all, multi-op (Neonize/Simplify/Reverse/etc.) loops in selection order. ProjectDetail drag-drop image upload mirrors PR #22's depth-counter pattern. Groups (33b) + Layers (33c) specs drafted at `specs/active/tier3-33b-groups.md` + `specs/active/tier3-33c-layers.md`; 33b unblocks Tier 3 #63 once it ships.
34. ✅ **Snap-to-angle and snap-to-geometry** (todo.md:104). Shipped in PR #74. Pen / rect / circle / arc tools now consume the snap-angle and snap-geometry settings during draw (the props were wired but unconsumed before). Active polyline endpoints + existing-run vertices snap within radius; angle snap holds Shift to constrain to 15° increments. Angular tickmarks render during the drag preview.
35. ✅ **Sample bitmaps + golden vectorized outputs** (todo.md:91). Shipped in PR #39. New `internal/vectorize/testdata/goldens/` corpus (six small PNG fixtures, each <300 bytes, all under 256×256 px) paired with `.golden.json` captures: `block_letter_i`, `thin_l`, `broken_horizontal`, `near_touching_bars`, `square_corners` (closed polyline), `curve_u` — covers thick fills, thin strokes, sub-spur gaps, non-merge separation, sharp corners, continuous curves. New `TestVectorizeGoldens` re-runs `VectorizeRaster` on each fixture and diffs to the golden within tolerance (run_count exact, total_length within 0.5%, vertex count ±1, per-vertex 0.1 mm; JSON points pre-rounded to 1 micron to absorb platform float noise). `-update` flag re-emits goldens; `scripts/regen-vectorize-goldens.go` (`//go:build ignore`) redraws PNGs + goldens deterministically. Total testdata: 8.4 KB. Threshold-sweep parametric coverage, benchmark harness on the same fixtures, and visual-diff failure artifacts deferred.
36. ✅ **Cache-pixel vs full-res crop coordinate fix** *(deferred from #24)*. Shipped in PR #49. New `web/src/lib/cropCoords.ts` lifts the conversion into a pure helper `cacheToFullRes(crop, cacheScale)` with vitest coverage. `VectorizePanel.submit()` computes the cache scale from `source.originalWidth / source.width` and scales x/y/w/h on the way out. The user-visible crop fields (typed inputs + draggable overlay) stay in cache-pixel space — only the wire format changes. Reload strategy: leave-as-is — VectorizePanel never receives a prior crop as a prop, always mounts from `DEFAULT_ADJUSTMENTS`. Three-space (display / cache / full-res) documentation comment block, inverse helper for the eventual edit-prior-crop flow, and the broader pre-vectorize asset-management story all deferred to follow-ups.
37. **Hershey text quality-of-life** *(follow-ups from #19)*. Kerning preset library ("AV", "To", "WA" pairs auto-tightened on insert); optical-kerning auto-pair (compute pair-specific defaults from each font's glyph metrics); font-preview thumbnails in the picker; vertical drag on kerning handles for per-line baseline shift (e.g. `OPEN` + `2026` mid-aligned).
38. **DXF / bundle / job-tracking minor follow-ups.** DXF: annotation markers for `Run.Annotations` (jump / support) on a `MARKERS` layer; blockout shading on a `BLOCKOUTS` layer; optional R2000+ dialect for shops whose CAM rejects R12; per-bender G-code post-processors. Bundle: pre-import preview dialog (project name / version count / tube-spec dims) so users can cancel a wrong drop. Job tracking: URL/localStorage persistence for sort/search; "Hide completed" toggle once a completion flag exists; calendar view of due dates.
39. **Hough auto-rotate quality-of-life** *(follow-ups from #24)*. Aspect-ratio lock on edge drags (Shift currently no-ops on edges); persistent "Last: −1.7° (conf 4.2×)" sticky badge so users can re-summon the suggestion; Hough peak-list mode that surfaces both candidates when both horizontal AND vertical strong features compete (today the function returns the single dominant orientation, sometimes off by 90° from the user's mental model); per-channel RGB curves (out-of-scope for binarize but useful for tinted source photos).
40. **Bundle schema v2 design notes** *(follow-up from #22)*. Likely v2 candidates: per-version asset references (raw bitmap + vectorize params), per-project metadata fields (customer / designer / job_number that don't survive v1 round-trip), saved layer state. Land when at least one of those features needs to round-trip.
41. ✅ **Tube-spec edit modal: lead-in / sharp-bend fields** *(follow-up from #29)*. Shipped in PR #75. Three-state `PATCH /api/tube_specs/{id}` extended with `min_lead_in_mm` (range `[0, 500]` mm) and `sharp_bend_angle_deg` (range `[0, 180]` degrees, with `null` clearing). `<TubeSpecEditor>` gains two number inputs next to the existing `min_bend_radius_mm` field; placeholder text shows the derived default when null. Live revalidate after PATCH commits, same pattern as PR #53.
42. ✅ **Drawing-tool state consolidation refactor** *(follow-up from #17)*. Shipped in PR #72. EditorCanvas's six pieces of drawing-tool state (`pen`, `rect`, `circle`, `arc`, `blockout`, `dimension`) consolidated under a `useReducer` over a `currentTool` discriminated union; tool-change cleanup is now an `INIT` action on the reducer instead of an effect. Vestigial `shapeDragRef` deleted (only ever written, never read).
43. ✅ **PATCH /api/tube_specs/{id} for wall thickness + technique** *(follow-up from #31)*. Shipped in PR #53. Three-state PATCH (omit/null/value) for `wall_thickness_mm` (range `[0.1, 10.0]` mm) and `bend_technique` (server-side whitelist: `ribbon` / `crossfire` / `hand_torch`, with `""` clearing). Editor's read-only display fields promoted to editable number input + dropdown wired into the existing `<TubeSpecEditor>` commit flow; the live "Derived: NN.N mm" indicator updates as you type. 5 new integration tests covering preserve / clear / whitelist-reject / fan-out-revalidate / accept-all-three-techniques. Per-glass-type technique presets and project-level "preferred technique" pre-selection deferred to follow-ups.
44. ✅ **Full-Limits forwarding in handlers** *(follow-up from #26 + #29 + #31)*. Shipped in PR #50. Audit found two `validate.Limits{...}` construction sites: `handlers_designdoc.go:52` (`handleValidateDoc`) and `handlers_vectorize.go:239` (`runValidation`, used by vectorize / revalidate / new-version / fan-out paths). Both updated to forward all 8 fields. `handlers_tube_specs.go` inherits the fix transitively via `revalidateOne`. **Validator bug surfaced**: `checkBendRadius` in `validate/rules.go:155` early-returns when `MinBendRadiusMM <= 0`, gating out the wall+technique-derived path that PR #42 wired through `runBendLimitMM`. Test substituted `sharp_bend_angle` (also a Tier 3 #29 wiring gap that this PR closed) as the second probed field. Centralizing the 8-field mapping in a `tubeSpecToLimits(spec) validate.Limits` helper, dropping the early-return guard, and PATCH-surface for the four optional tube-spec columns deferred to follow-ups.
45. **Bundle round-trip of strip_overlap_mm + lead-in fields** *(follow-up from #26)*. `bundleProject` only carries name/units/timestamps — same gap exists for `tube_end_gap_mm`, `channel_letter_depth_mm`, `strip_overlap_mm`, and the tube-spec lead-in fields. Bundle schema v2 (#40) is the natural home.
46. ✅ **Channel-letter polish v2** *(follow-up from #26)*. Shipped in PR #73. Auto-raceway grouping clusters face runs by baseline-Y proximity (within `1.5 × max(channelLetterDepthMM)` mm) and bbox-X overlap, then assigns each cluster a synthetic `auto-rcw-N` `RacewayID` when the user hasn't set one manually. New per-project `face_perimeter_strict_mode` flag (default off) escalates `RuleFacePerimeterExceedsBlank` from warning to error; project-detail toggle wired into the existing job-fields UI.
47. ✅ **Marker overlay polish: severity filter + keyboard nav + hover linking** *(follow-up from #28)*. Shipped in PR #54. Sidebar checkboxes hide errors-or-warnings (filter applies to both the sidebar list AND the canvas markers); `j` / `k` (and `]` / `[`) cycle the visible filtered issues, pan-zooming the canvas to each at 200 ms cubic-ease without rescaling current zoom. Sidebar↔canvas hover linking: hovering an issue row pulses the matching canvas marker via a 1.4 s stroke-width + stroke-opacity loop animation (intentionally subtler than PR #44's teal hover ring so the two states stay distinguishable); pulse animates stroke, NOT radius (radius drift would move the centroid off the issue's world coordinate). Sidebar-click selects the nearest run + sets the j/k cursor. Index space is global (into `report.issues`); canvas filters by severity internally. localStorage persistence, run-detail-panel issues filter, and color-blind-friendly severity palette deferred to follow-ups.
48. **Node-edit polish v2** *(follow-up from #25)*. Multi-vertex select + drag in node-edit mode (rubber-band or shift-click to grow selection); drag-a-vertex-onto-another-vertex merge (the inverse of split, useful after import); auto-rename legacy `<id>-a` / `<id>-b` runs to the new numeric scheme on doc load (opt-in migration); snap-to-vertex on the join-arming flow's second-endpoint click.
49. **Vectorize regression depth** *(follow-up from #35)*. Threshold-sweep parametric coverage on the existing fixture corpus; benchmark harness on the same fixtures (catches O(n²) regressions at the same point as correctness); visual-diff SVG artifact dumped on test failure into `testdata/goldens/_failures/` for faster reviewer triage; per-diameter sweep (8/12/15 mm) to catch regressions in diameter-derived `min_spur` / `smoothing` defaults.
50. 🟡 **OS print polish** *(follow-up from #32)*. Backend half shipped in PR #51: `?strips_only=1` query param on `/print.pdf` + `RenderFromDoc` `StripsOnly` option that suppresses the main pattern + bend-list pages and emits only per-run channel-letter return-strip pages and any raceway-grouped strip pages. Zero-strip docs return 422 with a clear remediation message (chose fail-loud over empty-PDF). Bonus bug fix: removed an `if-init` shadowing of `err` in `handlePrintPDF` that was silently swallowing render errors. **Frontend popover deferred** (see #52 below) — agent stalled before that half landed.
51. ✅ **Tube-spec CRUD** *(follow-up from #18)*. Shipped in PR #76. `POST /api/tube_specs` (with full-field validation matching the existing PATCH whitelist) + `DELETE /api/tube_specs/{id}` (FK-safe — refuses delete when projects reference the spec, with HTTP 409 + remediation message). New `storage.CreateTubeSpec` + `storage.UpdateTubeSpec` + `storage.DeleteTubeSpec` extracted to match the existing `UpdateProject` handler shape. Operator-facing UI: "Add tube spec" button on the project detail page opens the existing `<TubeSpecEditor>` in create mode; spec-row delete buttons on the spec list with confirm dialog matching the project-delete pattern.
52. **OS print frontend popover** *(follow-up from #50 partial)*. Backend's `?strips_only=1` shipped in PR #51 but the toolbar popover (paper-size + landscape + strips-only checkboxes next to the existing Print button on `EditorPage.tsx`) never landed — the agent stalled mid-test-run after committing only the backend. Need: extend `printPDFURL` in `api.ts` to accept `{paper, landscape, stripsOnly}`, wire `<PrintHost>` to pass them through, build the floating popover (~200 lines TSX + ~50 lines CSS), gate-by-dirty same as today's button. The existing `<PrintPanel>` on ProjectDetail.tsx already exposes paper/landscape selectors and can be the design reference.
53. **Phase 3 follow-up — wire project tube spec into PreviewPage** *(follow-up from #2)*. `Scene.tsx` has a `defaultDiameterMM` prop with a defensive 12 mm fallback; `PreviewPage` doesn't pass it. One-line edit: load the project's tube spec via `api.listTubeSpecs()` and forward `tube_spec.diameter_mm`. Without this, runs without `diameter_mm_override` always render at 12 mm in the preview regardless of the project's actual tube spec.
54. ✅ **Phase 3 follow-up — screenshot capture bypasses bloom** *(follow-up from #4)*. Shipped as Tier 1 #68 in PR #85. See row 68 above for the full writeup.
55. **Phase 3 follow-up — bloom intensity slider in scene controls** *(follow-up from #4)*. `Scene.tsx` exports `BLOOM_INTENSITY` / `BLOOM_LUMINANCE_THRESHOLD` / `BLOOM_RADIUS` constants; surface them as sliders in the existing `<SceneControls>` panel so per-project tuning is possible without a code change. Persist to localStorage along with background / wall / ambient when #56 ships.
56. **Phase 3 follow-up — scene-control persistence** *(follow-up from #7)*. The control sidebar (background, wall on/off + color, ambient slider) holds state in `useState`, so settings reset on every preview-route mount. Persist to localStorage keyed by `projectId` (or globally — TBD); reset button clears.
57. **Phase 3 follow-up — code-splitting the preview route** *(follow-up from #1)*. The four three-stack packages weigh ~310 KB gzipped on the main bundle; users who never visit the preview pay that cost. Wrap `PreviewPage` in `React.lazy(() => import('./preview/PreviewPage'))` with a `<Suspense>` boundary. Recoups the ~217 KB gzipped delta from #57 and reduces initial paint cost meaningfully.
58. 🟡 **Phase 3 follow-up — animated warm-up flicker + per-gas intensity tuning** *(follow-up from #3 + #4)*. Per-gas intensity tuning shipped as Tier 1 #69 in PR #84 (see row 69 above). Animated warm-up flicker still deferred — optional cosmetic 1.5–3 s `useFrame` time-driven `emissiveIntensity` modulation on initial load; the per-gas baseline is the anchor that animation multiplies against.
59. **Phase 3 follow-up — closed-loop seam continuity at blockout boundaries** *(follow-up from #6)*. Spec drafted at `specs/active/tier3-59-closed-loop-blockout-seam.md`. When a blockout straddles index 0 of a closed live arc, `blockoutSegments` emits two segments where one is correct; fix merges them in both the TS helper and its Go mirror. Rare edge case (decorative trim loops with mid-loop blockouts); spec'd but not dispatched yet.
60. ✅ **Connect Tubes — jumper runs** (NW #125). Shipped in PR #79. `Run.Kind` field (`""` | `"jumper"`) + `connectTubes(doc, fromRunId, fromElectrodeIdx, toRunId, toElectrodeIdx)` op + `'connect'` editor tool with hot-key `C` + dashed jumper rendering on the print PDF + thinner / dimmer jumper rendering in the 3D preview (radius halved, no emissive — reads as glass-sleeved twisted lead-wire per Miller p.204–205). JSON-blob storage means no migration. V1 is 2-vertex jumpers; multi-vertex routed + per-jumper diameter override deferred. Spec: `specs/done/tier3-60-connect-tubes.md`.
61. ✅ **Move Opening / Break Tube Open** (NW #130). Shipped in PR #78. `breakOpen(doc, runId, vertexIndex)` converts a closed polyline to open with electrodes inserted at the chosen vertex; `moveOpening(doc, runId, newStartVertexIndex)` rotates an open run's polyline so the gap lands at a new vertex. Live-arc index invariants from PR #44 keep blockouts / annotations / bends consistent. New `'break-open'` canvas tool with hot-key `O` dispatches based on run's `closed` flag. Spec: `specs/done/tier3-61-move-opening-break-tube.md`.
62. ✅ **Common + Custom electrode housings** (NW #120 + #126, combined). Shipped in PR #77. `Electrode` extended with `HousingType` / `BoreDiameterMM` / `ElevationMM` (all optional, JSON-blob storage so no migration). Stock library covers Strattman 15-shell + 19-shell; housing-picker modal with custom tab accepting any positive bore. Right-click on electrode pins opens the picker. Bend-list PDF gets a "Housings" subsection per run. 3D preview renders housing cylinders at the bore size with porcelain-like material. Spec: `specs/done/tier3-62-housings-common-and-custom.md`.
63. **Neon Preview for Groups** (NW #140) — **BLOCKED on Tier 3 #33b (groups model).** Spec drafted at `specs/active/tier3-63-preview-for-groups.md`. 33a (multi-select) shipped in PR #81 but `Run.GroupID` requires 33b (`specs/active/tier3-33b-groups.md`); once 33b lands, this is unblocked.

Tier 3 jump-offset row added retroactively (the spec landed before this row was authored):

68. ✅ **Jump annotations lift the tube in the 3D preview** (Tier 3 #68). Shipped in PR #71. Every `kind: 'jump'` annotation on a run causes that run's tube geometry to lift smoothly out of the XY plane via a raised-cosine kernel sized relative to the tube diameter (`HEIGHT = 2.5 × diameter`, `SPAN = 4.0 × diameter`). Two crossing tubes now read as one passing *over* the other in 3D instead of visibly intersecting. Multi-jump cluster threshold (`CLUSTER_GAP_MULT = 4.0 × diameter`) merges close jumps into one tabletop plateau so marking entry+exit of a crossing produces a continuous bridge instead of an "M-shaped" valley. Distance is arc length along the polyline (not Euclidean) so the lift follows the tube path through corners. Spec: `specs/done/tier3-68-jump-offset-3d.md`.

### Tier 4 — Deliberate "no for now"

These are NW-the-graphic-design-suite, not NW-the-neon-tool. Skip unless a shop specifically asks:

- All shadows / effects (NW #61–73, #142–148)
- Vinyl-cutter plumbing (NW #91, #95, #101–105, #107)
- TWAIN / WIA (NW #58, #146)
- Email Layout / Spell Checker / Customizable toolbar (NW #111, #114, #110)
- Color Vectorizing (NW #59) — single-color binarize is the right model for tube production
- **Mounting Holes (NW #121)** — substrate fastener placement is shop-assembly metadata, not pattern-production. Revisit if a shop integrates NeonBench output with a CNC back-pan cutter
- **Switch Drop / Flat Blend (NW #134)** — terminology absent from Miller / Strattman / Saving Neon / Blazek. Likely a NW-specific 3D bend-mode tag that NeonBench's 2D pattern model doesn't represent; revisit only if a shop migrating from NW asks for it specifically
- **Tube Support Holes (NW #136)** — already-shipped "support" annotations (NW #122 ✅) cover the location requirement; per-hole hardware geometry is graphic-design polish
- **Auto Tube Count (NW #137)** — single vs. double-stroke is a deliberate design decision, not auto-detected from bitmap stroke width; trade docs are silent. Revisit if a shop specifically asks for bitmap-inferred layout
- **Auto Spacing (NW #138)** — already covered by Neonize's 2× ø default spacing (PR #26). NW's auto-spacing is likely a per-tube-diameter table; revisit only if Neonize's defaults prove insufficient in production
