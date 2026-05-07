# Tier 3 #17 — ESLint cleanup + flip CI to hard-gate

> **Status:** active · started 2026-05-07 · branch `task/17-eslint-cleanup`

## Goal

CI runs `npm run lint` with `continue-on-error: true` because the tree carries 11 pre-existing errors and 2 warnings. The goal is to fix them all, then flip the CI step to hard-gate so future PRs can't introduce regressions.

Current diagnostics (verified 2026-05-07 against `origin/main`):

| File | Line | Rule | Kind |
|---|---|---|---|
| `web/src/lib/docOps.ts` | varies | `no-unused-vars` (`_drop`, `_closed`) | error × 2 |
| `web/src/components/EditorCanvas.tsx` | 79, 104 | `react-hooks/set-state-in-effect` | error × 2 |
| `web/src/pages/EditorPage.tsx` | 130, 131 | `react-hooks/refs` (`undoStackRef.current`, `redoStackRef.current` accessed during render) | error × 2 |
| `web/src/pages/EditorPage.tsx` | 153, 181 | unused `eslint-disable` for `react-hooks/exhaustive-deps` | warning × 2 |
| `web/src/pages/ProjectDetail.tsx` | 65 | `react-hooks/set-state-in-effect` (call to `load()` in effect body) | error × 1 |
| (run `npm run lint` from `web/` to confirm; the EditorCanvas line numbers may have shifted) | | | |

"Done" means: `npm run lint` returns 0 errors / 0 warnings, the CI workflow's lint step has `continue-on-error: false`, and the editor's user-visible behavior is unchanged.

## Branch + setup

```sh
git fetch origin
git checkout -b task/17-eslint-cleanup origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/lib/docOps.ts` — rename or remove the unused `_drop` / `_closed` parameters. They're already underscore-prefixed; the lint config still flags them, so they need to either be **fully removed** from signatures (preferred when a callsite audit confirms they're never set) or annotated with a function-scope `// eslint-disable-next-line` only if removing would break a stable API.
- `web/src/components/EditorCanvas.tsx` — fix two `react-hooks/set-state-in-effect` errors. Each is a `setState(...)` call inside a `useEffect` body that should either move into an event handler, become a derived value via `useMemo`, or be guarded by an equality check. **Investigate each one** — the fix depends on what state is being synchronized.
- `web/src/pages/EditorPage.tsx` — fix two `react-hooks/refs` errors at lines 130-131 (refs accessed during render to compute `canUndo` / `canRedo`). The fix is to track the boolean state in `useState` updated when the ref's stack mutates, NOT to read `ref.current` during render. The existing `historyTick` state may already be the right place to hang this off — confirm. Also remove the two unused `eslint-disable` directives at lines 153 / 181.
- `web/src/pages/ProjectDetail.tsx` — fix the `react-hooks/set-state-in-effect` at line 65: the `load()` call in `useEffect(() => { load(); }, [load])` cascades renders. Refactor to a stable async loader (memoized `useCallback` with the right deps, or fold the load logic inline in the effect with a `cancelled` flag).
- `.github/workflows/ci.yml` — flip `continue-on-error: true` to `false` (or remove the line) on the lint step at line ~44. **Do this in the same PR**, but **after** all errors are fixed and verified locally.

**Don't touch:**

