# Tier 3 #46 — Channel-letter polish v2: auto-raceway grouping + escalation

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/46-channel-letter-v2`

## Goal

PR #43 shipped manual `RacewayID` grouping — operators tag each channel-letter face run with a free-form raceway string and runs sharing a value get concatenated onto a combined-strip page. This works but it's tedious for a multi-letter sign where every letter on the same baseline shares the raceway.

This row adds:
1. **Auto-raceway grouping** — a one-click "Group by baseline" sidebar action that sets `RacewayID` on every face-flagged run based on a baseline + bounding-box clustering pass.
2. **Severity escalation toggle** — a per-project flag `face_perimeter_strict_mode` that escalates `RuleFacePerimeterExceedsBlank` from warning to error. Some shops want a hard-stop; others want the warning so they can splice instead.

"Done" means: clicking "Auto-group raceways" assigns deterministic group IDs to every face-flagged run; the combined-strip pages emit accordingly; the strict-mode toggle lives on `ProjectDetail` next to the channel-letter depth field; `RuleFacePerimeterExceedsBlank`'s severity reads from the project setting.

## Branch + setup

```sh
git fetch origin
git checkout -b task/46-channel-letter-v2 origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/lib/raceway.ts` (new) — `groupByBaseline(runs: Run[]): Map<string, string>` returns a map from run ID → assigned raceway ID. Pure function, vitest-friendly.
- `web/src/lib/raceway.test.ts` (new) — clustering tests.
- `web/src/lib/docOps.ts` — new `autoAssignRaceways(doc): DesignDoc` op that calls `groupByBaseline` and writes the assigned IDs back. Use existing `editDoc()` plumbing for undo/redo support.
- `web/src/pages/EditorPage.tsx` — sidebar button "Auto-group raceways" that calls the new docOp; disabled when no runs have `IsChannelLetterFace`.
- `internal/storage/migrations/0012_project_strict_mode.sql` (new — verify next unused number) — adds `projects.face_perimeter_strict_mode INTEGER NOT NULL DEFAULT 0`. Reversible Down.
- `internal/storage/projects.go` — read/write the new column.
- `internal/storage/models.go` — add the field.
- `internal/server/handlers_projects.go` — accept `face_perimeter_strict_mode` in PATCH (boolean, three-state via `*bool`).
- `internal/validate/rules.go` — `RuleFacePerimeterExceedsBlank` reads severity from a new `Limits.FacePerimeterStrict bool` field. When true, emit `severity: "error"`; when false (default), `"warning"`.
- `internal/validate/types.go` — add the `Limits.FacePerimeterStrict` field.
- `internal/server/handlers_vectorize.go` — forward `FacePerimeterStrict` from project to validator (this is the ninth Limits field — keep the audit pattern from #44).
- `web/src/api.ts` — add the field to `Project` and `updateProject`.
- `web/src/pages/ProjectDetail.tsx` — checkbox "Strict mode: face perimeter exceeds blank length is an error" next to the channel-letter depth + strip-overlap fields.

**Don't touch:**

- `EditorCanvas.tsx` — markers from PR #41 already render with the right severity; they read from the report.
- `internal/printpdf/raceway.go` — auto-grouping just writes the right `RacewayID` strings; the existing renderer handles them.
- Other validation rules.

**New:**

- `web/src/lib/raceway.ts` and its test
- Migration `0012_project_strict_mode.sql` (verify number; bump if needed)

## Deliverables

### Auto-grouping algorithm

For each face-flagged run, compute its bounding box. Cluster by:

1. **Baseline grouping**: runs whose bbox bottom-Y values are within `H × 0.15` (where H = median bbox height) belong to the same baseline.
2. **Within-baseline horizontal proximity**: runs on the same baseline whose horizontal gaps are less than `2 × H` belong to the same raceway. Larger gaps split the baseline into multiple raceways.
3. **Multi-baseline letters**: runs that don't fit into any existing baseline cluster get their own raceway (single-letter group).

Assign deterministic IDs: `raceway-1`, `raceway-2`, ... in left-to-right order by group leftmost X.

Handle pre-existing manual `RacewayID` values: by default, `autoAssignRaceways` overwrites them. Add a flag `preserveExisting: boolean` (default `false`) that skips runs with non-empty existing values; the sidebar button passes `false` (replace) but the same docOp can be called with `preserveExisting: true` for incremental tagging.

### Strict mode

- Project-level boolean (default `false`).
- When `true`, `RuleFacePerimeterExceedsBlank` emits `severity: "error"` and the marker overlay shows red. Existing tests with strict mode unset must produce identical reports.

## Constraints

- **No new third-party deps.** Plain TS + a small clustering loop.
- **Auto-grouping is destructive by default** — the docOp warns the user via a confirm dialog before running ("Replace all raceway IDs with auto-assigned values?"). Confirm dismisses if they cancel.
- **Migration number** must be the next unused — check the migrations dir before writing the SQL.
- **No silent severity changes** for existing data — strict mode default is `false` so existing reports stay identical.
- **Limits forwarding** must stay consistent — if PR #44 has merged, mirror its pattern; if not, document the gap and flag it as a follow-up.

## Geometry / algorithms

```ts
function groupByBaseline(runs: Run[], opts: { preserveExisting?: boolean } = {}): Map<string, string> {
  const faces = runs.filter(r => r.IsChannelLetterFace);
  if (faces.length === 0) return new Map();

  const bboxes = faces.map(r => bbox(r.Polyline));
  const heights = bboxes.map(b => b.h);
  const H = median(heights);

  // Group by baseline (bbox bottom)
  const baselineTol = H * 0.15;
  const baselineGroups: Run[][] = [];
  for (const r of faces) {
    const bb = bbox(r.Polyline);
    const group = baselineGroups.find(g => Math.abs(bbox(g[0].Polyline).bottom - bb.bottom) < baselineTol);
    if (group) group.push(r);
    else baselineGroups.push([r]);
  }

  // Within each baseline, split by horizontal gap > 2H
  const gapTol = H * 2;
  const racewayGroups: Run[][] = [];
  for (const baseline of baselineGroups) {
    baseline.sort((a, b) => bbox(a.Polyline).left - bbox(b.Polyline).left);
    let current: Run[] = [];
    for (const r of baseline) {
      if (current.length === 0) { current = [r]; continue; }
      const prevBB = bbox(current[current.length - 1].Polyline);
      const thisBB = bbox(r.Polyline);
      const gap = thisBB.left - prevBB.right;
      if (gap > gapTol) {
        racewayGroups.push(current);
        current = [r];
      } else {
        current.push(r);
      }
    }
    if (current.length > 0) racewayGroups.push(current);
  }

  // Sort groups left-to-right; assign raceway-N
  racewayGroups.sort((a, b) => bbox(a[0].Polyline).left - bbox(b[0].Polyline).left);
  const out = new Map<string, string>();
  racewayGroups.forEach((g, i) => {
    for (const r of g) {
      if (opts.preserveExisting && r.RacewayID) continue;
      out.set(r.ID, `raceway-${i + 1}`);
    }
  });
  return out;
}
```

`H × 0.15` and `2 × H` are heuristic tuning constants. Document them in the function header so a future maintainer can adjust.

## Tests

Add to `raceway.test.ts`:

- **Single line of letters**: 5 face runs in a row, similar heights, gaps < 2H → one raceway containing all 5.
- **Two-line sign**: top + bottom rows, each with 3 letters → two raceways.
- **Wide gap splits baseline**: 5 letters where the middle gap is 5H → two raceways on the same baseline.
- **No face flags**: empty input → empty map.
- **Mixed face + non-face**: only face-flagged runs appear in the output.
- **`preserveExisting: true`**: a face run with `RacewayID = "manual-1"` keeps it; others get auto-assigned.
- **Deterministic ordering**: shuffling the input run order produces the same output IDs (left-to-right group ordering by leftmost X).

Add to `internal/validate/rules_test.go`:

- **`TestFacePerimeterStrictModeEscalates`**: a doc with a face perimeter > 1168 mm. Validate twice — once with `Limits.FacePerimeterStrict = false`, once `true`. Assert severity differs (warning vs error) but the issue is otherwise identical.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke:

1. Open a multi-letter design with face flags set on each letter. Click "Auto-group raceways" → confirm dialog → accept.
2. Verify the assigned raceway IDs appear in each run's sidebar field.
3. Print the PDF; verify the combined-strip pages reflect the new groupings.
4. Toggle strict mode on a project with an oversized face. Verify the marker turns red and the report shows error severity.

## Workflow

1. Frontend `raceway.ts` + tests first.
2. Wire into docOps + sidebar button.
3. Backend strict-mode column + handler PATCH + validate rule.
4. Frontend project-detail checkbox.
5. Pre-merge checks; manual smoke.
6. Open PR titled "Channel-letter v2: auto-raceway grouping + strict-mode toggle (Tier 3 #46)".
7. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially the H×0.15 / 2H heuristic constants — what real-design fixtures you tested against; whether overwrite-default was the right call), file-size deltas, CI state, follow-ups (e.g. drag-to-reorder runs within a raceway group; visual cue on canvas showing which raceway each face belongs to).
