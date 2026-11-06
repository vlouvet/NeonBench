# Tier 3 #140 — Schema relationships are undiscoverable from the API

> **Status:** active · drafted 2026-09-02 · branch `task/3-schema-discoverability`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) C2

## Goal

Two stumbles while producing Chachi's proof, both solvable only by reading Go
source:

**(a) A `Raceway`'s ID must match an existing `"raceway"` Guideline.** It is not
a separate id space. `internal/designdoc/types.go` documents this thoroughly; the
API exposes none of it, and the failure surfaces as `UnmarshalJSON` rejecting the
whole document.

**(b) `DisallowUnknownFields` (`internal/server/json.go:35`) plus a stale binary
gives `unknown field "raceways"`** — which reads as *"your JSON is malformed"*
and actually means *"your binary predates PR #165"*. Verified 2026-09-02: there
is no schema, version or capabilities endpoint anywhere in
`internal/server/api.go`.

**Done** means a caller can ask a running build what document schema it accepts,
and a rejected save says which of those two things went wrong.

## Why this is worth doing at all

It is pure developer ergonomics, which is why it is Tier 3. But it is the
difference between a five-minute fix and an afternoon, and the afternoon has
already been spent once. It also gets more valuable with every additive schema
change — `Doc.Circuits` (Tier 2 #136) landed today, so **any client written
against yesterday's binary now hits exactly failure mode (b)**, with an error
message that points at the wrong thing.

## Two candidate shapes — pick one, and say why

1. **A doc-schema version.** One integer the server reports and the client
   compares. Cheap; tells you *that* you are out of date, not *what* is missing.
2. **A capabilities endpoint** listing the fields this build accepts. More
   useful and more work, and it needs a story for staying in sync with the
   structs — a hand-maintained list will drift, and a drifted capabilities
   endpoint is worse than none because it is trusted.

The unknown-field error message can be improved **independently of either**, and
that is the cheapest real win here: `json.go` knows it rejected an unknown field,
and can say "unknown field X — this build may predate it; check the server
version" rather than leaving the caller to guess. Consider shipping that alone if
the endpoint design stalls.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-schema-discoverability origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/server/json.go` — the error message.
- `internal/server/api.go` — at most one appended route, if you add an endpoint.
- A new handler file, if needed.
- `web/src/api.ts` — only if a client consumes the new surface.

**Don't touch:**

- `DisallowUnknownFields` itself. **Do not relax it.** It is what keeps the Go
  and TS models honest and it has caught real drift; the problem is the message,
  not the strictness.
- `internal/designdoc/types.go` semantics. The raceway/guideline id relationship
  is correct as designed — this row makes it *discoverable*, not different.

## Deliverables

1. A better unknown-field error that distinguishes "malformed" from "your build
   is older than this field".
2. Whichever discoverability surface you chose, with the drift story written
   down if it is the capabilities endpoint.
3. Tests below.

## Tests

- Posting a doc with an unknown field returns the improved message, asserted on
  its content — a message nobody asserts will rot.
- A raceway whose id names no guideline is rejected with an error that **says
  so**, rather than a generic unmarshal failure. That is stumble (a) closed.
- If you ship a capabilities endpoint: a test that fails when a struct field is
  added without updating it. Without that, it will drift and mislead.

## Report back

PR URL, which shape you chose and why, the before/after error text for both
stumbles, and how a capabilities list (if any) is kept from drifting.
