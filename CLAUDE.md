# CLAUDE.md — agent operating manual

This file is loaded into every Claude Code session in this repo. It is the playbook for how multiple agents work in parallel on NeonBench without breaking `main`.

If you are an agent, read this whole file before doing anything that writes to disk or runs git.

## Repo orientation (1 minute)

- **Backend:** Go 1.26+, single static binary. Entry: `cmd/neonbench`. Server in `internal/server`. SQLite via `modernc.org/sqlite` (pure-Go). Migrations are goose SQL files under `internal/storage/migrations/`.
- **Frontend:** React 19 + TypeScript + Vite under `web/`. Built and embedded into the Go binary via `web/web.go` (`//go:embed all:dist`). **Side effect:** Go cannot compile (and therefore `go vet` / `go test` / `go build` cannot run) until `web/dist/` exists with the built bundle. `scripts/test.sh` auto-builds it if missing; CI builds it as the first step. In a fresh clone or worktree, run `( cd web && npm install && npm run build )` once before any Go command.
- **Storage:** one SQLite file per install at the OS-conventional app-data path. Schema lives in migrations only — never hand-edit `appdata` DB files.
- **Distribution:** cross-compiled by `scripts/build.sh`. Targets: macOS arm64/amd64, Linux amd64, Windows amd64.
- **Tests:** `scripts/test.sh` runs `go test ./...` (excluding `web/node_modules`) then `vitest run` in `web/`. CI runs the same script.
- **Roadmap source-of-truth:** [`todo.md`](todo.md). Tier-ranked task backlog lives in **Appendix B**. Parity audit against NeonWizard lives in **Appendix A**.

## The golden rule

**Never commit or push to `main`.** Every change goes through a feature branch and a pull request. CI must pass before merge. This is enforced by:

1. GitHub branch protection on `main` (require PR, require CI green, no force push, no deletion).
2. A local `pre-push` hook (installed by `scripts/setup-hooks.sh`) that refuses direct pushes to `main`.

If your task can't be completed without breaking this rule, stop and ask the user.

## Setup checklist for a new agent (or new clone)

```sh
# Once per clone:
./scripts/setup-hooks.sh        # installs the pre-push guard
git config pull.rebase true     # linear history; PRs squash-merge

# Before starting any task:
git fetch origin
git checkout main && git pull --ff-only
```

## Picking a task

1. Open [`todo.md`](todo.md) and read **Appendix B**. Pick the lowest-numbered task in the highest-tier whose dependencies are met. Tier 1 first, then Tier 2, etc.
2. Run `git fetch origin && git branch -r | grep task/` to see in-flight branches. **If a task is already claimed, pick another one** — don't duplicate work.
3. Check the **file-coupling map** below. If your task touches a file currently being changed on another open `task/*` branch, pick a different task or wait.
4. Branch naming: `task/<tier>-<short-slug>`, e.g. `task/1-delete-version`, `task/2-hershey-text`, `task/3-validation-overlay`.

**Always name the base explicitly: `git checkout -b task/<slug> origin/main`.**
Never branch from whatever HEAD happens to be. We have twice cut a feature
branch off the *previous* feature branch by accident, which drags unrelated
commits into the PR diff and makes review meaningless. If you notice after the
fact, copy your changed files aside, re-cut from `origin/main`, and re-apply —
that is faster than untangling it.

The same rule applies to follow-up work: if a bug you found lives in code an
open PR is already rewriting, write the spec and **wait for that PR to merge**.
Do not branch off the open PR's branch.

## Working in parallel — worktrees

Multiple agents on the same machine should use **git worktrees**, not separate clones. One checkout per task, all sharing the same `.git`:

```sh
# From the main repo:
git worktree add ../neonbench-1-delete-version -b task/1-delete-version origin/main

# Each worktree is fully independent; tests, builds, and the dev server
# all work without stepping on the others. Pick a different --port for
# each running dev server (default 5173).
```

When done:

```sh
git worktree remove ../neonbench-1-delete-version
git branch -d task/1-delete-version    # only after PR is merged
```

The Claude Agent SDK's `Agent` tool supports `isolation: "worktree"` — use it when delegating an isolated implementation task to a sub-agent.

> **If you're the parent session about to dispatch sub-agents, also read [`AGENTS.md`](AGENTS.md).** It covers round planning, the file-coupling matrix, merge orchestration when parallel branches conflict, the cleanup-PR pattern, and how to handle the ~1-in-5 agent reports that glitch. CLAUDE.md is for "how this repo works"; AGENTS.md is for "how the parent agent coordinates a parallel round".

## File-coupling map (parallelism hazards)

Two agents touching the same file = merge conflict and one of them has to redo work. Avoid by either coordinating or sequencing. The high-traffic files are:

