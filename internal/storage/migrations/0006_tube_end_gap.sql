-- Add a per-project "tube end gap" setting: the distance, in millimeters,
-- from the glass tube's actual endpoint to the inside edge of the channel
-- letter (or other substrate) the tube sits inside. Real-world purpose:
-- the electrode housing extends past the tube end, plus there's clearance
-- for thermal expansion and installation tolerance, so the tube cannot
-- run all the way to the wall.
--
-- Mirrors NeonWizard #135 ("Tube End Gap"); see todo.md Appendix B Tier 2
-- #15. Stored as REAL because it's a physical millimeter measurement and
-- the rest of the schema keeps tube-spec dimensions in REAL too.
--
-- Nullable on purpose: existing projects keep working untouched after
-- the migration, and the API treats NULL as "use the shop default
-- (6.35 mm = ¼ in, per Miller, App I §126, p. 275 — see
-- docs/neon-rules/spacing.md)". We do NOT auto-populate the column on
-- existing rows so that "user has explicitly set a value" stays
-- distinguishable from "user is on the default".

-- +goose Up
ALTER TABLE projects ADD COLUMN tube_end_gap_mm REAL;

-- +goose Down
ALTER TABLE projects DROP COLUMN tube_end_gap_mm;
