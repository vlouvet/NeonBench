-- Add per-tube-spec safety/manufacturability rule limits used by the
-- validator (Tier 3 #29):
--
--   * min_lead_in_mm     — minimum straight tube length between an electrode
--                          and the first bend on a run. Short lead-ins crack
--                          at the seal under handling and thermal cycling
--                          (Miller App I §126; Saving Neon).
--   * sharp_bend_angle_deg — vertices with an interior angle at or below
--                          this value are flagged as bender-unfriendly stress
--                          concentrators. Hairpin double-backs (180° apex)
--                          are exempted via the existing detector so the
--                          warning doesn't flood legitimate U-turns.
--
-- Both columns are nullable on purpose: NULL means "no per-spec override;
-- the validator falls back to a derived default (2 × diameter for lead-in,
-- 85° for the sharp-bend threshold)". We do NOT auto-populate the columns
-- on existing rows so that "user has explicitly set a value" stays
-- distinguishable from "user is on the derived default". REAL matches the
-- rest of the tube-spec dimension columns.

-- +goose Up
ALTER TABLE tube_specs ADD COLUMN min_lead_in_mm REAL;
ALTER TABLE tube_specs ADD COLUMN sharp_bend_angle_deg REAL;

-- +goose Down
ALTER TABLE tube_specs DROP COLUMN sharp_bend_angle_deg;
ALTER TABLE tube_specs DROP COLUMN min_lead_in_mm;
