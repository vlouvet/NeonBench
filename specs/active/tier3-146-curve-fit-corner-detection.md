# Tier 3 #146 — The curve fit rounds 90° corners by ~3.6 mm

> **Status:** active · drafted 2026-09-02 · branch `task/3-curve-corner-detection`
> · follow-up from Tier 2 #133

## Goal

Tier 2 #133 fits centripetal Catmull-Rom cubics through the traced centerline
and removed every tangent break (368 → 0 on `open_neon.png`). That is right for
a script and wrong at a genuine corner: **a measured 90° corner rounds by about
3.6 mm**, because an interpolating spline passes through every sample but cannot
hold a tangent discontinuity.

**Done** means a corner that the artwork actually contains survives the smooth
rendering as a corner.

## The wrong fix is the obvious one — do not change α

`CatmullRomAlpha = 0.5` (`internal/vectorize/curvefit.go:19`) is centripetal, and
#133 pinned it against the uniform form with a test measuring 0.190 mm deviation
versus 1.768 mm. α is the visible knob, so it is what someone will reach for.
**It cannot fix this.** No value of α holds a tangent break: α controls knot
spacing, and the parameterisation is continuous whatever you set it to. Lowering
it toward 0 reintroduces the cusp overshoot at tight turns — trading a rounded
corner for a wrong curve everywhere else.

`fitCurveAlpha` is already parameterised on α (`curvefit.go:74`), which makes the
wrong fix a one-character change. Say so in a comment where someone would try it.

## The right shape

**Segment the polyline at corner vertices and fit each span independently.** The
join between two spans is then a real tangent break, because it is two separate
curves meeting, not one curve bending. This preserves #133's guarantee inside a
span and restores corners between them.

The design question this row exists to answer: **what counts as a corner?** A
turn-angle threshold is the obvious candidate and it interacts with the tracer —
too low and every vectorization wobble becomes a corner, which puts the faceting
straight back; too high and a real corner rounds. The threshold must be
justified against measurements on real traced artwork, not chosen by eye.

Related and deliberately separate: `checkSharpBendAngles` in the validator has
its own turn-angle threshold for a different purpose. Do not couple to it — Tier
1 #142 exists precisely because one rule's knob was steering another's.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-curve-corner-detection origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/vectorize/curvefit.go` — corner detection and span-wise fitting.
- `internal/vectorize/curvefit_test.go` — extend; do not weaken #133's tests.

**Don't touch:**

- `CatmullRomAlpha`, or the α test. Both are load-bearing.
- `EmitSVG`, `res.SVG`, `Polylines`, or `smoothing_mm`. #133's separation is the
  whole reason curves are safe: **the curve output is a picture and the polyline
  is the fabrication source of truth**, and `handlers_vectorize.go:181` feeds the
  polyline SVG into `generateDesignDoc`. Corners must not reach the design doc
  through this row.
- `internal/designdoc` / `segment_types`. Still not an arc feature.

## Tests

- **A known 90° corner survives**: measure the deviation at the corner and
  assert it is far below the current ~3.6 mm. Record the actual number.
- **A smooth curve is unchanged** — the corner detector must not fire on a
  script. Assert #133's tangent-break count on `open_neon.png` does not regress.
- **Threshold sensitivity is measured, not assumed**: a small sweep showing
  where the detector starts firing on tracer noise, with the chosen value and
  the margin either side stated in a comment.
- **The polyline output is byte-identical** with and without this change. #133
  pinned that with a two-way comparison and watched it fail; keep it passing.

## Report back

PR URL, the corner deviation before and after, the threshold you chose and the
sweep that justifies it, and confirmation that the fabrication polyline is
untouched.
