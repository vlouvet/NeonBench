# Tier {N} #{Number} — {Title}

> **Status:** active · started YYYY-MM-DD · branch `task/{N}-{slug}`

## Goal

One paragraph. Why this exists, what user pain it addresses, what "done" looks like.

## Branch + setup

```sh
git fetch origin
git checkout -b task/{N}-{slug} origin/main
./scripts/setup-hooks.sh
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `path/to/file.tsx` — what you're adding
- `path/to/other.go` — what you're adding

**New:**

- `path/to/new-file.ts`

**Don't touch:**

{everything else, with brief reason if a parallel agent is in adjacent files}

## Deliverables

1. ...
2. ...
3. ...

## Constraints

- {hard rules — no new third-party deps, no schema changes, etc.}
- {coordination notes if parallel agents are in adjacent files}
- {explicitly defer items to Tier 3 if they'd expand scope}

## Geometry / algorithms (if relevant)

{spell out anything tricky — formulas, edge cases, defaults; cite docs/neon-rules sources where applicable}

## Tests

- {what tests must exist before the PR is mergeable}
- {edge cases that must be covered — especially regression-prone ones}

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )  # advisory; no NEW diagnostics
```

## Workflow

1. ...
2. ...
3. **Move this spec** from `specs/active/` to `specs/done/` as part of your final commit.

## Report back

Under {N} words. Include:

- PR URL
- Implementation summary
- Judgment calls (and why)
- File sizes
- CI final state
- Follow-ups worth tracking as Tier 3 rows
