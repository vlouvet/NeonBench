# NeonBench

A local-first design and pattern planning tool for hand-bent neon. Drop in
a logo (PNG / JPG / SVG), vectorize it, edit electrodes / blockouts /
bends in a structured doc, and print a 1:1 pattern with a per-run bend
list — all from a single Go binary that opens your browser to a local
web UI.

> **Status:** Phase 2 of a 3-phase roadmap (vectorize → edit → 3D glow).
> Phase 0 + 1 (vectorize, validate, print) and most of Phase 2 (editor,
> per-run color/diameter/notes, blockouts, bend planning, live
> validation, undo/redo) ship today. Phase 3 (extruded 3D tube
> rendering) is not yet started.

## Why

Existing tools either treat neon designs as generic vector art (so the
patterns omit the trade rules — bend radii, blockouts, lead-ins, splice
points) or are old desktop apps tied to specific platforms. NeonBench
runs anywhere Go runs, persists every design version in SQLite for
cross-session undo, and validates against rules pulled from the trade
literature (Miller 1935, Strattman 1997, Saving Neon, Blazek pattern
books — extracted in [`docs/neon-rules/`](docs/neon-rules/)).

## Install

NeonBench is a single Go binary, no external runtime needed.

```sh
git clone https://github.com/vlouvet/neonbench
cd neonbench
go build -o bin/neonbench ./cmd/neonbench
./bin/neonbench
```

The binary embeds the React UI, picks a free port on 127.0.0.1, opens
your default browser, and stores its SQLite database at the OS
conventional location (macOS `~/Library/Application Support/NeonBench`,
Linux `$XDG_DATA_HOME/NeonBench`, Windows `%APPDATA%\NeonBench`).

### CLI flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--port` | `0` (free port) | Pin the HTTP port |
| `--data-dir` | OS-conventional | Override the SQLite + assets directory |
| `--dev` | `false` | Proxy `/` to a local Vite dev server on `:5173` for frontend hacking |
| `--no-open` | `false` | Don't auto-launch the browser |
| `--log-level` | `info` | `debug` / `info` / `warn` / `error` — `debug` logs every HTTP request |

## First-design walkthrough

1. **Open the app.** You'll land on the project list. Click "New
   project", pick a tube spec from the dropdown (the seeded specs map
   to the wall-thinning bend-radius derivation in
   `docs/neon-rules/bend-radius.md`), and name your project.

2. **Upload a source image** — *or skip this step entirely if your design
   is text*. PNG, JPG, or SVG up to 50 MB. SVGs pass through as-is;
   PNG/JPG go through an in-process skeleton-graph centerline extractor
   (Zhang-Suen thinning → graph walk → RDP simplify, all pure Go, no
   external binary). For typeset text (channel letters, "OPEN" signs,
   etc.) skip the upload and use the editor's **Add text** tool instead
   (step 5) — Hershey single-stroke fonts emit clean tube paths with no
   centerline extraction required, which sidesteps the topology errors
   that raster tracing can introduce at letter junctions.

3. **Vectorize.** Set the target width in millimeters (this is the
   physical sign width — paths are in mm internally everywhere). Tweak
   threshold and, under "Advanced centerline options", the smoothing
   ε and minimum spur length if needed (both default to values derived
   from the project tube diameter). The vectorizer extracts a 1-pixel
   centerline through Zhang-Suen thinning + skeleton-graph walking,
   so each letter stroke becomes a single tube path rather than two
   parallel outlines. Each vectorize run creates a new
   `design_versions` row, so you can branch and compare.

4. **Validate.** The validator runs automatically after vectorize. It
   checks per-tube bend radius (with double-back hairpin exemption),
   tube run length, minimum spacing (with crossing demotion to
   "needs blockout"), and warns on tall designs that should be built
   in multiple blanks. Issues are grouped by severity and pinned to
   geometric locations.

