package estimate

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/takeoff"
)

func f(v float64) *float64 { return &v }

func near(t *testing.T, got, want float64, what string) {
	t.Helper()
	if math.Abs(got-want) > 0.011 {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

// artechCard is a TEST FIXTURE, not seed data. These are the shop's verified
// contract prices as of 2026-08-24 (Odoo product.supplierinfo, company 2:
// FMS Sign Products and Grimco). They live here rather than in the migration
// because NeonBench ships to any shop and one shop's contract pricing does not
// belong in schema.
func artechCard() RateCard {
	return RateCard{
		ID: 1, Name: "Artech (fixture)", Currency: "USD",
		MarkupMultiplier:  2.22,
		LabourRatePerHour: 48,
		// Exact fit to the shop's three neon BoM operation times:
		// 4ft/150min, 7ft/240min, 11ft/360min.
		LabourSetupMinutes: 30, LabourMinutesPerFoot: 30,
		StickLengthMM: 1524, StickWasteMM: 305, SheetAreaSqFt: 32,
		Items: []RateCardItem{
			{Kind: takeoff.KindTube, Qualifier: "12mm/green", SKU: "MAT-M53", Unit: "ft", UnitCost: f(0.5962), MinQty: 5},
			{Kind: takeoff.KindTube, Qualifier: "12mm/purple", SKU: "MAT-M52", Unit: "ft", UnitCost: f(0.4000), MinQty: 5},
			{Kind: takeoff.KindTube, SKU: "MAT-M52", Unit: "ft", UnitCost: f(0.4000), MinQty: 5},
			{Kind: takeoff.KindElectrode, Qualifier: "12mm", SKU: "MAT-M55", Unit: "pair", UnitCost: f(1.3140), MinQty: 50},
			{Kind: takeoff.KindGasFill, SKU: "MAT-M57", Unit: "each", UnitCost: f(0.1380), MinQty: 250},
			{Kind: takeoff.KindTransformer, Qualifier: "12kv-30ma", SKU: "MAT-M58", Unit: "each", UnitCost: f(195.68)},
			{Kind: takeoff.KindBootEndcap, SKU: "MAT-M61", Unit: "each", UnitCost: f(0.9390), MinQty: 100},
			{Kind: takeoff.KindTubeSupport, SKU: "MAT-M60", Unit: "each", UnitCost: f(0.4080), MinQty: 500},
			{Kind: takeoff.KindBlockoutPaint, SKU: "MAT-M62", Unit: "L", UnitCost: f(27.7381)},
			{Kind: takeoff.KindBacking, SKU: "MAT-M40", Unit: "ft2", UnitCost: f(5.8391)},
		},
	}
}

// tubeRun builds a straight run of a given net length with two electrodes.
// setItem replaces the rate for a kind. findItem returns the FIRST match, so
// appending a second item for a kind that artechCard already carries would be
// silently ignored.
func setItem(card *RateCard, kind, unit string, cost *float64) {
	for i := range card.Items {
		if card.Items[i].Kind == kind {
			card.Items[i].Unit, card.Items[i].UnitCost = unit, cost
			return
		}
	}
	card.Items = append(card.Items, RateCardItem{Kind: kind, Unit: unit, UnitCost: cost})
}

func tubeRun(mm float64, colour string) designdoc.Run {
	return designdoc.Run{
		ID:         "r",
		Color:      colour,
		Polyline:   designdoc.Polyline{Points: [][2]float64{{0, 0}, {mm, 0}}},
		Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
	}
}

func priceDoc(d *designdoc.Doc, card RateCard, in takeoff.Inputs) Estimate {
	tk := takeoff.Compute(d, takeoff.Spec{DiameterMM: 12}, card.Yield(), card.LabourModel(), in)
	return Price(tk, card)
}

// The recorded cost against this shop's "Custom Neon - Large / Feature" SKU is
// $429 against a $950 list. That number is a stale hand-typed estimate: labour
// alone at the calibrated 6h x $48 is $288, and the transformer is $195.68, so
// real prices clear it before a single foot of glass is counted.
//
// This test's job is to prove the estimator NOTICES that, not to reproduce it.
// If it ever fails because the model came in under $429, the model has lost a
// cost line.
func TestLargeTierIsUnderwaterAtRealPrices(t *testing.T) {
	const recordedTierCost = 429.0
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(11*takeoff.MMPerFoot, "green")}}
	got := priceDoc(d, card, takeoff.Inputs{
		TransformerCount:     1,
		TransformerQualifier: "12kv-30ma",
	})

	near(t, got.LabourCost, 288, "LabourCost") // 30 + 30*11 min = 6h
	if got.IsProvisional {
		t.Fatalf("fixture should price every line; unpriced kinds: %v", got.UnpricedKinds)
	}
	if got.CostSubtotal <= recordedTierCost {
		t.Errorf("cost subtotal = %.2f, want > %.2f — the estimator must notice the "+
			"recorded tier cost cannot cover this build", got.CostSubtotal, recordedTierCost)
	}
	// And the markup convention does not deliver its nominal margin either.
	if got.ImpliedMarginPct <= 0 || got.ImpliedMarginPct >= 60 {
		t.Errorf("implied margin = %.1f%%, want a plausible positive figure", got.ImpliedMarginPct)
	}
}

