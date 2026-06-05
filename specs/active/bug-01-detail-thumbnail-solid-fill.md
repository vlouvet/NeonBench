# Bug #01 — Project-detail design thumbnail renders open tube runs as a solid black blob

> **Status:** active · drafted 2026-06-04 · found via Playwright screen-walk (screen-02 ProjectDetail vs screen-03 Editor) · branch (when dispatched) `task/bug-01-thumbnail-fill`

## Goal

On the **project detail page**, the "Design vN" thumbnail renders the design's geometry as a **solid black filled shape** instead of thin tube strokes. Screenshot evidence: for project 8 / v15 (a simple line + arc, 2 runs), the detail-page thumbnail is a black blob with a thin tail, while the **editor canvas draws the identical geometry correctly** as thin open strokes. The 3D preview also renders it correctly as glowing tubes. So the bug is isolated to the **stored SVG thumbnail**, not the underlying geometry.

Root cause: [`internal/designdoc/convert.go:278`](../../internal/designdoc/convert.go#L278) emits every non-blockout path with `fill="black" fill-rule="evenodd" stroke="none"`. An **open** polyline (the normal case for a tube run) filled with `evenodd` paints the enclosed area solid. The blockout branch one line up ([:276](../../internal/designdoc/convert.go#L276)) already does the right thing: `fill="none" stroke="black" stroke-width="0.6" …`.

"Done" means the detail-page thumbnail shows tube runs as thin strokes that visually match the editor canvas.

## The nuance — do NOT blanket-replace `fill="black"` with stroke

`emitPath()` ([convert.go:253](../../internal/designdoc/convert.go#L253)) takes a `closed bool` and a `isChannelLetterFace bool`. Two distinct cases share the buggy branch:

1. **Open tube runs** (`closed == false`) — the overwhelming majority. These must be **stroked, not filled**. This is the bug.
2. **Closed channel-letter faces** (`closed == true`, often `isChannelLetterFace == true`) — a filled silhouette here may be **intentional** (solid face for a channel-letter blank). Changing these is a product decision, not an obvious bug.

**Decision required before implementing** (ask the user / check `docs/neon-rules/`):
- **Option A (minimal, safe):** only change the `!closed` case to stroke; leave closed paths filled as-is. Fixes the observed blob for all open runs without touching channel-letter face rendering.
- **Option B (uniform):** stroke everything (open and closed), matching the editor's all-stroke model; closed faces become outlines. Cleaner/consistent but changes channel-letter face appearance — verify against `docs/neon-rules/` and the print PDF.

Recommend **Option A** unless the user confirms channel-letter faces should be outlines.

## Stored-SVG implication (important)

`svg_data` is generated at design-save time and stored in the DB (rendered on the detail page via `dangerouslySetInnerHTML` in [`web/src/pages/ProjectDetail.tsx`](../../web/src/pages/ProjectDetail.tsx) ~line 603). **A code fix does not retroactively fix existing versions** — project 8's 15 stored versions keep their bad SVG until re-saved. Decide:
- Accept that only newly-saved versions render correctly (document it), **or**
- Add a one-shot regeneration (re-emit `svg_data` for existing rows on read, or a migration/back-fill). Regeneration-on-read is lowest-risk; a data migration that rewrites `svg_data` needs user sign-off per CLAUDE.md (touches stored data).

## Strict file scope

**Modify:**
- `internal/designdoc/convert.go` — `emitPath()` only. Branch the non-blockout case on `closed` (Option A) so open runs emit `fill="none" stroke="black" stroke-width="…"` (match the blockout stroke width / the live-stroke convention). ⚠️ This file is on the file-coupling hazard list — coordinate; check no open `task/*` branch is also editing it.

**Possibly modify (only if regeneration is chosen):**
- The detail-page read path or a migration under `internal/storage/migrations/` — **requires user approval** (stored data).

**Don't touch:**
- `EditorCanvas.tsx` — its rendering is the correct reference, already `fill="none"`.
- The blockout branch ([:276](../../internal/designdoc/convert.go#L276)) — already correct.
- The 3D preview pipeline — renders correctly from geometry, not from `svg_data`.

## Stroke width

Pick a stroke width that reads at thumbnail scale. The blockout uses `0.6` (mm units in the SVG coordinate space). Tube runs are physically Ø8–15mm; consider keying the stroke to the tube diameter (`diameterMM`, already available in `emitPath`) so the thumbnail roughly conveys tube thickness, or use a fixed readable width. Confirm visually.

## Tests

- **Go unit test** in `internal/designdoc/` (there is likely an existing `convert_test.go`): assert that for an **open** run the emitted `<path>` contains `fill="none"` and a `stroke=` (not `fill="black"`). If Option A, add a companion assertion that a **closed** face still fills (locks in the intended distinction).
- Regression: blockout paths still emit the dashed stroke unchanged.

## Manual smoke test (Playwright or browser)

1. App on `:7373`. Create/save a NEW design version with a simple open run (pen tool, 2–3 points).
2. Go to the project detail page → the "Design vN" thumbnail must show a **thin stroke**, not a filled blob.
3. Compare side-by-side with the editor canvas — strokes should match.
4. If a channel-letter face design exists, confirm its rendering matches the chosen option.
5. Print PDF still renders correctly (the PDF path is separate, but verify it didn't regress if it shares any emit code).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Confirm Option A vs B and the regeneration decision with the user.
2. Implement in `emitPath()`; add the Go unit test.
3. Manual smoke test above.
4. Move this spec to `specs/done/` in the implementation commit.
5. PR title: `Fix detail-page thumbnail: stroke open tube runs instead of filling (Bug #01)`.

## Report back

Under 150 words: PR URL, which option chosen and why, whether existing versions were regenerated or left to re-save, test names added, screenshot of a corrected thumbnail, pre-merge state.