- The high-coupling list (`EditorCanvas.tsx`, `EditorPage.tsx`) is unavoidable here. **Coordinate before dispatch:** this PR must not run in parallel with any other Tier 3 task that touches these files (#20 drawing-tool polish, #28 marker overlay, #33 multi-select, #34 snap-to-geometry). Sequence #17 first; the cleaner lint baseline benefits all subsequent editor PRs.
- Any other source file. If a fix wants to spread, stop and reduce scope.
- ESLint config files (`.eslintrc*`, `eslint.config.*`). The rules are fine; the code needs to comply, not the other way around.

**New:** none.

## Deliverables

1. **Zero ESLint errors / warnings.** `( cd web && npm run lint )` exits 0 with no output indicating problems.
2. **Behavioral parity.** Every fix preserves observable UI behavior. Specifically: undo/redo still works (Cmd-Z / Cmd-Shift-Z), the editor still selects runs and reflects validation reports, the project-detail page still loads. Manual smoke after each file's fixes.
3. **CI hard-gate.** `.github/workflows/ci.yml` lint step no longer has `continue-on-error: true`. Push the branch and confirm CI passes.

## Constraints

- **Do not introduce new third-party deps.** No `eslint-plugin-*` additions.
- **Do not silence rules with file-level disables.** Targeted line-level `eslint-disable-next-line` is acceptable only with a one-line comment explaining the exception (and only as a last resort — most issues here have a clean fix).
- **Do not refactor unrelated code.** The editor files are high-coupling; minimal-blast-radius edits only.
- **Keep undo/redo semantics identical** — the canUndo/canRedo derivation is the most fragile fix in this task. Current behavior: refs hold the stacks; a tick state forces a re-render; the booleans are cheap reads. The fix likely changes "read ref during render" to "read state that mirrors the ref's length, updated alongside push/pop."

## Geometry / algorithms

**`react-hooks/refs` fix in EditorPage.** The current pattern:

```ts
const undoStackRef = useRef<...>([]);
const [historyTick, setHistoryTick] = useState(0);
// ... mutations push/pop on undoStackRef.current and bump historyTick ...
const canUndo = undoStackRef.current.length > 0;  // ← lint error
```

Replace with:

```ts
const undoStackRef = useRef<...>([]);
const [undoLen, setUndoLen] = useState(0);
const [redoLen, setRedoLen] = useState(0);
// ... mutations: push then setUndoLen(undoStackRef.current.length); pop then setUndoLen(...); ditto redo
const canUndo = undoLen > 0;
const canRedo = redoLen > 0;
```

`historyTick` may now be redundant (its only consumer was forcing the canUndo/canRedo recompute). Remove if and only if no other dependency uses it.

**`react-hooks/set-state-in-effect` patterns.** Read each effect body and decide:
- **Derived from props/state** → replace with `useMemo`.
- **Synchronizing external state** → leave the setState but only call it when the value actually changes (`if (next !== prev) setX(next)`).
- **Doing work that should be an event handler** → move out of effect entirely.

## Tests

This change is mostly behavior-preserving plumbing. No new unit tests required, but:

- `./scripts/test.sh` — existing Go and vitest suites must still pass.
- `( cd web && npm run lint )` — must exit 0 (this is the new test).
- Manual smoke (see below) — undo/redo + project load are the regression-prone paths.

## Pre-merge checks

```sh
( cd web && npm run lint )       # the headline check — must be 0 errors, 0 warnings
./scripts/test.sh
( cd web && npm run build )
go vet ./...
```

Manual smoke:

1. Boot the dev server, open any project with multiple design versions.
2. Make an edit (e.g. drag a vertex), confirm Undo button enables, click Undo — restored.
3. Click Redo — change re-applied. Cmd-Z / Cmd-Shift-Z keyboard variants too.
4. Reload the project-detail page; confirm assets and versions load (no infinite-loop spinner from the load() refactor).

## Workflow

1. Run `npm run lint` from `web/` to capture the live error list (line numbers shift over time).
2. Fix file-by-file in the order listed above. Commit each file's fixes separately for easier review.
3. Verify lint clean before touching `.github/workflows/ci.yml`.
4. Flip the CI step in a final commit. Push and confirm CI is green.
5. Open PR titled "ESLint cleanup + CI hard-gate (Tier 3 #17)". Body links to `todo.md` Appendix B row 17.
6. **Move this spec** from `specs/active/tier3-17-eslint-cleanup.md` to `specs/done/tier3-17-eslint-cleanup.md` as part of your final commit.

## Report back

Under 250 words. Include:

- PR URL
- Per-file fix summary (one line each)
- Whether `historyTick` was removed or kept
- CI final state (with the hard-gate flip live)
- Any rule that needed a targeted disable + the justification
- Tier 3 follow-ups if you noticed new lint smells outside the original 13 (don't fix them in this PR)
