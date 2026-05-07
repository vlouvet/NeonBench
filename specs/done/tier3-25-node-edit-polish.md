# Tier 3 #25 — Node-edit polish

> **Status:** active · started 2026-05-07 · branch `task/25-node-edit-polish`

## Goal

PR #23 shipped node insert / split / join (Tier 2 #9). Three follow-ups remained from that round's agent report and made it into Tier 3:

1. **Straddling-blockout split.** Today a blockout that straddles the split point is dropped with `console.warn(splitRun: blockout […] straddles split point — dropped)`. It should be split into two valid pieces — one on each new run — preserving the user's intent.
2. **Run-numbering convention.** Split outputs use `<id>-a` / `<id>-b` suffixes, which compounds on repeated splits (`<id>-a-a`, etc.). Replace with the same numeric convention the rest of the editor uses ("Run 1, Run 2, …" — bumping the next available index, not nesting suffixes).
3. **Snap-to-vertex highlight.** When the user alt-clicks (insert) near an existing vertex, render a small ring on that vertex and prefer the existing vertex over inserting a 0-distance dup. This makes the difference between "insert here" and "split here" visible at a glance.

"Done" means: split preserves a straddling blockout as two pieces; new run IDs use a flat-numbering scheme; alt-click within snap distance of an existing vertex shows a hover ring and skips redundant inserts.

## Branch + setup

```sh
git fetch origin
git checkout -b task/25-node-edit-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — `splitRun`: swap the dropped-blockout branch for a split-blockout branch; switch the `-a`/`-b` ID scheme to a numeric strategy. Keep the existing test signatures stable.
- `web/src/lib/docOps.test.ts` — update the existing tests for the new ID convention; add tests for the straddling-blockout split.
- `web/src/components/EditorCanvas.tsx` — add the snap-to-vertex hover ring during alt-hover when in node-edit mode. Reuse the existing snap math; don't add a new coordinate-conversion path. **Coupling note:** this file is in the no-fly zone for parallel Tier 3 work; sequence accordingly.

**Don't touch:**

- Backend (no schema or validation changes).
- `EditorPage.tsx` — node-edit handlers live in EditorCanvas; if you find yourself wanting to lift state, stop.
- Other `web/src/lib/shapes/*` files — node-edit ops are already in `docOps.ts`.

**New:** none.

## Deliverables

### 1. Straddling-blockout split

A blockout `[s, e]` on a run with `n` live-arc points "straddles" a split at vertex `k` if `s < liveIndexOfSplit(k) < e`. After split, run-A holds live-arc indices up to (and including) the split point as its endpoint; run-B starts at the split point. Convert the original blockout into two new ones:

- `runA.blockouts += { startLiveIndex: s, endLiveIndex: liveIndexOfSplit(k) }`
- `runB.blockouts += { startLiveIndex: 0, endLiveIndex: e - liveIndexOfSplit(k) }`

If either piece collapses to length 0 after the split (the split lands exactly on an endpoint), drop just that empty piece, not the whole pair.

Annotations and bends already pass through unchanged in the existing code — keep that logic.

### 2. Numeric run-numbering

Today: `splitRun(doc, "abc")` produces `abc-a` and `abc-b`. Repeated split → `abc-a-a`, `abc-a-b`, etc. Replace with:

- A helper `nextRunId(doc, prefix?: string): string` that returns the lowest unused integer ID (default prefix `"r"` so IDs become `r1`, `r2`, …) — or, if every existing run already uses a numeric scheme, continues from `max(existing)+1`. If existing runs don't follow a numeric scheme, switch them silently in the split call only (don't migrate the whole doc).
- `splitRun` calls `nextRunId(doc)` twice to get two fresh IDs. The original run is removed.
- Update join-related code in `docOps.ts` if it reads the suffix to identify split outputs (likely doesn't — verify).

The numeric scheme is editor-internal. DXF layer names continue to use the run.id as-is (sanitized). PDF labels already use 1-based array indices ("Run N") per Tier 3 #21's spec, so no PDF changes here.

### 3. Snap-to-vertex hover ring

In the node-edit alt-hover path inside `EditorCanvas.tsx`:

- Track `hoveredVertex: { runId: string; pointIndex: number } | null` derived from the cursor's distance to each visible run's polyline points.
- Snap radius: `max(8 / scale, snapMM / 2)` mm — visible at any zoom, but small enough not to grab vertices the user clearly isn't near.
- When non-null, render a 6-px-stroke circle at that vertex (under any selection ring; use a distinct color so "snap target" reads differently from "selected vertex").
- On alt-click: if `hoveredVertex` is non-null and the click is still within snap radius, **don't** insert a duplicate vertex; instead select the existing vertex (or no-op, depending on what makes sense — pick the simpler path and document).

## Constraints

- **No new third-party deps.**
- **No schema changes** — blockouts already store `start_live_index` / `end_live_index`, perfectly representable.
- **Run-id migration is not a goal.** Don't auto-rename runs that already have legacy `-a`/`-b` IDs; just don't produce more of them on new splits.
- **Don't break existing splits in old saved docs.** Loading a v0 doc with `r-a-b` runs must still work; the canvas just won't beautify them.

## Geometry / algorithms

`liveIndexOfSplit(k)` — converts a polyline point index to a live-arc index using the run's electrode positions and direction. The existing `splitRun` already does this; reuse the same math when partitioning the blockout.

Snap-to-vertex distance test:

```ts
const dx = mouseW.x - pt.x, dy = mouseW.y - pt.y;
if (dx * dx + dy * dy <= snapRadius * snapRadius) { /* snap */ }
```

(squared distance avoids the sqrt; `snapRadius` in mm).

## Tests

Add to `docOps.test.ts`:

- **`splitRun preserves straddling blockout`**: a 10-point open run with a blockout `[2, 7]` split at point index 5. Assert run-A's blockouts include `[2, 4]` (live-arc) and run-B's include `[0, 2]`.
- **`splitRun with blockout adjacent to split point doesn't synthesize empty piece`**: blockout `[2, 5]` split at 5; expect run-A to keep `[2, 5]`, run-B to have no blockout from this source.
- **`splitRun produces sequential numeric IDs`**: split a doc with one run `r1`. Expect outputs `r2` and `r3`, not `r1-a`/`r1-b`.

For canvas hover, no unit test (no RTL setup); manual smoke covers it.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Draw or import a polyline; add a blockout that spans roughly the middle third.
2. Split the run at a point inside the blockout. Confirm both new runs carry partial blockouts and the design renders correctly.
3. Repeat-split — verify the IDs stay flat (`r2`, `r3`, `r4` …) rather than nesting.
4. Hover with alt held near an existing vertex. Confirm the ring appears. Click — confirm no duplicate vertex is inserted.

## Workflow

1. `nextRunId` helper + tests.
2. Straddling-blockout split + tests.
3. Hover-ring on EditorCanvas.
4. Pre-merge checks + smoke.
5. PR titled "Node-edit polish: blockout split, numeric IDs, vertex snap-ring (Tier 3 #25)".
6. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Cover: PR URL, the alt-click-on-existing-vertex semantic chosen (no-op vs. select), how repeated splits play with legacy `-a`/`-b` IDs in old docs, CI state, follow-ups (e.g. multi-vertex select, drag a snap-target vertex to merge with another).
