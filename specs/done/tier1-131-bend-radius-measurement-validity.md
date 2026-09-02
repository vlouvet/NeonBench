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
