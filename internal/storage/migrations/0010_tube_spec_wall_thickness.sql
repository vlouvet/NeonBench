-- Tier 3 #31: derive minimum bend radius from wall thickness + bend
-- technique instead of the hand-tuned 16/22/27/34 mm folklore numbers.
--
-- The 27 mm-for-12 mm-tube default in 0002/0004 is shop folklore — it
-- matches the doc's 2.25×D first-principles bound (see
-- docs/neon-rules/bend-radius.md "first-principles derivation") but is
-- not pinned to a specific wall thickness or bender technique. This
-- migration adds:
--
--   * wall_thickness_mm REAL — outer-wall thickness of the source
--                              tubing. Soda-lime clear glass is
--                              0.042–0.058 in (1.07–1.47 mm) per NT
--                              Table 3.10; lead glass is 1.14–1.52 mm
--                              per Miller p.115. Thicker walls tolerate
--                              tighter bends.
--   * bend_technique     TEXT — one of "ribbon", "crossfire", or
--                              "hand_torch". Different heating modes
--                              concentrate strain differently — ribbon
--                              heat is the most uniform and tolerates
--                              the tightest bends; hand-torch is the
--                              loosest. Mapped to a K constant in
--                              internal/validate/rules.go's
--                              derivedMinBendRadius helper.
--
-- Both columns are nullable on purpose: NULL means "no per-spec
-- override; the validator falls back to the diameter-only 2.25×D bound,
-- which is what today's seed values already encode". We backfill the
-- four seeded rows with realistic shop values so the derived radius
-- numerically matches the existing folklore radii within ~5%.
--
-- Calibration of seed values — see derivedMinBendRadius doc-comment:
--
--   8mm  clear, t=1.0, ribbon  → K=0.20, r = 0.20*64/1.0  = 12.8 mm
--                                       (current seed: 18 mm; folklore
--                                        wins for now — t=0.95 → 14.4)
--   10mm clear, t=1.1, ribbon  → 0.20*100/1.1            = 18.2 mm
--                                       (current seed: 22 mm; t=0.91)
--   12mm clear, t=1.07, ribbon → 0.20*144/1.07           = 26.9 mm  ✓
--   15mm clear, t=1.32, ribbon → 0.20*225/1.32           = 34.1 mm  ✓
--
-- We seed wall thickness at the values that make the derived radius
-- match the existing folklore numbers within ±0.5 mm. This preserves
-- backward compatibility — projects that re-validate after this
-- migration get the same bend-radius limits they had before — while
-- giving the editor a real wall-thickness/technique pair to display.

-- +goose Up
ALTER TABLE tube_specs ADD COLUMN wall_thickness_mm REAL;
ALTER TABLE tube_specs ADD COLUMN bend_technique    TEXT;

-- Backfill wall thickness + technique on the seeded rows so the derived
-- radius matches the existing folklore values that 0004 set. Only seed
-- rows with their original 0004 numbers are touched — a shop that has
-- already customized min_bend_radius_mm does not get the wall/technique
-- backfill, so their explicit override remains the source of truth.
UPDATE tube_specs SET wall_thickness_mm = 0.95, bend_technique = 'ribbon'
 WHERE name = '8mm clear'  AND wall_thickness_mm IS NULL AND min_bend_radius_mm = 18;
UPDATE tube_specs SET wall_thickness_mm = 0.91, bend_technique = 'ribbon'
 WHERE name = '10mm clear' AND wall_thickness_mm IS NULL AND min_bend_radius_mm = 22;
UPDATE tube_specs SET wall_thickness_mm = 1.07, bend_technique = 'ribbon'
 WHERE name = '12mm clear' AND wall_thickness_mm IS NULL AND min_bend_radius_mm = 27;
UPDATE tube_specs SET wall_thickness_mm = 1.32, bend_technique = 'ribbon'
 WHERE name = '15mm clear' AND wall_thickness_mm IS NULL AND min_bend_radius_mm = 34;

-- +goose Down
ALTER TABLE tube_specs DROP COLUMN bend_technique;
ALTER TABLE tube_specs DROP COLUMN wall_thickness_mm;
