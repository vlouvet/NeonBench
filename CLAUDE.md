# CLAUDE.md — agent operating manual

This file is loaded into every Claude Code session in this repo. It is the playbook for how multiple agents work in parallel on NeonBench without breaking `main`.

If you are an agent, read this whole file before doing anything that writes to disk or runs git.

## Repo orientation (1 minute)

- **Backend:** Go 1.26+, single static binary. Entry: `cmd/neonbench`. Server in `internal/server`. SQLite via `modernc.org/sqlite` (pure-Go). Migrations are goose SQL files under `internal/storage/migrations/`.
- **Frontend:** React 19 + TypeScript + Vite under `web/`. Built and embedded into the Go binary via `web/web.go` (`//go:embed all:dist`).
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

## File-coupling map (parallelism hazards)

Two agents touching the same file = merge conflict and one of them has to redo work. Avoid by either coordinating or sequencing. The high-traffic files are:

| File | Why it conflicts | Mitigation |
|---|---|---|
| `web/src/components/EditorCanvas.tsx` (832 lines) | Almost every Phase 2 / Tier 1–2 frontend task touches it | One editor-feature task at a time, OR split into smaller components in a separate refactor PR first |
| `web/src/pages/EditorPage.tsx` (755 lines) | Sidebar / toolbar additions | Same as above |
| `internal/server/api.go` | Every new endpoint adds a route | Adding routes is line-append; usually conflict-free if PRs are small |
| `internal/designdoc/types.go` / `convert.go` | Schema additions | Coordinate; schema changes touch backend + frontend together |
| `internal/storage/migrations/*.sql` | New migration numbers | Always pick the next unused number; rename if a collision happens during merge |
| `todo.md` | Everyone wants to mark things ✅ | Update only the rows your PR addresses; let the merge tool handle the rest |
| `web/package.json` / `go.mod` | New deps | Coordinate; run `go mod tidy` / `npm install` and commit the lockfile changes |

If your task **must** touch one of these and another open PR is also touching it, post a comment on the open PR and either wait for it to merge or coordinate the split.

## Required pre-merge checks

Before opening a PR (and again after every push), run locally:

```sh
./scripts/test.sh             # Go tests + vitest
( cd web && npm run lint )    # ESLint
( cd web && npm run build )   # tsc -b + vite build
go vet ./...
```

CI runs the same. **Do not mark a PR ready** if any of these fail.

For frontend tasks, also: start the dev server (`./bin/neonbench --dev` after `cd web && npm run dev`) and exercise the feature in a real browser. Type-check passing ≠ feature works.

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
5. Update `todo.md` in a follow-up commit on the next task — don't mutate it post-merge in a separate PR just for the checkmark.

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
- Effects / shadows for marketing renders (NW #61–73, 142–148)
- TWAIN / WIA scanner integration (NW #58, 146)
- Color vectorizing — single-color binarize is the right model for tube production (NW #59)
- Email / spell-check / customizable toolbar (NW #110, 111, 114)

If a user request lands in Tier 4, surface it and ask before implementing.
