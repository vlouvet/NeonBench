// Package estimate turns a takeoff into money.
//
// It is pure: no database, no HTTP, no clock. A rate card goes in, a priced
// estimate comes out, and the same pair always produces the same total — which
// is what lets a printed quote be traced back to the rates that made it.
//
// The rule that shapes everything here: a missing rate is never silently zero.
// A rate card with no price for glass must produce an estimate that says so,
// loudly, rather than one that quietly omits the most expensive line on the
// job. The shop's own ERP tooling arrived at the same rule independently — it
// rolls up only fully-priced bills of material, because "a BOM holding one
// unpriced material produces a confident-looking cost that is simply too low".
package estimate

import (
	"math"

	"github.com/vlouvet/neonbench/internal/takeoff"
)

// RateCardItem is one rate: what a line kind costs, per unit, from whom.
//
// UnitCost is a pointer on purpose. nil means "nobody has priced this yet" and
// the line is reported unpriced; 0.0 means "deliberately free". Collapsing the
// two is the bug this whole package is arranged to prevent.
type RateCardItem struct {
	ID        int64    `json:"id"`
	Kind      string   `json:"kind"`
	Qualifier string   `json:"qualifier,omitempty"`
	SKU       string   `json:"sku,omitempty"`
	Label     string   `json:"label"`
	Unit      string   `json:"unit"`
	UnitCost  *float64 `json:"unit_cost"`
	// MinQty is the supplier's minimum order for this item, in Unit. A
	// one-off sign routinely consumes less than a supplier will ship — 6
	// electrodes against a 50-pair minimum — so the quantity consumed and
	// the quantity purchasable are tracked separately and never merged.
	MinQty float64 `json:"min_qty,omitempty"`
	// PackFee is a flat per-order charge. On a minimum order it can be a
	// large fraction of the line, so it belongs in purchase cost and
	// nowhere near the per-job draw.
	PackFee float64 `json:"pack_fee,omitempty"`
}

// RateCard is a shop's costing configuration.
type RateCard struct {
	ID       int64  `json:"id"`
	Name     string `json:"name"`
	Currency string `json:"currency"`

	// MarkupMultiplier is an editable input with a defensible default, not
	// a law. The 2.22x convention this shop used held against hand-typed
	// estimates and does not survive verified supplier prices — the same
	// products land near 40% margin, not 55%. Never derive a margin from
	// this and present it as fact; compute it from the numbers.
	MarkupMultiplier float64 `json:"markup_multiplier"`

	LabourRatePerHour    float64 `json:"labour_rate_per_hour"`
	LabourSetupMinutes   float64 `json:"labour_setup_minutes"`
	LabourMinutesPerFoot float64 `json:"labour_minutes_per_foot"`

	StickLengthMM float64 `json:"stick_length_mm"`
	StickWasteMM  float64 `json:"stick_waste_mm"`
	SheetAreaSqFt float64 `json:"sheet_area_sq_ft"`

	Source    string `json:"source,omitempty"`
	SyncedAt  string `json:"synced_at,omitempty"`
	UpdatedAt string `json:"updated_at,omitempty"`

	Items []RateCardItem `json:"items"`
}

// Yield projects the card's stock geometry into the takeoff's shape.
func (c RateCard) Yield() takeoff.Yield {
	return takeoff.Yield{
		StickLengthMM: c.StickLengthMM,
		StickWasteMM:  c.StickWasteMM,
		SheetAreaSqFt: c.SheetAreaSqFt,
	}
}

// LabourModel projects the card's fabrication-time coefficients.
func (c RateCard) LabourModel() takeoff.LabourModel {
	return takeoff.LabourModel{
		SetupMinutes:   c.LabourSetupMinutes,
		MinutesPerFoot: c.LabourMinutesPerFoot,
	}
}

