# Task specs

Per-task implementation specs for substantial features, written before dispatching an agent. The spec lives in `specs/active/` while the work is in flight, and moves to `specs/done/` after the implementation PR merges.

## Layout

```
specs/
├── README.md          (this file)
├── template.md        (copy this for new specs)
├── active/            (in-flight specs — agents read these)
└── done/              (audit trail — kept indefinitely)
```

## When to write a spec

Rule of thumb: if the agent prompt would be 100+ lines (file scope + deliverables + geometry + tests + constraints), pull it into a spec. The savings:

- **The user reviews the spec** before dispatch (catch errors before agent burn)
- **The spec is checked in** alongside the implementation PR (audit trail; future maintainers see *why* the code is shaped this way)
- **The agent's prompt collapses** to ~15 lines: "Read `CLAUDE.md`, `AGENTS.md`, and this spec. Implement. Open PR."
- **Adjacent agents in parallel rounds** can read each other's specs to coordinate scope

Don't write a spec for:

- Cleanup PRs (`todo.md` status updates, README typos, parity-tally refreshes)
- Lint fixes
- Anything where the agent prompt would be < 50 lines

## Spec lifecycle

1. **Write** spec in `specs/active/<name>.md` using `specs/template.md`.
2. **Review** with the user — one-paragraph summary in chat.
3. **Dispatch** an Agent that reads the spec; the agent moves the spec from `active/` to `done/` as part of its implementation commits.
4. **Merge** the PR. Done.

The spec staying in the same PR as the code keeps `git log specs/done/<name>.md` honest as a "design rationale" link for that feature.

## Naming

`specs/active/tier{N}-{taskNumber}-{slug}.md` where `tier{N}-{taskNumber}` matches the row in `todo.md` Appendix B. So `Tier 2 #9 Node insert/break/join` becomes `tier2-9-node-insert-break-join.md`. This avoids inventing yet-another-numbering-system that drifts from `todo.md`.

## Template

See `specs/template.md`.
