-- Add a per-project "strip overlap" setting: the millimeter allowance the
-- fabricator leaves at one end of an unfolded channel-letter return strip
-- so the two ends overlap when the strip is wrapped around the face.
-- Without this allowance the seam butts but doesn't bond; with it, the
-- seam is welded or pop-riveted through the doubled metal.
--
-- Mirrors NeonWizard #106 ("Channel letter return patterns") follow-up
-- polish; see todo.md Appendix B Tier 3 #26. The shop-default is
-- 12.7 mm = ½ in (Strattman NT Ch.5 trade convention; Miller p.88
-- describes the practice but doesn't tabulate the value).
--
-- Stored as REAL — the rest of the schema keeps physical mm as REAL.
-- Nullable on purpose: existing projects keep working untouched after
-- the migration, and the API treats NULL as "use shop default of
-- 12.7 mm". We do NOT auto-populate the column on existing rows so
-- "user has explicitly set a value" stays distinguishable from
-- "user is on the default".
--
-- Note: the original spec reserved migration number 0008 for this
-- column, but 0009 / 0010 shipped first (tube_spec_lead_in,
-- tube_spec_wall_thickness) so we pick the next unused number 0011
-- to keep the goose sequence monotonic and avoid "missing migration"
-- failures on existing installs.

-- +goose Up
ALTER TABLE projects ADD COLUMN strip_overlap_mm REAL;

-- +goose Down
ALTER TABLE projects DROP COLUMN strip_overlap_mm;
