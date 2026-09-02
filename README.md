# NeonBench

A local-first design and pattern-planning tool for hand-bent neon.

Drop in a logo (PNG / JPG / SVG), vectorize it to tube centerlines, edit
electrodes / blockouts / bends in a structured document, and print a 1:1
pattern with a per-run bend list — all from a single Go binary that opens
your browser to a local web UI.

- **Nothing leaves your machine.** One binary, an embedded UI, SQLite on disk.
- **It knows the trade.** Bend radii derived from wall thinning, blockouts,
  lead-ins and splice points are validated, not decoration.
- **The pattern is the product.** 1:1 tiled PDF, DXF with annotation layers,
  channel-letter return strips, and a 3D glow preview to show the customer.

## Documentation

| | |
|---|---|
| [User manual](docs/USER_MANUAL.md) | Feature reference and a step-by-step walkthrough, with screenshots. **Start here.** |
| [Windows](docs/windows.md) | Download, first-launch SmartScreen, where data lives, building from source. |
| [Architecture](docs/architecture.md) | Package layout and how to run the tests. |
| [Headless render](docs/headless-render.md) | One command for a bloom-correct preview PNG: the URL contract and the driver script. |
| [Design notes](docs/design-notes.md) | Why parts of it work the way they do. |
| [Trade rules](docs/neon-rules/) | The source literature the validator is built from. |
| [`todo.md`](todo.md) | Roadmap, parity matrix and task backlog. |

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

Prebuilt binaries for macOS, Linux and Windows are attached to every
[release](https://github.com/vlouvet/NeonBench/releases/latest) — on Windows,
start at the [Windows guide](docs/windows.md) first.

To build it yourself:

```sh
git clone https://github.com/vlouvet/neonbench
cd neonbench
# Frontend first: web/web.go has //go:embed all:dist, so any go command fails
# with "pattern all:dist: no matching files found" until web/dist/ exists.
( cd web && npm install && npm run build )
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

## Status

Vectorize, edit and 3D preview all ship today, and the shop-readiness
backlog is closed.

**[`todo.md`](todo.md) is the single source of truth for what is done.** It
carries the NeonWizard parity matrix (Appendix A) and the tier-ranked task
backlog (Appendix B), both kept current as work merges. Counts are
deliberately not repeated here — this file used to restate them and drifted
into contradicting both itself and `todo.md`.
