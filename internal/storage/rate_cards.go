package storage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/vlouvet/neonbench/internal/estimate"
)

// Rate cards are returned as estimate.RateCard rather than a storage-local
// type: the pricing package owns the domain shape, and mapping here keeps
// internal/estimate free of any database dependency.

const rateCardCols = `id, name, currency, is_default, markup_multiplier,
	labour_rate_per_hour, labour_setup_minutes, labour_minutes_per_foot,
	stick_length_mm, stick_waste_mm, sheet_area_sq_ft,
	source, synced_at, updated_at`

func scanRateCard(sc interface{ Scan(...any) error }) (estimate.RateCard, bool, error) {
	var (
		c        estimate.RateCard
		isDflt   int
		source   sql.NullString
		syncedAt sql.NullString
	)
	err := sc.Scan(&c.ID, &c.Name, &c.Currency, &isDflt, &c.MarkupMultiplier,
		&c.LabourRatePerHour, &c.LabourSetupMinutes, &c.LabourMinutesPerFoot,
		&c.StickLengthMM, &c.StickWasteMM, &c.SheetAreaSqFt,
		&source, &syncedAt, &c.UpdatedAt)
	if err != nil {
		return estimate.RateCard{}, false, err
	}
	c.Source, c.SyncedAt = source.String, syncedAt.String
	return c, isDflt != 0, nil
}

// ListRateCards returns every card with its items attached. Cards are few and
// items are small, so there is no lazy variant to get out of sync.
func ListRateCards(ctx context.Context, db *sql.DB) ([]estimate.RateCard, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+rateCardCols+` FROM rate_cards ORDER BY is_default DESC, name`)
	if err != nil {
		return nil, fmt.Errorf("query rate_cards: %w", err)
	}
	defer rows.Close()
	var out []estimate.RateCard
	for rows.Next() {
		c, _, err := scanRateCard(rows)
		if err != nil {
			return nil, fmt.Errorf("scan rate_card: %w", err)
		}
		out = append(out, c)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		items, err := listRateCardItems(ctx, db, out[i].ID)
		if err != nil {
			return nil, err
		}
		out[i].Items = items
	}
	return out, nil
}

// GetRateCard loads one card and its items.
func GetRateCard(ctx context.Context, db *sql.DB, id int64) (estimate.RateCard, error) {
	row := db.QueryRowContext(ctx, `SELECT `+rateCardCols+` FROM rate_cards WHERE id = ?`, id)
	c, _, err := scanRateCard(row)
	if errors.Is(err, sql.ErrNoRows) {
		return estimate.RateCard{}, ErrNotFound
	}
	if err != nil {
		return estimate.RateCard{}, fmt.Errorf("get rate_card: %w", err)
	}
	c.Items, err = listRateCardItems(ctx, db, c.ID)
	if err != nil {
		return estimate.RateCard{}, err
	}
	return c, nil
}

// DefaultRateCard returns the card flagged default, falling back to the
// lowest-id card so a database whose default flag was cleared still prices.
func DefaultRateCard(ctx context.Context, db *sql.DB) (estimate.RateCard, error) {
	row := db.QueryRowContext(ctx, `SELECT `+rateCardCols+`
	    FROM rate_cards ORDER BY is_default DESC, id ASC LIMIT 1`)
	c, _, err := scanRateCard(row)
	if errors.Is(err, sql.ErrNoRows) {
		return estimate.RateCard{}, ErrNotFound
	}
	if err != nil {
		return estimate.RateCard{}, fmt.Errorf("default rate_card: %w", err)
	}
	c.Items, err = listRateCardItems(ctx, db, c.ID)
	if err != nil {
		return estimate.RateCard{}, err
	}
	return c, nil
}

func listRateCardItems(ctx context.Context, db *sql.DB, cardID int64) ([]estimate.RateCardItem, error) {
	const q = `SELECT id, kind, qualifier, sku, label, unit, unit_cost, min_qty, pack_fee
	           FROM rate_card_items WHERE rate_card_id = ? ORDER BY kind, qualifier`
	rows, err := db.QueryContext(ctx, q, cardID)
	if err != nil {
		return nil, fmt.Errorf("query rate_card_items: %w", err)
	}
	defer rows.Close()
	out := []estimate.RateCardItem{}
	for rows.Next() {
		var (
			it   estimate.RateCardItem
			sku  sql.NullString
			cost sql.NullFloat64
		)
		if err := rows.Scan(&it.ID, &it.Kind, &it.Qualifier, &sku, &it.Label,
			&it.Unit, &cost, &it.MinQty, &it.PackFee); err != nil {
			return nil, fmt.Errorf("scan rate_card_item: %w", err)
		}
		it.SKU = sku.String
		// NULL stays nil. This is the whole reason UnitCost is a pointer:
		// an unpriced rate must not arrive downstream as a free one.
		if cost.Valid {
			v := cost.Float64
			it.UnitCost = &v
		}
		out = append(out, it)
	}
	return out, rows.Err()
}

