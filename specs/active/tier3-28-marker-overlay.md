# Tier 3 #28 — Visual marker overlay on SVG preview

> **Status:** active · started 2026-05-07 · branch `task/28-marker-overlay`

## Goal

The validation pass produces a `Report` with `Issues[]`, each carrying `(rule, severity, message, x_mm, y_mm)`. Today the report renders only as a textual list in the editor sidebar. The user has to read off coordinates and mentally locate the issue on the canvas.

This task draws the issues directly on the SVG preview as colored markers — red dots for errors, amber for warnings — with the rule message on hover. The user instantly sees which run / which corner is offending.

"Done" means: every issue with a non-zero `(x_mm, y_mm)` renders as a marker at that location on EditorCanvas; hovering a marker shows the rule + message in a tooltip; clicking a marker selects the nearest run; markers update live whenever the validation report refreshes.

## Branch + setup

```sh
git fetch origin
git checkout -b task/28-marker-overlay origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/components/EditorCanvas.tsx` — add a new SVG group that renders one `<circle>` per Issue from the latest validation report, layered above runs and below selection chrome. **Coupling note:** high-coupling file; sequence after #17 ESLint cleanup.
- `web/src/pages/EditorPage.tsx` — pass `validationReport` (or `report.Issues`) to EditorCanvas as a new prop; thread through from the existing validation state.
- `web/src/App.css` — marker styles + tooltip positioning.
- `web/src/api.ts` — verify the `ValidationReport` type already exposes `Issues` with `x_mm`, `y_mm` fields. Add types if missing.

**Don't touch:**

- Backend (no rule changes; markers consume existing report data).
- `internal/validate/` — no changes.

**New:** none.

## Deliverables

1. **Marker rendering.** For each `issue` with `Number.isFinite(issue.x_mm) && Number.isFinite(issue.y_mm)`:
   - Render a `<circle cx={issue.x_mm} cy={issue.y_mm} r={...}>` inside the canvas's world-space SVG group.
   - `r` is `max(8 / scale, 4)` mm so markers stay visible at any zoom (computed similarly to existing snap-radius math).
   - Color: severity `error` → CSS variable `--error` (red); `warning` → `--warn` (amber); add `--warn` to App.css if it doesn't exist yet.
   - Stroke: 1 px world-space, semi-transparent fill (alpha ≈ 0.5).
2. **Hover tooltip.** A `<title>` child on each circle gives a native browser tooltip carrying `rule + ": " + message`. Add a custom React tooltip if you prefer richer styling; native `<title>` is simpler and accessible.
3. **Click-to-select.** On marker click, find the run nearest `(x_mm, y_mm)` (existing run-selection helper); call `onSelectRun`. If multiple runs are equidistant, pick the first.
4. **Live refresh.** When the validation report changes (e.g. after a tube-spec edit triggers fan-out per Tier 3 #18), markers update in place. Use a `useMemo(..., [report])` so the marker geometry is recomputed only when issues change.
5. **Off-canvas filter.** Skip rendering markers whose `(x_mm, y_mm)` is outside the document bounding box ± 10 mm — these are usually data artifacts and clutter the canvas without informing the user.

## Constraints

- **No new third-party deps.** SVG `<title>` is sufficient for tooltips.
- **No backend changes.**
- **Keep the marker layer cheap.** Most reports have < 20 issues; even pathological ones rarely exceed 200. No virtualization needed; just render them all.
- **Respect existing pointer events.** Markers are interactive (hover + click); make sure they don't swallow drag events for the underlying run pickers. Use `pointer-events: stroke` or render markers in a layer that doesn't capture drag-start unless a click hits them directly.
- **Don't change the report schema.** This is purely a render layer.

## Geometry / algorithms

**Off-canvas filter:**

```ts
const padded = {
  x0: bbox.x - 10, y0: bbox.y - 10,
  x1: bbox.x + bbox.w + 10, y1: bbox.y + bbox.h + 10,
};
const inView = (i: Issue) =>
  Number.isFinite(i.x_mm) && Number.isFinite(i.y_mm) &&
  i.x_mm >= padded.x0 && i.x_mm <= padded.x1 &&
  i.y_mm >= padded.y0 && i.y_mm <= padded.y1;
```

**Nearest-run-on-click:** for each run, compute `min(dist² to each polyline point)`; pick the run with the global min. The existing canvas already has a similar helper for run-pick — search for `onSelectRun` callsites and reuse the same math if possible.

## Tests

No unit tests (no RTL setup). Manual smoke covers it.

## Pre-merge checks

Standard four. Manual smoke:

1. Open a project whose validation report has at least one error and one warning. Confirm a red dot and an amber dot appear on the canvas at the right locations.
2. Hover a marker; the rule + message tooltip appears.
3. Click a marker; the nearest run is selected (highlight ring appears).
4. Pan/zoom; markers stay anchored to world-space coordinates and stay visibly sized.
5. Edit the tube spec to introduce a new error; new markers appear without a manual refresh.
6. Save and load a different version with no issues; markers disappear.

## Workflow

1. Render marker layer with stub data; verify positioning at multiple zooms.
2. Wire up real `report.Issues`.
3. Add tooltip + click-to-select.
4. Pre-merge + smoke.
5. PR titled "Validation marker overlay (Tier 3 #28)".
6. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Include: PR URL, native `<title>` vs custom tooltip choice, marker pointer-events tuning, CI state, follow-ups (severity filter, jump-to-marker keyboard nav, badge in the sidebar issue list that pulses the corresponding marker on hover).
