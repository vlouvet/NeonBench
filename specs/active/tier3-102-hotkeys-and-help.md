# Tier 3 #102 — Keyboard shortcut reference, remapping, and tooltips

> **Status:** active · drafted 2026-08-31 · branch `task/3-hotkeys-help`

## Goal

The editor has accumulated a substantial keyboard surface — tool keys, `o` and
`c`, `j`/`k`/`[`/`]` for issue navigation, Cmd+Z/Y, Cmd+A, Delete, Escape,
Shift for angle snap, right-click for the node menu — and **none of it is
discoverable**. There is no shortcut list, no help, and no way to remap.

Closes NW Productivity **#113 Online Help** and **#118 Programmable Hotkeys**,
and promotes **#115 Tool Tips** 🟡 → ✅.

## Premise, verified

Key handling is currently spread across at least two files:
`EditorPage.tsx` (undo/redo, select-all, delete, issue navigation, the `o`/`c`
tool keys) and `EditorCanvas.tsx` (guideline delete, Escape, Enter, Shift
tracking). Each handler independently re-implements the "skip when typing in an
input" guard. That duplication is the actual reason there is no shortcut list:
there is no single place that knows what the shortcuts are.

## Strict file scope

**New:** `web/src/lib/hotkeys.ts` + tests — the registry, matching, and
conflict detection. `web/src/components/ShortcutHelp.tsx` — the reference
overlay.

**Modify:** `EditorPage.tsx` and `EditorCanvas.tsx` to register through the
registry instead of binding directly. `README.md`.

**Don't touch:** `docOps.ts`, `internal/**`. This is presentation and input
routing; no geometry changes.

## Deliverables

1. **A registry.** Each entry: id, human-readable label, category, default
   binding, and whether it is allowed while a text input has focus. The
   input-focus guard lives in the registry, once, instead of in every handler.
2. **Migrate the existing bindings** without changing any of them. This is a
   refactor with a feature attached; a shortcut that changes behaviour during
   the migration is a regression. Enumerate the current bindings first, in the
   PR body, and assert each still works.
3. **`?` opens a shortcut reference** grouped by category, listing the live
   binding rather than a hard-coded string — so it cannot drift from reality.
   That single property is most of this feature's value.
4. **Remapping**, persisted per user in `localStorage`, with **conflict
   detection**: assigning a binding already in use must say what it collides
   with and refuse or offer to swap. Reset-to-defaults must be one click.
5. **Tooltips** on toolbar buttons showing the action and its current binding,
   sourced from the same registry (this is what promotes #115).

## Watch for

- macOS vs Windows: Cmd vs Ctrl. Normalise once in the registry; do not scatter
  `metaKey || ctrlKey` checks.
- The existing `o` and `c` bindings are guarded so they do not fire while
  typing. Whatever replaces them must keep that guard, and Tier 2 #101 (inline
  canvas text) will need to suppress **all** printable-key shortcuts — design
  the registry with a "suspend all" mode so #101 does not have to fight it.
- Do not bind anything that collides with browser or OS shortcuts.

## Tests

- Registry matching: modifiers, case-insensitivity, `metaKey`/`ctrlKey`
  normalisation
- The input-focus guard: guarded actions do not fire while typing; allowed
  ones do
- Conflict detection catches an exact duplicate and a modifier-equivalent one
- Remap round-trips through `localStorage`; a corrupt stored value falls back
  to defaults without throwing
- Every currently-shipped binding is present in the registry with its existing
  default — a table-driven test enumerating them

## Out of scope

Chorded/sequential shortcuts, per-tool contextual bindings, and a full help
system with prose documentation. `#113 Online Help` is satisfied by a
discoverable, always-accurate shortcut reference; if a prose manual is wanted
later, `docs/USER_MANUAL.md` already exists to link to.
