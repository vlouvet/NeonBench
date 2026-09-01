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

- `web/src/components/EditorCanvas.tsx` (every editor tool touches it)
- `web/src/pages/EditorPage.tsx` (toolbar + state owner)
- `internal/server/integration_test.go` (parallel agents both appending test functions = the most common merge conflict we hit)

## Verify spec premises before dispatch

Across the last two parallel rounds, **6 of 8 specs contained a materially wrong
premise**. An agent working from one either builds the wrong thing or spends
half its budget discovering the truth. Premise-checking is the highest-leverage
thing the parent agent does; it costs a few greps.

Check every claim in your spec against the code before you dispatch:

- **"X is missing"** — grep for it. `todo.md` status rows drift badly. The
  August 2026 round's ❌ list still showed *layers* and *redo* as missing (both
  had shipped), and *"Mirror/Scale/Rotate at plot"* as missing when mirror
  shipped in PR #73. An agent taking that row at face value would have
  reimplemented mirroring.
- **"Function Y already handles Z"** — read Y. The #90 spec asserted
  `reverseRun` already remapped indices for arc runs. It didn't, and that gap
  turned out to be Bug #11.
- **"This is safely gated on W"** — read the gate. The #91 spec assumed the
  raceway-split button couldn't see construction guides; it was gated only on
  "some guideline is selected", so a construction guide would have split the
  design at `y_mm = 0`.
- **Internal consistency.** The #92 spec's title-case bullet gave an example
  that contradicted the rule stated in the same sentence. An agent has to pick
  one, and it may not pick the one you meant.

Then say this explicitly in the dispatch prompt: **a wrong premise is a
finding — report it, don't silently work around it.** The best results in both
rounds came from agents that pushed back on the spec.

## The spec has to be on `origin/main` before you dispatch

A worktree agent branches from `origin/main`. **Untracked files in your working
tree do not exist inside its worktree**, so a spec you just wrote and have not
pushed is invisible to the agent that needs it — it will improvise, or stall
asking for a file that is right there on your disk.

So the order is: spec PR → merged → dispatch. That is what PR #154 did for six
specs at once, and batching is the cheap way to pay the round-trip.

Two ways this bites:

- **Half a round is dispatchable and half is not.** In the September 2026 round
  #101 and #110 already had specs on main and went immediately, while #109 and
  #111 had to wait on a spec PR. Check which specs are *tracked* (`git ls-files
  specs/active/`) before planning the round, not after.
- **Do not work around it by having the agent write the spec itself.** That is
  how `specs/active/bug-14-*.md` ended up duplicating `specs/done/bug-14-*.md`,
  with the active copy still reading "blocked on PR #149 merging first" for a
  fix that had shipped in PR #152.

## Spec hygiene between rounds

Two mechanical checks, both one-liners, both of which have caught real drift:

```sh
# A spec in active/ that also exists in done/ is a stale leftover.
for f in specs/active/*.md; do [ -f "specs/done/$(basename "$f")" ] && echo "STALE: $f"; done

# An Appendix B row number carrying DISAGREEING status markers. A row appearing
# twice is normal and expected — the original "planned" entry keeps the
# rationale, the later entry records the outcome. What is broken is when the
# two disagree, because the first one then reports shipped work as unstarted.
python3 - <<'EOF'
import re, collections
apx = open('todo.md').read().split('## Appendix B')[1]
seen = collections.defaultdict(set)
for n, rest in re.findall(r'^(\d+)\. (.{0,3})', apx, re.M):
    seen[n].add('done' if rest.startswith('\u2705') else 'open')
for n, st in sorted(seen.items(), key=lambda kv: int(kv[0])):
    if len(st) > 1:
        print(f'DISAGREES: row {n} is listed as both open and shipped')
EOF
```

Do not use a bare `uniq -d` on the row numbers for this — it fires on every
legitimately-duplicated row, so it reads as noise and gets ignored, which is
worse than no check.

The status-disagreement check found **six** rows (87, 98, 99, 103, 104, 105)
reporting finished work as unstarted. Anyone reading the first entry would
conclude the task was open and could redo it. The roadmap disagreeing with
itself is the most expensive kind of staleness here, because it silently
converts a docs bug into duplicated engineering.

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

## Verify agent *claims*, not just agent PRs

Confirming the PR exists and CI is green (above) is necessary but not
sufficient. Agents also report **findings about already-merged code**, and those
land in the roadmap and drive follow-up work, so they need the same scepticism.

In the August 2026 round three agents each reported a latent bug in shipped
code. All three were real — but one arrived with wrong reasoning about its blast
radius ("changing `capHeightUnits` resizes every saved design"; it doesn't,
because text is baked to geometry at insert time and nothing persists the
parameter). Acting on that reasoning would have deferred a one-line fix
indefinitely. **The finding and the reasoning about it fail independently.**

Independent checks are usually one command, and beat re-reading the report:

- **Measure the data.** `node -e` over the bundled font JSON settled the
  cap-height claim: declared 12 units, actual 21, across all four faces.
- **Probe the function.** A throwaway `internal/printpdf/zz_probe_test.go`
  calling `makePageProjector` directly settled the multi-tile mirror claim by
  printing the projections. Delete the probe afterwards and confirm
  `git status` is clean — a leftover probe file has been committed by accident
  before.
- **Grep for persistence** before believing any "this changes saved data"
  claim.

Write the finding up as a `specs/active/bug-NN-*.md` with the evidence inline
(the probe output, the measurements), not as prose in a PR comment. Evidence
that isn't written down gets re-litigated next round.

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
