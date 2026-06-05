# Bug #07 — Default Add-text geometry fails validation (faceted Hershey glyphs trip min-bend-radius)

> **Status:** active · drafted 2026-06-04 · found via Playwright end-to-end workflow test (create "OPEN" → red → preview) · branch (when dispatched) `task/bug-07-smooth-hershey-glyphs`

## Goal

Typing text with the **Add-text** tool using all defaults produces an **invalid** design. Reproduced end-to-end: new project (default 12mm clear tube) → Add-text "OPEN" (default Roman Simplex font, default 100mm cap height) → **11 errors + 1 warning**. A user who changes nothing cannot get a valid sign, and there is no in-app operation that fixes it.

"Done" means inserting default text at a reasonable size yields a sign that **passes validation** (0 errors), so the common "type OPEN, send to bender" path works out of the box.

## Reproduction (Playwright-verified)

1. New project, accept defaults (12mm clear — Ø12mm, **min bend 27mm**).
2. Editor → **Add text** → type `OPEN` → keep defaults (Roman Simplex, cap height 100mm, line height 1.2) → **Insert**.
3. Result: 10 runs, 642 × 175mm, **11 errors · 1 warning**:
   - **Bend radius — 10 errors.** Reported radii 12.3–24.0mm, all below the 27.0mm tube minimum.
   - **Tube spacing — 1 error.** "tubes 8.8mm apart, below minimum spacing 14.0mm" (14 nearby).
   - **Electrode lead-in — 1 warning** — fires even though **0 electrodes are placed** (see sub-issue below).
4. The 3D preview of the same design looks smooth and correct (it Catmull-Rom-smooths the path) — so the problem is invisible in preview but blocks print.

## Root cause (code-verified)

The default Hershey font stores glyphs as **coarse integer polylines, not curves** — the capital `O` is a **21-point polygon** ([web/src/lib/hershey/rowmans.json](../../web/src/lib/hershey/rowmans.json)). `hersheyTextToRuns` only scales + translates those points with **no smoothing** ([web/src/lib/hershey/text.ts:183](../../web/src/lib/hershey/text.ts#L183)). Each facet corner is a near-zero-radius bend, so the `min_bend_radius` rule ([internal/validate/geometry.go](../../internal/validate/geometry.go), surfaced via [internal/validate/svg.go](../../internal/validate/svg.go)) flags 10 of them.

Key point: **this is faceting, not letter size.** A *smooth* "O" at 100mm cap on a 12mm tube has ~35–45mm curvature radius — comfortably above the 27mm minimum. The errors come from the polygon facets, which is the same defect as the "blocky arcs" report and the standalone font issue. The 3D preview hides it because [web/src/preview/tube-geom.ts](../../web/src/preview/tube-geom.ts) already smooths the path through a `CatmullRomCurve3` — the editor, validator, and DXF/PDF do not.

## No in-app remedy exists (confirmed)

The per-run/multi-run path-ops were checked: **Simplify** (Douglas-Peucker — *reduces* points, makes facets coarser), **Reverse** (direction only), **Neonize** (offsets one stroke into two parallel tubes — *worsens* spacing). **None smooth a faceted curve.** So a user literally cannot make default text valid without hand-editing nodes.

## Fix (recommended)

**Catmull-Rom resample each glyph stroke at insertion time**, in `hersheyTextToRuns` ([text.ts](../../web/src/lib/hershey/text.ts)). Reuse the same smoothing approach the 3D preview already uses (`tube-geom.ts`) so editor/validator/print agree with preview. Denser, smoother points spread the curvature so each segment clears the min-bend radius. This should clear most/all 10 bend-radius errors and is the same fix the standalone font-smoothing item calls for — do them together.

Implementation notes / caveats:
- **Do not bridge separate strokes.** A glyph like `P` is multiple strokes; smooth each stroke independently (the existing per-stroke loop already separates them).
- **Preserve intentional corners.** Letters like `E`, `N`, `A`, `V` have sharp vertices that must stay sharp — only smooth runs of points that approximate a curve, or use a curvature/angle threshold so straight segments and true corners are left alone. (A naive Catmull-Rom through every point will round the corners of `E`/`N`.) Validate against `E` and `N` not gaining spurious bends.
- **Min-bend safety.** Don't over-smooth tiny features into geometry tighter than the tube minimum — the goal is to *raise* the worst-case bend radius above 27mm, verified by re-validation.
- **Tube-spacing error** (8.8mm) is partly letterform geometry (e.g. `P` bowl meeting its stem) and partly facets; smoothing may or may not clear it. Re-validate after smoothing and, if it persists, treat the remaining spacing error as a separate follow-up (possibly a default-cap-height or kerning tweak), not a blocker for the bend-radius fix.

Secondary mitigation (not preferred alone): raise the default cap height — facet bend radii scale with glyph size — but that changes the physical sign dimensions, so it's a worse default than smoothing.

## Sub-issue to log separately (don't fix here)

The **electrode lead-in warning fires with 0 electrodes placed** ("electrode lead-in 18.6mm below recommended minimum 24.0mm"). With no electrodes, a lead-in rule arguably shouldn't trigger. Capture as its own validator spec (e.g. `bug-08`) — investigate whether `min_lead_in` should be skipped when a run has 0 electrodes. Out of scope for the font fix.

## Strict file scope

**Modify:**
- `web/src/lib/hershey/text.ts` — add a per-stroke curve-resample step in `hersheyTextToRuns` (corner-preserving). Shares intent with the standalone Hershey-smoothing item — coordinate so they don't double-implement.

**Don't touch (without separate sign-off):**
- `internal/validate/*` — the bend-radius rule is correct; the geometry is wrong, not the rule.
- `tube-geom.ts` 3D smoothing — already correct; reuse its approach, don't change it.
- The font JSON — smoothing at insertion avoids shipping larger glyph tables.

## Tests

- **vitest** in `web/src/lib/hershey/`: insert "OPEN" at 100mm cap on a 12mm spec; assert the resulting runs' minimum bend radius is ≥ 27mm (or that no segment-junction angle implies a sub-minimum radius). Assert `E` and `N` retain their corner vertices (no spurious rounding).
- **Regression:** a smooth letter (`O`) gains points; a straight letter (`I`) is unchanged.
- Optional end-to-end: the Go validator returns 0 bend-radius errors for the smoothed "OPEN" doc.

## Manual smoke test (Playwright or browser)

1. App on :7373. New project (defaults) → Add text "OPEN" (defaults) → Insert.
2. Validation shows **0 bend-radius errors** (down from 10). Note any residual tube-spacing error.
3. `E`/`N` still look correct (sharp corners, not rounded blobs).
4. 3D preview still renders smoothly (parity with editor now).

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Implement corner-preserving resample in `hersheyTextToRuns`; add vitest.
2. Re-run the manual OPEN reproduction; confirm errors drop to 0 (or only a documented residual spacing error remains).
3. Move this spec to `specs/done/`.
4. PR title: `Smooth Hershey glyph strokes on insert so default text validates (Bug #07)`.

## Report back

Under 150 words: PR URL, before/after validation counts for default "OPEN" (was 10 bend errors), confirmation `E`/`N` corners preserved, whether the tube-spacing error remains (and if so, the follow-up), test names, pre-merge state.
