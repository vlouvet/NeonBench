-- +goose Up
CREATE TABLE tube_specs (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    name                  TEXT    NOT NULL UNIQUE,
    diameter_mm           REAL    NOT NULL,
    min_bend_radius_mm    REAL    NOT NULL,
    max_segment_length_mm REAL    NOT NULL,
    min_spacing_mm        REAL    NOT NULL,
    is_default            INTEGER NOT NULL DEFAULT 0,
    created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE projects (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT    NOT NULL,
    tube_spec_id INTEGER NOT NULL REFERENCES tube_specs(id),
    units        TEXT    NOT NULL DEFAULT 'mm' CHECK (units IN ('mm', 'in')),
    created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE assets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind       TEXT    NOT NULL CHECK (kind IN ('source_image', 'vector', 'print_output')),
    filename   TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    size_bytes INTEGER NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX idx_assets_project ON assets(project_id);

CREATE TABLE design_versions (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id             INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version_no             INTEGER NOT NULL,
    label                  TEXT,
    svg_data               TEXT    NOT NULL,
    validation_report_json TEXT,
    created_at             TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE (project_id, version_no)
);
CREATE INDEX idx_design_versions_project ON design_versions(project_id);

INSERT INTO tube_specs (name, diameter_mm, min_bend_radius_mm, max_segment_length_mm, min_spacing_mm, is_default) VALUES
    ('8mm clear',  8,  16, 2500, 10, 0),
    ('10mm clear', 10, 20, 2500, 12, 0),
    ('12mm clear', 12, 25, 2500, 14, 1),
    ('15mm clear', 15, 30, 3000, 18, 0);

-- +goose Down
DROP INDEX IF EXISTS idx_design_versions_project;
DROP TABLE IF EXISTS design_versions;
DROP INDEX IF EXISTS idx_assets_project;
DROP TABLE IF EXISTS assets;
DROP TABLE IF EXISTS projects;
DROP TABLE IF EXISTS tube_specs;
