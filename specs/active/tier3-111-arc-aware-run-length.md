# Tier 3 #111 — Make TS run length arc-aware

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

**Go side** — the validator never sees the raw vertices. The pipeline is
`designdoc.ToSVG(doc)` (arcs emitted as path curves) →
`validate.ExtractMMPolylines` (curves flattened to many points) →
`Polyline.Length()`. It therefore measures the **curve**.

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

`autoSplitOverlongTubes` (`docOps.ts:3023`) and the editor's overlong-run
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
2. **Migrate the three call sites:** `docOps.ts:2981`, `docOps.ts:3023`,
   `EditorPage.tsx:651`.
3. Keep a chord-summing helper if genuinely needed for polyline-only callers,
   but the default a caller reaches for must be the arc-aware one.

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

Tier 3 #112 also edits this file, at lines 2158-3264. Your call site is ~1500
lines away so a textual conflict is unlikely, but you will still need
`gh pr update-branch` before merge. Do not restructure, reformat, or reorder
anything in that file.
