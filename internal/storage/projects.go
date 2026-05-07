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
	// Optional Job Manager metadata. Empty strings are stored as NULL so
	// "unset" round-trips cleanly through the schema.
	Customer  string
	Designer  string
	DueDate   string
	JobNumber string
}

func CreateProject(ctx context.Context, db *sql.DB, p CreateProjectParams) (Project, error) {
	if p.Units == "" {
		p.Units = "mm"
	}
	const q = `INSERT INTO projects (name, tube_spec_id, units, customer, designer, due_date, job_number)
	           VALUES (?, ?, ?, ?, ?, ?, ?)`
	res, err := db.ExecContext(ctx, q,
		p.Name,
		p.TubeSpecID,
		p.Units,
		nullableText(p.Customer),
		nullableText(p.Designer),
		nullableText(p.DueDate),
		nullableText(p.JobNumber),
	)
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
	const q = `SELECT id, name, tube_spec_id, units, customer, designer, due_date, job_number, created_at, updated_at
	           FROM projects ORDER BY updated_at DESC`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query projects: %w", err)
	}
	defer rows.Close()

	var out []Project
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func GetProject(ctx context.Context, db *sql.DB, id int64) (Project, error) {
	const q = `SELECT id, name, tube_spec_id, units, customer, designer, due_date, job_number, created_at, updated_at
	           FROM projects WHERE id = ?`
	row := db.QueryRowContext(ctx, q, id)
	p, err := scanProject(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Project{}, ErrNotFound
	}
	if err != nil {
		return Project{}, fmt.Errorf("get project: %w", err)
	}
	return p, nil
}

// UpdateProjectParams describes a partial update to a project. Only the
// non-nil fields are written; everything else stays as-is. For the
// optional metadata fields, a non-nil empty string sets the column to
// NULL — that's how the frontend clears a value.
type UpdateProjectParams struct {
	Name       *string
	TubeSpecID *int64
	Units      *string
	Customer   *string
	Designer   *string
	DueDate    *string
	JobNumber  *string
}

// UpdateProject applies a partial update and bumps updated_at.
func UpdateProject(ctx context.Context, db *sql.DB, id int64, p UpdateProjectParams) (Project, error) {
	if p.Name == nil && p.TubeSpecID == nil && p.Units == nil &&
		p.Customer == nil && p.Designer == nil && p.DueDate == nil && p.JobNumber == nil {
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
	if p.Customer != nil {
		sets = append(sets, "customer = ?")
		args = append(args, nullableText(*p.Customer))
	}
	if p.Designer != nil {
		sets = append(sets, "designer = ?")
		args = append(args, nullableText(*p.Designer))
	}
	if p.DueDate != nil {
		sets = append(sets, "due_date = ?")
		args = append(args, nullableText(*p.DueDate))
	}
	if p.JobNumber != nil {
		sets = append(sets, "job_number = ?")
		args = append(args, nullableText(*p.JobNumber))
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

// nullableText returns sql.NullString{Valid:false} for empty strings so
// the column gets stored as NULL, and Valid:true otherwise.
func nullableText(s string) any {
	if s == "" {
		return sql.NullString{}
	}
	return sql.NullString{String: s, Valid: true}
}

// scanRow is the subset of *sql.Row / *sql.Rows we need.
type scanRow interface {
	Scan(dest ...any) error
}

func scanProject(r scanRow) (Project, error) {
	var p Project
	var customer, designer, dueDate, jobNumber sql.NullString
	if err := r.Scan(
		&p.ID, &p.Name, &p.TubeSpecID, &p.Units,
		&customer, &designer, &dueDate, &jobNumber,
		&p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return Project{}, err
	}
	p.Customer = customer.String
	p.Designer = designer.String
	p.DueDate = dueDate.String
	p.JobNumber = jobNumber.String
	return p, nil
}
