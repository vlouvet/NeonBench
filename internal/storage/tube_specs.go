package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

func ListTubeSpecs(ctx context.Context, db *sql.DB) ([]TubeSpec, error) {
	const q = `SELECT id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm,
	                  min_spacing_mm, min_lead_in_mm, sharp_bend_angle_deg,
	                  wall_thickness_mm, bend_technique,
	                  is_default, created_at
	           FROM tube_specs
	           ORDER BY diameter_mm, name`
	rows, err := db.QueryContext(ctx, q)
	if err != nil {
		return nil, fmt.Errorf("query tube_specs: %w", err)
	}
	defer rows.Close()

	var out []TubeSpec
	for rows.Next() {
		var (
			t        TubeSpec
			leadIn   sql.NullFloat64
			sharpAng sql.NullFloat64
			wallTh   sql.NullFloat64
			tech     sql.NullString
		)
		if err := rows.Scan(&t.ID, &t.Name, &t.DiameterMM, &t.MinBendRadiusMM,
			&t.MaxSegmentLengthMM, &t.MinSpacingMM, &leadIn, &sharpAng,
			&wallTh, &tech, &t.IsDefault, &t.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan tube_spec: %w", err)
		}
		if leadIn.Valid {
			v := leadIn.Float64
			t.MinLeadInMM = &v
		}
		if sharpAng.Valid {
			v := sharpAng.Float64
			t.SharpBendAngleDeg = &v
		}
		if wallTh.Valid {
			v := wallTh.Float64
			t.WallThicknessMM = &v
		}
		if tech.Valid {
			v := tech.String
			t.BendTechnique = &v
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func GetTubeSpec(ctx context.Context, db *sql.DB, id int64) (TubeSpec, error) {
	const q = `SELECT id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm,
	                  min_spacing_mm, min_lead_in_mm, sharp_bend_angle_deg,
	                  wall_thickness_mm, bend_technique,
	                  is_default, created_at
	           FROM tube_specs WHERE id = ?`
	var (
		t        TubeSpec
		leadIn   sql.NullFloat64
		sharpAng sql.NullFloat64
		wallTh   sql.NullFloat64
		tech     sql.NullString
	)
	err := db.QueryRowContext(ctx, q, id).Scan(&t.ID, &t.Name, &t.DiameterMM,
		&t.MinBendRadiusMM, &t.MaxSegmentLengthMM, &t.MinSpacingMM, &leadIn,
		&sharpAng, &wallTh, &tech, &t.IsDefault, &t.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return TubeSpec{}, ErrNotFound
	}
	if err != nil {
		return TubeSpec{}, fmt.Errorf("get tube_spec: %w", err)
	}
	if leadIn.Valid {
		v := leadIn.Float64
		t.MinLeadInMM = &v
	}
	if sharpAng.Valid {
		v := sharpAng.Float64
		t.SharpBendAngleDeg = &v
	}
	if wallTh.Valid {
		v := wallTh.Float64
		t.WallThicknessMM = &v
	}
	if tech.Valid {
		v := tech.String
		t.BendTechnique = &v
	}
	return t, nil
}

// ErrTubeSpecNameTaken is returned by CreateTubeSpec / UpdateTubeSpec when
// the supplied name collides with an existing row's name. Callers in the
// HTTP layer surface this as 409 (POST) or 400 (PATCH) so the frontend
// can show a clear conflict message instead of a generic 500.
var ErrTubeSpecNameTaken = errors.New("tube_spec name already in use")

// CreateTubeSpecParams describes a new tube spec. The four required
// dimensional fields (diameter, bend radius, segment length, spacing)
// are non-pointer values; the four optional override columns (wall
// thickness, technique, lead-in, sharp-bend) are nilable pointers.
// Mirrors the storage.CreateProjectParams shape.
type CreateTubeSpecParams struct {
	Name               string
	DiameterMM         float64
	MinBendRadiusMM    float64
	MaxSegmentLengthMM float64
	MinSpacingMM       float64
	// Optional columns. Nil → SQL NULL; the validator falls back to
	// the documented derivation defaults at runtime.
	WallThicknessMM   *float64
	BendTechnique     *string
	MinLeadInMM       *float64
	SharpBendAngleDeg *float64
	// IsDefault is generally false for user-created specs; the
	// seeded "12mm clear" row is the only is_default=1 entry. We
	// expose this flag for completeness but the API never sets it.
	IsDefault bool
}

// CreateTubeSpec inserts a new tube_specs row and returns the persisted
// record. UNIQUE-constraint collisions on `name` surface as
// ErrTubeSpecNameTaken so callers can map them to a 409.
func CreateTubeSpec(ctx context.Context, db *sql.DB, p CreateTubeSpecParams) (TubeSpec, error) {
	const q = `INSERT INTO tube_specs (name, diameter_mm, min_bend_radius_mm, max_segment_length_mm,
	                                   min_spacing_mm, wall_thickness_mm, bend_technique,
	                                   min_lead_in_mm, sharp_bend_angle_deg, is_default)
	           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	res, err := db.ExecContext(ctx, q,
		p.Name,
		p.DiameterMM,
		p.MinBendRadiusMM,
		p.MaxSegmentLengthMM,
		p.MinSpacingMM,
		nullableFloat(p.WallThicknessMM),
		nullableString(p.BendTechnique),
		nullableFloat(p.MinLeadInMM),
		nullableFloat(p.SharpBendAngleDeg),
		boolToInt(p.IsDefault),
	)
	if err != nil {
		if isTubeSpecUniqueConstraintErr(err) {
			return TubeSpec{}, ErrTubeSpecNameTaken
		}
		return TubeSpec{}, fmt.Errorf("insert tube_spec: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return TubeSpec{}, fmt.Errorf("last insert id: %w", err)
	}
	return GetTubeSpec(ctx, db, id)
}

// UpdateTubeSpec writes the merged spec row back to SQLite. Mirrors the
// shape of UpdateProject but takes the merged TubeSpec value rather than
// a partial-update params struct because the handler already merges the
// PATCH onto the current row to run cross-field validation
// (validateMergedTubeSpec) before this function is reached. Tier 3 #51
// extracted this from the inline updateTubeSpecRow that PR #40 added.
//
// Returns the updated row on success; ErrNotFound when no row matches
// the id; ErrTubeSpecNameTaken when the new name collides with another
// spec.
func UpdateTubeSpec(ctx context.Context, db *sql.DB, id int64, t TubeSpec) (TubeSpec, error) {
	res, err := db.ExecContext(ctx, `
		UPDATE tube_specs
		   SET name                  = ?,
		       diameter_mm           = ?,
		       min_bend_radius_mm    = ?,
		       max_segment_length_mm = ?,
		       min_spacing_mm        = ?,
		       wall_thickness_mm     = ?,
		       bend_technique        = ?,
		       min_lead_in_mm        = ?,
		       sharp_bend_angle_deg  = ?
		 WHERE id = ?`,
		t.Name, t.DiameterMM, t.MinBendRadiusMM, t.MaxSegmentLengthMM, t.MinSpacingMM,
		nullableFloat(t.WallThicknessMM), nullableString(t.BendTechnique),
		nullableFloat(t.MinLeadInMM), nullableFloat(t.SharpBendAngleDeg),
		id)
	if err != nil {
		if isTubeSpecUniqueConstraintErr(err) {
			return TubeSpec{}, ErrTubeSpecNameTaken
		}
		return TubeSpec{}, fmt.Errorf("update tube_spec: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return TubeSpec{}, ErrNotFound
	}
	return GetTubeSpec(ctx, db, id)
}

// DeleteTubeSpec removes a tube_specs row by id. Callers must ensure no
// project still references the spec — the FOREIGN KEY on projects.tube_spec_id
// would otherwise refuse the DELETE; we surface that as a generic SQL error
// so the HTTP layer can pre-flight the constraint and return a clearer 409.
func DeleteTubeSpec(ctx context.Context, db *sql.DB, id int64) error {
	res, err := db.ExecContext(ctx, `DELETE FROM tube_specs WHERE id = ?`, id)
	if err != nil {
		return fmt.Errorf("delete tube_spec: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return ErrNotFound
	}
	return nil
}

// isTubeSpecUniqueConstraintErr does a string-match on the SQLite error
// text because modernc.org/sqlite does not expose typed constraint
// errors. "UNIQUE constraint failed" is the canonical message; we match
// the substring so we tolerate the column-name suffix (e.g.
// "...failed: tube_specs.name").
func isTubeSpecUniqueConstraintErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
}

// nullableString mirrors nullableFloat for TEXT columns: nil → SQL NULL,
// otherwise the dereferenced string. Used by CreateTubeSpec / UpdateTubeSpec
// for the optional bend_technique column.
func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
}
