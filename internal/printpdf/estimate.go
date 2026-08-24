package printpdf

import (
	"bytes"
	"fmt"
	"strings"

	"github.com/phpdave11/gofpdf"

	"github.com/vlouvet/neonbench/internal/estimate"
	"github.com/vlouvet/neonbench/internal/takeoff"
)

// The quote sheet is a SEPARATE emitter from the pattern pipeline in
// render.go, with its own entry point and its own endpoint. A shop prints a
// pattern for the bench and a quote for the customer; they go to different
// people, on different days, and bundling them would mean every pattern print
// carries pricing a bender does not need and a customer should not see.

// EstimateOptions carries the header fields a quote sheet needs. Everything
// else comes from the takeoff and the estimate.
type EstimateOptions struct {
	Paper              Paper
	MarginMM           float64
	ProjectName        string
	DesignVersionLabel string
	Customer           string
	JobNumber          string
	TubeSpecName       string
}

// DefaultEstimateOptions returns letter-portrait with the shared 10 mm margin.
func DefaultEstimateOptions() EstimateOptions {
	return EstimateOptions{Paper: PaperLetter, MarginMM: 10}
}

// RenderEstimate emits a one-page quote sheet: quantities, priced lines,
// totals, and — when any rate is missing — a provisional banner that is
// impossible to miss.
func RenderEstimate(t takeoff.Takeoff, e estimate.Estimate, opts EstimateOptions) ([]byte, error) {
	if opts.Paper.WidthMM == 0 {
		opts.Paper = PaperLetter
	}
	if opts.MarginMM <= 0 {
		opts.MarginMM = 10
	}
	w, h := opts.Paper.WidthMM, opts.Paper.HeightMM
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		UnitStr: "mm", Size: gofpdf.SizeType{Wd: w, Ht: h},
	})
	pdf.SetMargins(opts.MarginMM, opts.MarginMM, opts.MarginMM)
	pdf.SetAutoPageBreak(true, opts.MarginMM)
	pdf.AddPage()

	mx := opts.MarginMM
	usable := w - 2*mx

	pdf.SetFont("Helvetica", "B", 16)
	pdf.CellFormat(usable, 8, "Estimate", "", 1, "L", false, 0, "")
	pdf.SetFont("Helvetica", "", 9)
	pdf.CellFormat(usable, 5, headerLine(opts), "", 1, "L", false, 0, "")
	if e.RateCardName != "" {
		// Provenance: a printed quote has to be traceable to the rates that
		// produced it, or it cannot be checked six months later.
		stamp := "Rates: " + e.RateCardName
		if e.RateCardUpdatedAt != "" {
			stamp += " (updated " + e.RateCardUpdatedAt + ")"
		}
		pdf.CellFormat(usable, 5, stamp, "", 1, "L", false, 0, "")
	}
	pdf.Ln(2)

	if e.IsProvisional {
		drawBanner(pdf, usable, fmt.Sprintf(
			"PROVISIONAL — %d UNPRICED LINE%s (%s)",
			e.UnpricedCount, plural(e.UnpricedCount), strings.Join(e.UnpricedKinds, ", ")))
	}

	drawQuantities(pdf, usable, t)
	pdf.Ln(3)
	drawPricedLines(pdf, usable, e)
	pdf.Ln(2)
	drawTotals(pdf, usable, e)

	if e.MinOrderDominates {
		pdf.Ln(3)
		pdf.SetFont("Helvetica", "I", 8)
		pdf.MultiCell(usable, 4,
			"Note: one or more lines cost more than twice as much to buy as this job "+
				"consumes, because of supplier minimum orders. The purchase figure is what a "+
				"purchase order for this job alone would cost; it is not included in the price.",
			"", "L", false)
	}

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		return nil, fmt.Errorf("render estimate pdf: %w", err)
	}
	return buf.Bytes(), nil
}

func headerLine(o EstimateOptions) string {
	parts := []string{o.ProjectName}
	if o.DesignVersionLabel != "" {
		parts = append(parts, o.DesignVersionLabel)
	}
	if o.Customer != "" {
		parts = append(parts, o.Customer)
	}
	if o.JobNumber != "" {
		parts = append(parts, "job "+o.JobNumber)
	}
	if o.TubeSpecName != "" {
		parts = append(parts, o.TubeSpecName)
	}
	return strings.Join(parts, " · ")
}

// drawBanner renders the provisional warning as a filled bar. A quote missing
// its most expensive line must not be distinguishable from a complete one only
// by a number someone has to notice.
func drawBanner(pdf *gofpdf.Fpdf, usable float64, text string) {
	pdf.SetFillColor(255, 235, 200)
	pdf.SetDrawColor(200, 120, 0)
	pdf.SetFont("Helvetica", "B", 10)
	pdf.CellFormat(usable, 8, text, "1", 1, "C", true, 0, "")
	pdf.SetFillColor(255, 255, 255)
	pdf.SetDrawColor(0, 0, 0)
	pdf.Ln(2)
}

