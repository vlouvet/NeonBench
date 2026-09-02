# Tier 1 #131 — `min_bend_radius` is measuring the wrong thing

> **Status:** active · drafted 2026-09-02 · branch `task/1-bend-radius-validity`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) B1

## Goal

The `min_bend_radius` error count does not respond to the tube diameter and does
respond strongly to a vectorization knob. Two sweeps on the Chachi's job:

| held | swept | result |
|---|---|---|
| smoothing 6 mm | tube ø **8 / 10 / 12 / 15 mm** | **41 / 40 / 40 / 41** errors |
| tube ø 15 mm | `smoothing_mm` **0.5 → 30 mm** | **86 → 23** errors |

The limit nearly doubles across the first row and the count does not move. That
is backwards for a rule whose entire subject is "can this glass be bent to this
radius", and it means the number tracks how the raster was prepared rather than
what will be bent.

**Done** means the count moves with the tube spec and is stable under
input-preparation changes that do not change the drawn shape — or, if that turns
out to be unachievable, the rule says what it actually measures and the report
stops presenting it as a bend-radius verdict.

This is Tier 1 because the number reaches customers. Tier 3 #126 puts the
validation summary on a sheet somebody signs, and today that figure is not
quotable.

## This is an investigation, not a known fix — read this first

**Do not start by writing a patch.** The gaps doc offers a *hypothesis*: the
validator resamples the polyline and reads circumradius at whatever kink
survives smoothing, so it may be measuring vectorization noise rather than
design geometry. That is a lead, and it is consistent with both sweeps, but
nobody has confirmed it.

