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
- [ ] PNG/JPG: adjustable threshold preview before vectorize (currently sent as a request param; live canvas preview is a v1.x polish item)
- [x] SVG: skip vectorization, persist as design_version pass-through
- [x] Store original asset on disk under `<data-dir>/assets/<project_id>/` with metadata in DB

### Vectorization

- [x] **Centerline extraction via skeleton-graph (replaces potrace).** Pipeline: Decode → Binarize → Zhang-Suen thin → classify (arc-count test) → merge thick junction clusters → walk graph into open + closed polylines → spur prune (iterate until stable) → mm conversion → Ramer-Douglas-Peucker simplify → emit SVG. Pure Go, no third-party deps. Produces one polyline per tube stroke (instead of potrace's outline pairs), so a 600mm "OPEN" with 12mm tube goes from 11+ outline-spacing errors to 0 spacing errors and ~7 polylines (one per stroke or letter loop). Validator gained a small junction-weld exemption so polylines meeting at a weld aren't flagged as "tubes 0mm apart".
- [x] Vectorize parameters: target_width_mm, threshold, smoothing_mm (RDP ε override), min_spur_mm, label. Smoothing/spur default to values derived from the project tube diameter when blank.
- [x] Normalize vectorize output to mm-canonical viewBox — emitted directly by the centerline pipeline; downstream validator/print/designdoc see identity-mapped paths.
- [ ] Live before/after preview UI (currently just shows the result inline)

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
- [ ] Edit tube spec per project (currently set on create; mutation UI is a v1.x item)
- [x] Project detail with file upload (click to upload; drag-drop is a v1.x polish item)
- [x] Vectorize step with target width + threshold + smoothing/spur sliders
- [x] Validation results panel with grouped issue lists, severity colors, re-validate button
- [x] Version history list with click-to-switch preview
- [x] Print panel with paper picker + landscape toggle + download button
- [ ] Keyboard shortcuts (cmd/ctrl+Z, cmd+S) — placeholder behavior; real shortcuts in Phase 2 with the editor

### v1 release checklist

- [ ] Smoke test on macOS, Windows, Linux (currently only macOS verified)
- [ ] Sample bitmaps + golden vectorized outputs in `testdata/`
- [ ] User-facing README with install + first-design walkthrough
- [x] Crash recovery: every vectorize creates a `design_versions` row before returning, so a mid-session crash leaves the last good state in SQLite

---

## Phase 2 — Editor + Neon-specific features

### Vector editor

- [x] Canvas: raw SVG + custom pointer/wheel pan-zoom (lighter than Konva/Fabric, good enough for this scope)
- [x] Node-level polyline editing: drag any vertex to reshape; shift-click to delete; electrode references shift correctly. Bezier-aware control-handle editing and segment-click insert are follow-ups.
- [x] Path operations: simplify (Douglas-Peucker, ε configurable in sidebar) and reverse (flips polyline order, rewrites electrode anchors). Split/join still TODO.
- [x] Snap to grid (toolbar toggle + mm spacing input). Affects label/dimension placement and vertex drag; pan/zoom and run-path picks stay un-snapped. Snap-to-angle and snap-to-geometry still TODO.
- [ ] Multi-select, group, layers
- [x] Cross-session checkpoints: every Save writes a new `design_versions` row (history list lets you switch back). In-session undo/redo with coalescing still TODO.

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
- [x] Export project as a `.neonbench` bundle (zip of SVG + design doc + validation report per version, plus a manifest with project metadata and tube-spec snapshot). Import path is still TODO.

---

## Phase 3 — 3D glow rendering

- [ ] **Decision needed:** Three.js vs Babylon.js (Three is more common, larger ecosystem; react-three-fiber if staying in React)
- [ ] Extrude vector paths into 3D tube geometry along path with correct diameter
- [ ] Material: emissive glass shader with bloom/glow post-processing
- [ ] Per-run color (matches gas/phosphor: ruby red, neon orange, argon blue, etc.) — color library mapping gas → realistic glow color
- [ ] Blockout sections render as opaque black tubing
- [ ] Electrodes rendered as little metal caps
- [ ] Camera controls: orbit, pan, zoom; preset views (front, iso)
- [ ] Adjustable scene: background color, "wall" backing, ambient light
- [ ] Screenshot / video export of the rendered preview (for client mockups)
- [ ] Optional: animated "warm-up" or flicker effect

---

## Cross-cutting / nice-to-haves (not blocking)

- [ ] Auto-update mechanism (check GitHub releases on launch, prompt to update)
- [ ] Telemetry opt-in for crash reports only
- [ ] Import from NeonWizard format (if file format is documented or reverse-engineerable) — eases migration story
- [ ] DXF export for CNC tube benders (was option B for v1; deferred)
- [ ] Multi-user / shop mode (auth, shared project library) — only if there's demand
- [ ] Localization scaffolding (en first, i18n-ready strings)

---

## Open decisions

These are flagged inline above; collected here so they don't get lost:

1. **3D engine** — Three.js (+ react-three-fiber) vs Babylon (Phase 3)

## Resolved decisions

- **Vectorization engine** → shell out to system `potrace`, bundle binary in releases per OS, fall back to install instructions if missing. Single-binary purity sacrificed for quality.
- **Inputs** → PNG, JPG, SVG. BMP deferred (add only if requested).
- **PDF library** → `github.com/phpdave11/gofpdf` (mm-native, path-friendly, mature).
- **2D editor canvas** → raw SVG with custom pointer/wheel pan-zoom. Lighter than Konva/Fabric and adequate for the run-level interactions Phase 2 needs.
- **App data directory** → OS-conventional paths via `internal/appdata` with `--data-dir` override.

---

## Appendix A — NeonWizard feature parity

Source: https://neonwizard.com/products/features.php?nw=1 (148 advertised features). Pulled 2026-05-07 to baseline the shop-readiness gap.

Legend: ✅ done · 🟡 partial · ❌ missing · 🚫 deliberately out of scope (NeonBench is a 1:1 production-pattern tool, not a vinyl-cutter / wide-format RIP / graphic-design suite).

### Tally

| Category | ✅ | 🟡 | ❌ | 🚫 |
|---|---|---|---|---|
| Neon Design Tools | 5 | 1 | 17 | 0 |
| Fonts & Text | 0 | 1 | 17 | 0 |
| Design Tools | 4 | 4 | 31 | 3 |
| Effects | 0 | 0 | 13 | 0 |
| Vector Graphics | 1 | 3 | 6 | 0 |
| Image Manipulation | 1 | 1 | 5 | 0 |
| Cutting/Plotting/Printing | 2 | 2 | 5 | 9 |
| Productivity | 2 | 3 | 5 | 0 |
| Wide Format | 0 | 0 | 4 | 3 |
| **Totals** | **15** | **15** | **103** | **15** |

### Neon Design Tools (the core — 23 features)

| # | NeonWizard feature | Status | NeonBench equivalent |
|---|---|---|---|
| 119 | Add Blockouts | ✅ | blockout marking, dashed render, `data-kind="blockout"` |
| 120 | Add Common Housings | ❌ | electrodes placed, no housing geometry |
| 121 | Add Mounting Holes | ❌ | |
| 122 | Add Tube Supports | ✅ | click-to-place support markers |
| 123 | Auto Tube Layout | ❌ | no auto double-stroke / parallel-tube generator |
| 124 | Change Neon Tube Diameter Only | ✅ | per-run diameter override, scales bend-radius validation |
| 125 | Connect Tubes | ❌ | |
| 126 | Create Custom Housings | ❌ | |
| 127 | Current Tube / Total Length | ✅ | live status badge in editor header |
| 128 | Insert Doublebacks | 🟡 | DB *annotation* exists; no "insert DB at this point" tool |
| 129 | Maximum Tube Length | ✅ | validation rule + arc-midpoint flag |
| 130 | Move Opening / Break Tube Open | ❌ | path split/join is on Phase 2 todo |
| 131 | Neonize (outline → tube path) | ❌ | killer missing op |
| 132 | Neon Summary | ✅ | bend-list PDF page per run |
| 133 | Raceway Support | ❌ | |
| 134 | Switch Drop / Flat Blend | ❌ | |
| 135 | Tube End Gap | ❌ | |
| 136 | Tube Support Holes | ❌ | |
| 137 | Neon Auto Tube Count | ❌ | |
| 138 | Neon Auto Spacing | ❌ | |
| 139 | Neon Preview (glow) | ❌ | Phase 3 |
| 140 | Neon Preview for Groups | ❌ | Phase 3 |
| 141 | Parallel Tube Layout | ❌ | tied to #123 / #131 |

### Fonts & Text (18 features)

- ❌ #1–13, 15–17: Direct text entry, property bar, script fonts, kerning/spacing/slant/arc/rotate handles, spell-check, WYSIWYG font picker, vertical text, change case — there is no text tool yet
- 🟡 #14 Text Notes — per-run free-text Notes field; doc-level text labels via annotation
- ❌ #18 Font Wizard (match scanned letter to digital font)

### Design Tools (42 features)

- ✅ #36 Grids · #37 Anti-aliased rendering · #53 Automatic Vectorizing · #54 Dimensioning
- 🟡 #30 Color Management (per-run gas color only) · #38 History Window (cross-session, no in-session) · #40 Measure Tool (via dimension lines) · #52 Text Notes Enhanced (per-run notes)
- ❌ #19, 22–29, 31–35, 39, 41–51, 55–58, 60: depth order, alignment, anchor points, arrow tool, auto-square, border tool, break-into-outer-loops, distribute, layers, mirror, move-to-layer, nested groups, redo, rounded rect, rulers, guidelines, snap-to-guides, stack, step-and-repeat, polygon/star, styles, hotkeys, soft-shadow opts
- ❌ #20 Type1/OpenType font support · #59 Color Vectorizing
- 🚫 #21, 34, 51 Drawing engine / refresh / streamlined UI (modern web stack) · #58 TWAIN (use OS-level scanning)

### Effects (13 features)

- ❌ #61–73: Weld, Common Weld, Contour, Warp, Cast/Drop/Soft/Extruded/Perspective Shadow, Inline/Outline, Knife, Text on Path, Clipping Paths
- Mostly cosmetic/marketing-render features. Low priority for shop production; revisit if doing client mockups in NeonBench rather than a separate tool.

### Vector Graphics Tools (10 features)

- ✅ #80 Optimize Vectors (Douglas-Peucker simplify in editor sidebar)
- 🟡 #78 Node Edit Tools (drag + delete; insert/break/join still TODO — see Phase 2 line 102) · #81 PDF Import + Export (export ✅, import ❌) · #83 Vector Filters (SVG only)
- ❌ #75 Bezier Tool (Phase 2 follow-up) · #74 Tangency indicator · #76 AI/EPS import · #77 AI multi-version filter · #79 On-Screen Digitizing · #82 Sharp-Corner Tool

### Image Manipulation (7 features)

- ✅ #85 Export Original Bitmap (source asset persisted under `assets/<project>/`)
- 🟡 #84 Bitmap Filters (PNG/JPG only)
- ❌ #86–90 Rotate, brightness, contrast, saturation, crop — we have a single binarize threshold

### Cutting / Plotting / Printing (18 features)

- ✅ #93 Horizontal/Vertical Paneling (oversize tiling) · #96 Plot to File (1:1 PDF)
- 🟡 #92 All Windows Printers (download → OS print dialog) · #97 Print Preview (PDF is the preview)
- ❌ #94 Mirror/Scale/Rotate at plot · #98 Quick Plot · #99 Plot Step-and-Repeat · #106 Channel Letter Return Patterns · #108 DXF Routing/Engraving export
- 🚫 #91, 95, 100–105, 107: plotter/cutter drivers, network plot, plot manager, USB cutter, weed lines/borders, Windows print driver, pen fill — neon shops use a printed full-size pattern, not a vinyl cutter

### Productivity (10 features)

- ✅ #109 Auto Save (every save → design_version row) · #117 Zooming (pointer/wheel)
- 🟡 #112 Job Manager (project name + tube spec only; no customer/designer/due date) · #115 Tool Tips · #116 Unlimited Undo (cross-session yes; in-session no)
- ❌ #110 Customizable toolbar · #111 Email Layout · #113 Online Help · #114 Spell Checker · #118 Programmable Hotkeys

### Wide Format Printing (7 features)

- ❌ / 🚫 #142–148 (CMYK/HSV, GIF/TIFF LZW, stroke support, image resampling, WIA, external image edit, photomask). NeonBench is not a wide-format RIP — out of scope.

---

## Appendix B — Re-ranked next-tasks list (post-parity audit)

This list collapses todo.md gaps + NW parity findings into a single shop-readiness backlog, ordered roughly by leverage-per-effort. Tier 1 unblocks daily shop use; Tier 2 closes the largest parity gaps; Tier 3 is polish; Tier 4 is bounded "no" decisions.

### Tier 1 — Shop-readiness blockers (do first)

1. **Delete a design version + delete project** (UI). Unblocks "the vectorization made garbage, get it out of my history." API for projects exists at `api.go:26`; version-delete needs a new `DELETE /api/projects/{id}/design_versions/{vid}` endpoint and a button on each row of the version list.
2. **Hershey single-line text tool in the editor** (NW #1, #15, #16, #18). The right answer to "garbled OPEN N" — never raster-trace text. Type letters, pick cap height in mm, get one polyline per letter with hairpin DBs already where the font designer placed them. Public-domain JHF data, small parser, drops directly into the existing run model.
3. **Pen tool + rect / circle / arc / polygon primitives** (NW #32, #56, #75). Completes the "design from a blank file" workflow. Reuses existing run model — each finished path becomes a new run. Bezier handles can wait.
4. **Live before/after threshold preview for raster vectorize** (todo.md:40, 49). Highest-leverage QoL gap when the vectorizer misbehaves.
5. **Edit tube spec per project mutation UI** (todo.md:80). Half-done — wire the existing PATCH endpoint to a sidebar field.
6. **Windows smoke test** (todo.md:90). A shop tech is more likely on Windows than mac.

### Tier 2 — Largest NW parity gaps

7. **Neonize / Parallel-tube layout / Auto Double-Stroke** (NW #123, #131, #141). Take a closed outline path, emit two parallel tube paths offset by tube diameter + spacing. Single biggest neon-specific gap.
8. **In-session undo/redo with coalescing** (todo.md:106; NW #44, #116). Cross-session is already covered by the version log.
9. **Node insert / break / join** (todo.md:102, 104; NW #78). Click on a segment to add a vertex; split a polyline at a vertex; join two endpoints.
10. **Channel letter return patterns** (NW #106). The single channel-letter shop feature missing — measured return depth and trim outline per letter.
11. **DXF export for CNC tube benders** (todo.md:148; NW #108). Already in cross-cutting. Promote if a shop asks.
12. **Import the .neonbench bundle** (todo.md:124). Export exists at `handlers_export.go`; round-trip is missing.
13. **Job Manager fields: customer, designer, due date, job number** (NW #112). Cheap SQL columns + form fields.
14. **Insert Doubleback tool** (NW #128). Click a polyline midpoint → emit a hairpin segment of configurable depth (default 1.5× tube ø per Strattman).
15. **Tube End Gap setting** (NW #135). Distance from tube end to channel letter edge as a project-level percentage.
16. **Bitmap pre-vectorize adjustments: rotate / crop / brightness / contrast** (NW #86–90). Currently a single threshold.

### Tier 3 — Polish & validator depth

17. **ESLint cleanup + flip CI to hard-gate.** Tree currently has 10 pre-existing errors (`docOps.ts` unused `_drop`/`_closed`, `EditorCanvas.tsx` setState-in-effect at lines 79/104, `EditorPage.tsx` refs-during-render at lines 110/111, `ProjectDetail.tsx` setState-in-effect at line 40) + 2 unused-eslint-disable warnings. CI runs `npm run lint` with `continue-on-error: true` until this clears; after, set `continue-on-error: false` in `.github/workflows/ci.yml`.
18. **Visual marker overlay on SVG preview** (todo.md:61) — show validation flags on the canvas.
19. **Lead-in length / 90° angle validation** (todo.md:62) — needs electrode placement model (we have it now).
20. **Glass-to-grounded-metal / HV-cable spacing** (todo.md:63) — needs cabinet/substrate model.
21. **Tighten bend-radius defaults to wall-thinning derivation** (todo.md:64).
22. **Send to printer via OS print dialog** (todo.md:75).
23. **Drag-drop file upload + multi-select / group / layers** (todo.md:81, 105).
24. **Snap-to-angle and snap-to-geometry** (todo.md:104).
25. **Sample bitmaps + golden vectorized outputs** (todo.md:91).

### Tier 4 — Deliberate "no for now"

These are NW-the-graphic-design-suite, not NW-the-neon-tool. Skip unless a shop specifically asks:

- All shadows / effects (NW #61–73, #142–148)
- Vinyl-cutter plumbing (NW #91, #95, #101–105, #107)
- TWAIN / WIA (NW #58, #146)
- Email Layout / Spell Checker / Customizable toolbar (NW #111, #114, #110)
- Color Vectorizing (NW #59) — single-color binarize is the right model for tube production
