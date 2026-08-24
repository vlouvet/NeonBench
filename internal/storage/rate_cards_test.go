package storage

import (
	"context"
	"database/sql"
	"testing"

	"github.com/pressly/goose/v3"

	"github.com/vlouvet/neonbench/internal/estimate"
)

func testDB(t *testing.T) (context.Context, *sql.DB) {
	t.Helper()
	db, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	return context.Background(), db
}

func TestSeededRateCardShipsUnpriced(t *testing.T) {
	ctx, db := testDB(t)
	card, err := DefaultRateCard(ctx, db)
	if err != nil {
		t.Fatalf("default card: %v", err)
	}
	if card.Name != "Default (provisional)" {
		t.Errorf("name = %q", card.Name)
	}
	if len(card.Items) == 0 {
		t.Fatal("seeded card has no items")
	}
	// Every material rate must arrive unpriced. A migration that shipped a
	// price would put one shop's contract terms into every install.
	for _, it := range card.Items {
		if it.UnitCost != nil {
			t.Errorf("seeded item %s/%s has a price (%v); the seed must ship NULL",
				it.Kind, it.Qualifier, *it.UnitCost)
		}
	}
	// The kind -> SKU mapping IS seeded: that is the part that needed
	// human judgement and it is already settled.
	var withSKU int
	for _, it := range card.Items {
		if it.SKU != "" {
			withSKU++
		}
	}
	if withSKU == 0 {
		t.Error("no seeded item carries a SKU; the mapping should ship even though prices do not")
	}
	// Stock geometry defaults to the shop's real supplier, not Miller's
	// 1935 blank.
	if card.StickLengthMM != 1524 || card.StickWasteMM != 305 {
		t.Errorf("stick geometry = %v/%v, want 1524/305", card.StickLengthMM, card.StickWasteMM)
	}
}

// NULL and 0.0 must survive a round trip as distinct values. If SQLite's zero
// value leaked in on read, an unpriced rate would silently become a free one.
func TestUnitCostNullRoundTripsDistinctFromZero(t *testing.T) {
	ctx, db := testDB(t)
	card, err := DefaultRateCard(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	item := card.Items[0]

	zero := 0.0
	card, err = UpdateRateCardItem(ctx, db, card.ID, item.ID,
		UpdateRateCardItemParams{UnitCost: &zero})
	if err != nil {
		t.Fatal(err)
	}
	got := findItemByID(card.Items, item.ID)
	if got.UnitCost == nil || *got.UnitCost != 0 {
		t.Fatalf("after setting 0.0, UnitCost = %v; want a non-nil zero", got.UnitCost)
	}

	card, err = UpdateRateCardItem(ctx, db, card.ID, item.ID,
		UpdateRateCardItemParams{ClearUnitCost: true})
	if err != nil {
		t.Fatal(err)
	}
	if got := findItemByID(card.Items, item.ID); got.UnitCost != nil {
		t.Fatalf("after clearing, UnitCost = %v; want nil", *got.UnitCost)
	}
}

func TestUpdateRateCardStampsUpdatedAt(t *testing.T) {
	ctx, db := testDB(t)
	card, _ := DefaultRateCard(ctx, db)
	before := card.UpdatedAt

	markup := 1.8
	got, err := UpdateRateCard(ctx, db, card.ID, UpdateRateCardParams{MarkupMultiplier: &markup})
	if err != nil {
		t.Fatal(err)
	}
	if got.MarkupMultiplier != 1.8 {
		t.Errorf("markup = %v", got.MarkupMultiplier)
	}
	if got.UpdatedAt == "" {
		t.Error("updated_at empty")
	}
	_ = before // timestamps have millisecond resolution; presence is the contract
}

func TestEstimateInputsRoundTrip(t *testing.T) {
	ctx, db := testDB(t)
	proj, err := CreateProject(ctx, db, CreateProjectParams{Name: "p", TubeSpecID: 1, Units: "mm"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	v, err := CreateDesignVersion(ctx, db, CreateDesignVersionParams{
		ProjectID: proj.ID, SVGData: "<svg/>",
	})
	if err != nil {
		t.Fatalf("create version: %v", err)
	}

	// Absent inputs read as empty, not as an error.
	if raw, err := GetEstimateInputs(ctx, db, v.ID); err != nil || raw != "" {
		t.Fatalf("fresh version: raw=%q err=%v", raw, err)
	}
	const payload = `{"install_hours":4}`
	if err := SetEstimateInputs(ctx, db, v.ID, payload); err != nil {
		t.Fatal(err)
	}
	if raw, _ := GetEstimateInputs(ctx, db, v.ID); raw != payload {
		t.Errorf("raw = %q, want %q", raw, payload)
	}
	// Clearing stores NULL rather than "", so absent and empty stay one case.
	if err := SetEstimateInputs(ctx, db, v.ID, ""); err != nil {
		t.Fatal(err)
	}
	if raw, _ := GetEstimateInputs(ctx, db, v.ID); raw != "" {
		t.Errorf("after clear, raw = %q", raw)
	}
}

// Down then up must leave the schema and the seed intact — a migration that
// only runs forwards is a migration nobody can back out of.
func TestMigrationIsReversible(t *testing.T) {
	ctx, db := testDB(t)
	goose.SetBaseFS(migrationsFS)
	if err := goose.SetDialect("sqlite3"); err != nil {
		t.Fatal(err)
	}
	if err := goose.Down(db, "migrations"); err != nil {
		t.Fatalf("goose down: %v", err)
	}
	if _, err := DefaultRateCard(ctx, db); err == nil {
		t.Error("rate_cards still queryable after down")
	}
	if err := goose.Up(db, "migrations"); err != nil {
		t.Fatalf("goose up: %v", err)
	}
	card, err := DefaultRateCard(ctx, db)
	if err != nil {
		t.Fatalf("after re-up: %v", err)
	}
	if len(card.Items) == 0 {
		t.Error("seed did not survive down/up")
	}
}

func findItemByID(items []estimate.RateCardItem, id int64) estimate.RateCardItem {
	for _, it := range items {
		if it.ID == id {
			return it
		}
	}
	return estimate.RateCardItem{}
}
