# Tier 3 #29 — Lead-in length / 90° angle validation

> **Status:** active · started 2026-05-07 · branch `task/29-leadin-90-validation`

## Goal

Two safety/manufacturability rules from `docs/neon-rules/` that the validator doesn't yet enforce:

1. **Minimum lead-in length** (todo.md:62). The straight tube section between an electrode and the first bend must be ≥ a minimum length — short lead-ins crack at the seal under handling and thermal cycling. Per Miller App I §126 and Saving Neon, the working minimum is roughly 25 mm for 12 mm tube; scales with diameter.
2. **90° angle warning** (todo.md:62). Bend angles ≥ ~85° concentrate stress and are bender-unfriendly. Warn (not error) when a vertex has an interior angle ≤ 90° unless the bend is part of a documented hairpin (existing double-back exemption applies here too).

The electrode placement model lands in PR #18 / Tier 2 work — confirmed available. The bend exemption logic is already in `checkBendRadiusClustered` (`docs/neon-rules/bend-radius.md` reference); reuse the same hairpin detection.

"Done" means: the validator emits two new issue types (`min_lead_in`, `sharp_bend_angle`); both have severity warning by default; both honor the existing double-back exemption; markers light up via Tier 3 #28 once shipped.

## Branch + setup

```sh
git fetch origin
git checkout -b task/29-leadin-90-validation origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/validate/types.go` — add `RuleMinLeadIn` and `RuleSharpBendAngle` constants; add `MinLeadInMM` and `SharpBendAngleDeg` to `Limits` (with sensible defaults derived from tube diameter).
- `internal/validate/rules.go` — implement `checkMinLeadIn(polylines, limits)` and `checkSharpBendAngles(polylines, limits)`. Plug both into the main `ValidateSVG` pass alongside existing checks.
- `internal/validate/rules_test.go` — new tests.
- `internal/storage/tube_specs.go` (and the migrations dir) — add `min_lead_in_mm` and `sharp_bend_angle_deg` columns to `tube_specs`. Both nullable; the rule reads its limit from the tube spec, falling back to a derived default when null.
- `internal/storage/migrations/0009_tube_spec_lead_in.sql` — new migration. Reversible Down.

**Don't touch:**

- `EditorCanvas.tsx` / `EditorPage.tsx` — no editor changes; markers come from #28.
- Frontend at all — these rules surface through the existing report rendering. (Optional: add the new fields to the tube-spec edit modal if the implementing agent finds it; otherwise defer.)

**New:** none.

## Deliverables

1. **`min_lead_in_mm` rule.** For each electrode position on a run:
   - Walk forward from the electrode's polyline point until the first bend (vertex with interior angle below a "this is a bend, not a straight segment" threshold — ~170°).
   - Compute the arc length traversed.
   - If less than `limits.MinLeadInMM`, emit `Issue{Rule: RuleMinLeadIn, Severity: SeverityWarning, Message: "...", XMM, YMM: <electrode position>}`.
   - Default `MinLeadInMM` when null in tube_specs: `2 * limits.DiameterMM` (rule-of-thumb ~25 mm for 12 mm tube).
2. **`sharp_bend_angle_deg` rule.** For each interior vertex:
   - Compute the interior angle from the two adjacent segments.
   - If angle ≤ `limits.SharpBendAngleDeg` (default 85°), AND the vertex is not part of an existing hairpin double-back (reuse `isDoubleBackApex` or whatever the existing helper is named), emit `Issue{Rule: RuleSharpBendAngle, ...}` at the vertex coordinate.
   - Skip closed-polyline first/last point (it's just the closing duplicate).

## Constraints

- **Severity warning, not error.** Some shop styles deliberately use sharp angles (raceway corners, frame brackets) — error severity would force fabricators to suppress legitimate designs.
- **Double-back exemption is non-negotiable.** Hairpin U-bends ARE 180° turns by design; firing both new rules on every hairpin would flood the report and bury real issues.
- **Reuse existing geometry.** `clusterIssues` is already used for spatial dedup of bend-radius issues; if you find a tight bend cluster firing both `min_bend_radius` and `sharp_bend_angle`, dedup so the user sees one marker, not three. Decide which rule "wins" per cluster (suggest: keep both if they have different messages — they're informative for different reasons).
- **No new third-party deps.**

## Geometry / algorithms

**Interior angle at vertex.** Given vectors `u = points[i-1] - points[i]` and `v = points[i+1] - points[i]`:

```
angleRad = acos((u·v) / (|u| * |v|))
angleDeg = angleRad * 180 / π
```

Clamp the dot-product input to `[-1, 1]` to defend against floating-point drift.

**Lead-in length** = sum of segment lengths from the electrode point until a vertex with `angleDeg < bendThresholdDeg` (e.g. 170°). If the run is open and no bend is found, use the full polyline arc length to the far endpoint.

## Tests

Add to `rules_test.go`:

- **`TestMinLeadInWarnsWhenTooShort`** — synthetic open polyline with electrode at point 0, first bend at point 1 only 10 mm away, MinLeadInMM=25. Expect one issue.
- **`TestMinLeadInIgnoresWhenLongEnough`** — same shape, first bend 30 mm out. Expect zero issues.
- **`TestSharpBendAngleWarnsAt89Degrees`** — synthetic L-shape with 90° corner; expect one issue at the corner.
- **`TestSharpBendAngleExemptsHairpinApex`** — synthetic hairpin (180° apex); expect zero issues at the apex.
- **`TestLimitsFallBackToDerivedDefault`** — call `ValidateSVG` with a tube spec where MinLeadInMM is 0; assert default of 2×D applies.

## Pre-merge checks

Standard four. Manual smoke:

1. Open a project; place an electrode close to a bend (< 25 mm). Validation report shows the new warning; if Tier 3 #28 has shipped, a marker appears at the electrode.
2. Add a 60° bend on a run that isn't a hairpin. Warning fires.
3. Add a hairpin via Insert Doubleback (PR #18). Warning does NOT fire on the apex.

## Workflow

1. Schema migration + storage layer.
2. Rule implementations + tests.
3. Wire into `ValidateSVG`.
4. Pre-merge + smoke.
5. PR titled "Lead-in + sharp-angle validation rules (Tier 3 #29)".
6. **Move this spec** to `specs/done/`.

## Report back

Under 250 words. Include: PR URL, default `MinLeadInMM` formula chosen, dedup decision when both rules + bend-radius fire on the same cluster, citation source for the lead-in minimum, CI state, follow-ups (per-rule severity override on a per-project basis, configurable bend threshold).
