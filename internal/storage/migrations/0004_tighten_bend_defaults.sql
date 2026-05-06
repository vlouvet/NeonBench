-- Update default tube specs to use the wall-thinning derivation from
-- docs/neon-rules/bend-radius.md (r ≥ 2.25 × diameter, rounded up to a
-- conservative trade-friendly mm value). The original 0002 seed values
-- were uncited heuristics; the new ones reflect 80%-wall-preservation
-- bend math. We only update rows that still carry the old values, so
-- a user who customized their tube_specs table keeps their settings.

-- +goose Up
UPDATE tube_specs SET min_bend_radius_mm = 18 WHERE name = '8mm clear'  AND min_bend_radius_mm = 16;
UPDATE tube_specs SET min_bend_radius_mm = 22 WHERE name = '10mm clear' AND min_bend_radius_mm = 20;
UPDATE tube_specs SET min_bend_radius_mm = 27 WHERE name = '12mm clear' AND min_bend_radius_mm = 25;
UPDATE tube_specs SET min_bend_radius_mm = 34 WHERE name = '15mm clear' AND min_bend_radius_mm = 30;

-- +goose Down
UPDATE tube_specs SET min_bend_radius_mm = 16 WHERE name = '8mm clear'  AND min_bend_radius_mm = 18;
UPDATE tube_specs SET min_bend_radius_mm = 20 WHERE name = '10mm clear' AND min_bend_radius_mm = 22;
UPDATE tube_specs SET min_bend_radius_mm = 25 WHERE name = '12mm clear' AND min_bend_radius_mm = 27;
UPDATE tube_specs SET min_bend_radius_mm = 30 WHERE name = '15mm clear' AND min_bend_radius_mm = 34;
