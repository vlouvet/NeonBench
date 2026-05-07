-- Add a per-project "channel letter depth" setting: the height (in
-- millimeters) of the U-channel sheet-metal box that surrounds each
-- channel-letter face. The PDF renderer uses this as the height of
-- every "return strip" page emitted alongside a face-marked run, so
-- the operator knows how wide to cut the unfolded return strip.
--
-- Mirrors NeonWizard #106 ("Channel letter return patterns"); see
-- todo.md Appendix B Tier 2 #10.
--
-- Stored as REAL — depth is a physical millimeter measurement and
-- the rest of the schema keeps tube-spec dimensions in REAL too.
-- 100 mm (≈ 4 in) is the typical industry default (Strattman NT Ch.5;
-- Miller p.88) and is what the renderer falls back to when this column
-- is NULL.
--
-- Nullable on purpose: existing projects keep working untouched after
-- the migration, and the API treats NULL as "use shop default of
-- 100 mm". We do NOT auto-populate the column on existing rows so
-- "user has explicitly set a value" stays distinguishable from
-- "user is on the default".

-- +goose Up
ALTER TABLE projects ADD COLUMN channel_letter_depth_mm REAL;

-- +goose Down
ALTER TABLE projects DROP COLUMN channel_letter_depth_mm;
