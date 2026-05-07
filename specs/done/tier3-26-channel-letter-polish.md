# Tier 3 #26 — Channel-letter return polish

> **Status:** active · started 2026-05-07 · branch `task/26-channel-letter-polish`

## Goal

PR #25 shipped channel-letter return patterns: per-project depth, a face flag on each run, and an unfolded-strip PDF page per face. Four follow-ups carry forward as Tier 3 #26:

1. **Per-run depth override.** Today a project has one `channel_letter_depth_mm` value applied to every face run. Some signs mix tall returns (3" on the main letterforms) with low returns on bracket frames; let each run override the project default.
2. **Perimeter-vs-blank validator.** Sheet-metal blanks come on 1168 mm (46") rolls; a face whose perimeter exceeds that needs a documented seam. Add a validator rule that warns (or errors, configurable) when a face perimeter > a tube-spec-driven blank length constant.
3. **Draggable / configurable strip-overlap allowance.** Today the print PDF carries the overlap allowance as a footer note (informational). Make it: (a) a configurable per-project value (mm), (b) drawn on the unfolded strip page so the fabricator can see exactly where to shear.
4. **Multi-letter raceway groupings.** Strattman raceway construction shares one return strip across multiple joined faces (e.g. all letters in "OPEN" share one continuous back-channel). Add a way to group runs into a "raceway" and emit one combined unfolded strip per group instead of one per run.

"Done" means: per-run depth flows through to PDF correctly; perimeter validation appears in the report and on the marker overlay (Tier 3 #28 will render it once shipped); strip-overlap is a configurable value drawn on the page; raceway groupings produce a combined unfolded strip and the existing per-face strips disappear for grouped runs.

## Branch + setup

```sh
git fetch origin
git checkout -b task/26-channel-letter-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — add `ChannelLetterDepthMM *float64 \`json:"channel_letter_depth_mm,omitempty"\`` and `RacewayID string \`json:"raceway_id,omitempty"\`` to `Run`. Both optional, both backwards-compatible with existing docs.
- `internal/storage/migrations/0011_project_strip_overlap.sql` — new migration adding `projects.strip_overlap_mm REAL` (nullable, default 12.7 mm = 0.5"). Reversible Down. (Original spec reserved 0008 but PRs #35/#42 already shipped 0009/0010 since this spec was drafted; we use the next unused monotonic number to avoid goose "missing migration" failures on existing installs.)
- `internal/storage/storage.go` — read/write the new column on Project.
- `internal/server/handlers_projects.go` — same three-state PATCH semantics as `tube_end_gap_mm` (omitted / null / value) for `strip_overlap_mm`. Validate range [0, 100] mm.
- `internal/printpdf/render.go` — `emitReturnStrip` reads the per-run depth override (falls back to project default → 100 mm shop default). Extend the strip page to draw the overlap allowance as a dashed shear line at one end.
- `internal/validate/rules.go` — new rule `RuleFacePerimeterExceedsBlank`. For each run with `IsChannelLetterFace == true`, compute polyline perimeter; if perimeter > 1168 mm (constant `blankLengthMM`), emit an `Issue` with severity warning by default.
- `internal/validate/types.go` — register the new rule constant.
- `web/src/pages/ProjectDetail.tsx` — input field for `strip_overlap_mm` next to `channel_letter_depth_mm`.
- `web/src/pages/EditorPage.tsx` — per-run depth override input next to the existing face checkbox; raceway-id text input on each run (free-form short string; runs sharing a value group together).

**Don't touch:**

- `EditorCanvas.tsx` — no canvas changes.
- Other validation rules.

**New:**

- `internal/printpdf/raceway.go` — `groupByRaceway(runs []Run) map[string][]Run` and `emitRacewayStrip(pdf, opts, runs []Run)` for the combined unfolded strip.

## Deliverables

### Per-run depth override

`Run.ChannelLetterDepthMM *float64`. Print emission resolves to: per-run override → project default → 100 mm shop default. Frontend input on the run sidebar; only relevant when `IsChannelLetterFace == true` (hide otherwise).

### Perimeter-vs-blank validator

```go
const blankLengthMM = 1168 // 46" coil; sourced from Strattman NT Ch.5
```

For each face run, perimeter = sum of polyline segment lengths (closed polylines add the closing segment). When perimeter > blankLengthMM, emit:

```go
Issue{
    Rule:     RuleFacePerimeterExceedsBlank,
    Severity: SeverityWarning,
    Message:  fmt.Sprintf("Face perimeter %.0f mm exceeds standard %d mm blank — needs documented seam.", perimeter, blankLengthMM),
    XMM, YMM: <run centroid>,
}
```

### Configurable strip-overlap

Project-level `strip_overlap_mm` (default 12.7 mm = 0.5"). Drawn on the unfolded strip page as a dashed line `overlap_mm` from the right end (or both ends — confirm the fabricator convention against `docs/neon-rules/`; if unclear, draw at the right end and add a footer note saying "shear here for overlap"). Footer note continues to display the value.

### Raceway groupings

A raceway is a string label on each run; runs sharing the label are grouped. Empty `raceway_id` = ungrouped (current per-run behavior). For each non-empty group:

1. Collect every face run with that raceway_id.
2. Concatenate their polylines in declaration order (no fancy traversal — the user picks the order by run order).
3. Emit ONE unfolded strip page covering the combined perimeter, with each run's contribution boundary marked as a dashed line.
4. Skip emitting individual strip pages for those runs.

The grouping algorithm is pragmatic — Strattman's raceway construction has shop-floor judgment built in (which letters share a strip, where to put the seams). V1 just gives the user an explicit knob; future polish can offer auto-grouping.

## Constraints

- **Backwards compatible.** Existing docs with no per-run depth, no raceway, no overlap value continue to render identically. Migration's Down restores zero data loss.
- **Validator severity is warning, not error**, to match the existing `RuleSpliceRecommended` pattern. Some shops accept seamed faces; firm "error" behavior is a per-shop policy that doesn't belong in the rule.
- **No new third-party deps.**
- **No editor canvas changes.** Per-run depth + raceway live in the sidebar/run-detail panel.

## Geometry / algorithms

**Perimeter** = `Σ dist(points[i], points[i+1])` for `i in [0, n-1]`, plus the closing segment if `Closed`.

**Run centroid** for the validator marker — average of all polyline points. Acceptable approximation; the marker just needs to land near the run.

**Combined raceway strip dimensions** — width = sum of contributing perimeters; height = max(per-run depth) across the group (so the strip is one rectangle big enough for every contribution). Mark each run's perimeter contribution with a dashed vertical line at the cumulative-perimeter offset.

## Tests

- `internal/validate/rules_test.go` — `TestFacePerimeterExceedsBlank`: a face run with perimeter 1500 mm emits a warning; one with perimeter 800 mm does not.
- `internal/printpdf/render_test.go` (or extend `raceway_test.go`) — synthetic doc with two face runs sharing `raceway_id = "main"` produces one combined strip page, no per-run strips for those runs.
- Frontend: no unit tests; manual smoke covers it.

## Pre-merge checks

Standard four checks. Manual smoke:

1. Project with one face run, perimeter < 1168 mm, validation report has no perimeter warning.
2. Same run with a long polyline (perimeter > 1168 mm) shows the warning in the report.
3. Set per-run depth override on one face; print PDF — strip page reflects the override, not the project default.
4. Two face runs in the same raceway → one combined strip page; remove the raceway label → two strip pages return.
5. Change `strip_overlap_mm` from 12.7 to 25; reprint — the dashed shear line moves accordingly.

## Workflow

1. Schema migration + storage layer.
2. Designdoc types + handlers.
3. Validator rule + test.
4. PDF rendering: per-run depth, overlap line, raceway grouping.
5. Frontend inputs.
6. Pre-merge + smoke.
7. PR titled "Channel-letter polish: per-run depth, perimeter validator, overlap, raceways (Tier 3 #26)".
8. **Move this spec** to `specs/done/`.

## Report back

Under 300 words. Include: PR URL, raceway concatenation order policy (declaration order vs. user-controlled), shear-line placement decision (one end vs. both), CI state, follow-ups (auto-raceway grouping, shop-policy toggle to escalate the perimeter warning to an error).
