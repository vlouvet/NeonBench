# NeonBench

A local-first design and pattern planning tool for hand-bent neon. Drop in
a logo (PNG / JPG / SVG), vectorize it, edit electrodes / blockouts /
bends in a structured doc, and print a 1:1 pattern with a per-run bend
list — all from a single Go binary that opens your browser to a local
web UI.

> **Status:** End-to-end across all three phases (vectorize → edit → 3D glow).
> Phase 0 + 1 (vectorize with Hough auto-deskew + per-channel RGB mix +
> threshold-sweep + per-diameter regression coverage, validate, print
> with paper / landscape / strips-only popover, DXF + PDF export with
> annotation MARKERS + BLOCKOUTS layers + optional R2000 dialect),
> Phase 2 (editor, per-run color/diameter/notes, blockouts, bend
> planning, double-back hairpins, channel-letter return strips with
> raceway grouping, Hershey single-stroke text in three faces with
> preset + optical kerning + font thumbnails + case/slant/vertical-stack
> /arc transforms, polygon-offset Neonize
> with stitched single-tube output, **groups + layers panel** with
> per-group visibility + lock toggles, multi-select + drag-drop image
> upload, snap-to-angle / snap-to-geometry on every drawing tool,
> **mm rulers with drag-off construction guides and snap-to-guides**,
> common + custom electrode housings, connect-tubes (jumper runs),
> move-opening / break-tube-open, multi-vertex select + drag + merge
> in node-edit mode, a right-click node context menu, circular arc
> segments that survive into the PDF and DXF, raceway guidelines that
> split every tube crossing them, one-click splitting of overlong
> tubes, undo/redo, validation marker overlay with
> severity-filter + j/k keyboard nav + sidebar↔canvas hover linking,
> full-spec-driven validation including derived bend radius from wall
> thickness + technique, click-to-edit tube-spec fields with fan-out
> re-validation, full tube-spec CRUD, project-list bundle preview
> modal + URL/storage-persisted sort/search), and **Phase 3**
> (lazy-loaded 3D preview via three.js + react-three-fiber: extruded
> tubes from project tube-spec diameter, emissive gas-color materials
> with per-gas-tuned bloom, bloom intensity sliders + scene-control
> localStorage persistence, electrode caps, per-segment blockout
> sleeves, jump-annotation tube lifts, **per-group focus filter +
> visibility-aware rendering**, orbit camera with Front/Iso/Top/Side
> preset views, auto-fit-on-mount, scene chrome controls + bloom-aware
> PNG screenshot export) all ship today. **The preview route is now
> lazy-loaded — users who never visit it save 309 KB gzipped on first
> paint.** NeonWizard parity is **37 ✅ / 12 🟡** of 148 advertised
> features (19 deliberately out of scope as Tier 4 graphic-design-suite
> features that don't help neon production). The shop-readiness backlog
> is essentially closed; remaining work is two Phase 3 cosmetics
> (warm-up flicker animation, optional bundle schema v2 for
> round-tripping per-project metadata) plus Tier 3 #30 HV-cable spacing
> which is BLOCKED on a prereq design contract for cabinet outline +
> transformer placement + HV cable routing.

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
start at [Windows](#windows) below.

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

## Windows

The Windows build is a single self-contained `neonbench-windows-amd64.exe` —
no Go, no Node, no runtime to install. Verified end-to-end on Windows 11
(build 26200, amd64).

### Download and run

1. Download `neonbench-windows-amd64.exe` from the
   [latest release](https://github.com/vlouvet/NeonBench/releases/latest).
2. Optionally verify it — see [Downloads and trust](#downloads-and-trust).
3. Double-click it. A console window opens, the server starts on
   `127.0.0.1`, and your default browser opens on the project list.

Leave the console window open; closing it stops NeonBench. To pin the port or
stop it hijacking your browser, run it from a terminal with the
[CLI flags](#cli-flags) above:

```powershell
.\neonbench-windows-amd64.exe --port 5199 --no-open
```

> **Firefox users:** with Firefox's "Choose a profile when Firefox opens"
> setting enabled, the profile picker appears *instead of* the app. Pick a
> profile and NeonBench loads normally.

### Expect a SmartScreen warning on first launch

Releases are **not code-signed**, so Windows sees an unknown publisher. This is
expected and does not mean the download is damaged or hostile:

- Your browser may flag the file as "not commonly downloaded" — choose **Keep**.
- Windows then shows a blue **"Windows protected your PC"** dialog. Click
  **More info**, then **Run anyway**.
- If it keeps reappearing, right-click the `.exe` → **Properties** → tick
  **Unblock** → **OK**.

Only an Authenticode certificate silences SmartScreen, and NeonBench
deliberately doesn't buy one. Verify the checksum instead.

### Downloads and trust

Every release publishes a `.sha256` beside each binary. Comparing that pair is
the simplest check for a single download:

```powershell
certutil -hashfile neonbench-windows-amd64.exe SHA256
type neonbench-windows-amd64.exe.sha256
```

The hashes must match. PowerShell equivalent:
`Get-FileHash neonbench-windows-amd64.exe -Algorithm SHA256`.

Releases also carry a combined `SHA256SUMS` listing every platform's binary in
one file — useful when verifying more than one download, and the single file a
maintainer signature will cover once provenance signing lands.

### Where your data lives

Projects, design versions and uploaded assets live in one SQLite database under
your roaming profile:

```
%APPDATA%\NeonBench\neonbench.db
```

That folder is created on first launch and is the only thing NeonBench writes
outside its own directory — the `.exe` is portable and never runs an installer.
To keep data elsewhere (USB stick, shared drive), pass `--data-dir`:

```powershell
.\neonbench-windows-amd64.exe --data-dir D:\neonbench-data
```

Back up or migrate a workstation by copying that folder. Uninstalling is
deleting the `.exe`, plus that folder if you want the data gone.

### Building from source on Windows

Only needed if you're changing the code — end users should take the release
binary. Requires **Go 1.26+**, **Node 20+** and **Git**:

```powershell
git clone https://github.com/vlouvet/NeonBench.git
cd NeonBench

# Frontend first — web/web.go has //go:embed all:dist, so every go command
# fails with "pattern all:dist: no matching files found" until web/dist exists.
cd web ; npm.cmd install ; npm.cmd run build ; cd ..

$env:CGO_ENABLED = '0'
go build -trimpath -o bin\neonbench.exe .\cmd\neonbench
.\bin\neonbench.exe
```

> Use **`npm.cmd`**, not `npm`, from PowerShell. Bare `npm` resolves to
> `npm.ps1`, which the default execution policy blocks with *"running scripts
> is disabled on this system"*. `npm.cmd` sidesteps that without weakening
> machine policy. `cmd.exe` and Git Bash are unaffected.

The bash helpers (`scripts/build.sh`, `scripts/run.sh`, `scripts/test.sh`) run
under **Git Bash**, which ships with Git for Windows.


## First-design walkthrough

1. **Open the app.** You'll land on the project list. Click "New
   project", pick a tube spec from the dropdown (the seeded specs map
   to the wall-thinning bend-radius derivation in
   `docs/neon-rules/bend-radius.md`), and name your project. The
   optional **Tube end gap (mm)** field sets the distance from each
   glass-tube endpoint to the inside edge of its channel letter or
   substrate (NW #135); leave it blank to use the standard 6.35 mm
   (¼ in) default per Miller App I §126 (see
   `docs/neon-rules/spacing.md`).

2. **Upload a source image** — *or skip this step entirely if you want
   to draw the design from scratch in the editor*. PNG, JPG, or SVG up
   to 50 MB. SVGs pass through as-is; PNG/JPG go through an in-process
   skeleton-graph centerline extractor (Zhang-Suen thinning → graph
   walk → RDP simplify, all pure Go, no external binary). For typeset
   text (channel letters, "OPEN" signs, etc.) skip the upload and use
   the editor's **Add text** tool instead (step 5) — Hershey
   single-stroke fonts emit clean tube paths with no centerline
   extraction required, which sidesteps the topology errors that
   raster tracing can introduce at letter junctions. To start with a
   completely blank canvas, use **New blank design** on the project
   page — it opens the editor on a fresh 1000×500mm doc you can draw
   into with the pen / rect / circle / arc tools (step 5).

3. **Vectorize.** Set the target width in millimeters (this is the
   physical sign width — paths are in mm internally everywhere). Tweak
   threshold and, under "Advanced centerline options", the smoothing
   ε and minimum spur length if needed (both default to values derived
   from the project tube diameter). For messy sources (slightly-skewed
   phone photos, faint scans, busy backgrounds), open the **Image
   adjustments** panel for rotation (-45° to +45°), crop, brightness
   (-100..+100), and contrast (0.5×..2.0×). These run before the
   binarize step in the documented order — rotate → crop → brightness
   → contrast → threshold — and the live before/after preview reflects
   each adjustment as you drag. **Drag a crop rectangle directly on the
   source preview** instead of typing X/Y/W/H, and click **Auto-rotate**
   to run a Hough peak-finder on the dominant lines and suggest a
   deskew angle. The vectorizer then extracts a 1-pixel centerline
   through Zhang-Suen thinning + skeleton-graph walking, so each letter
   stroke becomes a single tube path rather than two parallel outlines.
   Each vectorize run creates a new `design_versions` row, so you can
   branch and compare.

4. **Validate.** The validator runs automatically after vectorize. It
   checks per-tube bend radius (with double-back hairpin exemption,
   and a derived `K·D²/t` minimum from the tube spec's wall thickness +
   technique when no manual override is set), tube run length, minimum
   spacing (with crossing demotion to "needs blockout"), minimum
   lead-in length, sharp-bend angles, channel-letter face perimeter vs
   blank length (1168 mm Strattman coil), and warns on tall designs
   that should be built in multiple blanks. Issues are grouped by
   severity in the sidebar **and rendered as colored circles directly
   on the canvas** — click a marker to select the run it belongs to,
   hover for the issue text. Markers are red for errors, amber for
   warnings; print output suppresses them. Sidebar severity checkboxes
   filter both the list and the canvas markers; press `j` / `k` (or
   `]` / `[`) to pan-zoom the canvas to the next/previous issue;
   hovering an issue row pulses the matching canvas marker (and vice
   versa) so dense-error designs stay scannable.

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
   - **Insert DB** — splice a U-shaped hairpin (180° fold-back) into a
     polyline at the click point. Default depth is 1.5× tube diameter
     and the U mouth is 1.0× — Strattman's "straight-drop combination
     bend." Shift-click to mirror the U onto the opposite side of the
     segment.
   - **Add bend** — manual bend overrides the auto-detected list.
     Sidebar lets you Reset to auto.
   - **Add text** — opens a modal that emits a Hershey single-stroke
     font. For text in your design, prefer this over uploading a
     rasterized image of typeset text — Hershey strokes are
     plotter/CNC paths designed to be drawn by a single pen, so they
     drop straight into the design as clean tube runs with no
     centerline extraction required. Each glyph emits one or more
     disconnected strokes, which matches how a channel-letter shop
     actually builds the sign. Pick a face — **Roman Simplex**
     (default), **Roman Duplex** (thicker, channel-letter look), or
     **Sans Simplex / Futural** (geometric sans) — type the text
     (`<textarea>` accepts newlines for multi-line layouts; line
     height is configurable), drag the triangle handles in the
     preview to nudge per-pair kerning (1 px screen = 1 mm design),
     set the cap height in mm, hit Insert.

     The **Transform** section reshapes the text without touching a
     single vertex by hand: one-shot **case** buttons (UPPER / lower /
     Title / Sentence — Title only touches the first letter of each
     word, so "McDonald" survives), a **slant** slider (±45°, a shear
     about each line's own baseline, i.e. faux-italic on any face),
     **vertical stacking** (one glyph per line down a common axis,
     centred on each glyph's ink rather than its advance width, with an
     even ink-to-ink gap down the column — the blade-sign layout), and
     **arc** (the baseline bent onto a circle
     of a chosen radius, arching up over a doorway or sagging down).
     They compose in a fixed order — case → layout → slant — and
     stacking and arc are mutually exclusive. Stacking is unavailable
     on the **Cursive** face, whose whole point is stitching adjacent
     letters into one continuous tube; the arc bends that stitched
     script intact. The dialog's live preview shows the transformed
     result, which is the exact geometry Insert puts on the canvas.
   - **Pen / Rect / Circle / Arc** — draw directly on the canvas. Pen
     drops a polyline a click at a time (double-click or Enter to
     commit, Esc cancels). Rect and Circle are pointer-down →
     drag → pointer-up: rectangle from corner to corner, circle from
     center to radius. Arc takes three sequential clicks (start, mid,
     end) and fits the unique circular arc through them, falling back
     to a straight line when the points are collinear. Each finished
     shape becomes a new tube run that you then color, tag with
     electrodes, and validate like any other run.
   - **Label / Dimension** — doc-level callouts. Dimension reports the
     measured distance.
   - **Node edit** — drag any polyline vertex; shift-click to delete;
     alt-click a path segment to insert a new vertex there; alt-click a
     vertex to split the run at that point (a teal hover ring confirms
     the snap target so you can tell insert-vs-split apart at a glance,
     and a blockout that straddles the split point is divided into two
     valid pieces rather than dropped). Pick "Join from head/tail" in
     the run sidebar to arm a join, then click another open run's
     endpoint to merge the two polylines (self-join head + tail closes
     the loop). **Right-click any vertex** for a context menu listing
     only the actions that apply there — insert vertex, split run,
     break a loop open, move the opening, place or move an electrode,
     add a housing, start a blockout, the five marks, and delete. On a
     Mac trackpad, ctrl-click or a two-finger tap does the same. The
     menu is an additional way in, not a replacement: every toolbar
     tool still works as before.
   - **Arcs** — right-click a vertex and pick **Convert to arc** to
     bow the segment *leaving* it into a circular arc (sagitta a
     quarter of the chord; radius 0.625 × chord). The vertex list does
     not change, so electrodes, bends and blockouts stay put. The
     curve is real geometry, not a drawing flourish: it flows through
     to the validator, the bend list, the glass footage, the PDF and
     the DXF (as a native LWPOLYLINE bulge the bender's CAM reads).
     Note that an arc meets its straight neighbours at a ~53° corner,
     so converting a mid-run segment usually adds two genuine
     bend-radius warnings — that is the validator being accurate about
     the glass, not a false positive.
   - **Snap** — toolbar toggle + mm spacing. Affects label, dimension,
     and vertex drag (run-path picks always snap to the nearest
     polyline vertex). Drawing tools compose four snap modes in
     priority order: existing geometry, then construction guides, then
     15° angle lock (Shift), then the mm grid.
   - **Rulers** — toolbar toggle (on by default). mm rulers along the
     canvas top and left edge, labelled at whichever step stays legible
     at the current zoom, with a cursor position indicator on each.
   Per-run sidebar: gas/phosphor color, diameter override, free-text
   notes (transformer specs, gas, voltage), simplify / reverse / neonize
   path ops.
   Validation re-runs 500 ms after the last edit; the header badge
   shows error/warning counts.

   **Neonize** — for double-stroke channel letters: select a closed run
   (e.g. a face outline drawn with the pen tool or imported from an
   SVG), click **Neonize**, set the spacing in mm. The single closed
   run is replaced with two parallel offset runs that follow the inside
   and outside of the original outline — that's the tube path the
   bender will fabricate. Tip: stroke width = 2 × tube diameter +
   spacing. Open polylines are also supported (parallel offset with
   butt caps), and a **Stitch ends** toggle in the popover joins the
   two runs into one continuous tube via U-bends at the endpoints —
   true single-tube double-stroke per Strattman's combination-bend
   pattern. Per-corner cap-style overrides (miter / round / bevel) are
   available via the optional `cornerStyles` array. If the geometry
   has acute corners (beveled by a miter clamp) or self-intersections
   after offset, you'll get a warning; the runs are still emitted and
   you can clean up with the node editor.

   **Raceway guideline** — for channel letters sharing one back
   channel: click **Add raceway guideline**, drag the dashed line to
   where the raceway will sit, then click **Split tubes at raceway**.
   Every tube crossing the line is cut at the crossing and tagged with
   the guideline's id, which is what groups them onto a single
   combined return-strip page in the PDF. Clicking twice does nothing
   — each piece already ends on the line. Moving the line and
   splitting again *adds* a second cut rather than undoing the first;
   undo is the way back, and it is one step. Deleting the guideline
   leaves the cuts and their raceway tag alone.

   **Construction guides** — press on a ruler and drag into the canvas
   to pull out a guide: the top ruler gives a horizontal one, the left
   ruler a vertical one. Release back over a ruler to cancel. Drag a
   guide to move it, click to select, `Delete` to remove, `Esc` to
   deselect. Guides are teal with a fine dash, to keep them clearly
   apart from the blue long-dash raceway guideline — a raceway guide
   means "tubes get cut here", a construction guide means nothing to
   the fabricator and never reaches the PDF, DXF, or the split action.
   With **Snap** on, drawing tools lock to guides: a horizontal guide
   pins y and leaves x free (or grid-snapped), and a horizontal plus a
   vertical guide together land you on their intersection.

   **Split overlong tubes** — the validator errors when a run exceeds
   the tube spec's max segment length, because it will not come off a
   single stick. The sidebar button (which shows how many runs are
   over) cuts each into the fewest equal-arc-length pieces that fit
   under the limit, in one undo step. Re-running it is a no-op.

   **Arrange** — with two or more runs selected, the sidebar's Arrange
   section aligns them (left / centre / right / top / middle /
   bottom), distributes them evenly left-to-right or top-to-bottom,
   mirrors the selection about its own bounding box, and moves runs
   through the draw order (to front / forward / backward / to back).
   Three runs are needed to distribute; mirror and depth order work on
   a single run. Each click is one undo step. Alignment measures each
   run's *true outline*, so a tube with an arc segment lands by the
   curve's bow rather than by its end points — and mirroring reverses
   the run's direction internally to keep every arc bowing the way it
   should, so the canvas, the printed pattern and the DXF all agree.
   Runs in a locked layer are left out and the buttons say so.

   **Step & repeat** — the same section arrays the selection into a
   grid: a count across and down, and a pitch measured either *edge to
   edge* (gap) or *centre to centre*. The original stays put as the
   top-left cell. The preview line shows how many copies, how many runs
   that adds, the overall size of the finished array and the actual
   step, so a gap entered where a centre pitch was meant is visible
   before you commit; arrays over 400 new runs are refused. The gap is
   measured off the true outline too, so a row of curved tubes really
   is that far apart. Copies carry the original's colour, diameter,
   channel-letter face flag and depth — but **not** its raceway, since
   a copy 500 mm away is not screwed to the same back-channel and would
   otherwise appear on that raceway's return-strip page. Each copy of a
   grouped selection gets its own new group ("E copy 1", "E copy 2"),
   so a multi-run letter still travels as one unit while staying
   separately selectable. One undo step.

6. **Save** the edits. A new design version row is written; navigate
   between versions in the project page's history list.

7. **Print.** From the project page, pick a paper size and download
   the 1:1 pattern PDF. The pattern includes registration crosses, a
   100 mm scale bar, electrode markers, numbered bend apexes (matching
   the editor sidebar), blockout dashed segments, doc-level
   labels/dimensions, and a final "Bend list" page summarizing each
   run's bends with arc-length offsets, turn angles, and per-run
   notes. The editor also has a **Print** button in the toolbar that
   opens the OS print dialog directly against this same PDF (via a
   hidden iframe) — saves the download-then-open round-trip when you
   want a quick proof print. Append `?strips_only=1` to the print
   URL to suppress the main pattern + bend-list pages and emit only
   the channel-letter return-strip pages — useful post-fabrication
   when the front face is bent and the operator just needs to bend
   the metal strip.

   **Plot options.** The toolbar's print popover (the `▾` next to
   **Print**) also carries rotation and copy count. `?rotate=fit`
   turns the pattern 90° only when doing so needs *fewer* sheets — a
   tie keeps the un-rotated orientation, so the same design always
   comes off the bench the same way round; `?rotate=90` rotates
   unconditionally. Rotation applies to the main pattern and bend-list
   pages only: return-strip and raceway-strip pages are unfolded 1D
   patterns in their own coordinate space and are left alone. Mirror
   and rotation do not commute, so the order is fixed as **mirror,
   then rotate** — mirroring is a property of the pattern (the bender
   reads through the back of the glass), rotation is a property of the
   paper. `?copies=N` (1–50) repeats the whole page set N times for
   step-and-repeat work; copies multiply *pages*, never geometry, so
   a 1:1 production pattern stays 1:1 and two letters never share a
   sheet. Any rotated or copied sheet says so in its footer
   (`ROTATED 90°`, `Copy 2 of 6`) — a rotated pattern found on a
   bench a week later with nothing indicating it is a real
   fabrication hazard. Finally, **Quick plot** next to the Print
   button reprints with the project's last-used settings in one
   click, no popover; hover it to see exactly what it will send.

   The project page panel also offers a **Download
   DXF** button — an AutoCAD R12 ASCII file with one polyline per
   run (millimeters, layered per run id) for feeding to CNC tube
   benders; the export includes electrode `CIRCLE` markers, run +
   free-form `TEXT` labels, and dimension `LINE+TEXT` pairs on
   dedicated `ELECTRODES` / `LABELS` / `DIMENSIONS` layers.

   **Channel-letter workflow.** For 3D channel letters (a flat metal
   face plus a "return strip" wrapped around the perimeter to form
   the side wall), set the project's **Channel letter depth (mm)**
   field on the project page (defaults to 100 mm ≈ 4 in per
   Strattman NT Ch.5; Miller p.88). The same panel exposes a
   **Strip overlap (mm)** field (default 12.7 mm = ½ in) for the
   shear allowance at each strip end. In the editor sidebar, tick the
   **Channel letter face** box on each run that represents a face
   silhouette. Optional per-run depth overrides the project default,
   and a free-form **Raceway** string groups multiple letters that
   share one return strip. The print PDF then emits one extra page
   per face-flagged run with the unfolded return strip drawn as a
   `perimeter × depth` rectangle, plus a vertical tick at every
   polyline vertex labelled with the cumulative arc length and signed
   interior turn angle so the operator knows exactly where to bend
   the strip; runs sharing a `Raceway` value are concatenated onto a
   single combined-strip page with heavy dashed boundaries between
   contributions, and a dashed shear line at the right end labels
   the overlap allowance. A `face_perimeter_exceeds_blank` warning
   surfaces on the canvas marker overlay if a face's perimeter passes
   the 1168 mm Strattman coil length (NW #106).

8. **Export / import.** Need to share the project with another install?
   The project page's "Export bundle" button downloads
   `<projectName>.neonbench` — a portable zip of every design version
   plus a manifest. The Projects list page has an "Import .neonbench"
   button **and accepts drag-drop directly onto the page** — drop a
   bundle anywhere on the project list and it imports straight in. The
   importer dedupes tube specs by dimensions (within 1 µm), appends
   "(imported)" if the name collides, and a versioned schema dispatcher
   rejects bundles from a newer NeonBench with a clear upgrade message.

9. **Project list productivity.** The list page exposes a search box
   (case-insensitive substring across name / customer / job number),
   a sort dropdown (recently updated / due-date next-first / name
   A–Z), and a red **Overdue** pill on rows whose due date is in the
   past. The same Job Manager fields (customer / designer / due date /
   job number) are click-to-edit on the project detail page; tube-spec
   edits there fan out to re-validate every saved design version on
   that spec, with a toast confirming the count.

10. **Tube-spec management.** The project detail page exposes an
    inline `<TubeSpecEditor>` for the active spec — every field is
    click-to-edit and auto-saves: name, dimensions string, diameter,
    manual `min_bend_radius_mm` override, plus the new
    `wall_thickness_mm` (range 0.1–10.0 mm) and `bend_technique`
    (`ribbon` / `crossfire` / `hand_torch`) inputs. The wall + technique
    pair drives the `K·D²/t` bend-radius derivation; a live "Derived:
    NN.N mm" indicator updates as you type, and a "Use derived" button
    copies that value into the manual-override field. Saving any field
    fans out the new validation across every dependent design version
    (toast: "Re-validated N versions across M projects"). Server-side
    whitelist-validates the `bend_technique` value with HTTP 422 on
    typos so an unknown technique doesn't silently fall back to the
    `2.25·D` diameter-only safety bound.

11. **3D glow preview.** Each saved design version on the project page
    has a "3D preview" link that opens a read-only WebGL scene at
    `/projects/:id/versions/:vid/preview`. Every `Run.Polyline` is
    extruded into a 3D glass tube along its 2D path with the correct
    diameter; the `Color` string is mapped against a ~20-entry gas
    library (`ruby red`, `neon orange`, `argon (blue)`, `cobalt blue`,
    `warm white`, etc.) onto an emissive `MeshStandardMaterial`, and a
    bloom post-process gives the canonical neon halo. **Per-segment
    blockouts** render as opaque dark-grey sleeves on top of the live
    tube; **electrodes** render as small metallic cylinders + hemisphere
    caps at each `Run.Electrode` position. Mouse-drag orbits the
    camera, scroll zooms, right-drag pans; the floating top-left bar
    snaps to **Front / Iso / Top / Side** preset views with a 600 ms
    cubic ease, and the camera auto-fits to the design bbox on initial
    load so the first frame frames the whole sign. The top-right
    sidebar exposes scene chrome controls — background color (Black /
    Dark grey / Neutral grey / White), wall-backing toggle + color
    (White / Steel grey / Black / Wood) for daytime client mockups, an
    ambient-light slider — and a **Save PNG** button that downloads
    `<project>-preview-<ISO>.png` at the canvas's display resolution.
    Append `?nobloom` to the preview URL to bypass the bloom pass on
    weak GPUs. (Phase 3 follow-ups in `todo.md` Appendix B Tier 3
    rows 53–58 cover the remaining polish items.)

12. **Quantity takeoff + estimate.** Each saved version has an
    "Estimate" link opening `/projects/:id/versions/:vid/estimate`. The
    **takeoff** half needs no prices at all and answers the ordering
    question directly: net tube (what glows) against gross glass (what
    leaves the supplier's shelf), grouped per diameter and colour, with
    stick and splice counts derived from a configurable stick yield —
    glass is bought in fixed lengths and cut down, so the length
    consumed and the length purchased are different numbers. Also
    electrode pairs, pumped sections, blockout linear feet, backing area
    (labelled "bounding box", because a panel cut to the sign's
    silhouette is smaller) and fabrication hours. The **estimate** half
    applies a rate card and shows the cost side next to the price, so a
    shop can see when a job has gone underwater rather than only what it
    sells for. A "Quote sheet (PDF)" button renders a one-page
    `estimate.pdf` — separate from `print.pdf` on purpose, since a
    pattern goes to the bench and a quote goes to the customer.

    **A missing rate is never treated as zero.** A rate card item's cost
    is nullable: blank means "nobody has priced this", a typed `0` means
    "deliberately free". Unpriced lines are *excluded* from the total
    rather than counted at nothing, the estimate is flagged
    **provisional** on screen and on the PDF, and a rate quoted in the
    wrong unit (paint by the litre against a line measured in feet) is
    rejected as **"wrong unit"** rather than silently multiplied. A
    quote that quietly omits its most expensive line and still looks
    complete is the failure this is built to prevent. Supplier minimum
    orders are carried too, as an advisory purchase figure alongside
    what the job actually draws — a one-off sign consuming 3 electrode
    pairs against a 50-pair minimum should not put a case of electrodes
    on the customer's quote.

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

On Windows, use the PowerShell sibling — it handles the `npm.cmd` execution-policy
quirk and the `web/dist` embed ordering that trip up the bash scripts:

```powershell
.\scripts\test.ps1          # same scope as test.sh
.\scripts\test.ps1 -Smoke   # also build the .exe and boot it (what CI runs)
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

See [`todo.md`](todo.md) for the granular checklist (148-row NeonWizard
parity matrix in Appendix A; tier-ranked task backlog in Appendix B).
Current scoreboard is **32 ✅ / 13 🟡 / 88 ❌ / 15 🚫** against NW.
Tier 1 (shop-readiness blockers), Tier 2 (largest parity gaps), and
**all of Phase 3 (3D glow rendering)** have shipped in full. Tier 3
polish has shipped 20 of ~35 items; remaining big chunks:

- **Editor productivity:** multi-select with batch ops, Bezier-aware
  path editing, snap-to-angle / snap-to-existing-geometry, group +
  layers model.
- **Glass-to-grounded-metal / HV-cable spacing rule:** blocked on
  introducing a cabinet outline + transformer placement + HV cable
  routing model in the design doc.
- **Phase 3 follow-ups:** wire project tube-spec into preview (so
  un-overridden runs render at the project diameter, not 12 mm
  default); route screenshot capture through the bloom composer (PNG
  export currently reads as a flat-emissive `?nobloom` render);
  scene-control persistence to localStorage; `React.lazy`
  code-splitting the preview route to recoup the ~310 KB gzipped
  three-stack from the initial bundle.
