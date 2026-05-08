# AGENTS.md — parallel agent coordination playbook

This file is for the **parent Claude session** that dispatches sub-agents. Sub-agents don't need it — they read `CLAUDE.md` + their per-task spec.

If you (the parent) are about to spawn one or more sub-agents, read this first.

## When to spawn parallel agents vs sequential vs solo

Three modes:

1. **Parallel** — multiple sub-agents run concurrently in isolated worktrees. Use when:
   - The candidate tasks have **disjoint primary files** (verify by file-coupling analysis)
   - You can write strict file scopes for each agent so they stay in their lane
   - Total combined CI burn fits a reasonable cascade window
2. **Sequential** — one agent at a time, each starting from the latest main. Use when:
   - Tasks share a high-coupling file (currently `EditorCanvas.tsx`, `EditorPage.tsx`)
   - One task's outcome influences another's design
   - Total work is small enough that parallel overhead exceeds savings
3. **Solo, parent-direct** — the parent agent writes the code. Use when:
   - The change is small (< ~50 lines)
   - You can verify it manually faster than briefing a sub-agent
   - It's a workflow chore (todo.md updates, version bumps, docs typos)

## Planning a round

Before dispatching, write down (mentally or in chat) a file-coupling matrix:

| Task | Primary files | Coupling risk |
|---|---|---|
| #X | ... | low / medium / high |
| #Y | ... | low / medium / high |

If two tasks share a primary file, they can't go in the same round. If they share a low-traffic file (`web/src/api.ts` is append-only and rarely conflicts; `internal/server/api.go` route registrations are also append-only), they probably can — but each agent's spec must list the **exact** files they're allowed to touch, and the dispatch prompt must repeat the most critical "do not touch" entries.

The current high-coupling files (per `CLAUDE.md`):

- `web/src/components/EditorCanvas.tsx` (~1150 lines, every editor tool touches it)
- `web/src/pages/EditorPage.tsx` (~755 lines, toolbar + state owner)
- `internal/server/integration_test.go` (parallel agents both appending test functions = the most common merge conflict we hit)

## Dispatching a sub-agent

For substantial tasks (deliverables that would take a 100+ line prompt):

1. Write `specs/active/tier{N}-{taskNumber}-{slug}.md` using `specs/template.md`.
2. Show the user a one-paragraph summary in chat; get approval to dispatch.
3. Use `Agent({ isolation: "worktree", subagent_type: "general-purpose", prompt: "..." })`.
4. The dispatch prompt itself stays short (~15 lines):
   - "You are implementing Tier {N} #{number}. Read `CLAUDE.md`, `AGENTS.md`, and `specs/active/tier{N}-{number}-{slug}.md`."
   - The branch name to use
   - "Open PR titled X. Watch CI. Move spec from `active/` to `done/` as part of your commits. Report PR URL + summary under 300 words."

For trivial tasks (todo.md updates, status fixes), skip the spec and write inline.

## Merge orchestration

After parallel agents return:

1. **Verify each PR independently** — agent verbal reports occasionally glitch even when the work shipped (~1 in 5 in our experience). Always confirm via `gh pr checks <n>`, `gh pr view <n> --json files`, and `gh pr diff <n>`. Don't rely on the verbal report alone.

2. **Merge order:** smallest scope first, increasing FE / shared-file overlap last. Each subsequent PR will need `gh pr update-branch <n>` because of the `strict: true` branch-protection setting.

3. **Manual merge resolution:** when `gh pr update-branch` reports `Cannot update PR branch due to conflicts`, the conflict is usually two parallel additions to the same file. Resolve locally:

   ```sh
   git checkout -B task/<branch> origin/task/<branch>
   git merge origin/main
   # resolve conflicts; the most common pattern is two PRs each appending
   # a function to integration_test.go — keep both functions, union the
   # imports, the test suite passes
   git push origin HEAD:task/<branch>
   ```

## Closing a round — cleanup PR pattern

Every parallel round (and most solo PRs that close a Tier row) ends with a docs-only **cleanup PR** that:

- Marks Tier rows ✅ in `todo.md` Appendix B with PR refs and a brief summary of what shipped
- Updates Appendix A NW parity tally (the table at the top of Appendix A)
- Logs Tier 3 follow-ups from agent reports (each agent typically surfaces 2–4 deferred items worth tracking)
- Refreshes the README walkthrough if user-visible features changed
- Fixes any stale Phase 1 / Phase 2 references in `todo.md`

Cleanup PRs ship in 2–3 minutes (CI only, no review burden) and keep the source-of-truth docs honest. **Don't bundle cleanup work into feature PRs** — they're separate concerns; the cleanup PR's diff should be readable as docs-only.

## Worktree file-path discipline (recurring agent failure)

When an agent runs with `isolation: "worktree"`, it executes inside `.claude/worktrees/agent-{id}/` — but its absolute filesystem path STILL resolves to a normal directory; nothing at the OS level prevents it from writing into the main repo. **Three of the seven Phase 3 agents (#5, #6, #7 reported it explicitly; #2 also flagged it) accidentally Wrote files to `/Users/v/code/neonbench/web/...` (the main repo) instead of their worktree path.** The Write tool happily creates the file in the wrong place — and the agent only notices when `git status` from inside the worktree comes back empty.

When dispatching an agent that touches a shared subdirectory (`web/src/preview/`, `web/src/components/`, etc.), include this guardrail in the prompt:

> CRITICAL — file path discipline. You are in a worktree at `.claude/worktrees/agent-{your-id}/`. Verify your `cwd` before EVERY Write/Edit call. Use absolute paths starting with the worktree root. If you see your edits not appearing in `git status` from the worktree, you wrote to the wrong place — check immediately, copy to worktree, revert main.

If the parent agent is also running things in `/Users/v/code/neonbench/`, the symptom looks like "agent's work is gone" — the file is sitting in the main repo's working tree, not the worktree's. Recovery: copy the file from main → worktree, then `git checkout -- <file>` in main to revert. Quick to fix once spotted, easy to miss until commit time.

## Worktree hygiene

The Agent SDK creates worktrees under `.claude/worktrees/agent-{id}/`. After agents return, those worktrees stay locked by the SDK. They're gitignored and harmless, but accumulate.

To clean up between rounds:

```sh
git worktree list --porcelain | grep '^worktree' | awk '{print $2}' \
  | grep -v "^$(pwd)$" | while read wt; do git worktree remove -f -f "$wt"; done
```

Run this between rounds. Failing to do so doesn't break anything (new agent IDs get fresh paths) but the locked branches block `gh pr merge --delete-branch` from cleaning up post-merge.

## When agent reports glitch

About 1 in 5 agent invocations returns a degenerate verbal report (literal observed examples: "wait for wakeup", "Good, both running. I'll wait for the monitor"). The actual work usually shipped. Verify via:

```sh
gh pr list --state open --json number,title,headRefName,statusCheckRollup
gh pr view <n> --json files --jq '.files[].path'
gh pr view <n> --json body
```

If the PR exists, has commits, and CI is green: trust the work, write the report yourself, move on. If something looks off (no PR, missing commits, CI red without an explanation), you can `SendMessage(to: <agentId>, ...)` to resume the agent — but cleaning up worktrees (which we do between rounds) prevents resume, so usually it's faster to verify the diff manually and either accept it or fix forward.
