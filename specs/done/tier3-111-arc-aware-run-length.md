# Tier 3 #111 — Make TS run length arc-aware

> **Status:** done · shipped as `runLengthMM` / `chordLengthMM` in
> `web/src/lib/docOps.ts`. Every premise above was re-verified against the code
> and against the running Go pipeline; see **Outcome** at the bottom for the
> two places reality was more involved than the spec, and for the two bugs this
> work turned up (`specs/active/bug-17`, `specs/active/bug-18`).

**Filed by:** the Bug #16 agent, deliberately not fixed in PR #161.
**Class:** Go/TS twin divergence (`CLAUDE.md` recurring bug class 4) + the
"measure the way the consumer measures" rule.

## Goal

`polylineLengthMM` must measure a run the way the Go validator measures it, so
that a fix the TypeScript side believes it has applied is a fix the validator
agrees with.

## Premise, verified (2026-09-01)

Both halves confirmed by reading the code and by probe, not by assertion.

**TS side** — `web/src/lib/docOps.ts:2897`:

```ts
export function polylineLengthMM(points: [number, number][], closed = false): number
```

It takes **points only**. It cannot see `segment_types`, so it sums raw
vertex-to-vertex chords. An arc segment is measured as its chord.

**Go side** — `(*Polyline).Length()` (`internal/validate/geometry.go:59`) is
the **same chord-summing algorithm**, read side by side and confirmed:

```go
for i := 1; i < len(p.Points); i++ { total += dist(p.Points[i-1], p.Points[i]) }
if p.Closed && len(p.Points) > 1 { total += dist(p.Points[len(p.Points)-1], p.Points[0]) }
```

**So the two functions do not disagree at all — what they are HANDED does.**
The validator never sees raw vertices: `designdoc.ToSVG(doc)` emits arcs as
path curves, then `validate.ExtractMMPolylines` subdivides them with
`flattenCubic` (`internal/validate/bezier.go:6`) into many points, and only
then is `Length()` called. Go sums ~33 short chords along the curve; TS sums
the 1 chord across it.

**This reframes the fix.** It is not "teach the length function arc maths" —
the maths is already right. It is "flatten first, exactly as
`ExtractMMPolylines` does for Go, then reuse the chord sum unchanged." The TS
flattener already exists (`flatRunPoints`), so the fix is plumbing, and the
line-only case is provably untouched because `flatRunPoints` returns the
original array when a run has no arcs.

**Measured divergence.** A one-segment run, chord `(0,0)→(100,0)`,
`segment_types: ["arc"]`, through the real Go pipeline:

```
polyline 0: 33 flattened pts, Go Length()=115.8964 | TS chord sum=100.0000 | ratio=1.1590
```

**13.7% underestimate on a single default arc.** This is not a rounding
difference. It is consistent with the known bulge = 0.5 geometry (r = 62.5,
included angle 106.26° → arc length 115.91), which is what makes the probe
trustworthy. Note it is *not* π/2 — the arc is not a semicircle, so do not
reason about this analytically; measure it.

## Why it matters

`autoSplitOverlongTubes` (`docOps.ts:3055`) and the editor's overlong-run
badge (`EditorPage.tsx:651`) both ask the TS helper. On an arc-bearing run the
TS side can conclude a run is now under `MaxSegmentLengthMM` and stop splitting
while the Go validator still raises `RuleMaxSegmentLength`. The operator sees
the tool declare success and the validator disagree, with nothing on screen to
explain it.

This is **exactly the failure mode the Tier 2 #75 spec warned about in the
abstract**. It became real when arcs shipped in #87.

## Deliverables

1. An **arc-aware length function** in `docOps.ts`. Take the run (or points +
   `segment_types`) so the arc labels are visible. Reuse the existing
   flattener — `flatRunPoints` in `web/src/lib/arcGeom.ts` — rather than
   writing new arc math. Handle `"arc"` and `"arc_r"`; both are arcs, the
   label only picks the side, and **the side does not change the length**.
2. **Migrate the three call sites**, located by grep on 2026-09-01:
   `docOps.ts:3082`, `docOps.ts:3124`, `EditorPage.tsx:651`.

4. **Rewrite the comment at `docOps.ts:2893`.** It currently reads "Deliberately
   mirrors the Go validator's `(*Polyline).Length()` … if the two disagree, a
   run the auto-split believes it fixed can still come back flagged." **That
   comment describes this exact bug while claiming to prevent it** — true when
   written, falsified when arcs shipped in #87. Leaving it in place leaves a
   guarantee asserted in the code that the code does not provide.
3. Keep a chord-summing helper if genuinely needed for polyline-only callers,
   but the default a caller reaches for must be the arc-aware one.

## The closed-run asymmetry — pin this with a test

`flatRunPoints` behaves differently for closed runs depending on whether the
run has arcs, and **both paths are correct for different reasons**, which makes
this easy to break later:

* **No arcs:** returns the live `points` array unchanged — not explicitly
  closed — so `polylineLengthMM(pts, closed=true)` must add the closing chord,
  and does.
* **Has arcs:** appends the flattened closing segment, so the returned array
  *ends at* `points[0]`. `polylineLengthMM(arr, closed=true)` then adds
  `dist(arr[last], arr[0])` = **0**, which is right only because the array is
  already closed.

