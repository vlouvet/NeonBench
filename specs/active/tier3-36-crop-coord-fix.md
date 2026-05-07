# Tier 3 #36 — Cache-pixel vs full-res crop coordinate mismatch

> **Status:** active · drafted 2026-05-07 · branch (when dispatched) `task/36-crop-coord-fix`

## Goal

The frontend stores crop coordinates in **cache-buffer pixel space** — that's the buffer after `SOURCE_CACHE_MAX_DIM = 1024` downsample. The backend's vectorize handler interprets `crop.x/y/w/h` as **full-resolution pixel space**. For any source image larger than 1024 px on the long side, the applied crop is shrunken by `cacheScale = sourceLongSideOrig / 1024`.

PR #15 (numeric crop inputs) and PR #30 (draggable crop overlay) both inherit this bug. PR #30's spec deliberately deferred the fix to keep the overlay PR scoped tight.

"Done" means: the crop the backend applies matches the crop the user drew on screen, regardless of source size. The fix is surgical — scale up the crop coords on the way out of the frontend (or send the cache scale alongside so the backend can convert). All existing manual-crop projects keep working post-fix; document the migration concern (any pre-fix saved-and-resubmitted crops will now apply the *correct* full-res crop instead of the incorrect-but-shrunken one).

## Branch + setup

```sh
git fetch origin
git checkout -b task/36-crop-coord-fix origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `web/src/components/VectorizePanel.tsx` — in the `submit()` (or equivalent vectorize-request) handler, scale the crop coords from cache-buffer space to full-resolution pixel space before sending. Cache scale = `originalImageWidthPx / cacheBufferWidthPx` (read from `source` state — the cache-buffer dims live alongside the original dims after upload).
- `web/src/components/VectorizePanel.test.ts` (new file IF the project has component tests; otherwise add unit tests on a pure helper) — pin the conversion math.
- `web/src/lib/cropCoords.ts` (new) — pure helper `cacheToFullRes({x, y, w, h}, cacheScale): {x, y, w, h}`. Trivial multiply, but lifting it into a typed function lets the test live there without RTL setup.

**Don't touch:**

- Backend (`internal/server/handlers_vectorize.go`, vectorize pipeline) — the backend's interpretation is correct; the frontend was sending the wrong units.
- `EditorCanvas.tsx`, `EditorPage.tsx` — unrelated.
- Other frontend components.

**New:**

- `web/src/lib/cropCoords.ts`
- `web/src/lib/cropCoords.test.ts`

## Deliverables

1. **Scale on submit.** The cache scale is already implicit in `source.adjustedBuffer.width` vs `source.original.width` (or whichever fields the upload-side code stores). Compute `scale = source.original.width / source.adjustedBuffer.width` once per submit; multiply x/y/w/h on the way out.
2. **Round to integer pixels** after scaling — fractional crop pixels are meaningless to the backend's image library.
3. **Unit tests** in `cropCoords.test.ts`:
   - Identity at scale 1.0.
   - Scale 2.0 doubles every component.
   - Scale 1.7 (non-integer) produces correctly-rounded integers.
   - Empty crop (all zeros) → all zeros (don't divide-by-zero on degenerate inputs).
4. **Backwards compatibility note**: a pre-fix project whose saved crop only describes a 600×400 region of a 2048-wide source will, after this fix, apply a 600×400 crop of the *full-resolution* source — not the cache-buffer-equivalent 1200×800 region. The change is correct (the user's intent was to crop a specific area on screen), but a smoke test on a real project with an existing crop should confirm the resulting vectorize output matches what the operator expected.
5. **Display of stored crop on reload.** When loading a saved version with a previously-stored crop, the displayed rectangle on the source preview must read the same units it was saved in. If saved crops are stored cache-scale (the bug), reading them back as full-res scale would draw a giant overflow. Inspect the storage format; if needed, scale on reload too. Document the choice.

## Constraints

- **No new third-party deps.**
- **No backend changes.** The fix is one-sided — frontend's job to send correct units.
- **No new state shape.** `adjustments.crop` keeps its current type.
- **No regression on the typed-input path.** Both the typed inputs and the draggable overlay must produce identical wire-format crops.
- **Don't change the units the user sees on screen.** The typed inputs and overlay both display cache-pixel space (matches what the user drew); only the wire format changes.

## Geometry / algorithms

```ts
export interface CropRect {
  x: number; y: number; w: number; h: number;
}

export function cacheToFullRes(crop: CropRect, cacheScale: number): CropRect {
  if (crop.w === 0 || crop.h === 0) return { x: 0, y: 0, w: 0, h: 0 };
  return {
    x: Math.round(crop.x * cacheScale),
    y: Math.round(crop.y * cacheScale),
    w: Math.round(crop.w * cacheScale),
    h: Math.round(crop.h * cacheScale),
  };
}
```

`cacheScale = source.original.width / source.adjustedBuffer.width` (always ≥ 1.0; equals 1.0 when the source was already ≤1024 px).

## Tests

Add to `cropCoords.test.ts`:

- `cacheToFullRes({x:10, y:20, w:30, h:40}, 1.0)` → `{x:10, y:20, w:30, h:40}`.
- `cacheToFullRes({x:10, y:20, w:30, h:40}, 2.0)` → `{x:20, y:40, w:60, h:80}`.
- `cacheToFullRes({x:5, y:5, w:5, h:5}, 1.7)` → all components = `Math.round(5*1.7) = 9`.
- `cacheToFullRes({x:0, y:0, w:0, h:0}, 2.0)` → all zeros.

Manual smoke test on a 2048×1536 phone photo:
1. Upload the photo; vectorize panel opens; cache scale is 2.0.
2. Drag a crop rectangle around the top-right quadrant of the source preview.
3. Submit; observe the backend-rendered binarized preview reflects the same top-right quadrant — pre-fix it would show only the top-right 1/4 of the cache-buffer region (effectively the top-right 1/8 of the original).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )       # hard-gate
```

## Workflow

1. Add `cropCoords.ts` + tests first; verify all four cases pass.
2. Wire into `VectorizePanel.tsx`'s submit path. Run vitest; all green.
3. Manual smoke on a >1024 px source.
4. Investigate stored-crop reload behavior. If saved crops on existing projects need scaling on read too, document and implement.
5. Run all four pre-merge checks.
6. Open PR titled "Fix crop coords: scale cache → full-res before submit (Tier 3 #36)".
7. **Move spec** from active/ to done/.

## Report back

Under 250 words. Include PR URL, implementation summary, the chosen reload strategy (scale or leave), file-size deltas, CI state, manual smoke results on a >1024 px source, follow-ups (the broader pre-vectorize asset-management story; the cache-vs-original-vs-display three-space issue is a recurring trap).
