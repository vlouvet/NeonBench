# Tier 3 #119 — Three more ops in the `segment_types` family

> **Status:** done. All three premises verified correct against `main`; one
> piece of the test guidance is not (see "Spec correction" at the bottom), and
> one new finding is recorded there rather than fixed.

**Filed by:** the Bug #17 agent, which pinned all three as failing tests rather
than fixing them out of scope.
**Class:** `CLAUDE.md` recurring bug class 1 — run-mutating ops that forget a
sibling field. This is the **fifth and sixth and seventh** instance.

## Goal

Every op that changes a run's point count or point order moves `segment_types`
with it. After this, the KNOWN BROKEN list in `docOps.test.ts` is empty.

## Premises, verified against `main` 2026-09-01

All three spread the old polyline and replace only the points, which is exactly
the shape of the bug:

```ts
polyline: { ...run.polyline, points }              // deleteVertex
polyline: { ...r.polyline, points: newPts, closed: false }   // breakOpen
polyline: { ...r.polyline, points: newPts }        // moveOpening
```

### `deleteVertex` — array ends up one entry TOO LONG

Points are filtered (`points.filter((_, i) => i !== pointIndex)`), the array is
not. The Go decoder rejects the mismatch, so **the next save is a 400** — the
same failure as `insertVertex` before Bug #17, with the opposite sign.

### `breakOpen` — right length, wrong rotation

This one is subtle and is why it hid. `breakOpen` emits **`n + 1` points**:

```ts
const newPts = [...pts.slice(vertexIndex), ...pts.slice(0, vertexIndex), pts[vertexIndex]];
```

A closed run of `n` points has `n` segments; the opened run has `n + 1` points
and therefore also `n` segments. **The length stays correct by luck**, so
`segmentTypesWellFormed` passes and the Go decoder accepts the doc. But the
walk rotated by `vertexIndex` and the array did not, so every arc now sits
`vertexIndex` segments away from the glass it describes. A length check cannot
see this; only a rotation assertion can.

### `moveOpening` — same rotation bug, no length change

Rotates the walk (`rotated.slice(pos).concat(rotated.slice(0, pos))`) and
leaves the array behind.

## Deliverables

1. **`deleteVertex`** — drop one entry. Deleting vertex `i` merges the two
   segments either side of it into one, so the array must shrink by one.
   **What the merged segment becomes follows the decision already made for
   Bug #17** (straighten only what the edit touched): if both merged segments
   are `line` the result is `line` and nothing is lost; **if either is an arc
   the merged segment becomes `line`**, because two arcs merged is not one arc
   and no value of a fixed bulge draws the pair. Every other arc on the run is
   untouched. This is not a new decision — say so in the comment and point at
   the Bug #17 spec.
2. **`breakOpen`** — rotate the array by `vertexIndex` to match the walk. Pure
   bookkeeping: **no glass is lost and no arc changes kind**, every segment
   just gets its correct index.
3. **`moveOpening`** — rotate the array with the walk. Also pure bookkeeping.
4. **Empty the KNOWN BROKEN list.** Those tests assert the *current broken*
   behaviour, so fixing each one turns it red — that is the design. Move each
   into the `passing` sweep as you fix it. **The sweep's vacuity guard must
   survive**: each case asserts the geometry actually changed, because an op
   that quietly did nothing satisfies the invariant for free.

## Tests

- Prefer the **geometric invariant** over field assertions, as Bug #17 did:
  for `breakOpen` and `moveOpening`, `flatRunPoints` of the result must draw
  the same glass as the source (same total length; the loop is the same loop,
  re-indexed). That is a much stronger statement than "the array rotated".
- For `deleteVertex`, assert the length loss is **exactly** the bow of the
  merged segment when an arc was involved, and **exactly zero** when it was
  two lines. Compute it, don't tolerate it.
- **Measure the bow with `runLengthMM`, not `segmentLengthMM`.** Bug #17 hit
  this: the flattened measurement (what the Go validator does) and the ideal
  circular arc differ by 0.2% — 47.6328 vs 47.7357 on a 300 mm chord — which is
  enough to fail every total-length assertion if you derive it from the formula.
- A round-trip through the real API for a doc that has been through
  `deleteVertex`; the 400 is the failure it hides behind.

## Strict file scope

**Modify:** `web/src/lib/docOps.ts`, `web/src/lib/docOps.test.ts`, and the
server integration test if you add an API round-trip.

**Don't touch:** `web/src/lib/arcGeom.ts`, `internal/printpdf/**` (another
agent is in there this round), `internal/designdoc/**`.

## Out of scope, deliberately

`racewayCrossings` walking raw chords, and the auto-split retry that can
decline — both are `todo.md` row 120 and both want an arc-aware cut walk, which
is a different piece of work. Do not start it here.

---

## As implemented

All three premises held exactly as written against `main`, and all three ops
are fixed in `web/src/lib/docOps.ts`.

