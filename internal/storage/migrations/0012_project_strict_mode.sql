-- Add a per-project "face_perimeter_strict_mode" boolean flag (Tier 3 #46).
-- When set to 1, the validator escalates RuleFacePerimeterExceedsBlank
-- from severity "warning" to "error" so the issue surfaces with the
-- red marker and blocks acceptance flows that key off Report.HasErrors().
-- When 0 (default), the existing warning-level behaviour is preserved
-- so existing reports stay byte-identical after the column is added.
--
-- Some shops want a hard-stop (face won't fit on a single 1168 mm coil
-- = stop the bender, restructure the design); others want the warning
-- so they can splice a documented seam (Strattman NT Ch.5 trade
-- practice). The toggle defers that policy decision to the operator
-- per-project.
--
-- Stored as INTEGER NOT NULL DEFAULT 0 (the SQLite booleans pattern
-- already used by tube_specs.is_default). The DEFAULT 0 keeps existing
-- rows in the warning-level mode at upgrade time without an explicit
-- backfill; the validator falls through to the existing behaviour
-- whenever Limits.FacePerimeterStrict is false.

-- +goose Up
ALTER TABLE projects ADD COLUMN face_perimeter_strict_mode INTEGER NOT NULL DEFAULT 0;

-- +goose Down
ALTER TABLE projects DROP COLUMN face_perimeter_strict_mode;
