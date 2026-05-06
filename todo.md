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

- [ ] Upload endpoint accepting PNG, JPG, SVG (max size guard)
- [ ] PNG/JPG: preprocess — grayscale, threshold to 1-bit (with adjustable threshold preview before vectorize)
- [ ] SVG: skip vectorization, validate it's parseable, normalize to internal representation
- [ ] Store original asset alongside processed bitmap

### Vectorization

- [ ] Shell out to system `potrace` binary (decided — quality > single-binary purity)
- [ ] On first launch, detect `potrace` on PATH; if missing, show install instructions per OS (`brew install potrace`, `choco install potrace`, `apt install potrace`)
- [ ] Setting to override `potrace` binary path (for non-standard installs)
- [ ] Bundle `potrace` binary alongside the Go binary in release artifacts per OS to keep UX one-step (still ship the install-instructions fallback for users who delete it)
- [ ] Wrapper: write input bitmap to temp file (PBM format potrace prefers), invoke with chosen params, capture SVG on stdout, parse
- [ ] Expose vectorize parameters: turn policy, alphamax (corner threshold), opttolerance (curve simplification)
- [ ] Output: SVG with paths in mm coordinates (no transforms, single coordinate space)
- [ ] Preview UI: show original raster + vectorized overlay with toggle

### Validation rules

- [ ] **Min bend radius:** sample each path at fine intervals, compute curvature, flag any radius < tube spec min
- [ ] **Single continuous path / connectivity:** detect disjoint subpaths; report as discrete "tube runs" needing electrodes/jumps
- [ ] **Max segment length:** sum arc length per continuous run; flag runs exceeding max
- [ ] **Min spacing:** detect parallel/adjacent path segments closer than tube diameter (spatial index over polyline samples; check distance between non-adjacent samples)
- [ ] Validation report: structured JSON (rule, severity, location, message) + visual overlay markers in editor
- [ ] Block "Send to printer" until report has zero errors (warnings allowed)

### Print output (1:1 PDF)

- [ ] **Decision needed:** PDF library — `signintech/gopdf` vs `jung-kurt/gofpdf` vs `unidoc/unipdf`. Need vector path support, exact mm scaling, multi-page tiling.
- [ ] Generate PDF at exact 1:1 scale, paths in mm
- [ ] Tiling for designs larger than paper: split across pages with overlap markers and tile labels (A1/A2/B1...)
- [ ] Page setup: paper size selection (Letter, A4, A3, custom), orientation, margins
- [ ] Registration marks at tile corners + ruler/scale bar on each page (let glassblower verify printer didn't scale)
- [ ] "Send to printer" → either generate PDF and open in OS default print dialog, or download

### Frontend (Phase 1)

- [ ] Project list / create / open
- [ ] Tube spec picker on project create; allow editing tube spec per project
- [ ] Upload screen with drag-drop
- [ ] Vectorize step: threshold preview, vectorize params, before/after view
- [ ] Validation results panel with click-to-zoom on issues
- [ ] Version history sidebar: every vectorize/validation pass creates a version, user can name & revert
- [ ] Print preview with tile layout, paper size, then trigger output
- [ ] Keyboard shortcuts from day one (cmd/ctrl+Z, cmd+S, etc. — even if no-ops initially, sets the tone vs NeonWizard)

### v1 release checklist

- [ ] Smoke test on macOS, Windows, Linux
- [ ] Sample bitmaps + golden vectorized outputs in `testdata/`
- [ ] User-facing README with install + first-design walkthrough
- [ ] Crash recovery: if app dies mid-session, last design version still in SQLite

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
