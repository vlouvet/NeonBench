# Phase 3 #6 — Electrodes + blockouts (per-segment material switching)

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/p3-6-electrodes-blockouts`

## Goal

Phase 3 #2 + #3 ship full-run tubes with one material per run. This spec adds two pieces of fidelity:

1. **Electrode caps** — each `Run.Electrode` (a `PointIndex` into the polyline + side info) renders as a small metallic cylinder + cap at the electrode's position, replacing the open tube end.
2. **Blockouts as opaque sleeves** — each `Run.Blockout` segment (a `[startPointIndex, endPointIndex]` pair) is rendered as a separate dark-grey tube segment overlaid on the run's emissive tube, simulating the painted-out tube section.

Together these two finally make the 3D preview look like a real built sign rather than uniform glowing wire.

"Done" means: opening a preview shows electrode caps where electrodes are placed; blockout segments render as opaque dark sleeves on top of the live tube; no visual gaps or z-fighting between the live tube and the blockout overlay.

## Branch + setup

```sh
git fetch origin
git checkout -b task/p3-6-electrodes-blockouts origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/Tube.tsx` — split the single tube geometry into multiple sub-segments based on the run's blockouts; render each segment with the appropriate material (emissive for live, dark grey for blockout). Render electrode caps as a child component.

**New:**

- `web/src/preview/Electrode.tsx` — single electrode component. Takes `{run, electrode}` props, computes the electrode's world position by walking the polyline to `electrode.PointIndex`, renders a small cylinder + hemisphere cap.
- `web/src/preview/segment-split.ts` — pure helper: `splitRunBySegments(run): Array<{points: Point[]; isBlockout: boolean}>`. Walks the polyline + the run's blockout list, returns an array of segments tagged `live` or `blockout`. Each segment becomes its own `<Tube>`.
- `web/src/preview/segment-split.test.ts` — tests covering edge cases (blockout at run start, blockout at run end, multiple blockouts, blockout spanning entire run, no blockouts).

**Don't touch:**

- `materials/` — emissive material from #3 stays; only its callsites change.
- `Scene.tsx`, `PreviewPage.tsx` (no top-level changes; the per-run rendering plumbing is in Tube.tsx).
- Backend.

## Deliverables

### Segment split

A run with blockouts at points `[2, 5]` and `[7, 9]` (0-indexed) and a 12-point polyline produces 5 segments:

```
points 0-2 (live) → emissive
points 2-5 (blockout) → dark grey sleeve
points 5-7 (live) → emissive
points 7-9 (blockout) → dark grey sleeve
points 9-11 (live) → emissive
```

The seam point is shared between adjacent segments (e.g. point 2 ends the first segment AND begins the second) so the tube geometry is continuous — no visual gap. The geometry's tube radius is the same across segments; only the material changes.

### Material per segment

- **Live segments**: the existing emissive material from Phase 3 #3, keyed by `run.color` / gas.
- **Blockout segments**: `<meshStandardMaterial color="#1a1a1a" roughness={0.7} metalness={0.0} emissive="#000000" />` — opaque, slightly rough-looking dark surface that simulates the blockout paint.

### Electrode caps

For each `electrode` in `run.electrodes`:

1. Compute the electrode's world position: walk the polyline from index 0 to `electrode.PointIndex`, sum positions, take `points[PointIndex]`. Apply Y-flip per Phase 3 #2.
2. Compute the electrode's tangent direction from `points[PointIndex]` to the previous (or next, if PointIndex===0) polyline point.
3. Render a small `<mesh>`:
   - `<cylinderGeometry args={[capRadius, capRadius, capHeight, 12]} />` where `capRadius = run_diameter / 2 * 1.05` (slightly larger than the tube so it caps cleanly), `capHeight = 6 mm`.
   - `<meshStandardMaterial color="#888888" roughness={0.3} metalness={0.85} />` — bright metallic cap.
   - Position at the electrode's polyline point, oriented along the tangent (cylinder's axis aligned with the tube's last segment direction).
4. Optionally a hemisphere on top (`<sphereGeometry args={[capRadius, 12, 6, 0, Math.PI*2, 0, Math.PI/2]} />`) for a more realistic GTO cap shape.

### Blockout-electrode interaction

If an electrode's `PointIndex` falls inside a blockout range, the cap renders on top of the dark sleeve. That's correct — physically the electrode pin protrudes through the blockout paint. No special-casing needed.

## Constraints

- **No new dependencies.**
- **No backend changes.**
- **No edit affordances.**
- **Z-fighting prevention** — when a live tube segment and a blockout segment share a seam point, both render at the exact same position. Three.js's depth buffer handles this fine because both are part of the same surface; we're not stacking two parallel surfaces. No need for `polygonOffset`.
- **Continuous look across segments** — radius MUST be identical between adjacent live + blockout segments. If a future spec wants visible "step" at the blockout edge (e.g. the paint adds slight thickness), that's a separate row.
- **Electrode count** — typical sign has 2-10 electrodes. Don't optimize the electrode rendering loop; per-electrode `<mesh>` instantiation is fine at this scale. If a future complex sign hits 100+ electrodes, instanced rendering becomes a follow-up.
- **Polyline-Y-flip is preserved** in electrode position calculation — same as Phase 3 #2.

## Geometry / algorithms

```ts
// segment-split.ts
export function splitRunBySegments(run: Run): Array<{ points: Point[]; isBlockout: boolean }> {
  const points = run.polyline.points;
  if (!points || points.length < 2) return [];
  const blockouts = (run.blockouts ?? []).slice().sort((a, b) => a[0] - b[0]);

  if (blockouts.length === 0) {
    return [{ points, isBlockout: false }];
  }

  const segments: Array<{ points: Point[]; isBlockout: boolean }> = [];
  let cursor = 0;
  for (const [bo_start, bo_end] of blockouts) {
    if (cursor < bo_start) {
      // Live segment from cursor to bo_start (inclusive of bo_start so the seam shares)
      segments.push({ points: points.slice(cursor, bo_start + 1), isBlockout: false });
    }
    // Blockout segment from bo_start to bo_end
    segments.push({ points: points.slice(bo_start, bo_end + 1), isBlockout: true });
    cursor = bo_end;
  }
  // Trailing live segment after last blockout
  if (cursor < points.length - 1) {
    segments.push({ points: points.slice(cursor, points.length), isBlockout: false });
  }
  return segments;
}
```

Edge cases handled:
- Blockout starts at point 0 → first segment is the blockout itself.
- Blockout ends at last point → no trailing live segment.
- Two adjacent blockouts (`[2, 5]` and `[5, 8]`) → produces two separate blockout segments sharing seam point 5; visually indistinguishable from one big blockout.
- Empty blockouts list → single live segment.

## Tests

`segment-split.test.ts`:

- No blockouts → one live segment.
- Single mid-run blockout → 3 segments (live, blockout, live).
- Blockout at start → 2 segments (blockout, live).
- Blockout at end → 2 segments (live, blockout).
- Two non-adjacent blockouts → 5 segments.
- Two adjacent blockouts → 4 segments (live, blockout, blockout, live).
- Whole-run blockout → 1 segment, type blockout.

For the visual rendering (electrode caps, blockout materials), manual smoke covers it.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open preview on a project with electrodes + blockouts (the OPEN sign demo if you have it).
2. Confirm dark blockout sleeves appear on the right tube segments.
3. Confirm metallic electrode caps appear at every electrode position.
4. Confirm tube continuity — no visible gaps where blockout meets live segment.
5. Frame rate stays ≥ 60 fps with 10+ electrodes + 5+ blockouts on a typical sign.
6. Camera orbit shows electrode caps clearly oriented along tube tangent (not floating off-axis).

## Workflow

1. `segment-split.ts` + tests first; verify all seven cases.
2. Wire into `Tube.tsx`; render each segment as a sub-`<Tube>` (or refactor Tube into a wrapper that accepts pre-split segments).
3. Build `Electrode.tsx`; wire into Tube wrapper.
4. Manual smoke; confirm all visuals.
5. Pre-merge checks.
6. Open PR titled "Phase 3 electrodes + blockouts (Phase 3 #6)".
7. **Move spec** from active/ to done/.

## Report back

Under 300 words. Include PR URL, summary, judgment calls (especially the seam-point-sharing strategy; the cap geometry choice; whether the cylinder-only or cylinder+hemisphere cap shape made it in), file-size deltas, CI state, follow-ups (e.g. instanced rendering for high-electrode-count signs; per-electrode-style overrides for transformer-mounted vs PK-style; blockout sleeve thickness for that "painted-on-glass" stepped look).
