# Tier 3 #47 — Marker overlay polish: severity filter, keyboard nav, sidebar↔canvas linking

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/47-marker-overlay-polish`

## Goal

PR #41 shipped the validation marker overlay — colored circles on the canvas at every issue's `(x_mm, y_mm)`. Three follow-ups remain from agent feedback:

1. **Severity filter** — sidebar checkboxes "Show errors" / "Show warnings" hide their corresponding markers (and the matching sidebar rows), so an operator focused on errors can suppress warning noise.
2. **Keyboard nav** — `j` / `k` (or `]` / `[`) jump-zoom-and-pan the canvas to the next/previous issue marker, cycling through them.
3. **Sidebar↔canvas hover linking** — hovering an issue row in the sidebar pulses the matching canvas marker; hovering a canvas marker highlights the corresponding sidebar row. Bidirectional via a shared `hoveredIssueIndex` state.

"Done" means: the overlay is operator-friendly even on dense designs (50+ issues); markers stay scannable; the sidebar and canvas feel like one surface, not two.

## Branch + setup

```sh
git fetch origin
git checkout -b task/47-marker-overlay-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/components/EditorCanvas.tsx` — accept `hoveredIssueIndex?: number` prop; render the matching marker with a brighter stroke + larger radius pulse animation. Emit `onIssueHover(idx | null)` when hovering a marker. Filter rendered markers by passed-in severity-filter prop.
- `web/src/components/ValidationReportView.tsx` — issue rows accept `onMouseEnter / onMouseLeave` that call up to a `setHoveredIssueIndex` from the parent. Click-to-jump-to-marker uses a new `onIssueClick(idx)` prop.
- `web/src/pages/EditorPage.tsx` — own the `hoveredIssueIndex` + `severityFilter` state; pass to both subcomponents. Add a global keyboard listener (`useEffect` with `addEventListener('keydown')`) for `j` / `k` (and `]` / `[`) that pans-and-zooms the canvas to the next/prev marker and selects the matching issue. Filter checkboxes live above the issue list.
- `web/src/App.css` — pulse animation for the highlighted marker; sidebar row :hover state matches.

**Don't touch:**

- Backend — issue data is unchanged.
- `internal/validate/*` — rule logic stays.
- `ProjectList.tsx`, `ProjectDetail.tsx`, `VectorizePanel.tsx` — unrelated.

**New:** none.

## Deliverables

1. **Severity filter**: two checkboxes above the sidebar issue list. Defaults: both checked. Unchecking "Errors" hides every error-severity issue from BOTH the sidebar list AND the canvas markers; same for warnings. State is component-local, not persisted.
2. **Keyboard nav**: `j` (next) / `k` (prev), with `]` / `[` as aliases. Cycles through `report.issues` in order. The selected issue's marker gets the same pulse animation as a hovered marker. The canvas pans-and-zooms (smooth) to center the marker. Pressing the key while no issue is selected starts at index 0.
3. **Sidebar↔canvas hover linking**:
   - Hovering an issue row in the sidebar → set `hoveredIssueIndex = i` → canvas pulses marker `i`.
   - Hovering a canvas marker → emit `onIssueHover(i)` → parent sets `hoveredIssueIndex = i` → sidebar row highlights.
   - Mouse-leave clears the index back to `null`.
   - Click on either side: select the corresponding run (matching `nearestRunId` from PR #41) AND set the active issue (so subsequent `j`/`k` cycles from that point).
4. **Pulse animation**: a CSS `@keyframes` doubling and dimming the stroke briefly. Subtle — operator notices but it doesn't fight for attention.

## Constraints

- **No new third-party deps.** Hover linking is plain prop drilling + state; the pulse is plain CSS.
- **No keyboard shortcut conflicts.** `j` and `k` are unused today (verified: search EditorPage / EditorCanvas for existing keydown handlers). The `[` / `]` aliases are also free. If a future tool wants `j`, this PR is the layer that decides — but for V1, claim them.
- **Filter state is component-local.** No URL params, no localStorage. Nice-to-have follow-up.
- **No new render perf hazards.** With 100+ issues, the marker layer must still render at 60 fps. Use a stable key per marker (`issue.x_mm + ":" + issue.y_mm + ":" + issue.code` is unique enough) so React's reconciler doesn't unmount-remount on every report refresh.
- **`pointer-events`** stay correct on markers — the existing `e.stopPropagation()` from PR #41 must continue to keep run-tool clicks from firing through markers.

## Geometry / algorithms

**Pan-and-zoom on keyboard nav**: read the marker's `(x_mm, y_mm)`, compute the canvas viewport center delta needed to put it at the screen center, animate via the existing canvas pan+zoom state. Keep the current zoom level — don't rescale just to fit.

**Smooth animation**: 200 ms cubic ease-out via a per-frame `requestAnimationFrame` loop OR a CSS `transition` on the SVG `<g transform=...>` element if the existing pan-zoom is already CSS-driven. Match whatever pattern exists.

## Tests

Component tests aren't set up; manual smoke covers the UI. Backend tests are unchanged.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

Manual smoke (use a project with 5+ issues spread across the canvas):

1. Open the editor; both severity filters checked → all markers + rows visible.
2. Uncheck "Show warnings" → warning markers + rows disappear; error markers + rows remain.
3. Hover a sidebar row → matching canvas marker pulses brightly.
4. Hover a canvas marker → matching sidebar row highlights.
5. Press `j` → canvas pans to issue 0; press `j` again → pans to issue 1; cycles through.
6. Press `k` → moves backward.
7. Press `]` and `[` → same behavior (alias).
8. Click a marker → run is selected (existing PR #41 behavior); subsequent `j` cycles forward from that issue.
9. Switch to a project with 50+ issues → keyboard nav stays responsive; markers render at 60 fps (DevTools performance panel).

## Workflow

1. Add `hoveredIssueIndex` + `severityFilter` state at EditorPage. Wire to both subcomponents.
2. Implement severity filter (filter the issue array in EditorPage; pass filtered array to both subcomponents).
3. Implement hover linking — sidebar onMouseEnter/Leave; canvas onIssueHover.
4. Add the pulse animation in CSS; confirm it triggers via `hoveredIssueIndex`.
5. Add the keyboard listener. Wire pan-zoom to selected issue.
6. Manual smoke through every scenario.
7. Pre-merge checks; open PR titled "Marker overlay polish: severity filter + keyboard nav + hover linking (Tier 3 #47)".
8. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, summary, judgment calls (pulse animation timing/intensity; whether pan-zoom keeps current zoom or rescales-to-fit), file-size deltas, CI state, manual smoke notes, follow-ups (filter persistence, run-detail panel showing issues for the selected run only, color-blind-friendly severity palette).