Related known behaviour that may or may not be the same thing: the validator
resamples at ~5 mm and reads circumradius at the kink, which is why a 16-gon's
corners flag min bend radius while a 96-point circle does not (recorded during
the Tier 3 #48 work). A polyline dense enough to be smooth and a polyline dense
enough to be *noisy* may be indistinguishable to that measurement.

The first deliverable is therefore a **written finding**, not code.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-bend-radius-validity origin/main
( cd web && npm install && npm run build )
```

## Deliverables

1. **A reproduction under test, in Go.** A table test in `internal/validate/`
   that builds polylines directly (no raster, no vectorize) and pins the
   observed behaviour: same drawn shape resampled at several vertex densities,
   asserted against the current issue count. This isolates "density" from
   "shape" — the sweeps above could not, because `smoothing_mm` changes both.
2. **A written finding** in the spec's own "Findings" section (append to this
   file; it moves to `specs/done/` with the PR): what the rule measures today,
   at which line, and whether the hypothesis held. State it plainly if it did
   not.
3. **Then, and only then, a fix** — whose shape depends on (2). Three
   possibilities are named below so the choice is a decision rather than a
   default.
4. **A regression test that would have caught this**: error count must be a
   function of the tube spec. Sweeping `min_bend_radius_mm` across a fixed doc
   must change the count monotonically; sweeping vertex density on a fixed shape
   must not.

## Candidate fixes — pick one, in the finding, with reasons

- **Measure at design scale, not sample scale.** Fit a radius over a window
  proportional to the tube diameter rather than at the raw kink. Closest to what
  a bender does: glass is bent on a former of known radius, over an arc of real
  length, not at a mathematical point.
- **Measure the arc, not the vertices.** `segment_types` arcs already carry a
  derived radius, and `flatRunPoints` exists. Where a run has explicit arc
  segments the answer is exact and needs no estimation at all.
- **Keep the measurement, change the claim.** If the current figure is really
  "polyline angularity", rename the rule and drop it to a warning. This is a
  legitimate outcome and it is better than a wrong number with the right name.

## Constraints

- **Go and TS geometry are mirrored and must be pinned together** —
  `internal/designdoc/arc.go` ↔ `web/src/lib/arcGeom.ts`. If the measurement
  changes and the editor draws a bend indicator from it, both move or neither
  does.
- **The validator sees SVG, not the doc** (`ToSVG` → `ValidateSVG`), and its
  parser does not implement `A`: elliptical arcs are approximated as a straight
  line and warned about. Any fix reasoning about arcs must confirm which
  representation actually reaches the rule.
- **Do not silently change the count on existing designs without saying so.**
  Every stored `validation_report` was computed under the old rule. If the fix
  changes numbers, the PR body states the before/after on at least one real
  fixture.
- No new third-party dependencies.

## Tests

- The density-vs-shape table test from deliverable (1), left in place as the
  regression guard.
- Monotonicity: for a fixed doc, raising `min_bend_radius_mm` may only increase
  (or hold) the error count. This is the assertion whose absence let the
  flat 41/40/40/41 row exist.
- A run built from explicit arc segments of known radius: an arc comfortably
  above the limit must produce zero errors, and one below it exactly one.
- Do not assert against a stored golden count — that is what would freeze the
  current wrong answer in place.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Reproduce under test before touching the rule.
2. Append the finding to this file.
3. Implement the chosen fix; if the finding says "no code change, rename and
   re-severity", that is a complete outcome.
4. **Move this spec** to `specs/done/` in the final commit.

## Report back

Include the finding verbatim, the before/after counts on a real fixture, and
whether Tier 3 #126 can now quote the number.

---

## Findings

> Written 2026-09-02. Every number below is from a probe run in-repo; the
> fixture ones are the real `internal/vectorize/testdata/open_neon.png` raster
> going through the real vectorizer and `ValidateSVG`.

### What the rule measured, and where

`checkBendRadius` (`internal/validate/rules.go`) resampled each polyline and
read a **3-point circumradius at consecutive samples**. Two of its parameters
were derived from the very threshold it was comparing against:

| line | quantity | old value |
|---|---|---|
| `rules.go:166` | resample step | `max(0.5, min(limit/4, 5))` |
| `rules.go:52` | issue-cluster radius | `max(1.5 × limit, 5)` |

That self-reference is the defect. A stricter tube spec **coarsened the
measurement** — a 3-point circumradius at a corner is `≈ 0.75 × step`, so it
reports the sampling rather than the shape — and **widened the cluster
radius**, merging physically distinct bends into one issue. Both effects cancel
the stricter limit, and past a point they overwhelm it.

Measured on the OPEN raster fixture, ø12 tube, smoothing 6 mm, sweeping
`min_bend_radius_mm` from 10 mm to 60 mm — one fixed doc, a 6× tightening:

```
limit  10   15   20   25   30   35   40   45   50   55   60
errors 14   14   14   12   10   10    9    8    6    6    6
```

**The count more than halves as the tube gets harder to bend.** It is not
merely insensitive; it is anti-monotone. The same fixture across the four
seeded tube specs gave `14 / 14 / 11 / 8` for ø8/10/12/15 — the 41/40/40/41
signature reproduced in-repo, with the falling tail visible.

And the density half, on a fixed drawn shape — a 40 mm circle, comfortably
above a 27 mm limit — sampled at different vertex counts:

```
vertices    8    12   16   24   32   48   96  360
errors      4     4    4    4    3    0    0    0
```

Same circle, same tube. The hypothesis in the gaps doc **held**: the rule was
reading vectorization density, not design geometry.

### The two leads in the dispatch brief

**Lead 1 — `runBendLimitMM` only scales by diameter for a per-*run* override —
is true as code, but it is NOT the explanation for 41/40/40/41.** The Chachi's
sweep switched *tube specs*, and `min_bend_radius_mm` is a `NOT NULL` column
seeded at 18/22/27/34 mm for ø8/10/12/15 (`migrations/0002`, retightened in
`0004`), with the API refusing anything outside 1..200 or below the diameter.
So the limit did move — it nearly doubled, exactly as the gaps doc says — and
the count still did not follow. Lead 1 would only bite if someone edited
`diameter_mm` alone on one spec.

Lead 1 does have a real sibling, and it is worse: `checkBendRadius`
early-returned on `limits.MinBendRadiusMM <= 0`, so the entire Tier 3 #31
wall-thinning derivation inside `runBendLimitMM` was **unreachable through this
rule**. Already logged as a Tier 3 follow-up at
`internal/server/integration_test.go:2955`. Fixed here (one line) and pinned.

**Lead 2 — the resample step is self-referential — is real, and is half the
mechanism, but its magnitude across the actual sweep is small.** Probed
directly, minimum measured circumradius against resample step:

```
step        0.5    1.0    2.0    4.5    5.0
true r=20   19.73  19.88  19.96  19.99  19.99   (step barely matters)
90° corner   0.35   0.71   1.41   3.75   3.54   (r ≈ 0.75 × step)
```

The step term only moves the answer *at corners* — and the step is clamped at
5 mm, so every limit at or above 20 mm sits on the clamp. Across the four
seeded specs it moves 4.5 → 5.0 → 5.0 → 5.0. It cannot flatten a doubling
limit on its own.

**The dominant term was the one neither lead named: the cluster radius,
`1.5 × limit`.** Six identical 12 mm bends spaced 40 mm apart — letterform
scale — under the old rule:

```
ø8  limit 18  clusterR 27.0   raw 24  reported 6   (correct)
ø10 limit 22  clusterR 33.0   raw 24  reported 6   (correct)
ø12 limit 27  clusterR 40.5   raw 24  reported 3   ← radius crossed the spacing
ø15 limit 34  clusterR 51.0   raw 24  reported 3
```

The raw flag count never moved; the *reported* count halved, purely because the
cluster radius crossed the 40 mm bend spacing. Tightening the tube spec was
merging real bends into each other.

### Two more defects found on the way

- **`isDoubleBackHairpin` exempted small closed loops.** Its three conditions —
  near-antipodal samples, close together, anti-parallel tangents — are all
  satisfied by an "o" bowl a few tube diameters across. On ø12 tube, closed
  loops of radius 20 mm and 24 mm were both excused as "structural double-back"
  and reported **zero** errors against a 40 mm limit. A bowl is exactly what
  this rule exists to catch.
- **A 14 % systematic bias in the replacement estimator**, caught by probe
  before it shipped: summing arc length over `2·half` segments while summing
  turn over `2·half − 1` transitions reads a true 25 mm circle as 28.55 mm —
  enough to clear a 27 mm limit. `TestRevalidateAfterTubeSpecSwap` caught it
  independently, which is a point in that test's favour.

### Verdict on the rule's name

**Keep the name and the severity.** The old figure was not "polyline
angularity" mislabelled — it was a real bend-radius question asked at the wrong
scale, with the answer allowed to depend on the question. Measured at design
scale it is a bend radius again, so no rename is needed and Tier 3 #126 can put
the number on a sheet.

### The fix: measure over the heat zone, segment before thresholding

Candidate (a) from the spec, "measure at design scale", with the window taken
from a source already in the repo. `docs/neon-rules/bend-radius.md` transcribes
Strattman NT Fig. 7.20: **the length of glass heated for a right-angle bend is
2 × tube ø**, and the same note derives the radius implied by that heat zone as
`arc ÷ turn = 2D/(π/2) ≈ 1.27·D`. That identity *is* the estimator:

> **bend radius = arc length of one heat zone ÷ net turn of the tangent across it**

It is exact on a true arc at any sampling; it gives the same answer for a hard
corner and a smooth curve that turn through the same angle over the same length
of glass — which is also true of the glass; and sub-millimetre tracer noise
contributes turns that cancel. Nothing in it consults `min_bend_radius_mm`.

Candidate (b), "measure the arc", was checked and rejected on availability.
The spec's constraint is slightly off here: doc arcs do **not** reach the
validator as SVG `A` commands. `emitPath` (`internal/designdoc/convert.go:316`)
renders every arc segment as cubic Béziers, which `flattenCubic` then flattens
to a polyline. The validator never sees an exact radius either way, so there is
no arc to read.

Three supporting changes fall out of it:

1. **Segment into bends *before* applying the limit.** Grouping on "is this
   sample failing" makes the grouping limit-dependent, and neighbouring
   failures then merge as the limit rises — the original defect in a new coat.
   Probed on OPEN under failure-grouping: `0, 3, 4, 6, 6, 9, 8, 8, 6, 6, 6`.
   Segmenting on curvature first — anything tighter than a 150 mm
   ribbon-burner sweep, Miller p. 118 via the same doc — makes the bend set a
   property of the drawing, so the count can only rise with the limit.
2. **That sweep floor is not scaled by tube diameter,** deliberately. How a
   design divides into bends belongs to the drawing; two shops quoting the same
   artwork in ø8 and ø15 must see the same bends and differ only in the verdict
   on each. A ø-scaled floor was tried and inverted the headline result.
3. **The double-back exemption is judged per bend, not per sample,** and gains
   a flank-straightness test so a uniformly-curving bowl no longer passes for a
   U-turn.

### Before / after on a real fixture

Sweeping `min_bend_radius_mm` at ø12, smoothing 6 mm (one fixed doc):

```
limit   10  15  20  25  30  35  40  45  50  55  60
before  14  14  14  12  10  10   9   8   6   6   6     ← falls
after    0   2   5   5   7   7   7   7   7   7   7     ← monotone
```

Sweeping `smoothing_mm` at ø12 / limit 27 — the knob that should do nothing:

```
smoothing  0.5   1    2    4    6   10   20   30
before      12   12   12   12   11   10    9    9
after        5    5    6    5    6    6   11   11
```

Flat across the range that simplifies the trace; it moves only at 20–30 mm,
where RDP is redrawing the letterform and the count *should* move.

On a synthetic run of eight 90° bends of known radius 8..36 mm joined by
straight legs, the four seeded specs now give exactly the right answer —
`ø8/18mm → 3`, `ø10/22mm → 4`, `ø12/27mm → 5`, `ø15/34mm → 7`.

### Known limits — say these out loud rather than discover them later

- **A design of hard corners is genuinely flat across tube specs.** A square
  corner measures `1.27·D` against a limit of `2.25·D`; both scale with
  diameter, so the verdict is diameter-independent and every corner fails in
  every tube. Part of the original 41/40/40/41 was correct for this reason, and
  block-letter centerlines like the OPEN fixture are mostly this.
- **The OPEN fixture's tube-spec sweep still falls** (`9, 7, 6, 5` for
  ø8/10/12/15) because the double-back exemption's window is 3–4 tube
  diameters, so a wider tube reclassifies more U-turns as intentional
  double-backs. That is a modelling decision rather than an artifact, but it is
  a second reason the count is not simply increasing in tube size. Worth a
  Tier 3 row to decide whether the DB window should be design-scaled too.
- **The rule can no longer distinguish "very tight 90°" from "tight 90°."** Any
  90° turn shorter than one heat zone measures `1.27·D`, because that is what
  the bender will achieve heating 2·D of glass. Intended semantics, not a
  regression — but the reported radius is a *formable* radius, not the drawn
  one.
- **Noise immunity roughly doubled; it did not become absolute.** A straight
  line carrying staircase noise stays clean to ~0.5 mm amplitude (was ~0.4 mm)
  and flags above it. `smoothing_mm` is still the right knob for genuinely
  noisy input.
- **Input coarser than the measurement step is a different shape.** Source
  vertex spacing beyond ~D/4 (3.4 mm on ø12) can move the count; the density
  invariant is asserted over 0.25–3 mm.
- **Every stored `validation_report` predates this change** and its
  `min_bend_radius` counts were computed under the old rule. Nothing rewrites
  them; they refresh on the next revalidate.
