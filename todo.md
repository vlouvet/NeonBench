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

- [ ] `projects` table: id, name, created_at, updated_at, tube_spec_id, units
- [ ] `tube_specs` table: id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm, min_spacing_mm
- [ ] Seed 3–5 default tube specs (common diameters: 8mm, 10mm, 12mm, 15mm)
- [ ] `assets` table: project_id, kind (source_image | vector | print_output), blob/path, mime
- [ ] `design_versions` table: project_id, version_no, label, svg_data, validation_report_json, created_at — **enables cross-session undo & named versions** (key gap vs NeonWizard)

### Image input

- [x] Upload endpoint accepting PNG, JPG, SVG (max size guard, 50MB)
- [ ] PNG/JPG: adjustable threshold preview before vectorize (currently sent as a request param; live canvas preview is a v1.x polish item)
- [x] SVG: skip vectorization, persist as design_version pass-through
- [x] Store original asset on disk under `<data-dir>/assets/<project_id>/` with metadata in DB

### Vectorization

- [x] Shell out to system `potrace` binary (decided — quality > single-binary purity)
- [ ] On first launch, detect `potrace` on PATH; if missing, show install instructions per OS — currently surfaces a 424 with install instructions only on first vectorize attempt; pre-flight check is a polish item
- [ ] Setting to override `potrace` binary path (for non-standard installs)
- [ ] Bundle `potrace` binary alongside the Go binary in release artifacts per OS
- [x] Wrapper: input PBM via stdin, capture SVG on stdout
- [x] Expose vectorize parameters: turn policy, alphamax, opttolerance, threshold, target_width_mm, label
- [ ] Normalize potrace output to mm-canonical viewBox (currently keeps potrace's pt-units viewBox; bake transform into path coords) — needed for SVG marker overlay (Phase 2 prereq)
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
- [x] Vectorize step with target width + threshold + advanced potrace params
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

- [ ] Choose canvas lib: **Konva** or **Fabric.js** for 2D editor (Konva is leaner, better perf for many nodes); or roll on raw SVG + d3-zoom
- [ ] Node-level path editing: add/remove/move anchor points, adjust handles
- [ ] Path operations: split, join, reverse direction, simplify
- [ ] Snap to grid, snap to angle, snap to existing geometry
- [ ] Multi-select, group, layers
- [ ] Cross-session undo/redo backed by `design_versions` (every meaningful op = checkpoint, with coalescing)

### Neon-specific features

- [ ] **Electrodes:** placeable nodes marking tube ends; each continuous run must have exactly 2; visualize as standard electrode symbol
- [ ] **Double-back / blockout:** mark sections where tube doubles back on itself and should be coated black so it doesn't glow
- [ ] **Jumps / supports:** mark where tube crosses without connecting (jump-over) vs structural supports
- [ ] **Tube run assignment:** group path segments into named runs, each with its own transformer/voltage notes
- [ ] **Bend planning:** mark each bend point; auto-suggest based on curvature; export bend list as part of pattern
- [ ] Live re-validation on edit (debounced)
- [ ] Annotation layer: text notes, dimensions, color/gas labels per run

### Phase 2 export

- [ ] PDF includes: bend list, electrode positions, tube run summary, total tube length per run, gas/color callouts
- [ ] Export project as a `.neonbench` bundle (zip of SVG + metadata + version history) for sharing between installs

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

1. **PDF library** — gopdf vs gofpdf vs unipdf (path fidelity + tiling support is the gating factor)
2. **2D editor canvas** — Konva vs Fabric vs raw SVG (Phase 2)
3. **3D engine** — Three.js (+ react-three-fiber) vs Babylon (Phase 3)
4. **App data directory** — confirm OS-conventional paths and whether to support `--data-dir` override

## Resolved decisions

- **Vectorization engine** → shell out to system `potrace`, bundle binary in releases per OS, fall back to install instructions if missing. Single-binary purity sacrificed for quality.
- **Inputs** → PNG, JPG, SVG. BMP deferred (add only if requested).
