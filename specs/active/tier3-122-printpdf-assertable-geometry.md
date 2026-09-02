# Tier 3 #122 — Give `printpdf` a way to assert drawn geometry

**Filed by:** the Bug #18 agent.
**Class:** test infrastructure, but with a demonstrated cost — this is the
package where a drawn-vs-measured bug hid longest.

## Why

`internal/printpdf` has no way to assert what it actually drew. The suite's own
comments admit it (`jumper_test.go`), and tests fall back to comparing **PDF
byte-length deltas**, which is a proxy that cannot distinguish "drew a curve"
from "drew a slightly longer straight line".

That is not hypothetical. Bug #18 found `RenderFromDoc` closing a closed run
with a straight `LineTo` — the printed pattern, the artifact the bender works
from, silently disagreeing with the DXF. It survived because nothing in this
package could assert the shape. Bug #18's own test had to inflate the PDF
content streams to check its work, which works but leaves a PDF parser living
in a test file.

## Goal

One supported way to ask "what path did this render draw?", used by the tests
that currently guess from byte counts.

## Deliverables

1. **A seam.** Either is acceptable; pick one and say why:
   - a `SetCompression(false)`-style hook on the render path so tests can read
     content streams directly, or
   - extract the run-drawing loop into a pure function that returns the path
     operations (move / line / cubic) for a run, which the renderer then
     executes. This is the stronger option — it makes the geometry testable
     without a PDF at all — but it is a bigger change to a hot path.
2. **Move Bug #18's stream-inflating test onto the new seam** and delete the
   in-test parser.
3. **Convert the byte-length-delta assertions** that `jumper_test.go` and its
   neighbours apologise for, at least where the intent is clearly geometric.
   Where a byte-length check is genuinely the right test, leave it and say so.

## Non-negotiable invariant

**Rendered output must not change.** This is a testability change, not a
rendering change. Pin it: for a representative doc, the PDF this produces must
be byte-identical to the one `main` produces (compression left at its default).
If you cannot make that assertion pass, you have changed the renderer and the
task has become something else — stop and report that.

## Tests

- The new seam must be **proved non-vacuous**: use it to assert a property that
  is false on a deliberately broken renderer. Reverting Bug #18's
  `RenderFromDoc` fix is the obvious candidate — the closing-arc test should go
  red through the new seam, not just through the old byte-count proxy.
- Keep the existing tests passing unmodified wherever they are not the ones
  being converted.

## Strict file scope

**Modify:** `internal/printpdf/**` only.

**Don't touch:** `web/**` (another agent is in `docOps.ts` this round),
`internal/designdoc/**`, `internal/validate/**`. No change to the public
`Options` struct's meaning for real callers — a test-only seam must stay
test-only.
