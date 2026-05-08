# Tier 3 #33b — Groups (bind runs that select + transform as one)

> **Status:** active · drafted 2026-05-08 · branch `task/3-33b-groups`
>
> **Depends on:** Tier 3 #33a (multi-select), shipped in PR #81. The selection-array plumbing in `EditorPage`/`EditorCanvas` is the foundation this builds on.

## Goal

After 33a (multi-select), the editor can act on N runs in one click. 33b binds those runs into a **persistent group** — the group survives save/reload and selecting any member auto-extends the selection to every other member. This is the trade convention for "this set of runs is one logical unit" (a single channel-letter face, one piece of decorative trim, etc.) and is the prerequisite for 33c (layers panel) and Tier 3 #63 (preview-for-groups, NW #140 — already spec'd at `specs/active/tier3-63-preview-for-groups.md`, blocked on this PR landing).

"Done" means: a `Run` has an optional `GroupID: string | null` field; `groupRuns(doc, runIds, name)` and `dissolveGroup(doc, groupId)` ops exist in `docOps.ts` with full undo/redo support; clicking any run in a group selects every member (Shift-click still extends the selection by one toggled run, not the whole group it would belong to — modifier semantics preserved); the editor sidebar gains a small "Groups" section showing each group's name + member count + dissolve button.

