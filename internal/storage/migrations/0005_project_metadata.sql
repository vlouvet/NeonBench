-- Add Job Manager metadata columns to projects so a real shop can track
-- the end customer, the in-house designer, the due date, and the shop's
-- own job/invoice number per project. NeonWizard's Job Manager has these
-- (see todo.md Appendix A NW #112); without them NeonBench is missing
-- the basic clerical fields a production shop relies on.
--
-- All four columns are nullable TEXT so existing projects keep working
-- after the migration runs. Validation (length / ISO-8601 format on
-- due_date) is enforced by the API handler, not the schema, to keep the
-- column types simple and reversible.

-- +goose Up
ALTER TABLE projects ADD COLUMN customer TEXT;
ALTER TABLE projects ADD COLUMN designer TEXT;
ALTER TABLE projects ADD COLUMN due_date TEXT;
ALTER TABLE projects ADD COLUMN job_number TEXT;

-- +goose Down
ALTER TABLE projects DROP COLUMN customer;
ALTER TABLE projects DROP COLUMN designer;
ALTER TABLE projects DROP COLUMN due_date;
ALTER TABLE projects DROP COLUMN job_number;
