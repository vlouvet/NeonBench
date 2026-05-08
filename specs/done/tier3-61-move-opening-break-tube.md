# Tier 3 #61 — Move Opening / Break Tube Open (NW #130)

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/61-move-opening-break-tube`

## Goal

NW's "Move Opening / Break Tube Open" lets the operator pick a point on a tube and (a) open a closed loop at that point, or (b) move the existing opening (the gap between the two electrode endpoints on an open run) to a different point along the polyline. Both operations rearrange the tube's geometry without changing its visual silhouette — the path stays the same, only where the electricity enters and leaves shifts.

NeonBench's editor already has `splitRun(doc, runId, pointIndex)` from PR #44 (Tier 3 #25 node-edit polish), but it splits one run into TWO runs at a vertex. NW's "Break Open" is different: it converts a closed polyline (`closed: true`, no electrodes) into an open polyline (`closed: false`, gap inserted at the chosen vertex), preserving the run as a single entity. NW's "Move Opening" walks the existing open run's electrode positions to a new vertex while keeping the same total geometry — useful when the operator realizes the as-drawn opening lands somewhere awkward (over a customer's logo, behind a column, in a corner that the bender can't reach).

This spec adds two new operations to `docOps.ts` and exposes them as a new editor tool that toggles between the two modes based on whether the clicked run is closed or open.

"Done" means: the editor has a "Break/Move Opening" tool. Clicking on a closed run inserts an opening at the nearest vertex (auto-places two electrodes at indices `i` and `i+1`, splitting the polyline into open form). Clicking on an open run with two electrodes moves both electrodes to the nearest vertex (preserving polyline geometry, only changing where the gap is). Undo/redo wraps both operations.

## Branch + setup

```sh
git fetch origin
git checkout -b task/61-move-opening-break-tube origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/lib/docOps.ts` — two new operations:
  - `breakOpen(doc, runId, vertexIndex)`: converts `closed: true` polyline to `closed: false`, splices a duplicate vertex at `vertexIndex`, places two electrodes at the duplicated indices, leaves direction undefined (defaults to `"forward"`).
  - `moveOpening(doc, runId, newStartVertexIndex)`: for an open run with two electrodes, rotates the polyline points (and indices in blockouts/annotations/bends) so that vertex `newStartVertexIndex` becomes index 0, and electrodes land at `[0, last]`.
- `web/src/lib/docOps.test.ts` — boundary tests:
  - `breakOpen_closedTriangle` — 3-point closed → 4-point open with electrodes at [0,3] and the duplicated vertex correctly added.
  - `breakOpen_preservesBlockouts` — closed run with mid-arc blockout; after break, blockout indices are still consistent against the new live arc.
  - `breakOpen_rejectsAlreadyOpen` — open run → throws clear error.
  - `moveOpening_simpleRotation` — 8-point open polyline electrodes at [0,7]; move opening to vertex 4 → electrodes at [0,7] post-rotate, and the geometry walked from new index 0 matches the prior walk starting at vertex 4.
  - `moveOpening_preservesBlockoutLiveIndices` — blockout from live-index 2 to live-index 5 stays at 2..5 after the rotation (live-arc indices are walk-relative).
  - `moveOpening_rejectsClosedOrTooFewElectrodes` — closed run or run with <2 electrodes → throws.
- `web/src/components/EditorCanvas.tsx` — new `'break-open'` value on `EditorTool`. Hover state highlights nearest vertex on hover; click commits the appropriate op based on the clicked run's `closed` flag.
- `web/src/pages/EditorPage.tsx` — toolbar button labeled "Break/Move Opening" with hot-key `O`.

**New:**

- `specs/active/tier3-61-move-opening-break-tube.md` (this file) — moved to `specs/done/` on completion.

**Don't touch:**

- `splitRun` from PR #44 — different operation, leave alone.
- `internal/designdoc/types.go` — no schema changes.
- Backend / handlers / migrations / printpdf / preview — purely a frontend operation. The reordered polyline serializes the same way it always did; existing render paths don't care.
- `validate/rules.go` — opening position has no validator implications today.

## Deliverables

### `breakOpen` operation

```ts
function breakOpen(doc: DesignDoc, runId: string, vertexIndex: number): DesignDoc;
```

Steps:
1. Find run; assert `closed === true`. Throw `OperationError` if already open.
2. New polyline points = `[...points.slice(vertexIndex), ...points.slice(0, vertexIndex), points[vertexIndex]]`. The closing vertex is duplicated at the end so the path geometry is preserved as an OPEN polyline.
3. Set `polyline.closed = false`.
4. Set `electrodes = [{ point_index: 0 }, { point_index: <last index> }]`.
5. Recompute `blockouts` / `annotations` / `bends` indices: each `live_index` walks the same live-arc, so live-arc-relative indices stay valid (a closed loop walked from any vertex traces the same arc; the live arc just starts at the new opening). No re-mapping needed because all three structures use live-index, not point-index.
6. Return new Doc.

### `moveOpening` operation

```ts
function moveOpening(doc: DesignDoc, runId: string, newStartVertexIndex: number): DesignDoc;
```

Steps:
1. Find run; assert `closed === false` AND `electrodes.length === 2`.
2. Resolve `walked` = the live-arc walk (in current direction) from `electrodes[0].point_index` to `electrodes[1].point_index`. This is the canonical sequence of vertices the live tube traces today.
3. Rotate `walked` so it starts at the user-clicked vertex: find `i = walked.indexOf(newStartVertexIndex)`; new walk = `walked.slice(i).concat(walked.slice(0, i))`.
4. Replace `polyline.points` with the rotated walk.
5. Set `electrodes = [{ point_index: 0 }, { point_index: walked.length - 1 }]`.
6. `blockouts`, `annotations`, `bends` are live-arc-relative — they still index into the live arc the same way, so no remap needed.
7. Return new Doc.

### UX

- Toolbar button "Break/Move Opening" + hotkey `O`.
- Hover: nearest vertex highlights teal (radius 8/k px, mirrors PR #44's snap-to-vertex hover).
- Click on closed run + nearest-vertex distance < snap radius: commit `breakOpen`.
- Click on open run + nearest-vertex distance < snap radius: commit `moveOpening`.
- Click further than snap radius: no-op (status bar hint: "Click within snap radius of a vertex").
- Esc or tool change cancels.

## Constraints

- **No new third-party deps.**
- **No backend changes** — this is a pure frontend doc-op, the persisted JSON shape is unchanged.
- **No printpdf / preview changes** — the rotated polyline serializes identically; downstream consumers don't notice.
- **Reject runs with <2 electrodes** for `moveOpening` — there's no opening to move.
- **Don't touch closed runs in `moveOpening`** and don't touch open runs in `breakOpen`. The tool dispatches based on the run's `closed` flag.

## Geometry / algorithms

The only subtle bit is that **live-arc indices stay valid** through both ops because:

- A closed loop walked from any starting vertex traces the same arc. Rotating the start vertex doesn't change which vertex is "live-arc index 3" — it's always "the vertex 3 hops from the start".
- An open run's live arc is the polyline from electrode[0] to electrode[1]. Rotating preserves arc length; live-index relative positions stay consistent.

Pure functional manipulation, no floating-point, no geometric search beyond `Math.hypot` for the click→nearest-vertex hit test. Snap radius `(8 / zoom)` mirrors the rest of the canvas chrome.

## Tests

See file scope above for the six test names. Existing `docOps.test.ts` already has 73+ tests covering split/join/insert; these add to that suite.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open a project. Draw a closed polygon (rect / circle) → save → reopen.
2. Press `O`; hover a vertex → teal highlight; click → run becomes open with electrodes at the clicked vertex.
3. Pick a run that's already open with electrodes at [0, last]; hover a different vertex; click → opening moves there; the canvas preview re-renders with electrodes at the new opening but the underlying tube path looks identical.
4. Add a blockout straddling the original opening; perform `moveOpening`; confirm the blockout's relative position to the live arc is preserved (blockout was 1/3 along the live arc; still 1/3 along after the move).
5. Undo / redo both operations.

## Workflow

1. Implement `breakOpen` with its three tests.
2. Implement `moveOpening` with its three tests.
3. Wire the canvas tool + toolbar button + hotkey.
4. Run pre-merge checks; manual smoke per above.
5. Open PR titled "Break/Move Opening tool (Tier 3 #61, NW #130)".
6. Move spec `specs/active/ → specs/done/` in final commit.

## Report back

Under 300 words. Include:

- PR URL
- File deltas
- Test results (6 new; total docOps test count after)
- CI state
- Judgment calls — particularly: how did you verify live-arc index preservation in `moveOpening`? Are there edge cases when the run direction is `"backward"`?
- Tier 3 follow-ups: opening-position validator rule (warn if opening lands inside a tight corner where the bender can't get a torch in); auto-suggest opening position based on the design's bbox (e.g. "place opening at the bottom-most vertex"); right-click context menu on vertex with "Break/Move opening here" item.
