# Bug #17 — every cut straightens the glass: `splitRun` drops `segment_types`

> **Status:** done · found 2026-09-01 while implementing Tier 3 #111 (PR "Make
> TS run length arc-aware"). The shape decision it was blocked on was made by
> the repo owner — see "The decision" below — and implemented as described.
> Outcome, including the two interactions it asked to be checked, is recorded
> at the bottom under "As implemented".

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


---

## As implemented

`web/src/lib/docOps.ts`:

* **`splitRun`** builds each piece's `segment_types` through `segmentTypeAt`
  rather than by slicing, so a piece comes out exactly `segmentCount(run)` long
  even when the source array is malformed — which matters, because docs written
  by the pre-fix `insertVertex` are already out there and an op that propagated
  the malformation could not be the repair path. A closed source drops the
  closing segment's entry along with the closing chord. A source with no array
  does not grow one.
* **`insertVertex`** splices two `'line'` entries in place of the segment the
  vertex lands in, exactly as `insertDoubleback` splices five. The new vertex is
  interpolated along the CHORD, so straightening that one segment is what the
  geometry actually did; every other arc keeps its position and its side.
* **`openClosedRunAtCrossing`** (private, the closed-run half of the raceway
  splitter) had the same defect one call further down: it rotates a closed loop
  into an open walk, which moves every `segment_types` index, and in the
  mid-segment case adds two vertices — so the array came out both misaligned
  and the wrong length. Fixed alongside, because leaving it would have meant
  "split at raceway" still produced unsaveable docs for closed curved runs,
  which is the case the fix exists for.

`web/src/lib/docOps.test.ts` gained `expectWellFormedRun` / `expectWellFormedDoc`
over a new exported `ops.segmentTypesWellFormed` — the TypeScript twin of the
decoder's check, so the suite can assert at the op what the server could only
assert at save time.

### Interaction 1 — `autoSplitOverlongTubes` convergence: it MOSTLY converges

Measured over 19,386 randomly generated curved runs (1–8 segments, 50–1000mm
chords, ~60% arcs, random limits), each split and re-measured arc-aware:

| retries used | cases |
|---|---|
| 0 (nominal `ceil(L/limit)`) | 18,930 |
| 1 (`n+1`) | 452 |
| 2 (`n+2`) | 3 |
| budget exhausted, run left uncut | **1** |

So the retry does real work now — before this fix every piece came back
straight and `n` always sufficed — and one extra cut covers all but a handful.
**It does not always converge**, and per the spec that is reported rather than
papered over with a wider budget.

The failure is structural, not float slop. `pieces` comes from the arc-aware
length while `cutIntoEqualPieces` places its cuts in the CHORD metric, so a
piece that happens to contain a whole INTACT arc measures up to 15.9% more
glass than its chord. Raising `n` shrinks the pieces but does not guarantee a
cut lands inside that arc, and once `n` is large the lattice can keep missing
it across all three attempts. Minimal reproduction:

```
run    [[0,0],[2000,0],[2100,0]]  segment_types ["line","arc"]
limit  125mm      L = 2115.878mm      nominal n = 17
result runsSplit 0 — the run is left exactly as found
```

It needs a run ~15x the limit carrying a short arc, so it is out of reach at
the stock 2500mm / 3000mm tube specs without a 37-metre polyline. Declining is
the honest failure — the operator sees the run still flagged — where the
pre-fix code "succeeded" by straightening the arc and dropping that glass from
the takeoff. Pinned as a KNOWN LIMIT in `docOps.test.ts` ("declines rather than
lying when the retry budget cannot clear an arc") and in the op's own header.

**The real fix is an arc-aware cut walk**: `splitRunAtArcLength` sums chords
over raw vertices, which is the same half of Tier 3 #111 that was deferred.
Worth a follow-up row; widening the retry budget only moves the case.

### Interaction 2 — the total-length assertion Tier 3 #111 left unwritten

Written, in both forms the spec asked for:

* cut AT a vertex — the pieces' arc-aware lengths sum to the original's to 9
  decimal places, and `flatRunPoints(head) ++ flatRunPoints(tail)` equals
  `flatRunPoints(original)`, with a negative control asserting the same
  comparison FAILS against straightened pieces;
* cut INSIDE an arc — they sum to the original minus exactly the bow of the one
  straightened segment, computed rather than tolerated.

One trap worth recording: the bow constant must be measured with
`runLengthMM` (which flattens, as the Go validator does), not with
`segmentLengthMM` (the ideal circular arc). The two differ by 0.2% — 47.6328 vs
47.7357 for a 300mm chord — and deriving the constant from the formula makes
every total-length assertion fail by exactly that sampling difference.

### Still broken, out of this fix's scope

The same audit, run over every op that changes a run's point count or order,
found three more instances. None is on the split path, so they are left for a
follow-up rather than widening this PR:

| op | symptom |
|---|---|
| `deleteVertex` | leaves the array at its old length — one entry too many, so the next save is a 400. Same failure as `insertVertex`, opposite sign |
| `breakOpen` | length stays correct by luck (n closed segments → n open ones) but the array is NOT rotated, so after breaking a loop at vertex k every arc is k segments away from the glass it describes |
| `moveOpening` | rotates the walk the same way and does not move the array with it |

`racewayCrossings` is a fourth, different, gap: it finds crossings by walking
raw chords, so a raceway that crosses an arc's bow but not its chord is not
seen at all. That one is arc-awareness rather than bookkeeping, and belongs
with the `splitRunAtArcLength` follow-up above.