**Layers (visibility toggles, lock affordance)** are deferred to 33c. The 33b PR just binds runs together.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-33b-groups origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` — add `GroupID string` to `Run` (use `json:"group_id,omitempty"` so absence stays clean in the JSON; empty string = no group). Add `Doc.Groups []Group` slice with `Group { ID string; Name string }`. The slice is the source-of-truth for group display names; runs only carry the FK.
- `web/src/api.ts` — mirror the type additions (`group_id` on `DesignRun`, `groups` array on `DesignDoc`).
- `web/src/lib/docOps.ts` — `groupRuns(doc, runIds, name): { doc, groupId }` allocates a new Group ID, sets `group_id` on each run, appends to `Doc.Groups`. `dissolveGroup(doc, groupId): Doc` clears `group_id` on each member and removes the Group entry. `renameGroup(doc, groupId, newName): Doc`. All three flow through the existing `editDoc` undo/redo plumbing.
- `web/src/lib/docOps.test.ts` — pin the new ops: group / dissolve / rename / round-trip / dissolve-of-empty / re-group-already-grouped (replaces vs no-op — pick replaces).
- `web/src/pages/EditorPage.tsx` — extend selection logic: click on a run whose `group_id` is set selects every run with the same `group_id` (no modifier needed). Shift-click still toggles a single run. Add a "Groups" sidebar section listing every `Doc.Groups` entry with `<name>` + `(N runs)` + a "Dissolve" button. Add a "Group selected" button (disabled when `selectedRunIds.length < 2`); prompts for a name (default "Group 1", "Group 2", … unique per doc); calls `groupRuns`.
- `web/src/components/EditorCanvas.tsx` — when rendering selection rings, render an additional pale outline ring per group around its members' bbox so the user can see group membership at a glance.
- `internal/designdoc/types_test.go` (extend) — round-trip JSON test covering an empty `Doc.Groups` (no entries), a single group with two members, and a doc that has runs without groups + runs with groups.

**Don't touch (deferred to 33c):**

- Visibility toggles, lock affordance, hide-other-layers behavior — that's 33c.
- Layer panel UX (collapsible sections, drag-to-reorder, etc.) — also 33c.
- Backend group-CRUD endpoints — groups live inside the JSON-blob `Doc.Json`; no SQL migration, no API endpoints.

## Deliverables

1. **Schema additions (no migration).**
   - `internal/designdoc/types.go`:
     ```go
     type Group struct {
       ID   string `json:"id"`
       Name string `json:"name"`
     }
     type Doc struct {
       // ...existing fields...
       Groups []Group `json:"groups,omitempty"`
     }
     type Run struct {
       // ...existing fields...
       GroupID string `json:"group_id,omitempty"`
     }
     ```
   - The `omitempty` tags keep existing-doc JSON byte-identical when no groups exist (back-compat with rows persisted before this PR).

2. **`docOps.ts` operations.** All take a `Doc`, return a new `Doc` (immutable). All flow through the existing `editDoc` reducer for undo/redo:
   - `groupRuns(doc, runIds: string[], name: string): { doc: Doc, groupId: string }`. Allocates a fresh `g1`, `g2`, … ID via a `nextGroupId(doc)` helper (mirror `nextRunId` from PR #44). Sets `group_id` on each named run; replaces any prior `group_id` (a run can only be in one group). Appends `{id, name}` to `Doc.Groups`.
   - `dissolveGroup(doc, groupId): Doc`. Clears `group_id` on every member; drops the entry from `Doc.Groups`. No-op if the groupId doesn't exist (don't throw).
   - `renameGroup(doc, groupId, newName: string): Doc`. Updates `Doc.Groups[i].Name`; no-op on missing groupId.

3. **Selection behavior.** Click on a run with `group_id !== ''` extends the selection to every run sharing that ID (no modifier). Shift-click / Cmd-click on a run still toggles ONLY that one run, preserving 33a's modifier semantics. Cmd-A still selects all runs (which automatically picks up grouped + ungrouped alike). Esc clears.

4. **Editor sidebar "Groups" section.**
   - Header: `Groups (N)` (count of `Doc.Groups`).
   - One row per group: `<name>` in editable text + `(M runs)` + `Dissolve` button.
   - Above the list: a `Group selected` button. Disabled when `selectedRunIds.length < 2`. Click prompts for a name (browser `prompt()` is fine for V1; auto-fill `Group ${N+1}`); empty-string cancels.
   - Hovering a row pulses the canvas selection ring around that group's members (reuse the marker-overlay pulse from PR #54).

5. **Canvas group outline.** When a group has 2+ members, render a pale dashed bounding box around its members in `EditorCanvas`. The same color as the multi-select ring (33a) at 50% opacity. Hover state matches the sidebar pulse.

6. **Tests.**
   - `groupRuns` returns a doc with the IDs set + entry appended.
   - `dissolveGroup` removes the entry and clears IDs.
   - `renameGroup` updates the name.
   - Re-group of already-grouped runs replaces the prior `group_id` (test case: group `[r1, r2]` as A, then group `[r2, r3]` as B → r2 belongs to B; A is unchanged but has only r1 left).
   - Dissolving a group whose runs don't exist is a no-op.
   - JSON round-trip preserves group_id on every run.

## Constraints

- **No backend migrations.** Groups live entirely in the JSON-blob `Doc`.
- **No new dependencies.**
- **`group_id` is one-to-many in the data model** (one group has many runs) but **one-to-one in the run model** (a run is in zero or one groups). Don't introduce M:N membership in this PR — if a future spec needs nested groups or run-in-multiple-groups, it can extend.
- **Existing-doc back-compat.** Loading a doc persisted before this PR must work unchanged: every `Run.GroupID` defaults to `""` (Go's zero-value), `Doc.Groups` defaults to `nil` / `[]`. The unit tests should include a fixture loaded from a pre-33b JSON literal.
- **Don't refactor 33a's selection plumbing.** This PR adds *to* it (group-aware extension). The single-select / Shift-click / Cmd-A surface is unchanged.

## Geometry / algorithms

```ts
// docOps.ts
export function nextGroupId(doc: Doc, prefix = 'g'): string {
  const existing = new Set((doc.groups ?? []).map(g => g.id));
  let n = 1;
  while (existing.has(`${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

export function groupRuns(doc: Doc, runIds: string[], name: string): { doc: Doc, groupId: string } {
  const groupId = nextGroupId(doc);
  const groups = [...(doc.groups ?? []), { id: groupId, name }];
  const runs = doc.runs.map(r =>
    runIds.includes(r.id) ? { ...r, group_id: groupId } : r
  );
  return { doc: { ...doc, runs, groups }, groupId };
}

export function dissolveGroup(doc: Doc, groupId: string): Doc {
  const groups = (doc.groups ?? []).filter(g => g.id !== groupId);
  const runs = doc.runs.map(r =>
    r.group_id === groupId ? { ...r, group_id: '' } : r
  );
  return { ...doc, runs, groups };
}
```

```ts
// EditorPage selection logic
function selectRun(runId: string, modifier: 'none' | 'shift' | 'cmd' | 'ctrl', doc: Doc) {
  const clicked = doc.runs.find(r => r.id === runId);
  if (modifier !== 'none') return toggle(selectedRunIds, runId);
  if (clicked?.group_id) {
    return doc.runs.filter(r => r.group_id === clicked.group_id).map(r => r.id);
  }
  return [runId];
}
```

## Tests

Manual smoke:

1. Create a doc with three runs. Multi-select all three (Cmd-A). Click "Group selected" → name "Trim". Sidebar shows `Groups (1)` with Trim (3 runs).
2. Click on background to clear. Click on any one of the three runs — all three are now selected.
3. Shift-click an ungrouped fourth run — selection becomes 4 (3 group + 1 toggled). Hit Esc.
4. Click on the group's "Dissolve" button. Click on one of the formerly-grouped runs — only that run is selected.
5. Save the doc. Reload the page. The group reappears with the same membership.
6. Multi-op (delete, color change) on a grouped selection still applies to every member individually.

If you can't get a browser smoke from your worktree, say so explicitly.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint )
( cd web && npm run build )
go vet ./...
```

## Workflow

1. Schema additions: `internal/designdoc/types.go` + `web/src/api.ts`. Add the round-trip Go test first; verify byte-identical JSON for groupless docs.
2. Add `groupRuns` / `dissolveGroup` / `renameGroup` + tests in `docOps.ts`.
3. Selection logic in `EditorPage`: group-extension on plain click; Shift / Cmd preserved.
4. Sidebar Groups section + canvas group outline.
5. Pre-merge + smoke.
6. PR titled `Group runs (Tier 3 #33b) — bind runs that select + transform as one`.
7. **Move this spec from `specs/active/` to `specs/done/`** in the same PR.

## Report back

Under 300 words. Include: PR URL, the chosen group-conflict semantic when grouping already-grouped runs (replace vs reject), keyboard or modifier behaviors, list of EditorPage callsites that needed the group-aware selection extension, CI state, follow-ups (33c layers spec ready to draft once this lands; #63 preview-for-groups already spec'd and blocked on this).

## When 33b merges — file 33c spec

After 33b is in main, draft `specs/active/tier3-33c-layers.md` covering: visibility toggle per group, lock affordance, drag-to-reorder layer panel, hide-other-layers shortcut. The schema has room — `Doc.Groups` entries can grow `Visible bool` / `Locked bool` fields without a migration.
