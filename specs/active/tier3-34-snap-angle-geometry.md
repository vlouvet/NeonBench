# Tier 3 #34 — Snap-to-angle and snap-to-geometry

> **Status:** active · started 2026-05-07 · branch `task/34-snap-angle-geometry`

## Goal

The editor canvas already takes `snapEnabled` + `snapMM` props (see `EditorCanvas.tsx:41-42, 67-68`) and quantizes pointer positions to a grid. Two follow-ups:

1. **Snap-to-angle during draw.** While dragging the second point of a pen / rect / circle / arc tool, constrain the working segment to the nearest of `0°, 15°, 30°, 45°, 60°, 75°, 90°, …` from the previous point. Hold Shift to engage the snap; release to free-draw. The props are wired through but the new tools don't consume them yet.
2. **Snap-to-geometry.** When the cursor is within snap distance of an existing run's vertex or its segment midpoint, snap the working point to that exact location. Reuses the snap-to-vertex hover-ring pattern from Tier 3 #25.

"Done" means: holding Shift while drawing a pen/rect/circle/arc segment locks the angle to the nearest 15° increment; cursor near an existing vertex or midpoint shows a hover ring and snaps the next click; both behaviors compose cleanly with the existing grid snap.

## Branch + setup

```sh
git fetch origin
git checkout -b task/34-snap-angle-geometry origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/components/EditorCanvas.tsx` — wire `snapEnabled` / `snapMM` through to the drawing-tool branches (currently the props are read by `snapPoint` but only for label/dimension/vertex-drag; the new pen/rect/circle/arc tools don't consult them). Add Shift-key tracking (`isShiftHeld`) and the angle-snap math. Add the snap-to-vertex / snap-to-midpoint detection on cursor-move.
- `web/src/pages/EditorPage.tsx` — none expected; the snap toggle is already in the toolbar.

**Coupling note:** `EditorCanvas.tsx` is high-coupling. Sequence after #17 ESLint cleanup. Do not run in parallel with #25 (which adds a snap-to-vertex hover ring during node-edit alt-hover) or #28 (marker overlay) or #33 (multi-select).

**Don't touch:**

- Backend (no schema changes).
- `web/src/lib/shapes/*.ts` — geometry primitives are fine as-is.

**New:** none.

## Deliverables

### 1. Angle snap (Shift-held)

- During a tool's draw phase (after pen has at least one anchor; rect/circle/arc has its center or first corner), if Shift is held, the working segment from `lastAnchor` to the cursor is constrained to the nearest 15° increment.
- Default increment: 15° (`stepDeg = 15`). Document in a constant.
- Math:
  ```
  dx = cursor.x - last.x
  dy = cursor.y - last.y
  ang = atan2(dy, dx)              // radians
  angSnapped = round(ang / step) * step   // step = stepDeg * π / 180
  len = hypot(dx, dy)
  snapped.x = last.x + len * cos(angSnapped)
  snapped.y = last.y + len * sin(angSnapped)
  ```
- Visual cue: render a 1-px guide line from the anchor along the snapped angle so the user sees the constraint live.
- Pen tool: Shift constrains the in-progress segment from the last committed anchor.
- Rect tool: Shift constrains to a square (W = H, sign-preserved).
- Circle tool: Shift makes the radius axis-aligned (circle "from center" is already radial; in this case "snap" doesn't change geometry — document as no-op or repurpose Shift for "circle from center" vs "circle from edge" if useful).
- Arc tool: Shift constrains the chord between control points to the angle increment.

### 2. Snap-to-geometry (no modifier needed when grid snap is on)

When `snapEnabled` is true and the cursor is within a snap radius of:
- **Existing vertex** of any run's polyline, or
- **Midpoint** of any segment of any run's polyline,

… snap the working point to that exact world coordinate. Render a small hover ring (matching #25's pattern).

Snap radius: `max(8 / scale, snapMM / 2)` mm so it stays visible at any zoom but doesn't grab points the user clearly isn't aiming at.

Priority when multiple candidates compete: vertex > midpoint > grid (so a real geometric point beats a 5 mm grid intersection nearby).

### 3. Composition

The three snap modes — grid, angle, geometry — compose:

- Geometry first (highest priority): if the cursor is within range of an existing vertex/midpoint, the working point is THAT.
- Then angle: if Shift is held and no geometry snap fired, constrain the segment to the nearest 15°.
- Then grid: if neither geometry nor angle snap fired, quantize to `snapMM`.

Document this composition in the code comment for `snapPoint` (extend the existing helper or add a sibling).

## Constraints

- **No new third-party deps.**
- **Don't change the snap props' shape.** Both already exist; this PR consumes them more thoroughly.
- **Visual cues are subtle.** Angle-guide line is 1-px, light gray, no shadows. Hover ring is the same look as Tier 3 #25 (consistent visual vocabulary).
- **Keep the math fast.** Snap detection runs on every `pointermove`; for designs with thousands of vertices, naive O(N) scan per move is still < 1ms but document if you need a quadtree.

## Geometry / algorithms

**Nearest vertex / midpoint scan:**

```ts
let best = { dist2: snapRadius * snapRadius, point: null, kind: null };
for (const run of doc.runs) {
  for (let i = 0; i < run.polyline.points.length; i++) {
    const p = run.polyline.points[i];
    const d2 = (p[0]-cursor[0])**2 + (p[1]-cursor[1])**2;
    if (d2 < best.dist2) best = { dist2: d2, point: p, kind: 'vertex' };
  }
  for (let i = 0; i < run.polyline.points.length - 1; i++) {
    const a = run.polyline.points[i];
    const b = run.polyline.points[i+1];
    const m = [(a[0]+b[0])/2, (a[1]+b[1])/2];
    const d2 = (m[0]-cursor[0])**2 + (m[1]-cursor[1])**2;
    if (d2 < best.dist2) best = { dist2: d2, point: m, kind: 'midpoint' };
  }
}
```

Vertex strictly beats midpoint (the loop order encodes this — vertex pass first).

## Tests

No unit tests for the canvas (no RTL setup). Add unit tests for any extracted snap-math helper if it lives in a separate file.

Manual smoke:

1. Pen tool, click two points without Shift; segment is free.
2. Pen tool, hold Shift while moving cursor; segment locks to 0°/15°/30°/etc.
3. Pen tool with grid-snap on (snapMM=5), no Shift; segment quantizes to grid.
4. Pen tool with grid-snap on, Shift held; angle wins (the segment locks to angle).
5. Existing vertex of another run within snap range; cursor jumps to it; click commits a vertex co-located with the existing one.
6. Hover near a segment midpoint; ring appears at the midpoint; click snaps there.
7. Rect tool with Shift; rectangle is square.

## Pre-merge checks

Standard four. Manual smoke per above.

## Workflow

1. Wire angle snap into the existing pen / rect / arc tool branches.
2. Add geometry snap (vertex + midpoint) detection.
3. Render angle-guide line + hover ring.
4. Pre-merge + smoke.
5. PR titled "Snap-to-angle + snap-to-geometry during draw (Tier 3 #34)".
6. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Include: PR URL, circle-tool Shift semantic chosen, perf measurement of geometry-scan on a doc with 1000+ vertices, CI state, follow-ups (configurable angle increment, polar snap relative to a different anchor, snap-to-extension-line beyond a vertex).
