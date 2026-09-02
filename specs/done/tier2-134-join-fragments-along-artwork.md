# Tier 2 #134 — Join fragments back into runs, along the artwork

> **Status:** active · drafted 2026-09-02 · branch `task/2-join-along-artwork`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) A3

## Goal

NeonBench splits a run at every junction, so a connected script comes back as
~50 fragments meeting in V-shaped wedges, and nothing rejoins them. A bender
runs one tube through as much of a script as possible and splices only where
necessary; the tool cannot currently express that.

**Done** means an operator can select a fragmented script and have it become a
small number of continuous runs whose glass still lies **on the letterforms**.

## Read the constraint section before anything else

This row's difficulty is not the joining. It is that **a naive join gets better
on every available metric by cheating**, and no number in the takeoff will tell
you. Measured on Chachi's job:

| near | min_cos | runs | glass | transformers | raceway |
|---|---|---|---|---|---|
| 35 mm | −0.2 | 15 | 80 ft | 15 | does not fit |
| 90 mm | −0.9 | 9 | 60 ft | 9 | **fits** |
| 120 mm | −0.95 | 6 | 50 ft | 6 | **fits** |

Fewer runs, less glass, fewer transformers, and the raceway conflict disappears.
Every one of those improvements came from letting the tube **leave the letters
and cut diagonally across blank sign face**. It was caught only by rendering the
runs in per-run colours and looking.

So the acceptance criterion is not "fewest runs". **A hop whose path leaves the
artwork must be refused, and the op must report how many it refused.** With that
constraint the same sweep tops out at 12–14 runs and the raceway still does not
fit — which is the honest answer, and the one a shop needs.

## What was already ruled out — do not retry these

- **`min_spur_mm` 60 → 160 mm**: run count moved 51 → 47 and **every wedge was
  still there**. They are junctions, not dead-end stubs.
- **Within-polyline de-spike**: removed **nothing**. The V is formed by two
  *different* runs' ends diving into the same notch, so no single polyline
  contains the spike.
- **Trimming the ends apart**: cleared the wedges and left ~50 mm gaps; the
  script read as broken glass.

## Relationship to Tier 1 #128

Different operations, and they compose. #128 (`joinTouchingRuns`) welds
endpoints that **already meet**, within a small tolerance, and refuses to invent
travel. This row decides where a tube is **allowed to travel** in order to reach
an endpoint that does not currently meet anything. Build on `joinRuns` the same
way #128 does — never a private concatenation path; that is how Bug #14 and Bug
#15 shipped, twice.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-join-along-artwork origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — the op. Folds through `joinRuns`.
- `web/src/pages/EditorPage.tsx` — an operator action in the sidebar.
- A new lib file for the on-artwork test, so it is unit-testable without a doc.

**Don't touch:**

- `internal/vectorize/`. Fragmenting at junctions is correct; this repairs
  downstream, it does not change the tracer.
- `joinTouchingRuns` (#128). Leave it alone and compose.

## The on-artwork test

The op needs to answer "does the straight path between these two endpoints stay
on glass the operator drew". The cheapest sound answer available: sample the
candidate hop at a fixed interval and require every sample to lie within a
threshold of *some* existing run's polyline. A hop across blank face fails
immediately; a hop along a stroke passes.

Threshold and sample interval both need defaults tied to the tube diameter
rather than absolute millimetres, and both must be stated in the UI. **The
operator must be able to see what was refused** — a count at minimum, and
ideally the refused hops drawn.

**This must be an operator action, not an automatic pass.** It changes
fabrication cost, run count and transformer count. A pass that silently
restructured a design would be the same class of error as the cheating join,
one level up.

## Deliverables

1. The on-artwork predicate, pure and unit-tested.
2. The join op, folding through `joinRuns`, one undo step, returning counts:
   joined, refused-off-artwork, remaining.
3. Sidebar action with the two parameters exposed and the refusal count
   reported.
4. Tests below.

## Tests

- **The cheating case is refused**: two collinear fragments separated by blank
  face, well within `near` — the op must decline and report the refusal. This is
  the single most important test in the row; it is the bug the table above
  documents.
- **The legitimate case is joined**: two fragments whose gap lies along a third
  run's polyline.
- Determinism across selection order, as in #128.
- Glass length is preserved across every accepted weld.
- `segment_types` and run classification survive a chained join (inherited from
  `joinRuns`, asserted here anyway — both have regressed before).
- A sweep fixture asserting that loosening the distance parameter **cannot**
  reduce the run count below the on-artwork floor.

## Constraints

- No new third-party dependencies.
- Arc segments: the hop test operates on flattened points
  (`flatRunPoints`) — flatten for measuring, never for indexing.
- Do not tune the defaults to make Chachi's raceway fit. It does not fit; that
  is the finding.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Predicate + its tests first.
2. Op, then UI.
3. Drive a real build on a fragmented script and **look at it in per-run
   colours** before claiming it works. The metrics will not tell you.
4. **Move this spec** to `specs/done/` in the final commit.

## Report back

Run count and glass before/after, the refused-hop count, and a screenshot in
per-run colours.
