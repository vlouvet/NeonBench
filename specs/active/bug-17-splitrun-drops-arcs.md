# Bug #17 — every cut straightens the glass: `splitRun` drops `segment_types`

> **Status:** ready to implement · found 2026-09-01 while implementing Tier 3
> #111 (PR "Make TS run length arc-aware"). The shape decision it was blocked
> on has been made — see "The decision" below.

Two defects in the same family: an op that changes a run's point count or point
order must carry `segment_types` (`CLAUDE.md` → Recurring bug classes → 1).
`reverseRun` and `joinRuns` were fixed for this in #141/#142 and Bug #14.
`splitRun` and `insertVertex` never were.

## Defect A — `splitRun` drops `segment_types` entirely

`withMeta` inside `splitRun` (`web/src/lib/docOps.ts`) builds each piece as:

```ts
const next: DesignRun = { id, polyline: { points, closed: false } };
```

`carryRunClassification` then copies `kind`, `raceway_id`, `group_id`, the
channel-letter fields and so on — but nothing copies `segment_types`. Every
piece of a cut run is therefore straight, whatever the operator drew.

### Evidence (browser + API, not reasoning)

Seeded one run, chord `(200,700)→(2600,700)`, `segment_types: ["arc"]`, against
the stock 12mm spec (`max_segment_length_mm` 2500):

| | validator `total_length_mm` | `max_segment_length` issues |
|---|---|---|
| as drawn | 5181.90 | `tube run 2782mm exceeds max segment length 2500mm` |
| after "Split overlong tubes" + save | 4800.00 | none |

The run was 2782mm of glass. The two pieces it became are 1200mm each, and
carry no `segment_types` at all — 382mm of tube (13.7%) disappeared from the
takeoff, the pattern and the DXF, silently and in one click.

Reachable from: "Split overlong tubes" (Tier 2 #75), the raceway splitter
(Tier 2 #74), and the node-menu `splitRun`.

## Defect B — `insertVertex` leaves the array the wrong LENGTH

`insertVertex` splices a point in and never touches `segment_types`. Probed:

```
insertVertex(doc, 'r1', 0, 0.5) on 3 points + ['arc','line']
  → points 4 | segment_types ["arc","line"] | segmentCount(run) wants 3
```

That doc cannot be saved. The Go decoder validates the length at unmarshal
(`internal/designdoc/types.go`, `(*Polyline).UnmarshalJSON`), so the next save
is a 400, confirmed against a running server:

```
POST /api/projects/1/design_versions  → HTTP 400
{"error":"invalid JSON: polyline: segment_types has 2 entries, want 3
 (one per segment for 4 points, closed=false)"}
```

The arc label is also now one segment off the glass it describes.

Reachable from the canvas: right-click a vertex on an arc run → **Insert
vertex** (`availableActionsForVertex` gates on `segmentIndex < n-1` only), and
from double-click-on-segment. The operator gets a working-looking editor whose
every subsequent save fails. `insertDoubleback` got this right — it rebuilds
the array — and is the model to copy.

Auto-split hides Defect B behind Defect A: it inserts a vertex and then calls
`splitRun`, which throws the broken array away.

## Why the fix needs a decision, not just bookkeeping

**A cut inside an arc segment has no representation in this schema.** `ARC_BULGE`
is fixed at 0.5, so halving a bulge-0.5 arc would need bulge
`tan(atan(0.5)/2) ≈ 0.2361` on each half. There is no value of the existing
field that draws the two halves of the curve the operator drew. This is the
same class of limitation as the signed-bulge note in `CLAUDE.md` (an `arc` flag
cannot survive reversal).

## The decision (made by the repo owner, 2026-09-01)

**A cut inside an arc segment straightens ONLY that segment.** Both halves of
the cut segment become `line`; every other arc on both resulting pieces keeps
its type.

Rejected, and why, so this is not relitigated:

* *Flatten the cut segment into short lines* would preserve the drawn shape and
  the glass length almost exactly, but it converts one curve into ~30 **live**
  vertices permanently. `internal/designdoc/bends.go` walks `liveArcIndices` —
  live vertices, not flattened points — so the bend list would read a cluster
  of small kinks where the operator drew one smooth bend. Clustering softens
  that but does not remove it, and the run becomes far harder to edit.
* *Refuse the cut* never lies about shape, but neither caller can choose where
  it cuts: the raceway splitter cuts where the raceway physically crosses, and
  auto-split cuts where the length limit demands. Refusing means both features
  simply fail on curved runs.

Straightening one segment is a large, strict improvement on today — which
straightens **every** arc on the run — it keeps the bend list truthful, and it
does not foreclose flattening later if the shape loss turns out to matter.

That splits the work cleanly:

1. **A cut AT a vertex is pure bookkeeping and must preserve every arc.**
   Splitting a 4-arc run at vertex 2 should hand back two 2-arc runs whose
   `flatRunPoints` concatenate to the original. This is the common case for the
   raceway splitter and the node menu, and it is straightforwardly correct.
2. **A cut INSIDE an arc segment straightens only that segment**, per the
   decision above. Today's behaviour — straighten *every* arc on the run — is
   the bug.
3. **`insertVertex` must rebuild `segment_types`** whichever of those is
   chosen, or the doc is unsaveable.

## Tests the fix owes

- `flatRunPoints(head) ++ flatRunPoints(tail)` equals `flatRunPoints(original)`
  for a cut at a vertex — the geometric invariant, not field assertions
  (`CLAUDE.md` → Recurring bug classes → 1).
- `segment_types.length === segmentCount(run)` on every run every op emits;
  worth a shared helper the whole suite can assert, since the Go decoder is
  currently the only thing that checks it and it does so at save time.
- A round-trip through `POST /api/projects/{id}/design_versions` for a doc that
  has been through insertVertex — a 400 is the failure this hides behind.
- Tier 3 #111's `autoSplitOverlongTubes` test notes the straightening in a
  comment and deliberately does not assert total-length preservation. When this
  is fixed, that assertion is the one to add.


## Two interactions to check before you claim this is done

**1. `autoSplitOverlongTubes` may need more pieces once arcs survive.** Tier 3
#111 left that op carrying two metrics on purpose: `runLengthMM` (arc-aware)
decides *whether and how many* pieces, and `chordLengthMM` decides *where* the
cuts land, because `splitRunAtArcLength` walks chords over raw vertices. Today
every piece comes back straight, so those two agree after the cut. **This fix
breaks that coincidence**: pieces will keep their arcs, so a set of
chord-equal pieces can each still exceed the limit in arc length. The op
already retries at `n+1` and `n+2` and re-checks the postcondition with
`runLengthMM`, so it should converge — but **prove it does** on a run of
several arcs, and say what the retry count actually reached. If it does not
converge, that is a finding worth reporting, not something to paper over by
widening the retry budget.

**2. Tier 3 #111 left an assertion deliberately unwritten, and it is now
yours.** `docOps.test.ts` notes in a comment that it does not assert
total-length preservation across a split, because straightening made that
false. **Add it**: for a cut at a vertex, the arc-aware lengths of the pieces
must sum to the original's. For a cut inside an arc, they must sum to the
original minus exactly the glass lost on the one straightened segment — which
is a number you can compute, not a tolerance to hand-wave.