// An unpriced line must be excluded, never zeroed-and-included. The difference
// is invisible in the total and total in its consequences.
func TestUnpricedLineIsExcludedAndFlagged(t *testing.T) {
	card := artechCard()
	for i := range card.Items {
		if card.Items[i].Kind == takeoff.KindTube {
			card.Items[i].UnitCost = nil // nobody has priced the glass yet
		}
	}
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(11*takeoff.MMPerFoot, "green")}}
	got := priceDoc(d, card, takeoff.Inputs{})

	if !got.IsProvisional || got.UnpricedCount == 0 {
		t.Fatalf("provisional=%v count=%d, want a flagged unpriced line",
			got.IsProvisional, got.UnpricedCount)
	}
	var tube *PricedLine
	for i := range got.Lines {
		if got.Lines[i].Kind == takeoff.KindTube {
			tube = &got.Lines[i]
		}
	}
	if tube == nil || !tube.Unpriced {
		t.Fatal("tube line not reported unpriced")
	}
	if tube.DrawCost != 0 {
		t.Errorf("unpriced line carries cost %v", tube.DrawCost)
	}
	// Material cost must reflect only the lines that actually have rates.
	priced := priceDoc(d, artechCard(), takeoff.Inputs{})
	if got.MaterialCost >= priced.MaterialCost {
		t.Errorf("material cost %v did not drop when glass lost its rate (%v)",
			got.MaterialCost, priced.MaterialCost)
	}
	if got.SKUlessTubeRetained() {
		t.Error("unpriced line was dropped from the output; it must still be shown")
	}
}

// SKUlessTubeRetained reports whether the tube line vanished — it must not.
func (e Estimate) SKUlessTubeRetained() bool {
	for _, l := range e.Lines {
		if l.Kind == takeoff.KindTube {
			return false
		}
	}
	return true
}

// 0.0 is a price. nil is the absence of one.
func TestZeroCostIsPricedNotUnpriced(t *testing.T) {
	card := artechCard()
	for i := range card.Items {
		if card.Items[i].Kind == takeoff.KindTube {
			card.Items[i].UnitCost = f(0)
		}
	}
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(3000, "green")}}
	got := priceDoc(d, card, takeoff.Inputs{})
	for _, l := range got.Lines {
		if l.Kind == takeoff.KindTube && l.Unpriced {
			t.Error("a deliberately free line was reported unpriced")
		}
	}
	if got.IsProvisional {
		t.Error("estimate marked provisional despite every line having a rate")
	}
}

// A one-off job routinely consumes less than a supplier will ship. Both
// numbers must survive, and the divergence must be visible.
func TestMinimumOrderSplit(t *testing.T) {
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{
		tubeRun(3000, "green"), tubeRun(3000, "green"), tubeRun(3000, "green"),
	}}
	d.Runs[1].ID, d.Runs[2].ID = "r2", "r3"
	got := priceDoc(d, card, takeoff.Inputs{})

	var el *PricedLine
	for i := range got.Lines {
		if got.Lines[i].Kind == takeoff.KindElectrode {
			el = &got.Lines[i]
		}
	}
	if el == nil {
		t.Fatal("no electrode line")
	}
	near(t, el.Qty, 3, "electrode pairs consumed")
	near(t, el.DrawCost, 3*1.3140, "electrode draw cost")
	near(t, el.OrderQty, 50, "electrode order qty (supplier minimum)")
	near(t, el.PurchaseCost, 50*1.3140, "electrode purchase cost")
	if !el.MinOrderDominates || !got.MinOrderDominates {
		t.Error("a 50-pair minimum against 3 pairs consumed must raise the divergence flag")
	}
	// Materials drawn must sit well below what a PO for this job alone would
	// cost. Compare like with like: PurchaseCost covers materials only, so
	// CostSubtotal (which carries labour) is not the number to test against.
	if got.MaterialCost >= got.PurchaseCost {
		t.Errorf("material draw %.2f should sit below the minimum-order purchase cost %.2f",
			got.MaterialCost, got.PurchaseCost)
	}
}

