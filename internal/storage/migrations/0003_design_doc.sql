-- +goose Up
ALTER TABLE design_versions ADD COLUMN design_doc TEXT;

-- +goose Down
ALTER TABLE design_versions DROP COLUMN design_doc;
