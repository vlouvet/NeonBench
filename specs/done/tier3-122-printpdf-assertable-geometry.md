# Tier 3 #122 — Give `printpdf` a way to assert drawn geometry

> **Status:** done · shipped 2026-09-01.
> Built option 2 (the pure path-op extraction) as `internal/printpdf/runpath.go`:
> `planRunDrawing(run)` returns the stroked subpaths and the jumper callout in
> world millimetres, and `RenderFromDoc` does nothing but project each
> coordinate and hand it to gofpdf. Byte-identity with `main` is pinned by
> `TestRenderFromDocGoldenBytes` (SHA-256 of a broad representative doc, taken
> from `main` at 17c9dec). Bug #18's regression test moved onto the seam and the
> in-test PDF inflater is gone. Non-vacuity proved by reverting the Bug #18 fix
> inside `planRunDrawing`: the closing-arc test fails with
> "drawn path misses the arc apex [45 70] by 25.000 mm", and the golden digest
> moves too. Two further vacuous assertions turned up and were removed — see the
> notes at the bottom.

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

---

## Outcome notes

**Design choice.** Option 2, the pure extraction, for the reason the spec gave
plus one it did not: the seam is *the same value the renderer executes*, not a
re-implementation of it. A `SetCompression(false)` hook would have left the
assertion reading operators back out of a byte stream, one layer removed from
the geometry, and would have put a test-only knob on the render path. The
"bigger change to a hot path" risk is bounded by the golden digest, which is
what made the choice safe to make: the projection is per-coordinate and affine,
so projecting a world-mm plan is arithmetically identical to projecting during
the walk, and the bytes prove it.

**Byte checks deliberately left alone.**

- `TestRenderFromDocMirrorChangesOutput` — "default options and `Mirror=&true`
  produce the same artifact" *is* a byte-equality question, and the ±10 %
  size-divergence check watches for structural divergence, not shape. Mirroring
  lives in the projector, which `TestMakePageProjectorMirrored` already tests
  directly; the drawing plan is world-space and knows nothing about it.
- `len(out) < 1024` smoke checks in `housings_test.go`, `jumper_test.go`,
  `raceway_test.go` — these ask "did a PDF assemble at all", which a length
  answers correctly.
- `pdfPageCount` — parses `/Type /Page` out of the (uncompressed) page
  dictionaries. A structural count, not a length proxy. Left as is.

**Two vacuous assertions found and removed while converting.**

1. `TestRenderFromDocSkipsJumpersInBendList` guarded a ~40-byte compressed
   bend-list row with a 500-byte threshold — an order of magnitude above the
   thing it was watching for, so it could never have fired. Its companion
   `strings.Contains(pdf, "j1 ·")` could not fire either: the content streams
   are Flate-compressed. Replaced by an assertion on `bendListRuns`, extracted
   so that the pre-compute in `RenderFromDoc` and `drawBendListPage` walk one
   list.
2. `TestRenderFromDocSkipsHousingsWhenNoneConfigured` carried
   `strings.Contains(pdf, "Housings:")` under a comment asserting "this codebase
   uses the uncompressed default, so a substring check is reliable". It does
   not. The check passed by construction and would have gone on passing if the
   gate broke. Removed; the load-bearing `housingsForRun` assertion beside it
   stays.

**A third one was in the golden fixture itself.** The first draft claimed to
cover "a closed run whose closing segment is an arc" using a closed run with two
electrodes — but two electrodes make the run draw as the live *arc between
them*, not as a loop, so the closing segment is never emitted. Reverting the
Bug #18 fix left that digest unchanged, which is how it was caught. The fixture
now also carries an electrode-free closed loop with an arc closing segment, and
reverting the fix moves the digest.

**Not closed by this task.** Nothing structurally forces `RenderFromDoc` to keep
consulting the plan — a future edit could inline geometry back into the render
loop and the golden would still pass, leaving `runpath.go` a dead parallel
implementation. The defence is the comment at the call site and at the top of
`runpath.go` ("geometry decisions belong in runpath.go, not here"). A stronger
guard would need the renderer to be driven by a recorded sink, which is a much
larger change than #122 asked for.

**The SVG-only `Render` path was left alone.** It draws flat `M`/`L` polylines
straight out of `validate.ExtractMMPolylines` with no arcs, blockouts or
jumpers, so it has no geometry decisions to extract. Routing it through the same
seam would add indirection without adding an assertable question.
