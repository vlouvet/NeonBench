package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

var ErrNotFound = errors.New("not found")

type CreateProjectParams struct {
	Name       string
	TubeSpecID int64
	Units      string
}

func CreateProject(ctx context.Context, db *sql.DB, p CreateProjectParams) (Project, error) {
	if p.Units == "" {
		p.Units = "mm"
	}
	const q = `INSERT INTO projects (name, tube_spec_id, units) VALUES (?, ?, ?)`
	res, err := db.ExecContext(ctx, q, p.Name, p.TubeSpecID, p.Units)
	if err != nil {
		return Project{}, fmt.Errorf("insert project: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Project{}, fmt.Errorf("last insert id: %w", err)
	}
	return GetProject(ctx, db, id)
}

func ListProjects(ctx context.Context, db *sql.DB) ([]Project, error) {
	const q = `SELECT id, name, tube_spec_id, units, created_at, updated_at
	           FROM projects ORDER BY updated_at DESC`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query projects: %w", err)
	}
	defer rows.Close()

	var out []Project
	for rows.Next() {
		var p Project
		if err := rows.Scan(&p.ID, &p.Name, &p.TubeSpecID, &p.Units, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func GetProject(ctx context.Context, db *sql.DB, id int64) (Project, error) {
	const q = `SELECT id, name, tube_spec_id, units, created_at, updated_at
	           FROM projects WHERE id = ?`
	var p Project
	err := db.QueryRowContext(ctx, q, id).Scan(&p.ID, &p.Name, &p.TubeSpecID, &p.Units, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	return p, nil
}

// UpdateProjectParams describes a partial update to a project. Only the
// non-zero fields are written; everything else stays as-is.
type UpdateProjectParams struct {
	Name       *string
	TubeSpecID *int64
	Units      *string
}

// UpdateProject applies a partial update and bumps updated_at.
func UpdateProject(ctx context.Context, db *sql.DB, id int64, p UpdateProjectParams) (Project, error) {
	if p.Name == nil && p.TubeSpecID == nil && p.Units == nil {
		return GetProject(ctx, db, id)
	}
	sets := []string{}
	args := []any{}
	if p.Name != nil {
		sets = append(sets, "name = ?")
		args = append(args, *p.Name)
	}
	if p.TubeSpecID != nil {
		sets = append(sets, "tube_spec_id = ?")
		args = append(args, *p.TubeSpecID)
	}
	if p.Units != nil {
		sets = append(sets, "units = ?")
		args = append(args, *p.Units)
	}
	sets = append(sets, `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
	q := `UPDATE projects SET ` + strings.Join(sets, ", ") + ` WHERE id = ?`
	args = append(args, id)
	res, err := db.ExecContext(ctx, q, args...)
	if err != nil {
		return Project{}, fmt.Errorf("update project: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return Project{}, ErrNotFound
	}
	return GetProject(ctx, db, id)
}

func DeleteProject(ctx context.Context, db *sql.DB, id int64) error {
	res, err := db.ExecContext(ctx, `DELETE FROM projects WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete project: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

func TouchProject(ctx context.Context, db *sql.DB, id int64) error {
	_, err := db.ExecContext(ctx,
		`UPDATE projects SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`, id)
	return err
}
