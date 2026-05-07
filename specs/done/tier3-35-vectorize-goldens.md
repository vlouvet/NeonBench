# Tier 3 #35 — Sample bitmaps + golden vectorized outputs

> **Status:** active · started 2026-05-07 · branch `task/35-vectorize-goldens`

## Goal

`internal/vectorize/integration_test.go` exercises the pipeline end-to-end against `testdata/open_neon.png` — a single fixture. There's no regression coverage for:

- Different glyph styles (block letters, script, serif, edge-only stroke art).
- Edge cases (very thin strokes, very thick fills, near-touching strokes that should NOT merge, broken strokes that SHOULD merge after smoothing).
- Threshold-sensitivity (an image that should produce identical polylines for any threshold in [120, 180], proving the pipeline is robust to lighting variation).

This task adds 4–6 new sample bitmaps under `internal/vectorize/testdata/`, each paired with a golden `.svg` (or a polyline-list `.json` golden) produced by the current pipeline at a fixed threshold + smoothing setting. A new test asserts each fixture produces output matching its golden within tolerance.

"Done" means: a small but representative corpus of bitmap fixtures lives in `testdata/`; each has a captured-once golden output; a new test (`TestVectorizeGoldens`) iterates the corpus and compares outputs; a CI run that drifts the pipeline produces a clean diff so reviewers can decide whether to update the golden or fix the regression.

## Branch + setup

```sh
git fetch origin
git checkout -b task/35-vectorize-goldens origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/vectorize/integration_test.go` — add `TestVectorizeGoldens` that loops over `testdata/goldens/*.png` and compares each pipeline output to its sibling `.golden.json`.
- `internal/vectorize/testdata/.gitignore` — make sure golden files are checked in (no broad `*` exclusion).

**New:**

- `internal/vectorize/testdata/goldens/` — directory with 4–6 small PNG fixtures + their `.golden.json` companions.
- `scripts/regen-vectorize-goldens.go` (or a small `_test.go` helper with a `-update` flag) — re-emits goldens when the pipeline changes intentionally.

**Don't touch:**

- `internal/vectorize/*.go` (the pipeline itself) — this is regression coverage, not a refactor.
- Frontend.

## Deliverables

### Fixture corpus

4–6 hand-picked PNGs under `internal/vectorize/testdata/goldens/`. Each ≤ 100 KB so the repo doesn't bloat. Suggested set:

1. **`block_neon.png`** — bold block letters ("OPEN" in a heavy display face). Tests stroke extraction on thick fills.
2. **`script_neon.png`** — connected script. Tests centerline extraction on continuous curves.
3. **`thin_serif.png`** — thin serifs ("EAT" in Garamond-ish). Tests minimum-stroke-width handling.
4. **`broken_strokes.png`** — letters with deliberate 1–2 px gaps. Tests `min_spur_mm` / smoothing rejoining short segments.
5. **`near_touching.png`** — two letters almost touching but not. Tests the pipeline's separation behavior.
6. **`edge_case_corners.png`** — sharp 90° corners and 135° angles. Tests corner detection.

Each fixture is a hand-drawn PNG (or grabbed from the existing demo seed) — no external dependencies, no licensing surprises. Document each fixture's intent in a `README.md` inside `goldens/` (one paragraph per fixture).

### Golden format

`<fixture>.golden.json`:

```json
{
  "threshold": 128,
  "smoothing_mm": 0.4,
  "min_spur_mm": 1.0,
  "polylines": [
    { "points": [[x0,y0],[x1,y1],...], "closed": false },
    ...
  ],
  "total_length_mm": 1234.5,
  "run_count": 7
}
```

Capture the threshold + smoothing + min_spur once when the golden was generated so the test reproduces those exact inputs.

### Test logic

For each fixture:

1. Load the PNG.
2. Run the pipeline with the parameters captured in the golden.
3. Compare:
   - `run_count` exact match.
   - `total_length_mm` within 0.5% of golden.
   - For each polyline, point count within ±1 of golden, each point within 0.1 mm of golden.

Report mismatches with file + index + delta so a reviewer can eyeball the regression.

### Update flow

When the pipeline changes intentionally (e.g. a new smoothing improvement), regenerate goldens via:

```sh
go test ./internal/vectorize -run TestVectorizeGoldens -update
```

The `-update` flag (read via `flag.Bool`) re-emits each fixture's golden file. Manually inspect the diff before committing.

## Constraints

- **No new third-party deps.**
- **Fixtures must be small.** ≤ 100 KB each, ≤ 256×256 px is fine; goldens shouldn't be the reason `go test` slows down.
- **Tolerances are documented.** A test that fails on every minor floating-point change is noise; one with a 0.5% length tolerance + 0.1 mm point tolerance + ±1 vertex count tolerance is informative.
- **Goldens are checked in.** Don't compute them on the fly — that defeats the regression point.
- **Public-domain or self-drawn fixtures only.** No third-party copyrighted glyph sources.

## Geometry / algorithms

None — pure test infrastructure.

## Tests

The test IS the deliverable. Add no other tests.

## Pre-merge checks

```sh
./scripts/test.sh                # the new TestVectorizeGoldens runs as part of go test
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual: `go test ./internal/vectorize -run TestVectorizeGoldens -v` — should show one line per fixture, all passing.

## Workflow

1. Hand-draw / curate the 4–6 PNG fixtures. Land them with a brief `README.md`.
2. Generate goldens with a temporary harness (the `-update` flag implementation comes next).
3. Add `TestVectorizeGoldens` that compares fixture output to golden.
4. Add `-update` flag for golden regeneration; commit the script alongside.
5. Pre-merge + smoke.
6. PR titled "Vectorize golden fixtures (Tier 3 #35)".
7. **Move this spec** to `specs/done/`.

## Report back

Under 200 words. Include: PR URL, fixture corpus chosen + license provenance, tolerance numbers landed (length / point / vertex-count), CI state, follow-ups (parametric fixtures across threshold ranges, performance benchmarks alongside correctness).