// UpdateRateCardParams carries the editable card-level scalars. Every field is
// a pointer so a PATCH can move one number without restating the rest.
type UpdateRateCardParams struct {
	Name                 *string
	Currency             *string
	MarkupMultiplier     *float64
	LabourRatePerHour    *float64
	LabourSetupMinutes   *float64
	LabourMinutesPerFoot *float64
	StickLengthMM        *float64
	StickWasteMM         *float64
	SheetAreaSqFt        *float64
	Source               *string
	SyncedAt             *string
}

// UpdateRateCard applies a partial update and returns the reloaded card.
func UpdateRateCard(ctx context.Context, db *sql.DB, id int64, p UpdateRateCardParams) (estimate.RateCard, error) {
	set := []string{}
	args := []any{}
	add := func(col string, v any) { set = append(set, col+" = ?"); args = append(args, v) }

	if p.Name != nil {
		add("name", *p.Name)
	}
	if p.Currency != nil {
		add("currency", *p.Currency)
	}
	if p.MarkupMultiplier != nil {
		add("markup_multiplier", *p.MarkupMultiplier)
	}
	if p.LabourRatePerHour != nil {
		add("labour_rate_per_hour", *p.LabourRatePerHour)
	}
	if p.LabourSetupMinutes != nil {
		add("labour_setup_minutes", *p.LabourSetupMinutes)
	}
	if p.LabourMinutesPerFoot != nil {
		add("labour_minutes_per_foot", *p.LabourMinutesPerFoot)
	}
	if p.StickLengthMM != nil {
		add("stick_length_mm", *p.StickLengthMM)
	}
	if p.StickWasteMM != nil {
		add("stick_waste_mm", *p.StickWasteMM)
	}
	if p.SheetAreaSqFt != nil {
		add("sheet_area_sq_ft", *p.SheetAreaSqFt)
	}
	if p.Source != nil {
		add("source", *p.Source)
	}
	if p.SyncedAt != nil {
		add("synced_at", *p.SyncedAt)
	}
	if len(set) == 0 {
		return GetRateCard(ctx, db, id)
	}
	// updated_at is the provenance stamp a printed quote is traced by, so it
	// moves on every edit.
	set = append(set, `updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
	args = append(args, id)

	q := `UPDATE rate_cards SET ` + joinComma(set) + ` WHERE id = ?`
	res, err := db.ExecContext(ctx, q, args...)
	if err != nil {
		return estimate.RateCard{}, fmt.Errorf("update rate_card: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return estimate.RateCard{}, ErrNotFound
	}
	return GetRateCard(ctx, db, id)
}

// UpdateRateCardItemParams carries the editable item fields.
//
// ClearUnitCost exists because a nil UnitCost pointer already means "field not
// supplied" in a PATCH, so there would otherwise be no way to move a rate back
// to unpriced. Deleting a wrong price has to be as easy as setting one, or
// people leave bad numbers in place.
type UpdateRateCardItemParams struct {
	Label         *string
	SKU           *string
	Unit          *string
	UnitCost      *float64
	ClearUnitCost bool
	MinQty        *float64
	PackFee       *float64
}

// UpdateRateCardItem applies a partial update to one rate and returns the
// reloaded card, so a caller re-prices against a consistent snapshot.
func UpdateRateCardItem(ctx context.Context, db *sql.DB, cardID, itemID int64, p UpdateRateCardItemParams) (estimate.RateCard, error) {
	set := []string{}
	args := []any{}
	add := func(col string, v any) { set = append(set, col+" = ?"); args = append(args, v) }

	if p.Label != nil {
		add("label", *p.Label)
	}
	if p.SKU != nil {
		add("sku", *p.SKU)
	}
	if p.Unit != nil {
		add("unit", *p.Unit)
	}
	switch {
	case p.ClearUnitCost:
		add("unit_cost", nil)
	case p.UnitCost != nil:
		add("unit_cost", *p.UnitCost)
	}
	if p.MinQty != nil {
		add("min_qty", *p.MinQty)
	}
	if p.PackFee != nil {
		add("pack_fee", *p.PackFee)
	}
	if len(set) > 0 {
		args = append(args, itemID, cardID)
		q := `UPDATE rate_card_items SET ` + joinComma(set) + ` WHERE id = ? AND rate_card_id = ?`
		res, err := db.ExecContext(ctx, q, args...)
		if err != nil {
			return estimate.RateCard{}, fmt.Errorf("update rate_card_item: %w", err)
		}
		if n, _ := res.RowsAffected(); n == 0 {
			return estimate.RateCard{}, ErrNotFound
		}
		// A changed rate changes every quote printed after it, so the
		// card's provenance stamp moves too.
		if _, err := db.ExecContext(ctx,
			`UPDATE rate_cards SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`,
			cardID); err != nil {
			return estimate.RateCard{}, fmt.Errorf("stamp rate_card: %w", err)
		}
	}
	return GetRateCard(ctx, db, cardID)
}

func joinComma(parts []string) string {
	out := ""
	for i, p := range parts {
		if i > 0 {
			out += ", "
		}
		out += p
	}
	return out
}