| File | Why it conflicts | Mitigation |
|---|---|---|
| `web/src/components/EditorCanvas.tsx` (the largest FE file) | Almost every Phase 2 / Tier 1–2 frontend task touches it | One editor-feature task at a time, OR split into smaller components in a separate refactor PR first |
| `web/src/pages/EditorPage.tsx` (toolbar + state owner) | Sidebar / toolbar additions | Same as above |
| `internal/server/api.go` | Every new endpoint adds a route | Adding routes is line-append; usually conflict-free if PRs are small |
| `internal/designdoc/types.go` / `convert.go` | Schema additions | Coordinate; schema changes touch backend + frontend together |
| `internal/storage/migrations/*.sql` | New migration numbers | Always pick the next unused number; rename if a collision happens during merge |
| `todo.md` | Everyone wants to mark things ✅ | Update only the rows your PR addresses; let the merge tool handle the rest |
| `web/package.json` / `go.mod` | New deps | Coordinate; run `go mod tidy` / `npm install` and commit the lockfile changes |

If your task **must** touch one of these and another open PR is also touching it, post a comment on the open PR and either wait for it to merge or coordinate the split.

## Recurring bug classes (read before writing code)

Each of these has shipped to `main` more than once. They are not hypothetical,
and every one of them passed CI at the time.

### 1. Run-mutating ops that forget a sibling field

Any op that changes a run's **point count or point order** must consciously
carry or remap every field that indexes into those points. We have shipped this
same bug twice:

