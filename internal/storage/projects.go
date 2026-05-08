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
	// Optional tube end gap (mm). Nil means "no per-project override";
	// the column stays NULL and the API surface returns no value, so
	// consumers fall back to the shop default at render-time.
	TubeEndGapMM *float64
	// Optional channel-letter depth (mm). Nil means "no override";
	// the column stays NULL and renderers fall back to the shop
	// default (100 mm) when emitting return-strip pages.
	ChannelLetterDepthMM *float64
	// Optional strip-overlap allowance (mm). Nil means "no override";
	// the column stays NULL and renderers fall back to the shop
	// default (12.7 mm = ½ in) when drawing the shear line on the
	// unfolded return strip.
	StripOverlapMM *float64
	// FacePerimeterStrictMode escalates the face-perimeter validation
	// rule from warning to error when true (Tier 3 #46). Defaults to
	// false; create requests that omit the field land in the
	// warning-level mode that matches pre-migration behaviour.
	FacePerimeterStrictMode bool
}

func CreateProject(ctx context.Context, db *sql.DB, p CreateProjectParams) (Project, error) {
	if p.Units == "" {
		p.Units = "mm"
	}
	const q = `INSERT INTO projects (name, tube_spec_id, units, customer, designer, due_date, job_number, tube_end_gap_mm, channel_letter_depth_mm, strip_overlap_mm, face_perimeter_strict_mode)
	           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	res, err := db.ExecContext(ctx, q,
		p.Name,
		p.TubeSpecID,
		p.Units,
		nullableText(p.Customer),
		nullableText(p.Designer),
		nullableText(p.DueDate),
		nullableText(p.JobNumber),
		nullableFloat(p.TubeEndGapMM),
		nullableFloat(p.ChannelLetterDepthMM),
		nullableFloat(p.StripOverlapMM),
		boolToInt(p.FacePerimeterStrictMode),
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
	const q = `SELECT id, name, tube_spec_id, units, customer, designer, due_date, job_number, tube_end_gap_mm, channel_letter_depth_mm, strip_overlap_mm, face_perimeter_strict_mode, created_at, updated_at
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
	const q = `SELECT id, name, tube_spec_id, units, customer, designer, due_date, job_number, tube_end_gap_mm, channel_letter_depth_mm, strip_overlap_mm, face_perimeter_strict_mode, created_at, updated_at
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
	// TubeEndGapMM is a pointer-to-pointer so the handler can distinguish
	// three states: omitted (don't touch the column), set to nil (clear
	// the column → NULL → "use shop default"), and set to a concrete
	// float (write that value).
	TubeEndGapMM **float64
	// ChannelLetterDepthMM uses the same three-state pattern as
	// TubeEndGapMM: nil = "field omitted, leave column alone";
	// non-nil pointer to nil = "clear column → use shop default";
	// non-nil pointer to value = "write that value".
	ChannelLetterDepthMM **float64
	// StripOverlapMM uses the same three-state pattern as
	// ChannelLetterDepthMM (Tier 3 #26).
	StripOverlapMM **float64
	// FacePerimeterStrictMode is a two-state pointer (Tier 3 #46): nil
	// = "field omitted, leave column alone"; non-nil = "write that
	// boolean". The column itself is NOT NULL DEFAULT 0 so there's no
	// "clear → fall back" semantic — the value is always definite.
	FacePerimeterStrictMode *bool
}

// UpdateProject applies a partial update and bumps updated_at.
func UpdateProject(ctx context.Context, db *sql.DB, id int64, p UpdateProjectParams) (Project, error) {
	if p.Name == nil && p.TubeSpecID == nil && p.Units == nil &&
		p.Customer == nil && p.Designer == nil && p.DueDate == nil && p.JobNumber == nil &&
		p.TubeEndGapMM == nil && p.ChannelLetterDepthMM == nil && p.StripOverlapMM == nil &&
		p.FacePerimeterStrictMode == nil {
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
	if p.TubeEndGapMM != nil {
		sets = append(sets, "tube_end_gap_mm = ?")
		args = append(args, nullableFloat(*p.TubeEndGapMM))
	}
	if p.ChannelLetterDepthMM != nil {
		sets = append(sets, "channel_letter_depth_mm = ?")
		args = append(args, nullableFloat(*p.ChannelLetterDepthMM))
	}
	if p.StripOverlapMM != nil {
		sets = append(sets, "strip_overlap_mm = ?")
		args = append(args, nullableFloat(*p.StripOverlapMM))
	}
	if p.FacePerimeterStrictMode != nil {
		sets = append(sets, "face_perimeter_strict_mode = ?")
		args = append(args, boolToInt(*p.FacePerimeterStrictMode))
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

// nullableFloat returns sql.NullFloat64{Valid:false} for nil pointers so
// the column gets stored as NULL, and Valid:true with the pointed-to
// value otherwise. NULL is the "use shop default" signal for the
// optional tube end gap; the caller is responsible for upstream
// validation (range checks live in the API handler).
func nullableFloat(f *float64) any {
	if f == nil {
		return sql.NullFloat64{}
	}
	return sql.NullFloat64{Float64: *f, Valid: true}
}

// scanRow is the subset of *sql.Row / *sql.Rows we need.
type scanRow interface {
	Scan(dest ...any) error
}

func scanProject(r scanRow) (Project, error) {
	var p Project
	var customer, designer, dueDate, jobNumber sql.NullString
	var tubeEndGapMM, channelLetterDepthMM, stripOverlapMM sql.NullFloat64
	var strictMode int64
	if err := r.Scan(
		&p.ID, &p.Name, &p.TubeSpecID, &p.Units,
		&customer, &designer, &dueDate, &jobNumber,
		&tubeEndGapMM,
		&channelLetterDepthMM,
		&stripOverlapMM,
		&strictMode,
		&p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return Project{}, err
	}
	p.Customer = customer.String
	p.Designer = designer.String
	p.DueDate = dueDate.String
	p.JobNumber = jobNumber.String
	if tubeEndGapMM.Valid {
		v := tubeEndGapMM.Float64
		p.TubeEndGapMM = &v
	}
	if channelLetterDepthMM.Valid {
		v := channelLetterDepthMM.Float64
		p.ChannelLetterDepthMM = &v
	}
	if stripOverlapMM.Valid {
		v := stripOverlapMM.Float64
		p.StripOverlapMM = &v
	}
	p.FacePerimeterStrictMode = strictMode != 0
	return p, nil
}

// boolToInt maps Go booleans to the SQLite 0/1 integer convention used
// across the projects schema. Kept tiny and local so callers don't have
// to inline the ternary at every Exec site.
func boolToInt(b bool) int64 {
	if b {
		return 1
	}
	return 0
}