// PricedLine is one takeoff line with a rate applied.
type PricedLine struct {
	takeoff.Line

	SKU      string   `json:"sku,omitempty"`
	UnitCost *float64 `json:"unit_cost"`

	// Unpriced means no rate matched, the matched rate has no cost yet, or
	// the rate is quoted in a unit the line is not measured in. Unpriced
	// lines contribute nothing to any total — they are excluded, not
	// zeroed, and the estimate is marked provisional because of them.
	Unpriced bool `json:"unpriced"`

	// UnitMismatch means a rate exists but is quoted in the wrong unit —
	// blockout paint sold by the litre against a line measured in linear
	// feet, say. Multiplying those gives a confident number that means
	// nothing, so the line is excluded exactly like an unpriced one and
	// flagged separately so the fix is obvious: the rate card needs a
	// coverage figure (litres per foot), not a different price.
	UnitMismatch bool `json:"unit_mismatch,omitempty"`

	// DrawCost is what the sign consumes: Qty x UnitCost. This is the
	// estimate's basis, and it is the honest number when the material is
	// already on the shelf.
	DrawCost float64 `json:"draw_cost"`

	// OrderQty and PurchaseCost are what a purchase order for this job
	// alone would look like — every line rounded up to its supplier
	// minimum, plus packing. Advisory: folding this into the sell price
	// would put a whole case of electrodes on a one-off quote.
	OrderQty     float64 `json:"order_qty,omitempty"`
	PurchaseCost float64 `json:"purchase_cost,omitempty"`

	// MinOrderDominates flags a line whose purchase cost exceeds twice its
	// draw cost — the case where a one-off job is really buying inventory.
	MinOrderDominates bool `json:"min_order_dominates,omitempty"`
}

// Estimate is the priced result.
type Estimate struct {
	Lines []PricedLine `json:"lines"`

	MaterialCost float64 `json:"material_cost"`
	LabourCost   float64 `json:"labour_cost"`
	CostSubtotal float64 `json:"cost_subtotal"`

	MarkupMultiplier float64 `json:"markup_multiplier"`
	Price            float64 `json:"price"`
	ImpliedMarginPct float64 `json:"implied_margin_pct"`

	// PurchaseCost is the sum of the advisory per-line purchase costs. It
	// is NOT part of Price and must never be presented as if it were.
	PurchaseCost float64 `json:"purchase_cost"`

	UnpricedCount int      `json:"unpriced_count"`
	UnpricedKinds []string `json:"unpriced_kinds,omitempty"`
	// UnitMismatchKinds lists the kinds whose rate is in the wrong unit.
	UnitMismatchKinds []string `json:"unit_mismatch_kinds,omitempty"`
	// IsProvisional is true whenever any line lacks a rate. A provisional
	// estimate still shows a total, because a partial number is useful, but
	// it must be labelled everywhere it appears.
	IsProvisional bool `json:"is_provisional"`
	// MinOrderDominates is true when any line's purchase cost more than
	// doubles its draw cost.
	MinOrderDominates bool `json:"min_order_dominates"`

	// Provenance, so a printed quote can be traced to the rates behind it.
	RateCardID        int64  `json:"rate_card_id"`
	RateCardName      string `json:"rate_card_name"`
	RateCardUpdatedAt string `json:"rate_card_updated_at,omitempty"`
	Currency          string `json:"currency"`
}

// isLabour reports whether a kind is priced off the card's hourly rate rather
// than a material rate.
func isLabour(kind string) bool {
	switch kind {
	case takeoff.KindLabourFab, takeoff.KindLabourInstall, takeoff.KindLabourDesign:
		return true
	}
	return false
}

// findItem resolves a line to a rate. Exact (kind, qualifier) wins; a
// kind-wide rate with an empty qualifier is the fallback. No fuzzy matching —
// a near-miss that silently prices coated glass at clear-glass rates is worse
// than an unpriced line, because nobody looks twice at a number that appeared.
func findItem(items []RateCardItem, kind, qualifier string) *RateCardItem {
	var wildcard *RateCardItem
	for i := range items {
		it := &items[i]
		if it.Kind != kind {
			continue
		}
		if it.Qualifier == qualifier {
			return it
		}
		if it.Qualifier == "" && wildcard == nil {
			wildcard = it
		}
	}
	return wildcard
}

