# Tier 3 #63 — Neon Preview for Groups (NW #140)

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/63-preview-for-groups` · **BLOCKED on Tier 3 #33 (multi-select / groups model)**

## Goal

Phase 3 (PRs #57–63) shipped end-to-end 3D glow preview rendering the entire design. NW's #140 "Neon Preview for Groups" is finer-grained: select a subset of runs (a group, in NW terminology) and preview only that group, leaving the rest of the design dark or hidden. This is useful when:

- The whole sign has dozens of runs and the operator wants to verify a single channel-letter cluster.
- The design includes mockup-only "background" runs (city skyline behind a logo) that distract from the focal element being reviewed.
- A multi-tenant cabinet (multiple letters that flash separately) needs each addressable group rendered alone.

This spec adds a per-group filter to the existing preview route. **Blocked on Tier 3 #33** (multi-select / group / layers model), which must land first to provide the grouping primitive — there's no point selecting groups today because no group structure exists.

## Branch + setup

```sh
git fetch origin
git checkout -b task/63-preview-for-groups origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/preview/PreviewPage.tsx` — read `?groupId=<id>` query param from `useLocation`. If present, pass `selectedGroupId={id}` down to `<Scene>`. If absent, render all runs (today's behavior).
- `web/src/preview/Scene.tsx` — accept `selectedGroupId?: string` prop. Filter `doc.runs.filter(r => !selectedGroupId || r.group_id === selectedGroupId)` before mapping over `<Tube>`. Bbox / camera-fit / wall-plane positioning all key off the filtered run list so the preview frames just the group.
- `web/src/preview/SceneControls.tsx` — add a "Group" `<select>` at the top of the sidebar listing all unique `group_id` values present in the design plus an "All groups" entry. Selection updates the URL via `useNavigate(?groupId=...)` so the state survives reloads and is shareable via copy-paste link.
- `web/src/preview/preview.css` — minor styling for the new group selector (matches the existing background/wall dropdowns).
- `web/src/preview/Scene.test.tsx` (NEW) — vitest module test confirming the filter behavior works as a pure function (mock doc with two groups; assert filtered run count for each `selectedGroupId` value).

**New:**

- `specs/active/tier3-63-preview-for-groups.md` (this file) — moved to `specs/done/` on completion.

**Don't touch:**

- `internal/designdoc/types.go` — `Run.GroupID` lands in Tier 3 #33's spec, not here.
- Tube extrusion / emissive material / bloom / electrodes — all unchanged; they iterate over whatever runs `Scene` renders.
- Preset views / orbit camera — they bbox-fit the filtered run list automatically.
- `EditorCanvas.tsx`, `EditorPage.tsx` — group authoring is in #33, not here.
- Backend / handlers / migrations — purely a frontend filter change.

## Deliverables

### URL state

`/projects/:projectId/versions/:versionId/preview?groupId=<id>` — preserves group state across reload and is shareable. Empty/missing means "render all".

### Sidebar group selector

`<SceneControls>` gets a new top-of-panel control:

```tsx
<select
  value={selectedGroupId ?? ""}
  onChange={e => navigate(`?groupId=${e.target.value}`)}
>
  <option value="">All groups</option>
  {uniqueGroupIds.map(id => <option key={id} value={id}>{groupLabel(id)}</option>)}
</select>
```

`uniqueGroupIds` derived once from `doc.runs.map(r => r.group_id).filter(Boolean)`. `groupLabel` uses the human label if Tier 3 #33 ships group metadata; otherwise the raw id.

### Filtered scene rendering

`<Scene>`:

```tsx
const visibleRuns = useMemo(
  () => selectedGroupId ? doc.runs.filter(r => r.group_id === selectedGroupId) : doc.runs,
  [doc.runs, selectedGroupId],
);
```

`bboxOfRuns(visibleRuns)` (already exists in `cameraPresets.ts`) drives the wall-plane and camera-fit logic — they automatically reframe to just the group.

### "Other" runs handling

V1 simply hides non-selected runs. Two more behaviors are common in NW; deferred to follow-ups:

- **Dim mode**: render non-selected runs at low emissive intensity (5%) so the operator sees context but the focal group dominates.
- **Cutout mode**: render non-selected runs as wireframe outlines (no fill, no glow) for spatial context without visual competition.

V1 picks **hide** as the boring default.

## Constraints

- **No new third-party deps.**
- **No backend changes.** The doc with `Run.GroupID` already exists post-Tier 3 #33; this spec only filters at render time.
- **Group state is URL-only**; no localStorage persistence (matches the rest of the preview's component-local state convention from Phase 3).
- **No group-authoring affordances on the preview** — preview stays read-only; #33 owns the editor side.
- **Camera reframes on group change** — the current animation pattern (Phase 3 #5's 600 ms cubic ease) applies here too.

## Geometry / algorithms

Trivial — pure filter on the runs array. Existing bbox / camera-fit / wall-plane / bloom all key off the filtered list with no further changes needed.

## Tests

- `Scene.test.tsx`: unit test asserting filter math. Mock doc with three runs across two groups; assert `selectedGroupId="A"` yields 2 runs, `"B"` yields 1, undefined yields 3.
- Integration test deferred — the existing `PreviewPage.test.tsx` import-shape test catches regressions in the file's structure; full-render testing requires RTL setup which Phase 3 explicitly skipped.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Project with at least 4 runs across 2 distinct `group_id` values (requires Tier 3 #33 to be merged for the group-authoring affordance).
2. Open the 3D preview; sidebar shows the group `<select>`.
3. Select group A; only A's runs render; camera reframes to A's bbox.
4. Toggle to "All groups"; full design renders.
5. Copy the URL with `?groupId=A`; paste into a new tab; preview loads pre-filtered.
6. Reload the page; group state persists via URL.

## Workflow

1. **Verify Tier 3 #33 has merged.** If not, this spec stays in `specs/active/` and dispatch is deferred. Do not start.
2. Implement the filter in `Scene.tsx`; verify with the unit test.
3. Wire the group selector + URL state in `SceneControls.tsx` + `PreviewPage.tsx`.
4. Pre-merge checks + manual smoke per above.
5. Open PR titled "Preview for groups (Tier 3 #63, NW #140)".
6. Move spec `specs/active/ → specs/done/` in final commit.

## Report back

Under 300 words. Include:

- PR URL
- File deltas
- Tests added
- CI state
- Judgment calls — particularly: did the camera reframe feel right when toggling groups, or does it need a "lock camera" toggle? How did the group `<select>` order feel (declaration order vs alphabetical vs first-encountered)?
- Tier 3 follow-ups: dim-mode and cutout-mode for non-selected groups; "compare two groups side-by-side" view (split-canvas); per-group screenshot export with the group name embedded in the filename; localStorage persistence of the last-selected group per project.
