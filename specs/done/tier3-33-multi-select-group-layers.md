# Tier 3 #33 — Drag-drop file upload + multi-select / group / layers

> **Status:** active · started 2026-05-07 · branch `task/33-multi-select-group-layers`

## Goal

`todo.md` Appendix B row 33 bundles four loosely-related editor improvements:

1. **Drag-drop file upload** for raw images on `ProjectDetail` (the existing file input + button stays; drag-drop lands an image without clicking).
2. **Multi-select runs** — click + Shift-click extends a selection; Cmd-A selects all; bulk operations (delete, color change, transform) work on the selection.
3. **Group runs** — bind a set of runs into a group that selects + transforms as one unit.
4. **Layers** — a sidebar listing visual groups with visibility toggles and a "lock" affordance so users can hide one channel-letter face's runs while editing another's.

These four are not a single PR. **Recommended split at dispatch time:**

- **PR 33a — Multi-select + drag-drop file upload** (this spec's primary deliverable).
- **PR 33b — Groups** (filed separately when 33a merges).
- **PR 33c — Layers** (filed separately when 33b merges; depends on group semantics).

This document is the **33a spec**. 33b and 33c each get their own spec when their dependencies land.

"Done" (for 33a) means: `ProjectDetail` accepts dropped image files and uploads them; `EditorCanvas` supports Shift-click / Cmd-click multi-select; `EditorPage` toolbar reflects the count of selected runs; existing single-select callers (color picker, delete button, neonize, etc.) work on multi-select; the existing single-select API (`selectedRunId: string | null`) is replaced by a `selectedRunIds: string[]` shape.

## Branch + setup

```sh
git fetch origin
git checkout -b task/33-multi-select-group-layers origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope (PR 33a)

**Modify:**

- `web/src/components/EditorCanvas.tsx` — replace the `selectedRunId: string | null` prop with `selectedRunIds: string[]`; update click/Shift-click/Cmd-click logic; render selection rings on every selected run, not just one. **High-coupling file** — sequence after #17 ESLint cleanup, ideally also after #28 marker overlay if both ship in the same round.
- `web/src/pages/EditorPage.tsx` — same prop swap; replace `selected: string | null` with `selectedRunIds: string[]`; update every consumer (delete handler, neonize button gating, run-detail panel, simplify, reverse, etc.).
- `web/src/pages/ProjectDetail.tsx` — add drag-drop handlers for image upload (mirror the bundle-import pattern from Tier 3 #22's spec, but for raw `.png/.jpg/.svg`). Reuse the existing `handleUpload` body for the dropped file; the existing button + hidden file input keeps working.
- `web/src/App.css` — drag-active overlay for `ProjectDetail`'s upload zone; multi-select count badge on the toolbar.

**Don't touch (this PR):**

- `web/src/lib/docOps.ts` — group + layer ops are 33b/33c.
- `internal/designdoc/types.go` — no schema additions for multi-select; selection is editor-state, not persisted.
- Backend — drag-drop reuses existing upload endpoints.

**New:**

- None for 33a.

**Deferred to 33b (groups):**

- `Group` type in `internal/designdoc/types.go` (or kept editor-only — debate at the time).
- Group create / dissolve / transform-as-one ops in `docOps.ts`.

**Deferred to 33c (layers):**

- Layer model (essentially named groups with visibility + lock flags).
- Sidebar layer list with show/hide/lock toggles.
- Persistence in `Doc`.

## Deliverables (PR 33a)

### Drag-drop image upload on ProjectDetail

Same drag-depth-counter pattern from Tier 3 #22 (preventDefault on dragover, counter ref to handle nested children, pointer-events:none overlay). On drop:

- Validate filename ends with one of `.png`, `.jpg`, `.jpeg`, `.svg` (case-insensitive).
- Call the existing `handleUpload` with the dropped File.
- Multi-file drops: process the first; ignore the rest with a console hint.
- Show a transient hint banner: "Uploaded foo.png". Auto-dismiss after 4 s.

### Multi-select runs

Selection state changes from `selectedRunId: string | null` to `selectedRunIds: string[]`:

- **Click on a run** with no modifier → set selection to `[runId]` (replaces).
- **Shift-click on a run** → toggle that runId in the set.
- **Cmd-click (⌘ on macOS, Ctrl on Windows/Linux)** — same as Shift-click. Both modifiers behave identically; we don't have a "range select" semantic since runs aren't ordered visually.
- **Click on background** → clear (`[]`).
- **Cmd-A (or Ctrl-A) when canvas is focused** → select every run in the doc.
- **Esc** → clear.

Update every consumer in EditorPage:

- **Run-detail panel** shows for the most-recently-clicked run when len > 1, with a "(N selected)" indicator. Operations that take one run (rename, change color, change diameter override) apply to all selected runs.
- **Delete** removes every selected run.
- **Neonize / Simplify / Reverse / etc.** — apply to each selected run independently (loop). Document the order semantic.
- **Save / undo** — selection is editor state, not persisted. Undo/redo restores the previous selection alongside doc state for ergonomics.

Selection rings on the canvas: render one ring per selected run, all in the same color. Add a small "+N more" indicator on the toolbar when len > 1 so the user always sees the total count.

### Toolbar count badge

`<span className="selection-count">3 selected</span>` next to the existing run-name display, only when `selectedRunIds.length >= 2`. Single-select keeps current behavior.

## Constraints

- **No new third-party deps.**
- **No backend changes.** Selection is client-side; nothing persists to the design doc.
- **Keep the API stable for callers.** A grep for `selectedRunId` should return zero matches after this PR; every callsite migrates to `selectedRunIds`. Don't shim a backward-compat alias — full migration in one commit avoids a half-broken state.
- **Do not introduce groups or layers in this PR.** They're separate work.
- **Drag-drop on ProjectDetail must not interfere with bundle drag-drop on ProjectList** (Tier 3 #22). They're different pages; no conflict expected, but verify the depth-counter + overlay pattern doesn't leak handlers up to a shared parent.

## Geometry / algorithms

Drag-depth counter — same as Tier 3 #22 spec:

```ts
const depth = useRef(0);
const [dragActive, setDragActive] = useState(false);
function onDragEnter(e) { e.preventDefault(); if (++depth.current === 1) setDragActive(true); }
function onDragLeave() { if (--depth.current <= 0) { depth.current = 0; setDragActive(false); } }
function onDragOver(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
function onDrop(e) {
  e.preventDefault(); depth.current = 0; setDragActive(false);
  const file = e.dataTransfer.files[0];
  if (!file || !isImage(file)) return;
  upload(file);
}
```

Multi-select toggle:

```ts
function toggle(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter(x => x !== id) : [...ids, id];
}
```

## Tests

No unit tests (no RTL setup). Manual smoke covers it.

## Pre-merge checks

Standard four. Manual smoke:

1. Drop a `.png` on ProjectDetail; verify the file uploads and appears in the assets list.
2. Drop a `.txt`; verify nothing happens (graceful reject).
3. In the editor, click a run; selection ring appears. Shift-click another run; both have rings.
4. Cmd-A; every run shows a ring; toolbar shows "N selected".
5. Click Delete; every selected run is removed; undo restores them all.
6. Multi-select two runs; click Neonize; both get neonized (verify two pairs of new runs appear, not one).
7. Esc clears selection.

## Workflow

1. Refactor selection state in EditorPage / EditorCanvas (most invasive; do first).
2. Update each consumer (delete, neonize, simplify, etc.) to loop on the selection.
3. Add drag-drop to ProjectDetail.
4. Add toolbar count badge + CSS.
5. Pre-merge + smoke.
6. PR titled "Multi-select runs + drag-drop image upload (Tier 3 #33a)".
7. **Move this spec** to `specs/done/`.

## Report back

Under 300 words. Include: PR URL, multi-op order semantic chosen for Neonize/Simplify (sequential vs parallel), keyboard-shortcut decision matrix, list of consumers updated (so 33b/33c agents know what's already plumbed), CI state, follow-ups (33b groups + 33c layers specs ready when this lands).

## When 33a merges — file 33b and 33c specs

After 33a is in main, draft `specs/active/tier3-33b-groups.md` (group create/dissolve/transform) and `specs/active/tier3-33c-layers.md` (layer panel + persistence) using this spec as a template. Each follows the same lifecycle — review, dispatch, ship, move to `done/`.
