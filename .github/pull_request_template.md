## What

<!-- One sentence. The diff shows the rest. -->

## Which todo.md task

<!-- Link to the Appendix B row, e.g. "todo.md Appendix B Tier 1 #1 — Delete a design version" -->

## Why now

<!-- WHY this change is being made — constraint, deadline, parity gap, bug. Skip the WHAT. -->

## Pre-merge checklist

- [ ] `./scripts/test.sh` passes locally
- [ ] `cd web && npm run lint` clean
- [ ] `cd web && npm run build` succeeds
- [ ] `go vet ./...` clean
- [ ] Manually smoke-tested in a browser (for UI changes)
- [ ] `todo.md` updated to reflect new state
- [ ] No commits to `main` (this PR only)
- [ ] No new third-party deps without prior agreement
- [ ] No schema-destructive migrations (additive only) unless previously discussed

## File-coupling notes

<!-- If your PR touches one of the high-traffic files in CLAUDE.md's coupling map and another open PR also touches it, note the coordination here. -->
