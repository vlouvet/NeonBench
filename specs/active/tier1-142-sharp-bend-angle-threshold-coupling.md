# Tier 1 #142 — `sharp_bend_angle` is measured with the bend-radius rule's knobs

> **Status:** active · drafted 2026-09-02 · branch `task/1-sharp-bend-coupling`
> · follow-up from Tier 1 #131, found while fixing it

## Goal

Tier 1 #131 removed two threshold-derived parameters from `checkBendRadius`.
`checkSharpBendAngles` still has both, and takes them from **a different rule's
limit**:

| line | quantity | value |
|---|---|---|
| `internal/validate/rules.go:1044` | resample step | `max(0.5, min(limits.MinBendRadiusMM/4, 5))` |
| `internal/validate/rules.go:1097` | issue-cluster radius | `max(limits.MinBendRadiusMM*1.5, 5)` |

This rule is thresholded on `effectiveSharpBendAngleDeg`. Its subject is the
**turn angle** at a vertex. Nothing about it is a bend radius. Yet both its
measurement granularity and its marker merging are driven by
`min_bend_radius_mm`, so **editing the tube's bend limit silently moves the
`sharp_bend_angle` count** on an unchanged design.

**Done** means `sharp_bend_angle` responds to the angle threshold and to the
drawn geometry, and not at all to `min_bend_radius_mm`.

## Why this is Tier 1

Same reason #131 was. The count reaches customers through the validation
summary, and Tier 3 #126 puts that summary on a sheet somebody signs. A figure
that moves when you change an unrelated field is not quotable.

It is arguably worse than the bug #131 fixed. There the measurement folded back
on its own threshold, which is self-referential but at least internally
consistent. Here the coupling **crosses rules**: two independent knobs, one
silently steering the other, with nothing in the UI or the report hinting at it.

## Read #131's fix first — most of the work is already designed

`specs/done/tier1-131-bend-radius-measurement-validity.md` has the full finding,
the probe numbers and the estimator that replaced the old one. Do not re-derive
it. The relevant conclusions:

- A 3-point discrete measurement at spacing `s` reports the sampling, not the
  shape — at a hard corner it returns `≈ 0.75 × s`.
- Clustering at a radius derived from the limit merges physically distinct
  features as the limit grows, and that was the **dominant** term.
- #131's replacement measures over **one heat zone = 2 × tube ø**
  (`docs/neon-rules/bend-radius.md`, Strattman NT Fig. 7.20), a length that
  comes from the glass rather than from a threshold.

The same treatment should apply here: a window taken from the tube, not from
another rule's limit. **Whether the angle rule should use the heat zone or some
other tube-derived length is the actual design question of this row** — a turn
angle is not integrated over a heat zone the way a radius is, so do not assume
the answer. State what you chose and why.

## The trap that makes this less mechanical than it looks

`isDoubleBackHairpin` consumes `stepMM` (`rules.go:509`):

```go
lookMM := math.Max(3*tubeDiameterMM, 10)
K      := int(math.Ceil(lookMM / stepMM))
if n < 2*K+1 || K < 2 { return false }
```

So the resample step feeds the hairpin detector's look-around **in samples**.
Change the step and you change `K`, which changes which vertices are exempted as
legitimate double-backs — a behaviour change in a *different* concern, reachable
from an edit that looks like it only touches sampling. `checkBendRadius` calls
the same helper. Any new step must keep `K >= 2` and must not silently move the
exemption; pin the exemption behaviour with a test **before** changing the step,
so a shift shows up as a red test rather than as a changed error count.

Related and deliberately **not** in this row: Tier 3 #143 asks whether that
3 × ø / 4 × ø window should be design-scaled at all. Leave the window alone here
and change only where the *step* comes from.

## Branch + setup

```sh
git fetch origin
git checkout -b task/1-sharp-bend-coupling origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/validate/rules.go` — `checkSharpBendAngles` only. Its step and its
  cluster radius.
- `internal/validate/` — a test file for the new behaviour, or extend
  `bendradius_test.go` if the fixtures are shared.

**Don't touch:**

- `checkBendRadius` or the heat-zone estimator. #131 shipped hours before this
  row and its tests pin it; a change there is a regression, not a fix.
- `isDoubleBackHairpin`'s `3 × ø` / `4 × ø` window. That is Tier 3 #143.
- The rule id, its severity, or `effectiveSharpBendAngleDeg`. The threshold is
  correct; its *measurement* is what is wrong.

## Deliverables

1. A written finding first, as in #131: sweep `min_bend_radius_mm` over one
   fixed doc and record the `sharp_bend_angle` count before and after. Without
   that table nobody can tell whether this row achieved anything.
2. The measurement change.
3. Tests, below.

## Tests

- **The measurement is invariant to `min_bend_radius_mm`.** Same doc, two very
  different bend limits, byte-identical `sharp_bend_angle` issues. This is the
  row in one assertion.
- **It still responds to the angle threshold**, and to the drawn geometry — a
  negative control, or the fix trivially passes by returning nothing.
- **Density invariance**: the same shape sampled at several source spacings
  yields the same count.
- **The double-back exemption did not move**: pin it before the step change,
  and keep the assertion afterwards.
- **No golden counts.** #131 deliberately asserts no frozen numbers, because
  that freezes the current answer rather than the property. Follow it.

## Report back

PR URL, the before/after sweep table, what tube-derived window you chose for the
angle measurement and why, and whether the double-back exemption moved.