// Price applies a rate card to a takeoff.
func Price(t takeoff.Takeoff, card RateCard) Estimate {
	e := Estimate{
		MarkupMultiplier:  card.MarkupMultiplier,
		RateCardID:        card.ID,
		RateCardName:      card.Name,
		RateCardUpdatedAt: card.UpdatedAt,
		Currency:          card.Currency,
	}
	if e.Currency == "" {
		e.Currency = "USD"
	}

	seenUnpriced := map[string]bool{}
	seenMismatch := map[string]bool{}

	for _, l := range t.Lines {
		pl := PricedLine{Line: l}

		if isLabour(l.Kind) {
			// Labour always has a rate: the card carries one. A per-kind
			// item can still override it — install is often billed
			// differently from bench time.
			rate := card.LabourRatePerHour
			if it := findItem(card.Items, l.Kind, l.Qualifier); it != nil && it.UnitCost != nil {
				rate = *it.UnitCost
				pl.SKU = it.SKU
			}
			pl.UnitCost = &rate
			pl.DrawCost = round2(l.Qty * rate)
			e.LabourCost += pl.DrawCost
			e.Lines = append(e.Lines, pl)
			continue
		}

		it := findItem(card.Items, l.Kind, l.Qualifier)
		mismatch := it != nil && it.Unit != "" && it.Unit != l.Unit
		if it == nil || it.UnitCost == nil || mismatch {
			pl.Unpriced = true
			pl.UnitMismatch = mismatch
			if it != nil {
				pl.SKU = it.SKU
			}
			e.UnpricedCount++
			if !seenUnpriced[l.Kind] {
				seenUnpriced[l.Kind] = true
				e.UnpricedKinds = append(e.UnpricedKinds, l.Kind)
			}
			if mismatch && !seenMismatch[l.Kind] {
				seenMismatch[l.Kind] = true
				e.UnitMismatchKinds = append(e.UnitMismatchKinds, l.Kind)
			}
			e.Lines = append(e.Lines, pl)
			continue
		}

		cost := *it.UnitCost
		pl.SKU, pl.UnitCost = it.SKU, &cost
		pl.DrawCost = round2(l.Qty * cost)
		e.MaterialCost += pl.DrawCost

		orderQty := l.Qty
		if it.MinQty > orderQty {
			orderQty = it.MinQty
		}
		pl.OrderQty = orderQty
		pl.PurchaseCost = round2(orderQty*cost + it.PackFee)
		e.PurchaseCost += pl.PurchaseCost
		if pl.DrawCost > 0 && pl.PurchaseCost > 2*pl.DrawCost {
			pl.MinOrderDominates = true
			e.MinOrderDominates = true
		}

		e.Lines = append(e.Lines, pl)
	}

	e.MaterialCost = round2(e.MaterialCost)
	e.LabourCost = round2(e.LabourCost)
	e.PurchaseCost = round2(e.PurchaseCost)
	e.CostSubtotal = round2(e.MaterialCost + e.LabourCost)

	markup := card.MarkupMultiplier
	if markup <= 0 {
		markup = 1
	}
	e.Price = round2(e.CostSubtotal * markup)

	// Computed from the numbers actually present, not derived from the
	// markup constant — so it stays honest if either side is edited.
	if e.Price > 0 {
		e.ImpliedMarginPct = round2((e.Price - e.CostSubtotal) / e.Price * 100)
	}

	e.IsProvisional = e.UnpricedCount > 0
	return e
}

// round2 snaps to cents. Called only at the boundary — every accumulation
// above runs in full precision first.
func round2(v float64) float64 { return math.Round(v*100) / 100 }