func TestPackFeeLandsOnPurchaseOnly(t *testing.T) {
	card := artechCard()
	for i := range card.Items {
		if card.Items[i].Kind == takeoff.KindTube {
			card.Items[i].PackFee = 25
		}
	}
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(3000, "green")}}
	withFee := priceDoc(d, card, takeoff.Inputs{})
	without := priceDoc(d, artechCard(), takeoff.Inputs{})

	near(t, withFee.MaterialCost, without.MaterialCost, "material cost unchanged by pack fee")
	if withFee.PurchaseCost <= without.PurchaseCost {
		t.Error("pack fee did not reach purchase cost")
	}
}

// An exact qualifier must beat a kind-wide fallback — coated glass priced at
// clear-glass rates is a 1.5x error that nobody would look twice at.
func TestExactQualifierBeatsWildcard(t *testing.T) {
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(3000, "green")}}
	got := priceDoc(d, card, takeoff.Inputs{})
	for _, l := range got.Lines {
		if l.Kind == takeoff.KindTube {
			if l.SKU != "MAT-M53" {
				t.Errorf("green tube matched SKU %q, want MAT-M53 (the coated rate)", l.SKU)
			}
			near(t, *l.UnitCost, 0.5962, "green unit cost")
		}
	}
}

func TestWildcardUsedWhenNoExactMatch(t *testing.T) {
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(3000, "chartreuse")}}
	got := priceDoc(d, card, takeoff.Inputs{})
	for _, l := range got.Lines {
		if l.Kind == takeoff.KindTube {
			if l.Unpriced {
				t.Error("an unqualified kind-wide rate should have matched")
			}
			near(t, *l.UnitCost, 0.4000, "fallback unit cost")
		}
	}
}

func TestLabourAlwaysPricedAndOverridable(t *testing.T) {
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(10*takeoff.MMPerFoot, "green")}}

	got := priceDoc(d, card, takeoff.Inputs{InstallHours: 4})
	near(t, got.LabourCost, 5.5*48+4*48, "labour at the card rate")

	card.Items = append(card.Items, RateCardItem{
		Kind: takeoff.KindLabourInstall, Unit: "hour", UnitCost: f(125),
	})
	got2 := priceDoc(d, card, takeoff.Inputs{InstallHours: 4})
	near(t, got2.LabourCost, 5.5*48+4*125, "install labour overridden per kind")
	if got2.IsProvisional {
		t.Error("labour must never be unpriced")
	}
}

func TestMarkupAndImpliedMargin(t *testing.T) {
	card := artechCard()
	d := &designdoc.Doc{Runs: []designdoc.Run{tubeRun(3000, "green")}}
	got := priceDoc(d, card, takeoff.Inputs{})

	near(t, got.Price, got.CostSubtotal*2.22, "price")
	near(t, got.ImpliedMarginPct, (1-1/2.22)*100, "implied margin")

	// A degenerate markup must not produce a negative price or a NaN margin.
	card.MarkupMultiplier = 0
	got2 := priceDoc(d, card, takeoff.Inputs{})
	near(t, got2.Price, got2.CostSubtotal, "price at markup 0 falls back to cost")
	if math.IsNaN(got2.ImpliedMarginPct) || math.IsInf(got2.ImpliedMarginPct, 0) {
		t.Errorf("implied margin = %v", got2.ImpliedMarginPct)
	}
}

