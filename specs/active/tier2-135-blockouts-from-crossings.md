# Tier 2 #135 — Place block-outs from the crossing check

> **Status:** active · drafted 2026-09-02 · branch `task/2-blockouts-from-crossings`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) A4

## Goal

The validator already locates every place two tubes cross shallowly enough to
need paint — `RuleCrossingNeedsBlockout` (`internal/validate/types.go:19`), with
`XMM` / `YMM` on the issue. Turning those into `Run.Blockouts` is mechanical and
is currently done by hand, one at a time, on a script with dozens of crossings.

**Done** means an operator can turn the crossing findings into block-outs in one
action, and the paint on the drawing matches the paint the validator asked for.

## Two tuning facts, both learned by rendering the wrong version first

Bake these in rather than rediscovering them.

**(a) Only `crossing_needs_blockout`.** Including `min_spacing` looks reasonable
— same geometric check, one severity up — but on a script it fires wherever two
tubes run near-parallel, which is most of the piece. Painting those out
**swallowed whole strokes and the word stopped reading.** The op must filter on
the rule id, not on severity, and a comment must say why, because "also do the
errors" is a natural-looking future change that breaks the feature.

**(b) ~2 tube diameters of blacked-out span per crossing.** Measured: 90 mm
severed the letterforms; 30 mm kills the bright X at the crossing while the
letter still reads through it. Derive the default from the run's tube diameter
(falling back to the project spec) rather than hard-coding 30.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-blockouts-from-crossings origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — the op.
- `web/src/pages/EditorPage.tsx` — a sidebar action, enabled when the current
  report has crossing findings.

**Don't touch:**

- `internal/validate/`. The rule is correct and its coordinates are already
  right; this consumes them.

## The index problem is the actual work

`Blockout` carries `start_live_index` / `end_live_index` — **live** indices,
walk-relative, not raw point indices. The validator hands back **millimetre
coordinates**. So the op must, for each finding:

1. Find which run the crossing lies on (both runs cross; a block-out belongs on
   the one being painted — decide and document which, or emit on both and say
   so).
2. Resolve `(x, y)` to a position along that run's walk.
3. Convert that position to the live index space, via `runArcs`, **not** to a
   raw point index.
4. Expand to a span of ±(diameter) around it, clamped to the run's ends.

Step 3 is where this will go wrong. For an open run the live walk is the whole
polyline and the two index spaces coincide, which means a naive implementation
**passes every test built on open runs and is wrong on a closed loop with two
electrodes**. Include a closed-run fixture.

Flatten for measuring, index on the live vertex array — never resolve a live
index against a flattened array.

## Deliverables

1. The op: report + doc in, doc with block-outs out, one undo step.
2. Span default derived from tube diameter, operator-overridable.
3. Sidebar action reporting how many block-outs were placed and how many
   findings were skipped (already covered by an existing block-out).
4. Idempotence: running it twice must not double-paint. Overlapping spans on the
   same run merge rather than stack.

## Tests

- **Rule filtering**: a doc producing both `crossing_needs_blockout` and
  `min_spacing` findings yields block-outs only for the former. Assert the
  `min_spacing` count is non-zero in the fixture, or the test is vacuous.
- **Span**: default equals ~2× the run's effective tube diameter; a per-run
  diameter override is honoured over the project spec.
- **Closed run with two electrodes**: the placed block-out covers the crossing
  point as measured in millimetres. This is the test that catches a raw-vs-live
  index confusion; a fixture of open runs alone will not.
- **Idempotence**: second run adds nothing; overlapping spans merge.
- **Clamping**: a crossing near a run end produces a span inside the run, not a
  negative or out-of-range index.
- Well-formedness of every touched run afterwards.

## Constraints

- No new third-party dependencies.
- Does not change point counts, so this is not a `segment_types` op — but it
  *does* write live indices, so it belongs in the same family of care.
- No automatic invocation. Paint is a fabrication decision; the operator asks.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Coordinate resolution + live-index conversion first, with the closed-run
   fixture.
2. Op, then UI.
3. Render a real script and confirm the letters still read.
4. **Move this spec** to `specs/done/` in the final commit.

## Report back

Block-outs placed vs findings present, and a render confirming the word reads.
