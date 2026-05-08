# Tier 3 #33c — Layers panel (visibility + lock toggles per group)

> **Status:** active · drafted 2026-05-08 · branch `task/3-33c-layers`
>
> **Depends on:** Tier 3 #33b (groups). Don't dispatch until 33b is merged into main and `Doc.Groups` exists. The persistence and selection plumbing this builds on come from 33b.

## Goal

After 33b binds runs into groups, 33c surfaces those groups as a **Layers panel** in the editor sidebar with two affordances per group:

1. **Visibility toggle** — eye icon hides the layer's runs from the canvas (rendered with `display: none` in SVG, so they don't appear and aren't hit-testable). Validation, save, neonize, and PDF still see them — visibility is a *display* filter, not a doc filter.
2. **Lock affordance** — padlock icon prevents click-selection on members of a locked layer. Useful when editing one channel-letter face while leaving the others visible-but-untouchable as references. Locked layers still appear on canvas; they just don't respond to clicks.

This is the trade convention pulled from NW + every adjacent design tool (Illustrator's `Layers` panel, NW's group sidebar). It's the natural completion of the 33-row in Appendix B.

"Done" means: the editor sidebar gains a "Layers" section listing every `Doc.Groups` entry with eye + padlock icons; clicking eye toggles `Group.Visible`; clicking padlock toggles `Group.Locked`; the canvas honors both flags; both flags persist via JSON-blob round-trip.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-33c-layers origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — add `Visible bool` (default `true` — `omitempty` would invert; use a custom JSON tag or default-handler in the unmarshal path) and `Locked bool` to `Group`. Default visible-true is a back-compat invariant: a doc persisted before 33c has groups with no explicit `visible`, which deserializes as `false`; we override that to `true` at unmarshal time. (Alternative: use a pointer `*bool` and treat `nil` as visible; that's cleaner if you'd rather not write a custom unmarshaler.)
- `web/src/api.ts` — mirror the `visible: boolean` / `locked: boolean` fields. The TypeScript side defaults `undefined` → visible (semantic identical to Go's nil-pointer interpretation).
- `web/src/lib/docOps.ts` — `setGroupVisible(doc, groupId, visible: boolean): Doc`; `setGroupLocked(doc, groupId, locked: boolean): Doc`. Both flow through `editDoc` so undo/redo work.
- `web/src/lib/docOps.test.ts` — pin the new ops + back-compat test loading a pre-33c JSON literal (group with no `visible` field → `visible === true` after parse).
- `web/src/components/EditorCanvas.tsx` — when a run's group is hidden, don't render its `<polyline>` at all (skip in the `runs.map` filter). When a run's group is locked, set `pointer-events: none` on its polyline + ignore in any nearest-run hit-test for click selection.
- `web/src/pages/EditorPage.tsx` — sidebar "Layers" section. One row per group: `<eye>` toggle + `<padlock>` toggle + group name (editable text from 33b) + `(N runs)` + `Dissolve` button. Hidden runs in the canvas selection auto-clear (a hidden run can't stay selected). Cmd-A respects visibility (only visible runs select).
- `web/src/App.css` — eye + padlock icon styles, dimmed appearance for hidden / locked rows.

**Don't touch:**

- Validation / save / PDF / DXF — those see all runs regardless of layer visibility (per spec). Hidden runs are display-only.
- The neonize / simplify / multi-op consumers — they operate on the explicit `selectedRunIds` array; if the user has selected hidden runs (via Cmd-A before hiding, or via API), the op still runs. Hidden runs that fall out of the selection at toggle time is the only filter.
- The 3D preview (`/preview` route) — the preview should ALSO honor `Group.Visible` (a hidden group should not render). That's a small follow-up, but if the file scope here is bounded enough, include it: `Scene.tsx` reads `doc.runs` filtering by `r.group_id` → `doc.groups[gid].visible`. Spec it as a deliverable but document if the agent defers.

**New:**

- `web/src/components/icons/Eye.tsx` + `web/src/components/icons/Padlock.tsx` (small inline SVG, no new dep). Two states each: open / closed. Use existing icon conventions in the codebase.

## Deliverables

1. **Schema additions.**
   ```go
   type Group struct {
     ID      string `json:"id"`
     Name    string `json:"name"`
     Visible *bool  `json:"visible,omitempty"` // nil = visible (back-compat)
     Locked  bool   `json:"locked,omitempty"`
   }
   ```
   Or with a custom unmarshaler that defaults `Visible: true` on field-absent. Pick whichever keeps the JSON round-trip clean.

2. **`docOps.ts` operations.**
   ```ts
   setGroupVisible(doc, groupId, visible: boolean): Doc
   setGroupLocked(doc, groupId, locked: boolean): Doc
   ```
   Both no-op on missing groupId.

3. **Canvas honors visibility.**
   - Hidden group's runs: skipped in the `runs.map(...)` render entirely.
   - Locked group's runs: rendered, but with `pointer-events: none` AND excluded from any background-click nearest-run hit test.
   - Selection ring + group outline (33b) honor both flags too: hidden runs don't show rings; locked runs show a dimmed (50%-opacity) ring when in the selection.

4. **Sidebar Layers section.**
   - Header: `Layers (N)` with N = count of `Doc.Groups`.
   - Per-row layout:
     ```
     [👁] [🔒] <name editable>  (M runs)  [Dissolve]
     ```
   - Eye icon toggles `Group.Visible`. Padlock toggles `Group.Locked`. Both are flat icon buttons with hover state.
   - Hidden / locked rows render at 0.5 opacity for the row label so the user sees the state at a glance.
   - Click on row body (not the icons) selects the group's runs (same behavior as 33b clicking on a member).

5. **Selection invariants.**
   - Hiding a group: any of its members in `selectedRunIds` are removed (filter through current selection on visibility change).
   - Locking a group: selection stays intact (locked is *click-protect*, not *display-protect*).
   - Cmd-A: only visible + non-locked runs select. Otherwise the user can't tell where their selection went.

6. **3D preview honors visibility (in-scope; defer if too costly).** `web/src/preview/Scene.tsx` filters `doc.runs` by `groupVisibleMap[r.group_id] !== false`. If the agent defers to keep the PR focused, document the deferred work in the report and split into a follow-up.

7. **Tests.**
   - `setGroupVisible(doc, 'g1', false)` → `Doc.Groups[0].Visible === false`.
   - Round-trip: `Group.Visible` survives JSON encode/decode.
   - **Back-compat:** `JSON.parse('{"groups":[{"id":"g1","name":"X"}]}')` → `groups[0].visible === true` (or `=== undefined` interpreted as visible by the consumer code; consistent throughout).
   - `setGroupLocked` is independent of `setGroupVisible` (they don't entangle).
   - Hide → visible runs in selection drop out.

## Constraints

- **No new third-party deps.**
- **No backend / SQL migrations** — JSON-blob storage absorbs the new fields.
- **Hidden ≠ deleted.** A hidden run is fully present in the doc (validation, PDF, DXF all see it). Display-only.
- **Locked ≠ read-only-everywhere.** A locked run can still be modified via the sidebar (color picker, delete button) when explicitly selected. Lock blocks *click-selection*; it doesn't lock the data.
- **Visibility default = visible.** Existing-doc back-compat must work.
- **Don't break Cmd-A** — it filters by visibility/lock, but doesn't crash when there are no visible runs.

## Tests

Manual smoke:

1. Group three runs as "Trim". Hide → all three vanish from canvas.
2. Show → all three reappear.
3. Lock the (visible) group. Click a member — nothing happens (locked).
4. Click the row body in the Layers panel — the group selects (sidebar entry-point bypasses the lock).
5. Save the doc. Reload. Visibility + lock state persists.
6. Validation report references hidden runs by ID + line marker — confirm the validation still runs over them.

Don't claim browser smoke if you can't run a browser.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint )
( cd web && npm run build )
go vet ./...
```

## Workflow

1. Schema additions + back-compat unmarshal (Go test first).
2. `setGroupVisible` / `setGroupLocked` ops + tests.
3. Layers sidebar UI + icon SVGs.
4. EditorCanvas filters (visibility + lock).
5. Selection invariants.
6. 3D preview filter (or defer, with a clear PR note).
7. Pre-merge.
8. PR titled `Layers panel: visibility + lock per group (Tier 3 #33c)`.
9. **Move this spec from `specs/active/` to `specs/done/`** in the same PR.

## Report back

Under 300 words. Include: PR URL, the chosen back-compat strategy for `Visible` (pointer-bool vs custom unmarshaler — which won and why), whether the 3D preview filter landed in this PR or deferred, the locked-group sidebar-bypass behavior chosen, CI state, follow-ups (drag-to-reorder layer panel, hide-other-layers shortcut, layer color tags).