* **`deleteVertex`** rebuilds `segment_types` over the surviving vertices with
  the same span-merge loop `simplifyRun` already uses — a new segment that
  still spans exactly one old segment keeps its type, and the one that spans
  two is the merge across the dropped vertex, which becomes `line`. That
  covers the closed case for free: deleting vertex 0 merges the CLOSING
  segment with segment 0 and the merged entry has to land at the END of the
  array, which a naive `splice(i, 2, 'line')` gets wrong. The merged type is
  Bug #17's decision, cited in the comment, not a new one. Built only when an
  array existed, so a pre-#78 run round-trips without growing the key.
  Also bounds-checks `pointIndex`: an index off the end used to leave the
  points alone while `shift` quietly renumbered every electrode.
* **`breakOpen`** rotates the array by `vertexIndex` — new segment `j` is old
  segment `(vertexIndex + j) % n`. Pure bookkeeping, as specified: measured
  `runLengthMM` before and after from all four break vertices of an arc-bearing
  square, identical to 9 decimal places.
* **`moveOpening`** rotates the array with the walk, with one entry the
  rotation cannot source — see the correction below.

`web/src/lib/docOps.test.ts` empties the KNOWN BROKEN list: all three ops move
into the `passing` sweep (five cases, since `deleteVertex` has three
materially different shapes — merge, drop-an-end, closed), the vacuity guard is
untouched, and a new assertion pins that every point-count op in the file is
named in the sweep so the list cannot silently shrink again. Verified the new
tests fail against pre-fix `docOps.ts`: **17 of them do**, including all five
new sweep cases for `deleteVertex`. The `breakOpen` and `moveOpening` sweep
cases pass either way — which is the spec's point about the length being
correct by luck, and why the rotation and shape assertions carry those two.

`internal/server/segment_types_integration_test.go` gains
`TestDeleteVertexDocRoundTripsThroughSave`, the mirror of the insertVertex
round trip: the pre-fix body (array one entry too LONG) is POSTed first and
must come back 400 saying `segment_types has 3 entries, want 2`, then the body
the op actually emits saves, reloads, and comes back with the surviving `arc_r`
still on the segment it was drawn on. Both bodies are pinned from the TS side
by "emits the polyline the API round-trip test posts".

### Spec correction — `moveOpening` does not preserve glass, and cannot

The spec asks for the same geometric invariant on `moveOpening` that
`breakOpen` satisfies: "the result must draw the same glass as the source — it
is the same loop, re-indexed". **That is false, and the reason is in the
POINTS, not in `segment_types`.**

`moveOpening` treats an open polyline as a cycle whose MISSING segment is the
opening. Rotating the walk to start at vertex *k* therefore trades exactly one
segment of glass for exactly one other: old segment *k-1* becomes the new gap,
and the old gap (last vertex → first) becomes drawn glass. Measured on the
suite's own `openArcRun` — `[[0,0],[100,0],[200,0],[300,0]]` typed
`['arc','line','arc_r']`:

| opening moved to | `runLengthMM` |
|---|---|
| 0 (unchanged) | 331.7552 |
| 1 | 515.8776 |
| 2 | 531.7552 |
| 3 | 515.8776 |

That is the op's documented behaviour and its existing tests (`describe
('moveOpening')` → "rotates the polyline so the chosen vertex becomes the new
start") assert the point rotation directly. So the test written here asserts
the exact trade instead — `after == before - glass(old segment k-1) +
glass(new chord across the old opening)`, to 9 decimal places — plus that every
segment which survived the rotation is byte-identical in endpoints, bow and
side. `breakOpen` does get the invariant the spec asked for, in both forms:
the drawn-segment list is an exact rotation from every break vertex, and
`flatRunPoints` equals the source's flattened curve entered at that vertex.

The entry the rotation cannot source is old index `n-1`, which is not a segment
on an open run — it is the opening. Moving the opening makes it glass, and the
operator drew no curve across it, so it enters as `line`: Bug #17's "straighten
only what the edit touched", applied to the one segment this edit creates.

### Found while here, NOT fixed — `moveOpening` on a `breakOpen` output

`breakOpen` ends the walk on a DUPLICATE of the start vertex, so its output is
a zero-width opening tracing the full perimeter. `moveOpening`'s own doc
comment names that as its common input. Feeding one to the other is where the
two ops' models disagree, and it costs glass:

```
loop      [[0,0],[100,0],[100,100],[0,100]] closed, ["arc","line","arc_r","line"]
breakOpen at 0 -> [[0,0],[100,0],[100,100],[0,100],[0,0]]   431.7552mm  (exact)
moveOpening to 2 -> [[100,100],[0,100],[0,0],[0,0],[100,0]] 331.7552mm  (-100mm)
```

The duplicated vertex is stranded mid-polyline as a zero-length segment, and
old segment 1 — a real 100mm straight — is gone from the takeoff, the pattern
and the DXF. This is a POINTS bug, present before this PR and unchanged by it;
`segment_types` now follows the points faithfully either way. Reconciling the
two ops (rotate-and-re-duplicate when the endpoints coincide, versus keep
today's one-segment gap) is a shape decision for the repo owner and a change to
the point handling, which this row explicitly scopes out. Pinned as a KNOWN
LIMIT in `docOps.test.ts` with the numbers above so the next person does not
have to re-derive them. **Worth a follow-up row.**

### Still open, deliberately

`racewayCrossings` walking raw chords, and the auto-split retry that can
decline, are `todo.md` row 120 and both want an arc-aware cut walk. Not
started.
