package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
)

type CreateAssetParams struct {
	ProjectID int64
	Kind      AssetKind
	Filename  string
	MIME      string
	SizeBytes int64
}

func CreateAsset(ctx context.Context, db *sql.DB, p CreateAssetParams) (Asset, error) {
	const q = `INSERT INTO assets (project_id, kind, filename, mime, size_bytes)
	           VALUES (?, ?, ?, ?, ?)`
	res, err := db.ExecContext(ctx, q, p.ProjectID, string(p.Kind), p.Filename, p.MIME, p.SizeBytes)
	if err != nil {
		return Asset{}, fmt.Errorf("insert asset: %w", err)
	}
	id, err := res.LastInsertId()
	if err != nil {
		return Asset{}, fmt.Errorf("last insert id: %w", err)
	}
	return GetAsset(ctx, db, id)
}

func ListAssets(ctx context.Context, db *sql.DB, projectID int64) ([]Asset, error) {
	const q = `SELECT id, project_id, kind, filename, mime, size_bytes, created_at
	           FROM assets WHERE project_id = ? ORDER BY created_at DESC`
	rows, err := db.QueryContext(ctx, q, projectID)
	if err != nil {
		return nil, fmt.Errorf("query assets: %w", err)
	}
	defer rows.Close()

	var out []Asset
	for rows.Next() {
		var a Asset
		var kind string
		if err := rows.Scan(&a.ID, &a.ProjectID, &kind, &a.Filename, &a.MIME, &a.SizeBytes, &a.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan asset: %w", err)
		}
		a.Kind = AssetKind(kind)
		out = append(out, a)
	}
	return out, rows.Err()
}

func GetAsset(ctx context.Context, db *sql.DB, id int64) (Asset, error) {
	const q = `SELECT id, project_id, kind, filename, mime, size_bytes, created_at
	           FROM assets WHERE id = ?`
	var a Asset
	var kind string
	err := db.QueryRowContext(ctx, q, id).Scan(&a.ID, &a.ProjectID, &kind, &a.Filename, &a.MIME, &a.SizeBytes, &a.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Asset{}, ErrNotFound
	}
	if err != nil {
		return Asset{}, fmt.Errorf("get asset: %w", err)
	}
	a.Kind = AssetKind(kind)
	return a, nil
}