5. **Edit.** Open the editor for a version. Every editor mutation flows
   through `editDoc()` which records to an in-session undo stack with
   500 ms coalescing (Cmd/Ctrl+Z to undo, Cmd/Ctrl+Shift+Z to redo).
   Tools:
   - **Place electrode** — click a path. Closed runs with two
     electrodes auto-pick the longer arc as live; toggle with "Switch
     live arc".
   - **Mark blockout** — click two points on the same run; renders
     dashed in editor, prints dashed on the PDF.
   - **Mark jump / support / double-back** — single-click annotations.
     Double-back marks suppress bend-radius errors in their region.
   - **Add bend** — manual bend overrides the auto-detected list.
     Sidebar lets you Reset to auto.
   - **Add text** — opens a modal that emits a Hershey single-stroke
     font. For text in your design, prefer this over uploading a
     rasterized image of typeset text — Hershey strokes are
     plotter/CNC paths designed to be drawn by a single pen, so they
     drop straight into the design as clean tube runs with no
     centerline extraction required. Each glyph emits one or more
     disconnected strokes, which matches how a channel-letter shop
     actually builds the sign. Type the text, set the cap height in
     mm, hit Insert.
   - **Label / Dimension** — doc-level callouts. Dimension reports the
     measured distance.
   - **Node edit** — drag any polyline vertex; shift-click to delete.
   - **Snap** — toolbar toggle + mm spacing. Affects label, dimension,
     and vertex drag (run-path picks always snap to the nearest
     polyline vertex).
   Per-run sidebar: gas/phosphor color, diameter override, free-text
   notes (transformer specs, gas, voltage), simplify / reverse path
   ops.
   Validation re-runs 500 ms after the last edit; the header badge
   shows error/warning counts.

6. **Save** the edits. A new design version row is written; navigate
   between versions in the project page's history list.

7. **Print.** From the project page, pick a paper size and download
   the 1:1 pattern PDF. The pattern includes registration crosses, a
   100 mm scale bar, electrode markers, numbered bend apexes (matching
   the editor sidebar), blockout dashed segments, doc-level
   labels/dimensions, and a final "Bend list" page summarizing each
   run's bends with arc-length offsets, turn angles, and per-run
   notes.

8. **Export.** Need to share the project with another install? The
   project page's "Export bundle" button downloads
   `<projectName>.neonbench` — a portable zip of every design version
   plus a manifest. Import is a planned follow-up.

## Architecture

```
cmd/neonbench/        ← main; HTTP server bootstrap, CLI flags
internal/
  appdata/            ← per-OS data-directory resolution
  designdoc/          ← Doc/Run/Bend/Annotation types + ToSVG/FromSVG
  printpdf/           ← gofpdf-based 1:1 tile renderer + bend list
  server/             ← HTTP API: projects, assets, vectorize, design_versions, validate_doc, print, export
  storage/            ← modernc.org/sqlite + goose migrations
  validate/           ← polyline extraction, bend-radius/spacing/length rules
  vectorize/          ← skeleton-graph centerline extraction (Zhang-Suen + graph walk + RDP)
web/
  src/                ← React + TypeScript editor (no canvas library; raw SVG + custom pan/zoom)
  src/lib/docOps.ts   ← pure-function editor mutations (vitest-tested)
docs/
  neon-rules/         ← extracted trade rules from PDFs/Kindle screenshots
scripts/test.sh       ← runs Go tests + vitest
```

## Testing

```sh
./scripts/test.sh         # full suite
go test ./...             # Go tests only
cd web && npm test        # editor unit tests (vitest)
cd web && npm run test:watch
```

The integration test
(`internal/server/integration_test.go`) drives the full upload →
vectorize → edit-every-tool → save → reload → print pipeline using
`internal/server/testdata/open_neon.png`. A separate vectorize-package
integration test
(`internal/vectorize/integration_test.go`) confirms the centerline
extractor produces ~7 polylines on the same image with no junction-weld
spacing false positives. The vitest suite covers every editor mutation
as a pure function.

## Roadmap

See [`todo.md`](todo.md) for the granular checklist. Big remaining
chunks:

- **Phase 2 polish:** path-op split/join, multi-select with batch ops,
  Bezier-aware path editing, snap-to-angle / snap-to-existing-geometry.
- **Phase 3:** extrude vector paths to 3D glass tubes, emissive shader
  with bloom, per-gas color, blockout opacity, electrode caps,
  orbit-camera preview UI.
- **Cross-cutting:** Windows / Linux smoke testing, bundle import,
  send-to-printer dialog.
