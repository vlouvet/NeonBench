package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type DesignVersion struct {
	ID                   int64   `json:"id"`
	ProjectID            int64   `json:"project_id"`
	VersionNo            int64   `json:"version_no"`
	Label                *string `json:"label,omitempty"`
	SVGData              string  `json:"svg_data"`
	DesignDocJSON        *string `json:"design_doc_json,omitempty"`
	ValidationReportJSON *string `json:"validation_report_json,omitempty"`
	CreatedAt            string  `json:"created_at"`
}

type CreateDesignVersionParams struct {
	ProjectID            int64
	Label                string // empty string → NULL
	SVGData              string
	DesignDocJSON        string // empty string → NULL
	ValidationReportJSON string // empty string → NULL
}

// CreateDesignVersion inserts a new design_version, atomically computing the
// next version_no for the project as MAX(version_no) + 1.
func CreateDesignVersion(ctx context.Context, db *sql.DB, p CreateDesignVersionParams) (DesignVersion, error) {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return DesignVersion{}, fmt.Errorf("begin tx: %w", err)
	}
	defer tx.Rollback()

	var nextVer int64
	err = tx.QueryRowContext(ctx,
		`SELECT COALESCE(MAX(version_no), 0) + 1 FROM design_versions WHERE project_id = ?`,
		p.ProjectID).Scan(&nextVer)
	if err != nil {
		return DesignVersion{}, fmt.Errorf("compute version_no: %w", err)
	}

	res, err := tx.ExecContext(ctx,
		`INSERT INTO design_versions (project_id, version_no, label, svg_data, design_doc, validation_report_json)
		 VALUES (?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''))`,
		p.ProjectID, nextVer, p.Label, p.SVGData, p.DesignDocJSON, p.ValidationReportJSON)
	if err != nil {
		return DesignVersion{}, fmt.Errorf("insert design_version: %w", err)
	}
	id, _ := res.LastInsertId()

	if _, err := tx.ExecContext(ctx,
		`UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
		p.ProjectID); err != nil {
		return DesignVersion{}, fmt.Errorf("touch project: %w", err)
	}

	if err := tx.Commit(); err != nil {
		return DesignVersion{}, fmt.Errorf("commit: %w", err)
	}
	return GetDesignVersion(ctx, db, id)
}

func GetDesignVersion(ctx context.Context, db *sql.DB, id int64) (DesignVersion, error) {
	const q = `SELECT id, project_id, version_no, label, svg_data, design_doc, validation_report_json, created_at
	           FROM design_versions WHERE id = ?`
	var v DesignVersion
	err := db.QueryRowContext(ctx, q, id).Scan(&v.ID, &v.ProjectID, &v.VersionNo,
		&v.Label, &v.SVGData, &v.DesignDocJSON, &v.ValidationReportJSON, &v.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DesignVersion{}, ErrNotFound
	}
	if err != nil {
		return DesignVersion{}, fmt.Errorf("get design_version: %w", err)
	}
	return v, nil
}

// ListDesignVersions returns versions for a project, newest first. SVG data
// and design doc are omitted to keep listings small; callers fetch them via
// GetDesignVersion when needed.
func ListDesignVersions(ctx context.Context, db *sql.DB, projectID int64) ([]DesignVersion, error) {
	const q = `SELECT id, project_id, version_no, label, '' AS svg_data, NULL AS design_doc, validation_report_json, created_at
	           FROM design_versions WHERE project_id = ?
	           ORDER BY version_no DESC`
	rows, err := db.QueryContext(ctx, q, projectID)
	if err != nil {
		return nil, fmt.Errorf("query design_versions: %w", err)
	}
	defer rows.Close()
	var out []DesignVersion
	for rows.Next() {
		var v DesignVersion
		if err := rows.Scan(&v.ID, &v.ProjectID, &v.VersionNo, &v.Label, &v.SVGData,
			&v.DesignDocJSON, &v.ValidationReportJSON, &v.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan design_version: %w", err)
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// UpdateDesignVersionReport replaces the validation_report_json for a
// version. Used when re-validating a design after the tube spec changed.
func UpdateDesignVersionReport(ctx context.Context, db *sql.DB, id int64, reportJSON string) (DesignVersion, error) {
	res, err := db.ExecContext(ctx,
		`UPDATE design_versions SET validation_report_json = NULLIF(?, '') WHERE id = ?`,
		reportJSON, id)
	if err != nil {
		return DesignVersion{}, fmt.Errorf("update design_version report: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return DesignVersion{}, ErrNotFound
	}
	return GetDesignVersion(ctx, db, id)
}

// LatestDesignVersion returns the most recent version for a project, or
// ErrNotFound if none exist.
func LatestDesignVersion(ctx context.Context, db *sql.DB, projectID int64) (DesignVersion, error) {
	const q = `SELECT id, project_id, version_no, label, svg_data, design_doc, validation_report_json, created_at
	           FROM design_versions WHERE project_id = ?
	           ORDER BY version_no DESC LIMIT 1`
	var v DesignVersion
	err := db.QueryRowContext(ctx, q, projectID).Scan(&v.ID, &v.ProjectID, &v.VersionNo,
		&v.Label, &v.SVGData, &v.DesignDocJSON, &v.ValidationReportJSON, &v.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return DesignVersion{}, ErrNotFound
	}
	if err != nil {
		return DesignVersion{}, fmt.Errorf("latest design_version: %w", err)
	}
	return v, nil
}
