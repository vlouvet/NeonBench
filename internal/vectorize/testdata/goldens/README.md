# Vectorize golden fixtures

Regression coverage for the centerline-extraction pipeline. Each PNG here is
a hand-drawn synthetic fixture (geometric primitives, not glyph faces — so
no font licensing surprises) paired with a `.golden.json` capture of the
pipeline's output at known parameters.

`TestVectorizeGoldens` (in `internal/vectorize/integration_test.go`) loads
each PNG, runs `vectorize.VectorizeRaster` with the params recorded in the
golden, and compares output to the golden within tolerance. A pipeline
change that drifts any fixture's output produces a clean per-fixture diff
so reviewers can decide: regression to fix, or intentional improvement to
re-bless via `-update`.

Regenerating after intentional pipeline changes:

```sh
# Just refresh the goldens (PNGs unchanged):
go test ./internal/vectorize -run TestVectorizeGoldens -update

# Redraw the PNG fixtures themselves AND refresh goldens:
go run scripts/regen-vectorize-goldens.go
```

Always inspect the diff before committing — small floating-point drift is
expected; large topology changes (run-count flips, total-length deltas
above a few percent) want explanation in the PR body.

## Fixture catalog

- **`block_letter_i.png`** — heavy block "I" with serifs (vertical bar
  flanked by top + bottom horizontal serifs). Tests centerline extraction
  on solid filled regions; expected to emit ~5 polylines (one per stroke
  axis) rather than an outline pair.

- **`thin_l.png`** — two 3-px-wide strokes meeting at a 90° corner. Tests
  minimum-stroke-width handling and corner pinning. Expected to emit a
  single polyline with three vertices (start, corner, end).

- **`broken_horizontal.png`** — horizontal stroke split by a deliberate
  2-px gap. Tests how the pipeline treats sub-`min_spur` discontinuities;
  the golden captures whichever choice the current pipeline makes (split
  vs. bridge), so a silent flip in that behaviour shows up as a diff.

- **`near_touching_bars.png`** — two parallel vertical bars 4 px apart.
  Tests that the pipeline keeps them as separate centerlines and doesn't
  merge across the small gap.

- **`square_corners.png`** — a hollow square (4 straight edges, four 90°
  corners). Tests corner detection and closed-polyline emission. Expected
  to emit a single closed polyline.

- **`curve_u.png`** — U-shape: two vertical stems joined by a bottom
  semicircular arc. Tests centerline extraction on continuous curves and
  smooth-curve sampling density.

## Provenance + licensing

All fixtures are generated programmatically from rectangles and arcs by
`scripts/regen-vectorize-goldens.go` — pure Go stdlib `image/png`, no
external assets, no third-party fonts, no licensed clip-art. Re-running
the script bit-for-bit reproduces the PNGs because the drawing routines
are deterministic and PNG encoding pins compression level.
