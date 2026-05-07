# Tier 3 #24 — Bitmap adjustments: draggable crop overlay + Hough auto-rotate

> **Status:** active · started 2026-05-07 · branch `task/24-bitmap-adjust-polish`

## Goal

PR #15 shipped rotate / crop / brightness / contrast as numeric inputs and sliders inside `<details>Image adjustments</details>` on the vectorize panel. From `todo.md` Appendix B row 24, two follow-ups remain:

1. **Draggable crop overlay** on the live preview canvas — letting the user drag a rectangle directly is much faster than typing X/Y/W/H. The overlay is two-way bound to the existing numeric inputs.
2. **Auto-rotate button** that runs a simple Hough-on-edges deskew estimator on the preview buffer and suggests a rotation angle that levels the dominant lines.

"Done" means: the user can rubber-band a rectangle on the source preview to set crop, and drag handles or the body to adjust it; the existing typed inputs stay editable and stay in sync; an "Auto-rotate" button next to the rotation slider sets `rotationDeg` based on Hough analysis (or shows "no clear skew detected" if confidence is low); the existing rotate/crop/brightness/contrast pipeline is otherwise unchanged; the change is frontend-only.

This is **not** a coordinate-space refactor. The current X/Y/W/H values live in cache-buffer-pixel space (the pre-existing convention from PR #15); the new overlay must produce values in that same space so the backend continues to receive what it receives today. If the cache→full-res scaling is incorrect, that's a separate Tier 3 follow-up — flag it in your report, do not fix it here.

## Branch + setup

```sh
git fetch origin
git checkout -b task/24-bitmap-adjust-polish origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/components/VectorizePanel.tsx` — render the crop overlay positioned over the existing source preview canvas (the figure around line 558-565); add an "Auto-rotate" button next to the rotation input; wire both to the existing `adjustments` state. The numeric crop inputs stay; they're a useful fallback and provide explicit numeric editing for power users.
- `web/src/App.css` — overlay styles (rectangle stroke + semi-transparent fill, 8 grab-handles, dimmed area outside the crop), keyed in a clearly-commented `/* Tier 3 #24 */` block at the bottom of the file.

**New:**

- `web/src/lib/hough.ts` — pure-function Hough deskew estimator: `estimateSkewDegrees(pixels: Uint8ClampedArray, width: number, height: number, opts?: { searchRangeDeg?: number; thetaStepDeg?: number }): { angleDeg: number; confidence: number } | null`. Operates on RGBA pixel buffers (R/G/B/A interleaved per pixel). Returns null when no clear dominant orientation is found.
- `web/src/lib/hough.test.ts` — vitest tests covering tilted-bars detection, low-confidence rejection, and the boundary "already aligned" case.
- (Optional) `web/src/components/CropOverlay.tsx` — only if the overlay logic grows past ~150 lines and embedding it in `VectorizePanel.tsx` would push that file uncomfortably large. Otherwise keep it inline. `VectorizePanel.tsx` is currently ~789 lines; staying inline is fine for ~100 lines of overlay.

**Don't touch:**

- Anything under `internal/` — backend image-processing pipeline is unchanged. The same `rotation_deg` + `crop` fields go to the same endpoint with the same request shape.
- `web/src/components/EditorCanvas.tsx`, `web/src/pages/EditorPage.tsx` — high-coupling editor files; unrelated.
- `web/src/api.ts` — request shape unchanged.
- `web/src/components/HersheyTextDialog.tsx`, `ProjectList.tsx`, `ProjectDetail.tsx` — unrelated; possible same-PR-round collisions if other Tier 3 tasks ship in parallel, so stay strictly scoped.

## Deliverables

### 1. Crop overlay

- Render an absolutely-positioned overlay over the source preview canvas (NOT the binarized one — the binarized canvas reflects post-crop already). The overlay shares the canvas's display dimensions (`previewSize.w/h`) and absolute origin.
- States:
  - **No crop set** (all four `cropX/Y/W/H` are `''`): clicking + dragging on the canvas rubber-bands a fresh rectangle. On `pointerup`, commit the new X/Y/W/H to `adjustments` state. Single click without drag does nothing.
  - **Crop set**: render the rectangle with a 1-px solid stroke, 8 handles (4 corners + 4 edge midpoints), and a semi-transparent dark overlay outside the crop ("masking" effect to make the crop region visually dominant).
- Drag interactions:
  - Drag a corner → resize that corner; the opposite corner stays fixed.
  - Drag an edge midpoint → resize that edge only; the opposite edge stays fixed.
  - Drag the body (inside the rectangle, not on a handle) → translate.
  - Hold Shift while resizing a corner → preserve aspect ratio (optional but nice — flag as a follow-up if time-pressed).
- All operations clamp the rectangle to `[0, adjustedBuffer.width] × [0, adjustedBuffer.height]`.
- All operations enforce a minimum size of 8 px (cache-pixel space) so the user can't accidentally collapse to a degenerate rectangle.
- A small "Reset crop" button (already exists in `resetCrop()`) clears the four fields. Reuse the existing function; the overlay reads the same `adjustments` state.

**Two-way binding.** The existing typed `<input type="number">` fields for `cropX/cropY/cropW/cropH` keep working. Editing them updates the overlay's rendered rectangle. Dragging the overlay updates the typed fields. Both feed the same `adjustments` state — no new state shape.

**Coordinate-space rule.** The overlay's stored values are in **cache-buffer pixel space** (the same units the typed inputs use today). The displayed rectangle is computed by scaling from cache-pixel to display-pixel via `displayWidth / adjustedBuffer.width`. Drag deltas convert in the inverse direction.

### 2. Auto-rotate button

- A small button labeled "Auto-rotate" next to the existing rotation slider/numeric input, inside the same grid cell.
- Clicking runs `estimateSkewDegrees(adjustedBuffer.pixels, .width, .height, { searchRangeDeg: 15 })`. The search range of ±15° matches the realistic deskew use case (phone photos / scans of mostly-upright designs); narrower than ±45° keeps Hough fast.
- On result:
  - If non-null and `confidence ≥ 3.0`: set `adjustments.rotationDeg` to `-result.angleDeg` (negate, because we want to rotate the image to undo the detected skew). Round to 1 decimal place. Show a transient hint near the button: "Detected 1.7° skew → −1.7°". Hide the hint after 4s or on next click.
  - Otherwise: show "No clear skew detected (try cropping first)". Don't change rotationDeg.
- The button is disabled while `source.kind !== 'ready'`. It runs against the **adjusted buffer** so a user can crop to a region before auto-rotating, which often improves the estimate.

## Constraints

- **No new third-party deps.** No opencv.js, no transformer libraries, no fast-Hough libraries. Plain TypeScript + canvas.
- **No backend changes.** Same request body, same endpoint, same coordinate convention.
- **Hough must complete in < 500 ms** on a 1024×768 cache buffer. Downsample further internally (e.g. cap to 512 px on the longer side) before running Sobel + Hough; visual quality of the estimate doesn't need full preview resolution.
- **Don't refactor the cache→full-res scale.** The current frontend sends crop coords in cache-pixel space, and the backend interprets them as full-res pixels. This is a known pre-existing inconsistency — flag it in the report under Tier 3 follow-ups, do not fix it in this PR.
- **The overlay must not break canvas pointer events for non-crop interactions.** Today there are none on the source canvas (it's display-only); we're adding the first interactive layer. Use `pointer-events` carefully so the rubber-band entry path works on the bare canvas, the overlay handles capture pointer events when present, and the figcaption stays selectable.
- **No URL/localStorage persistence** of the overlay state. Component-local only.

## Geometry / algorithms

### Crop overlay coordinate math

Two scales are in play:

- `cacheToDisplay = displayWidth / adjustedBuffer.width` (and the same for height). Use this to render the overlay rectangle from stored cache-pixel coords.
- `displayToCache = 1 / cacheToDisplay`. Use this to convert pointer-move deltas into cache-pixel deltas.

A pointer-down on a corner records `(startCacheX, startCacheY, startW, startH, startScreenX, startScreenY, anchorCorner)`. On move, compute new corners as `start + (currentScreen - startScreen) * displayToCache`, clamp, write back to state, normalize so W/H stay positive (swap with anchor if dragged through it), enforce min size.

### Hough deskew

Reference implementation outline:

1. **Greyscale + downsample.** Compute Y = `0.299·R + 0.587·G + 0.114·B`. If `max(width, height) > 512`, sample with a stride so the working buffer is ≤ 512 on the longer side. Working in greyscale halves the per-pixel cost; downsampling cuts edge-pass cost quadratically.
2. **Sobel magnitude.** For each non-border pixel, compute `|Gx| + |Gy|` (cheaper than √(Gx² + Gy²) and good enough for thresholding). Keep pixels whose magnitude is in the top quintile (computed via a histogram + accumulating from the high end until 20% of total) — these are edge candidates.
3. **Hough accumulator.** Theta range = `[-searchRangeDeg, +searchRangeDeg]` with step `0.25°` (default). Rho range = `[-diag, +diag]` with step 1 px, where `diag = ceil(hypot(width, height))`. The accumulator is a `Uint32Array(nThetas * nRhos)`. For each edge pixel `(x, y)`, for each theta bin, compute `rho = round(x · cos(θ) + y · sin(θ))` (offset by `+diag` to index from 0) and increment that cell.
4. **Peak detection.** For each theta bin, find the max rho cell; the bin's "score" is that max. The dominant theta is the bin with the highest score. Confidence = `peak / (median(scores) + 1)`. Return `null` if confidence < the caller's `confidenceThreshold` (default `3.0`).
5. **Convert theta → image rotation.** Theta is the normal angle of the dominant line. If we want to make horizontal lines truly horizontal: the rotation that aligns them is `−(90° − θ)` for near-vertical normals, or `−θ` for near-horizontal normals. Pick the convention that returns the smaller absolute angle within `[-searchRangeDeg, +searchRangeDeg]` so the answer is the rotation that levels things, not the rotation that rotates by 90°.

This is a 100–150-line implementation. Commit it under a header comment that explains step-by-step why each choice was made — future maintainers will appreciate the doc more than a clever short version.

## Tests

### `hough.test.ts`

- **Synthetic horizontal-bars at 5° tilt.** Build a 200×200 RGBA buffer of all-white, draw five evenly-spaced black horizontal bars (4 px tall) rotated by 5° around the center (each bar pixel is set if its rotated y-coordinate falls inside a bar). Call `estimateSkewDegrees` with default opts. Assert the returned `angleDeg` is in `[4, 6]` and `confidence ≥ 3.0`.
- **Synthetic at -3° tilt.** Same fixture, -3°. Assert in `[-4, -2]`.
- **Already aligned (0° bars).** Assert `|angleDeg| ≤ 1`.
- **Pure noise.** A 200×200 buffer of independent Math.random()-driven pixels. Assert `confidence < 3.0` so the function returns `null`.
- **Tilt outside search range.** Synthetic at 30° tilt with `searchRangeDeg: 15`. Assert the function returns `null` (the dominant orientation is outside the search window) — proving the search range is honored.

### `VectorizePanel.tsx` / overlay

No unit tests (no React Testing Library setup in the project). Manual smoke test below covers the overlay UX.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # advisory; no NEW diagnostics
```

Manual smoke test:

```sh
( cd web && npm run dev )
```

Use a project that has a real source bitmap upload (the demo seed assets if available, or upload a phone photo).

1. Open the project, open the vectorize panel, expand "Image adjustments".
2. With no crop set, drag a rectangle on the source preview. Confirm the typed X/Y/W/H fields populate. Submit a vectorize and verify the result reflects the crop.
3. Drag the body to translate; drag a corner to resize; drag an edge to resize one side. Verify the rectangle clamps to the canvas bounds.
4. Edit one of the typed inputs (e.g. set `cropW` to 100). Verify the overlay re-renders to match.
5. Click "Reset crop" — overlay clears, typed fields clear.
6. Click "Auto-rotate" on a slightly-skewed photo. Verify the rotation slider updates with a small angle and a hint shows. Click again on a featureless / aligned image — verify the "no clear skew" message.
7. Click "Auto-rotate" with `source.kind !== 'ready'` (refresh while busy). Confirm the button is disabled — no error.

## Workflow

1. Build `hough.ts` first as a pure function. Land its tests; verify all green. Profile against a 1024×768 noise buffer in the browser console to confirm < 500 ms.
2. Add the "Auto-rotate" button next to the rotation input; wire it through.
3. Build the crop overlay (inline or extracted into `CropOverlay.tsx` only if it grows past ~150 lines).
4. Add the CSS rules under a `/* Tier 3 #24 */` block.
5. Run the four pre-merge checks. Manual smoke through the seven scenarios above.
6. Open PR titled "Bitmap adjustments polish: draggable crop + Hough auto-rotate (Tier 3 #24)". Body links to `todo.md` Appendix B row 24.
7. **Move this spec** from `specs/active/tier3-24-bitmap-adjust-polish.md` to `specs/done/tier3-24-bitmap-adjust-polish.md` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary
- Judgment calls — overlay extraction (inline vs CropOverlay component), confidence threshold tuning, search-range default, whether Shift-aspect-lock made it in
- Hough perf measurement on a real photo (cache buffer size + ms)
- File-size deltas on `VectorizePanel.tsx`, `App.css`, and any new files
- CI final state
- Tier 3 follow-ups worth tracking — especially:
  - **Cache-pixel vs full-res coordinate mismatch** for `crop` (the pre-existing bug we deliberately did not fix here)
  - Aspect-ratio lock for crop (if not landed)
  - Saving/loading the auto-rotate confidence so users can redo the suggestion
  - Per-channel adjustments (RGB curves)
