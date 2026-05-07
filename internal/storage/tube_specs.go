package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

func ListTubeSpecs(ctx context.Context, db *sql.DB) ([]TubeSpec, error) {
	const q = `SELECT id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm,
	                  min_spacing_mm, min_lead_in_mm, sharp_bend_angle_deg,
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
			t       TubeSpec
			leadIn  sql.NullFloat64
			sharpAng sql.NullFloat64
		)
		if err := rows.Scan(&t.ID, &t.Name, &t.DiameterMM, &t.MinBendRadiusMM,
			&t.MaxSegmentLengthMM, &t.MinSpacingMM, &leadIn, &sharpAng,
			&t.IsDefault, &t.CreatedAt); err != nil {
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
		out = append(out, t)
	}
	return out, rows.Err()
}

func GetTubeSpec(ctx context.Context, db *sql.DB, id int64) (TubeSpec, error) {
	const q = `SELECT id, name, diameter_mm, min_bend_radius_mm, max_segment_length_mm,
	                  min_spacing_mm, min_lead_in_mm, sharp_bend_angle_deg,
	                  is_default, created_at
	           FROM tube_specs WHERE id = ?`
	var (
		t       TubeSpec
		leadIn  sql.NullFloat64
		sharpAng sql.NullFloat64
	)
	err := db.QueryRowContext(ctx, q, id).Scan(&t.ID, &t.Name, &t.DiameterMM,
		&t.MinBendRadiusMM, &t.MaxSegmentLengthMM, &t.MinSpacingMM, &leadIn,
		&sharpAng, &t.IsDefault, &t.CreatedAt)
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
	return t, nil
}