- `splitRun` dropped `is_channel_letter_face`, `channel_letter_depth_mm`,
  `raceway_id`, `kind` and `group_id`, so the halves of a split channel-letter
  face silently stopped emitting return-strip pages (fixed in PR #140).
- `reverseRun` never learned about `polyline.segment_types` when arc segments
  landed in #141/#142, so reversing an arc run moved every arc onto the wrong
  segment and flipped its bow (Bug #11).
- `joinRuns` has its own local `reversedRun` helper with the same omission,
  *plus* it flips blockout `start_live_index` / `end_live_index` without
  swapping them, so a reversed range comes out inverted. Found while fixing
  Bug #11 — grep for every place that reverses or re-indexes points, not just
  the one you were sent to fix.

**A boolean `arc` flag cannot survive reversal.** `arcFor` always bows left of
travel, so reversing a chord puts the arc centre on the other side — probed
directly: forward centre `(50, -37.5)`, reversed `(50, +37.5)`. No amount of
index remapping undoes that. Preserving shape through a reversal needs a signed
bulge (or `arc-cw` / `arc-ccw`) in the schema. Until that lands, an op that
reverses point order **changes the drawn shape of any arc run**, and the honest
options are to gate the op or to say so in the UI — not to claim the shape is
preserved. Mirroring is the exception: it flips handedness once and the
reversal flips it back, so the two cancel.

Walk this list explicitly before merging such an op, and state in the PR body
what you did with each:

| Field | Rule |
|---|---|
| `polyline.segment_types` | index *i* is the segment **leaving** vertex *i*. Reversal maps new *j* → old `n-2-j` (mod n when closed); insert/delete shifts everything after the touch point |
| `electrodes[].point_index` | remap |
| `blockouts` / `annotations` / `bends` | live-arc-relative positions — remap through `runArcs`, do not assume raw vertex indices |
| `direction` | meaningful only on a closed run with two electrodes; reversal inverts it |
| `is_channel_letter_face`, `channel_letter_depth_mm` | carry to every resulting run |
| `raceway_id`, `group_id`, `kind` | carry — these FKs drive the PDF strip pages and grouping |
| `id` | new runs get `nextRunId`; never reuse an id |

**The test that actually pins this is a geometric invariant, not field
assertions.** `flatRunPoints(after)` must equal the expected transform of
`flatRunPoints(before)`. Field-by-field assertions pass while the drawn shape is
wrong. Use `flatRunPoints` (`web/src/lib/arcGeom.ts`): a bbox, length, or
midpoint computed from raw `polyline.points` ignores arc bow and is wrong for
any run with arcs.

Arc handedness is the subtlety behind both bugs: `arcFor(p0,p1)` bows toward
`(-dy, dx)`, which flips when you reverse a segment or mirror a coordinate. Two
flips cancel (this is why mirroring reverses vertex order on purpose — see
`web/src/lib/arrange.ts`); one flip silently inverts every curve.

### 2. "It returned 200, so it worked"

A successful-looking response is not a passing test.

- `POST /validate_doc` with the wrong request key (`doc` rather than
  `design_doc`) returns **HTTP 200 with zero issues** — byte-identical to a
  clean design. Always run the call against a state you know is dirty first, so
  "no issues" is a result rather than a default.
- `internal/server/json.go` sets `DisallowUnknownFields()`. A TS field with no
  Go counterpart makes **every save 400**. Schema changes move both sides in
  one PR, and `omitempty` on new Go fields keeps existing doc JSON
  byte-identical — that back-compat invariant is load-bearing, not cosmetic.

### 3. Unit tests green, feature unusable

All of these passed CI and were broken the moment a human touched them:

- validation markers render over node handles and intercept the click
- a guide's 10px grab band called `stopPropagation`, swallowing the exact click
  the feature existed to serve
- `<input type="number" min="1" step="10">` makes `min` a lattice base, so a
  default value that is not on that lattice fails HTML validation and
  **silently swallows the form submit** — no error, no console warning, the
  button just does nothing. **This has now shipped twice** (PR #146's arc
  radius, PR #158's flatten tolerance), so treat it as a rule rather than a
  war story: on any `type="number"` that is not a plain integer counter, use
  `step="any"`. See `todo.md` row 105 for the shared component that will
  enforce it
- a `setDoc(prev => …)` updater runs during render, so a result captured in the
  event handler is stale — route doc mutations through `applyOp` in
  `EditorPage.tsx`, never a bare `editDoc` whose return value you read
- right-click started a node drag because the pointerdown handler didn't check
  `e.button !== 0`

For any UI change: drive the real build in a browser, and assert on **data read
back out** — the saved doc, the API response, the generated PDF — not on the
render layer you just drew.

### 4. Go and TypeScript twins must move together

`internal/designdoc/arc.go` ↔ `web/src/lib/arcGeom.ts`; the validator's
`dist()` ↔ `segLenMM` in `docOps.ts`. The editor draws from the TS side while
the printed pattern, the DXF and the validator all derive from the Go side. When
they drift, the operator is shown one shape and handed another. Change both in
one PR and pin the shared constants in both test suites.

Corollary: measure the way the consumer measures. `segLenMM` uses naive
`sqrt(dx*dx+dy*dy)` rather than `Math.hypot` **on purpose**, because the Go
validator does — and the validator decides what gets flagged.

### 5. Magnitude vs signed comparison

`smoothed[i] >= turnMinRad` is a magnitude test. Feeding it a signed turn made
every right-hand bend disappear from detection. Any threshold compared against a
signed quantity needs `math.Abs`, plus a test with a clockwise case — the suite
had none, which is why it went unnoticed.

### 6. Declared metrics that don't match the data

`fonts.ts` declared `capHeightUnits: 12` while every bundled face measures 21
JHF units, so all single-stroke text rendered 1.75× the requested height
(Bug #13). When a constant claims to describe bundled data, assert it against
that data in a test rather than trusting the declaration.

### 7. Widening an enum can make a test go vacuous

A test that silently stops testing is worse than a deleted one, because it
still reports success.

`arcChords` in `docOps.test.ts` filtered segments with
`segmentTypeAt(run, i) !== 'arc'`. When Tier 3 #87 added `'arc_r'` for the
flipped side, that helper started finding **zero** arcs on any reversed run —
so the Bug #11 and Bug #14 invariants built on it compared `[]` to `[]` and
passed trivially. The regression tests guarding two already-fixed bugs would
have stopped guarding anything, with CI green throughout. Caught by review, not
by the suite.

Whenever you widen an enum or add a variant, grep the test suite for equality
checks against the old value (`=== 'arc'`, `!== 'line'`, `switch` without a
`default`) before you do anything else. Prefer a predicate (`isArcKind`) over a
literal comparison so there is one place to update.

**The general defence is a negative control.** A test that asserts X passes is
only meaningful if you have also seen it fail. Where an invariant is
load-bearing, construct the broken variant in the same test and assert it
**fails** — PR #159 does this for the mirror double-flip, and it is what makes
the passing case mean something.

## Required pre-merge checks

Before opening a PR (and again after every push), run locally:

```sh
./scripts/test.sh             # Go tests + vitest
( cd web && npm run lint )    # ESLint
( cd web && npm run build )   # tsc -b + vite build
go vet ./...
```

CI runs the same. **Do not mark a PR ready** if any of these fail.

For frontend tasks, also: start the dev server (`./bin/neonbench --dev` after `cd web && npm run dev`) and exercise the feature in a real browser. Type-check passing ≠ feature works. Assert on data read back
out of the API or the saved doc, not on what you just rendered — see
**Recurring bug classes** above for the failure modes this catches.

## Commit hygiene

- Small commits, imperative subject ("Add Hershey font tool to editor"), one logical change per commit.
- Body: WHY, not WHAT. The diff already shows what.
- Co-author trailer for AI-assisted work: `Co-Authored-By: Claude <noreply@anthropic.com>`.
- Never `git push --force` to a shared branch. `--force-with-lease` only on your own `task/*` branch.
- Never commit: `dist/`, `bin/`, `web/node_modules/`, `.DS_Store`, app-data SQLite files, raw test bitmaps in repo root (already in `.gitignore`).

## Pull request workflow

1. Push your branch: `git push -u origin task/<slug>`.
2. Open PR with `gh pr create`. The PR template will prompt you for:
   - Which `todo.md` Appendix B task this addresses (link to the line)
   - Tests added / updated
   - Manual smoke test performed
   - Any file-coupling collisions noted
3. Wait for CI green. Address any review feedback.
4. Squash-merge into `main` (rebase-merge OK if commits are already clean). Delete the branch.
5. **Don't mutate `todo.md` in the feature PR's diff for the checkmark** — bundle that into the post-round cleanup PR (see below).

## Working with specs

For substantial tasks (those whose agent prompt would exceed ~100 lines), write a per-task spec in `specs/active/tier{N}-{taskNumber}-{slug}.md` before dispatching. The spec captures the file scope, deliverables, geometry, and tests. The user reviews it before agent dispatch; the spec is then committed alongside the implementation PR (the implementing agent moves it to `specs/done/` as part of its work).

Use inline prompts for trivial tasks (`todo.md` updates, lint fixes, README typos). See [`specs/README.md`](specs/README.md) for the lifecycle and [`AGENTS.md`](AGENTS.md) for parent-agent coordination patterns.

## Post-round cleanup PR pattern

After every parallel round (and most solo PRs that close a Tier row), open a small docs-only cleanup PR that:

- Marks Tier rows ✅ in `todo.md` Appendix B with PR refs and one-sentence summaries of what shipped
- Updates Appendix A NW parity tally (the table at the top of Appendix A)
- Logs Tier 3 follow-ups from agent reports (each agent typically surfaces 2–4 deferred items worth tracking)
- Refreshes `README.md` walkthrough if user-visible features changed
- Fixes any stale Phase 1 / Phase 2 references in `todo.md`

Cleanup PRs ship in 2–3 minutes (CI only, no review burden) and keep the source-of-truth docs honest. **Don't bundle cleanup work into feature PRs** — they're separate concerns; the cleanup PR's diff should be readable as docs-only.

## When to stop and ask the user

These require explicit approval, not "auto-mode reasonable assumption":

- **Schema changes** that drop columns or rewrite existing data (additive migrations are fine).
- **New third-party dependencies** (Go modules or npm packages). Justify and pick the most boring option.
- **Anything in `appdata/`** — that's user data on their machine.
- **Anything that affects shared infrastructure** — branch protection rules, CI secrets, repo settings.
- **Ambiguous trade rules** — if your code makes a decision that disagrees with `docs/neon-rules/`, ask. The PDF citations in that directory are the source of truth, not your training data.
- **Cross-tier scope creep** — if a Tier 2 task starts pulling in Tier 1 fixes, stop and split the PR.

## Migrations

To add a schema migration:

1. New file under `internal/storage/migrations/` named `NNN_short_description.sql` where `NNN` is the next unused number.
2. Standard goose format: `-- +goose Up` / `-- +goose Down` sections.
3. Migrations run automatically on app startup. Test by deleting your local app-data DB and restarting the binary.
4. The migration must be idempotent and reversible — every `Up` needs a meaningful `Down`.

## Definition of done for a tier task

- All four pre-merge checks pass (tests, lint, build, vet).
- Manual smoke test in a browser for any UI change (golden path + at least one edge case).
- `todo.md` Appendix B row updated: change `❌` / `🟡` to `✅` and strike through if fully complete.
- PR merged into `main`, branch deleted, worktree removed.
- If the task changed a public-facing behavior, the README walkthrough still reflects reality.

## Things that are out of scope (per Appendix A Tier 4)

Don't accept these as tasks even if asked, without first confirming with the user:

- Vinyl-cutter / plotter driver work (NW #91, 95, 101–105, 107)
- Shadows and compositing for marketing renders — Cast / Drop / Soft / Extruded / Perspective Shadow, Clipping Paths, Warp (part of NW #61–73), plus all of #142–148. **Not the whole #61–73 range:** that blanket wording used to cover **Weld** (boolean union of overlapping outlines), which script and connected lettering genuinely need and which nothing here provides — that one is a real gap, not a "no". Contour, Inline/Outline and Knife in the same range already ship. See `todo.md` Appendix A → Effects for the split.
- TWAIN / WIA scanner integration (NW #58, 146)
- Color vectorizing — single-color binarize is the right model for tube production (NW #59)
- Email / spell-check / customizable toolbar (NW #110, 111, 114)

If a user request lands in Tier 4, surface it and ask before implementing.