func drawQuantities(pdf *gofpdf.Fpdf, usable float64, t takeoff.Takeoff) {
	pdf.SetFont("Helvetica", "B", 11)
	pdf.CellFormat(usable, 6, "Quantities", "", 1, "L", false, 0, "")
	pdf.SetFont("Helvetica", "", 9)

	s := t.Summary
	rows := [][2]string{
		{"Net tube (lit)", fmt.Sprintf("%.2f ft", s.NetTubeFt)},
		{"Gross glass (ordered)", fmt.Sprintf("%.2f ft in %d stick%s", s.GrossGlassFt, s.StickCount, plural(s.StickCount))},
		{"Runs / bends / splices", fmt.Sprintf("%d / %d / %d", s.RunCount, s.BendCount, s.SpliceCount)},
		{"Electrodes", fmt.Sprintf("%d (%d pair)", s.ElectrodeCount, s.ElectrodePairs)},
		{"Pumped sections", fmt.Sprintf("%d", s.PumpedSections)},
	}
	if s.JumperFt > 0 {
		rows = append(rows, [2]string{"Jumpers", fmt.Sprintf("%.2f ft in %d", s.JumperFt, s.JumperCount)})
	}
	if s.BlockoutFt > 0 {
		rows = append(rows, [2]string{"Blockout", fmt.Sprintf("%.2f ft", s.BlockoutFt)})
	}
	if s.BackingBBoxSqFt > 0 {
		label := "Backing"
		if s.BackingIsBBox {
			// Never present a bounding box as a cut area — a shaped panel
			// is smaller, and quoting the box overcharges.
			label = "Backing (bounding box)"
		}
		rows = append(rows, [2]string{label,
			fmt.Sprintf("%.2f sq ft — %d sheet%s", s.BackingBBoxSqFt, s.BackingSheets, plural(s.BackingSheets))})
	}
	rows = append(rows, [2]string{"Fabrication", fmt.Sprintf("%.2f h", s.FabricationHours)})
	rows = append(rows, [2]string{"Stock basis",
		fmt.Sprintf("%.0f mm stick less %.0f mm handling; %.0f mm lead-in per electrode",
			t.Yield.StickLengthMM, t.Yield.StickWasteMM, t.LeadInMM)})

	labelW := usable * 0.42
	for _, r := range rows {
		pdf.CellFormat(labelW, 5, r[0], "", 0, "L", false, 0, "")
		pdf.CellFormat(usable-labelW, 5, r[1], "", 1, "L", false, 0, "")
	}
}

func drawPricedLines(pdf *gofpdf.Fpdf, usable float64, e estimate.Estimate) {
	pdf.SetFont("Helvetica", "B", 11)
	pdf.CellFormat(usable, 6, "Lines", "", 1, "L", false, 0, "")

	wDesc := usable * 0.40
	wQty := usable * 0.16
	wRate := usable * 0.16
	wCost := usable * 0.14
	wBuy := usable - wDesc - wQty - wRate - wCost

	pdf.SetFont("Helvetica", "B", 8)
	pdf.CellFormat(wDesc, 5, "Item", "B", 0, "L", false, 0, "")
	pdf.CellFormat(wQty, 5, "Qty", "B", 0, "R", false, 0, "")
	pdf.CellFormat(wRate, 5, "Rate", "B", 0, "R", false, 0, "")
	pdf.CellFormat(wCost, 5, "Cost", "B", 0, "R", false, 0, "")
	pdf.CellFormat(wBuy, 5, "To buy", "B", 1, "R", false, 0, "")

	pdf.SetFont("Helvetica", "", 8)
	for _, l := range e.Lines {
		desc := l.Label
		if l.Qualifier != "" {
			desc += " (" + l.Qualifier + ")"
		}
		if l.SKU != "" {
			desc += " · " + l.SKU
		}
		rate, cost, buy := "—", "—", ""
		if l.Unpriced {
			// Spelled out on the line itself. A dash alone reads as "no
			// charge" at a glance, which is exactly the wrong inference.
			rate, cost = "UNPRICED", "excluded"
		} else {
			if l.UnitCost != nil {
				rate = fmt.Sprintf("%.4f", *l.UnitCost)
			}
			cost = fmt.Sprintf("%.2f", l.DrawCost)
			if l.OrderQty > l.Qty {
				buy = fmt.Sprintf("%.0f %s = %.2f", l.OrderQty, l.Unit, l.PurchaseCost)
			}
		}
		pdf.CellFormat(wDesc, 4.5, trunc(desc, 46), "", 0, "L", false, 0, "")
		pdf.CellFormat(wQty, 4.5, fmt.Sprintf("%.2f %s", l.Qty, l.Unit), "", 0, "R", false, 0, "")
		pdf.CellFormat(wRate, 4.5, rate, "", 0, "R", false, 0, "")
		pdf.CellFormat(wCost, 4.5, cost, "", 0, "R", false, 0, "")
		pdf.CellFormat(wBuy, 4.5, buy, "", 1, "R", false, 0, "")
	}
}

func drawTotals(pdf *gofpdf.Fpdf, usable float64, e estimate.Estimate) {
	labelW := usable * 0.70
	row := func(style string, size float64, label, value string) {
		pdf.SetFont("Helvetica", style, size)
		pdf.CellFormat(labelW, 5.5, label, "", 0, "R", false, 0, "")
		pdf.CellFormat(usable-labelW, 5.5, value, "", 1, "R", false, 0, "")
	}
	cur := e.Currency
	if cur == "" {
		cur = "USD"
	}
	money := func(v float64) string { return fmt.Sprintf("%s %.2f", cur, v) }

	row("", 9, "Materials", money(e.MaterialCost))
	row("", 9, "Labour", money(e.LabourCost))
	row("B", 9, "Cost subtotal", money(e.CostSubtotal))
	row("", 9, fmt.Sprintf("Markup ×%.2f", e.MarkupMultiplier), "")
	row("B", 12, "Price", money(e.Price))
	// The cost side is shown deliberately: a shop that can only see the sell
	// price cannot tell when a job has gone underwater.
	row("", 8, fmt.Sprintf("Implied margin %.1f%%", e.ImpliedMarginPct), "")
	if e.PurchaseCost > 0 {
		row("", 8, "Materials at supplier minimums (advisory, not in price)", money(e.PurchaseCost))
	}
}

func trunc(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