So `polylineLengthMM(flatRunPoints(run), run.polyline.closed)` is correct in
both cases, but by a coincidence rather than by construction. Say so in a
comment, and **test a closed arc-bearing run** — not just an open one — so a
future change to either function cannot silently double-count or drop the
closing segment.

## The trap

**`flatRunPoints` is for measuring true shape, never for indexing.** Electrodes,
blockouts, annotations and bends index into the *live* vertex array. If you
find yourself passing flattened points to anything that then indexes them, stop
— see `CLAUDE.md` on the flatten-vs-index rule.

## Tests

- **The pinning test is a Go/TS agreement test, not a snapshot.** Assert the TS
  length of the probe run above is within a small tolerance of `115.8964`. A
  test that only asserts "longer than the chord" would pass on a 1% fix.
- A line-only run must measure **exactly** what it measures today — pin it, so
  the change is provably a no-op for the non-arc case.
- `autoSplitOverlongTubes` on an arc-bearing run must keep splitting until the
  **arc-aware** length is under the limit. Build the case so the chord-based
  answer is under the limit and the arc-aware answer is over it; then the old
  code fails this test and the new code passes. **If the test passes before
  your change, it is vacuous — rebuild it.**

## Strict file scope

**Modify:** `web/src/lib/docOps.ts` (+ tests), `web/src/pages/EditorPage.tsx`
(**exactly the one call site at line 651 — nothing else in this file**).

**Don't touch:** `web/src/lib/arcGeom.ts` (consume it, don't change it),
`internal/**`. The Go side is the reference implementation here and is correct.

## Coupling warning

`EditorPage.tsx` is one of the two highest-traffic files in the repo (see the
coupling map in `CLAUDE.md`) and its line numbers drift every round — the refs
above were re-verified 2026-09-01 and had already moved once (`docOps.ts`
2796 -> 2897, `EditorPage.tsx` 601 -> 651). **Locate the call site by grepping
for `polylineLengthMM`, not by line number.**

Tier 3 #112 has since shipped (PR #173) and its edits to this file are already
on `main`; line 651 was unaffected and is still 651. **You are the only agent
in this round**, so no conflict is expected — but do not restructure, reformat,
or reorder anything in that file regardless.

---

## Outcome (2026-09-01)

Shipped as specced, with two additions the spec did not anticipate. Every
number below was measured, not derived.

### The three call sites were not three interchangeable measurements

Migrating `docOps.ts:3082` naively — `const length = runLengthMM(run)` and
nothing else — **regresses** auto-split on long curved runs. That `length` is
used twice: once to decide whether to split, and once as the distance handed to
`cutIntoEqualPieces`, whose walk (`splitRunAtArcLength`) sums straight chords
over raw vertices and interpolates the inserted vertex along a chord. Feed it
an arc length and every cut lands ~16% too far along; on a run needing several
cuts the last one falls off the end, `cutIntoEqualPieces` returns null, all
three retries fail and the run is left **unsplit** — silently, on exactly the
runs the pass exists to fix. Probed: a 900mm chord marked `arc` against a 100mm
limit went from 10 pieces to 0.

So the op now carries two metrics on purpose: `runLengthMM` decides *whether*
and *how many*, `chordLengthMM` decides *where*. The regression has its own
test (`still cuts a long arc run into enough pieces to clear the limit`), which
fails on both the pre-#111 code and the naive migration.

### Renamed rather than added

`polylineLengthMM` → `chordLengthMM`. The name was the trap: a polyline in this
schema can contain arcs, so a caller holding a run reached for a function whose
name promised the run's length and got its chords. `runLengthMM(run)` is now
the obvious call and `chordLengthMM(points, closed)` says what it limits itself
to. Call sites: two in `docOps.ts`, one in `EditorPage.tsx`, the rest in tests.

### Verified end to end, not just in vitest

Real build, real server, Playwright, stock 12mm spec (2500mm limit), one run of
chord 2400 marked `arc`:

- badge/button read **"Split overlong tubes (1)"** and was enabled (chord 2400
  is under the limit; the glass, 2782mm, is not — pre-#111 this button was
  disabled and the operator had no way to act on the validator's complaint)
- validator on the saved doc: `tube run 2782mm exceeds max segment length
  2500mm` before, **no `max_segment_length` issues** after. The fix the TS side
  believes it applied is one the Go validator agrees with, which was the point.

### Two bugs found, neither fixed here

- **`specs/active/bug-17-splitrun-drops-arcs.md`** — `splitRun` drops
  `segment_types`, so every cut straightens the glass: the same probe run lost
  382mm (13.7%) of tube between `total_length_mm` 5181.90 and 4800.00.
  `insertVertex` separately leaves the array the wrong LENGTH, which the Go
  decoder rejects with a 400 — reachable from the canvas node menu.
- **`specs/active/bug-18-closing-segment-arc-ignored.md`** — an arc on a closed
  run's *closing* segment is ignored by both emitters (`indicesToD` and Go's
  `emitPath` write a bare `Z`) but honoured by `flatRunPoints`. So on that one
  segment this task's new length is more curve than the operator is shown or
  the bender receives.

The closed-run test the spec asked for uses `['arc','arc','arc','line']` for
this reason: with `'arc'` in the closing slot the Go and TS numbers legitimately
disagree, and pinning that would have pinned bug #18 as correct.