func TestProvenanceIsEchoed(t *testing.T) {
	card := artechCard()
	card.UpdatedAt = "2026-08-24T19:00:00Z"
	got := priceDoc(&designdoc.Doc{}, card, takeoff.Inputs{})
	if got.RateCardID != 1 || got.RateCardName != "Artech (fixture)" ||
		got.RateCardUpdatedAt != "2026-08-24T19:00:00Z" || got.Currency != "USD" {
		t.Errorf("provenance not echoed: %+v", got)
	}
}

func TestEmptyTakeoffPricesToZero(t *testing.T) {
	got := Price(takeoff.Takeoff{}, artechCard())
	if got.CostSubtotal != 0 || got.Price != 0 || got.IsProvisional {
		t.Errorf("empty takeoff produced %+v", got)
	}
}

// A rate quoted in the wrong unit is worse than no rate: it produces a
// confident number that means nothing. Blockout paint is the real case —
// suppliers sell it by the gallon, the takeoff measures it in linear feet of
// tube, and multiplying the two is meaningless without a coverage figure.
func TestUnitMismatchIsExcludedNotMultiplied(t *testing.T) {
	card := artechCard()
	// Priced, but per litre against a line measured in feet.
	setItem(&card, takeoff.KindBlockoutPaint, "L", f(27.7381))
	d := &designdoc.Doc{Runs: []designdoc.Run{{
		ID: "r", Color: "green",
		Polyline:   designdoc.Polyline{Points: [][2]float64{{0, 0}, {500, 0}, {1000, 0}}},
		Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
		Blockouts:  []designdoc.Blockout{{StartLiveIndex: 0, EndLiveIndex: 2}},
	}}}
	got := priceDoc(d, card, takeoff.Inputs{})

	var paint *PricedLine
	for i := range got.Lines {
		if got.Lines[i].Kind == takeoff.KindBlockoutPaint {
			paint = &got.Lines[i]
		}
	}
	if paint == nil {
		t.Fatal("no blockout line")
	}
	if !paint.UnitMismatch {
		t.Error("a per-litre rate against a per-foot line was not flagged")
	}
	if !paint.Unpriced || paint.DrawCost != 0 {
		t.Errorf("mismatched line still priced: unpriced=%v cost=%v", paint.Unpriced, paint.DrawCost)
	}
	if !got.IsProvisional {
		t.Error("estimate not marked provisional despite a mismatched unit")
	}
	if len(got.UnitMismatchKinds) == 0 {
		t.Error("mismatch kind not reported, so nobody can find the rate to fix")
	}
}

// Matching units must still price normally — the check must not reject
// everything.
func TestMatchingUnitPricesNormally(t *testing.T) {
	card := artechCard()
	setItem(&card, takeoff.KindBlockoutPaint, "ft", f(2.0))
	d := &designdoc.Doc{Runs: []designdoc.Run{{
		ID:        "r",
		Polyline:  designdoc.Polyline{Points: [][2]float64{{0, 0}, {500, 0}, {1000, 0}}},
		Blockouts: []designdoc.Blockout{{StartLiveIndex: 0, EndLiveIndex: 2}},
	}}}
	got := priceDoc(d, card, takeoff.Inputs{})
	for _, l := range got.Lines {
		if l.Kind == takeoff.KindBlockoutPaint {
			if l.Unpriced || l.UnitMismatch {
				t.Errorf("matching units rejected: %+v", l)
			}
			near(t, l.DrawCost, 1000/takeoff.MMPerFoot*2.0, "blockout cost")
		}
	}
}

// An item with no unit recorded is treated as compatible: the check exists to
// catch a wrong unit, not to force every rate card to be fully annotated.
func TestBlankItemUnitIsNotAMismatch(t *testing.T) {
	card := artechCard()
	setItem(&card, takeoff.KindBlockoutPaint, "", f(2.0))
	d := &designdoc.Doc{Runs: []designdoc.Run{{
		ID:        "r",
		Polyline:  designdoc.Polyline{Points: [][2]float64{{0, 0}, {500, 0}, {1000, 0}}},
		Blockouts: []designdoc.Blockout{{StartLiveIndex: 0, EndLiveIndex: 2}},
	}}}
	for _, l := range priceDoc(d, card, takeoff.Inputs{}).Lines {
		if l.Kind == takeoff.KindBlockoutPaint && l.Unpriced {
			t.Error("an unannotated unit was treated as a mismatch")
		}
	}
}
