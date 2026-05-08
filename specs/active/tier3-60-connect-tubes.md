# Tier 3 #60 — Connect Tubes (NW #125)

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/60-connect-tubes`

## Goal

Bring NW's "Connect Tubes" feature into NeonBench. In neon trade language a **jumper** is a short glass tube (typically 10–11 mm OD with a flared end per Strattman Fig.11.3, or 16 mm OD glass-sleeved twisted lead-wire per Miller p.204–205) that splices the live electrical path between two adjacent tube runs whose physical ends sit close together. NeonBench currently has no way to model a jumper — operators end up scribbling them onto the printed pattern by hand.

This spec adds a **Connect Tubes** editor tool that lets the operator click two run endpoints (specifically: an electrode position on one run, and an electrode position on a second run) and emit a new short `Run` that polylines between them. The new run inherits a sensible diameter default (project tube spec, with a per-jumper override slot reserved), is tagged with a `kind="jumper"` flag so the validator + 3D preview can render it differently from a primary tube run, and inherits the source runs' `RacewayID` if both share one.

"Done" means: the editor toolbar gets a "Connect tubes" tool; clicking two electrode points on two different runs creates a new jumper run between them; the jumper renders dashed on the 2D canvas; the print PDF emits the jumper on the main pattern with a `JUMPER` label at midpoint; the 3D preview renders the jumper at a thinner diameter to distinguish it from primary tubes.

## Branch + setup

```sh
git fetch origin
git checkout -b task/60-connect-tubes origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/designdoc/types.go` — add `Run.Kind string` field with allowed values `""` (default — primary tube), `"jumper"`. Add doc-comment block citing Strattman Fig.11.3 + Miller p.204–205.
- `internal/storage/migrations/NNN_run_kind.sql` — pick the next unused migration number (currently 0011 is the latest, so this becomes 0012). Add `kind TEXT NOT NULL DEFAULT ''` to `runs` if runs are stored relationally; if runs live inside the `design_versions.doc_json` blob (which they do today), this migration is not needed and the field flows through JSON serialization with no schema change. **Verify which path applies before opening the migration; delete the file if not needed.**
- `web/src/lib/docOps.ts` — new `connectTubes(doc, fromRunId, fromElectrodeIdx, toRunId, toElectrodeIdx, opts?)` operation. Returns a new Doc with a freshly-allocated jumper Run between the two electrode world positions. Reserves a new run ID via `nextRunId(doc, 'j')`. Inherits `RacewayID` if both source runs share one.
- `web/src/lib/docOps.test.ts` — five tests: open polyline endpoints; closed run with electrode at index 0; mismatched diameters → jumper inherits project default; both runs in same raceway → jumper inherits raceway; two-vertex jumper polyline endpoints exactly match clicked electrode world coords.
- `web/src/components/EditorCanvas.tsx` — new `'connect'` value on the `EditorTool` discriminated union. Hover state highlights electrode handles in connect-tube mode; first click stages the source endpoint (renders a green pulse), second click commits via `connectTubes()`. Esc cancels the staged source.
- `web/src/pages/EditorPage.tsx` — new "Connect tubes" toolbar button next to Insert DB. Wire keyboard shortcut `C` (matches the rest of the toolbar's single-letter convention).
- `internal/printpdf/render.go` — main pattern page emits jumper runs with a dashed stroke (≤2 mm dash, 1 mm gap) and a `JUMPER` text label at the polyline midpoint. Bend-list pages skip jumpers entirely (no bends on a 2-vertex segment).
- `web/src/preview/Tube.tsx` — read `run.kind`; when `kind === "jumper"` render with a thinner radius (50% of computed) and a slightly desaturated emissive color so jumpers are visually distinguishable in the 3D preview. (Trade convention: jumpers are usually unlit clear glass anyway.)

**New:**

- `specs/active/tier3-60-connect-tubes.md` (this file) — moved to `specs/done/` on completion.

**Don't touch:**

- `internal/validate/rules.go` — no new validator rules in V1. (Future: warn if jumper exceeds typical 16 mm sleeve length; deferred.)
- `internal/server/handlers_*.go` — no new routes; jumpers persist via the existing design-version save path.
- Tube-spec model — jumpers reuse the project tube spec; per-jumper overrides deferred.

## Deliverables

### Doc model

```go
type Run struct {
    // ... existing fields ...
    // Kind classifies the run. "" (default) = primary tube; "jumper" =
    // splice tube connecting two primary runs (Strattman Fig.11.3,
    // Miller p.204–205). Jumpers render dashed on the 2D pattern,
    // thinner in the 3D preview, and skip bend-list emission.
    Kind string `json:"kind,omitempty"`
}
```

### `connectTubes` operation

```ts
function connectTubes(
  doc: DesignDoc,
  fromRunId: string,
  fromElectrodeIdx: number,  // index INTO from-run.Electrodes, not point index
  toRunId: string,
  toElectrodeIdx: number,
  opts?: { diameter_mm_override?: number },
): DesignDoc;
```

Steps:
1. Resolve `fromPoint` = `from-run.polyline.points[from-run.electrodes[fromElectrodeIdx].point_index]`. Same for `to`.
2. Reject if `fromRunId === toRunId` (prevents self-jumper; throw a clear error).
3. New run: `id = nextRunId(doc, 'j')`, `kind = "jumper"`, `polyline = { points: [fromPoint, toPoint], closed: false }`, no electrodes (jumpers are wired, not electrically open).
4. Inherit `raceway_id` from `from-run` if `from-run.raceway_id === to-run.raceway_id` (both grouped together).
5. Append to `doc.runs`. Return new Doc.

### Editor tool UX

- Toolbar button labeled "Connect" with hot-key `C`.
- Hover any electrode pin: pin highlights teal.
- First click: source pin pulses green; cursor changes to crosshair.
- Hover any electrode on a *different* run: target pin previews; a dashed line draws from source to current pointer position (live).
- Second click: commit → `connectTubes()` → jumper run added → tool returns to neutral state.
- Esc or right-click: cancel staged source.

### Print rendering

- Jumpers render on the main pattern page as dashed line (`gofpdf.SetDashPattern([]float64{2.0, 1.0}, 0)`).
- Centered text label "JUMPER" at midpoint, 6 pt, no outline.
- Bend list page: emit nothing for jumper runs (skip via `if run.Kind == "jumper" { continue }`).

### 3D preview

- `Tube.tsx`: `const radius = run.kind === "jumper" ? baseRadius * 0.5 : baseRadius;`
- Emissive material: render with `emissiveIntensity` halved to suggest unlit glass (trade convention: jumpers are usually 16 mm OD clear glass-sleeved wire, not active tube).

## Constraints

- **No new third-party deps.**
- **Backwards compatibility**: existing saved design-version blobs without `kind` deserialize cleanly to `""` (primary tube). Roundtrip-test this.
- **Strict 2-vertex jumpers in V1.** Multi-vertex routed jumpers (around obstacles) deferred to a follow-up.
- **No per-jumper diameter override UI in V1.** The opts argument exists but only the API can set it.
- **Validator silent on jumpers.** No bend-radius / lead-in / segment-length rules apply (jumpers are trivially short and flexible).

## Geometry / algorithms

Trivial — a jumper is a 2-point polyline. The interesting math is:

1. **World position of an electrode**: `polyline.points[electrode.point_index]`. No interpolation; electrodes always sit on a vertex per the type comment.
2. **Midpoint for "JUMPER" label**: `(p1 + p2) / 2` in mm. PDF text positioning uses the existing `mmToPt` helper.

## Tests

- **`docOps.test.ts`**:
  - `connectTubes_basicTwoOpenRuns` — endpoints exactly match clicked electrodes.
  - `connectTubes_inheritsRacewayId` — both source runs share `raceway_id="A"` → jumper has the same.
  - `connectTubes_doesNotInheritWhenRacewayMismatch` — sources differ → jumper has empty raceway_id.
  - `connectTubes_rejectsSameRun` — `fromRunId === toRunId` throws.
  - `connectTubes_idIsFresh` — adds 3 jumpers, ids are `j1`, `j2`, `j3`.
- **`integration_test.go`**: round-trip — create project → add jumper via API or save-design path → reload → assert jumper run survives with `kind="jumper"` and 2-vertex polyline.
- **`render.go`**: golden test — small doc with one primary run + one jumper. Print PDF byte-compare against checked-in golden in `internal/printpdf/testdata/jumper_golden.pdf`. Update via existing `-update` flag.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

```sh
( cd web && npm run dev )
```

1. Open a project with at least two runs that have electrodes.
2. Press `C` (or click "Connect"); click two electrode pins on different runs.
3. Verify: a dashed line connects them; sidebar shows the new `j1` run.
4. Print the project; main pattern shows the dashed jumper with a `JUMPER` label at midpoint.
5. Open the 3D preview; jumper renders thinner and dimmer than primary tubes.

## Workflow

1. Backend: add `Run.Kind` field; verify JSON round-trip; check whether migration 0012 is needed (only if runs are relational).
2. Frontend: implement `connectTubes` op + tests; wire the canvas tool + toolbar button; verify keyboard shortcut.
3. Print: dashed-line rendering + label + bend-list skip; commit golden.
4. 3D preview: 50%-radius branch in `Tube.tsx`.
5. Run all four pre-merge checks. Manual smoke per above.
6. Open PR titled "Connect tubes: jumper runs (Tier 3 #60, NW #125)".
7. Move spec `specs/active/ → specs/done/` in final commit.

## Report back

Under 300 words. Include:

- PR URL
- File deltas
- Tests added
- CI state
- Judgment calls — particularly: did migration 0012 need to land (relational vs JSON-blob storage)? How is jumper world-position resolution handled if the source run reverses direction or its electrode list is reordered?
- Tier 3 follow-ups: per-jumper diameter override UI, multi-vertex routed jumpers, validator rules for excessive jumper length, "auto-connect-end-pairs" tool that finds visually-close electrode pairs in the design and proposes jumpers.
