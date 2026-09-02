# Tier 3 #119 — Three more ops in the `segment_types` family

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
