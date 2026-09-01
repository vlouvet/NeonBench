package printpdf

import (
	"fmt"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// RacewayGroups is the result of grouping face runs by their RacewayID.
// Runs with an empty RacewayID are NOT included — they remain individual
// per-run strip pages. The OrderedIDs slice carries each non-empty group
// id in the order it first appeared in the run list, so the printed PDF
// stays stable across saves (Strattman raceway pages always come back in
// the same order; the operator's printed stack is reproducible).
type RacewayGroups struct {
	ByID       map[string][]designdoc.Run
	OrderedIDs []string
}

// groupByRaceway buckets face runs that share a non-empty RacewayID.
// Non-face runs and runs with no raceway are skipped entirely (the
// caller iterates them separately to keep the per-run strip pages).
//
// The grouping is "pragmatic": Strattman raceway construction has
// shop-floor judgment built in (which letters share a strip, where
// the seams go), so V1 just trusts the user's RacewayID labels.
// Future polish can offer auto-grouping based on bbox proximity or
// baseline alignment (see follow-ups).
func groupByRaceway(runs []designdoc.Run) RacewayGroups {
	out := RacewayGroups{ByID: map[string][]designdoc.Run{}}
	for _, run := range runs {
		if !run.IsChannelLetterFace || run.RacewayID == "" {
			continue
		}
		if len(run.Polyline.Points) < 2 {
			continue
		}
		if _, ok := out.ByID[run.RacewayID]; !ok {
			out.OrderedIDs = append(out.OrderedIDs, run.RacewayID)
		}
		out.ByID[run.RacewayID] = append(out.ByID[run.RacewayID], run)
	}
	return out
}

// runDepthMM resolves the depth (mm) used for a single run's return
// strip. Resolution order:
//
//  1. Per-run override (run.ChannelLetterDepthMM, if non-nil and > 0)
//  2. Project default (projectDepthMM, the renderer's resolved fallback)
//  3. Shop default 100 mm — but the caller is expected to have already
//     substituted that for projectDepthMM ≤ 0, so this branch only
//     fires for explicit user "0" entries which we treat as "use the
//     project default".
func runDepthMM(run designdoc.Run, projectDepthMM float64) float64 {
	if run.ChannelLetterDepthMM != nil && *run.ChannelLetterDepthMM > 0 {
		return *run.ChannelLetterDepthMM
	}
	if projectDepthMM > 0 {
		return projectDepthMM
	}
	return 100
}

// emitNestedReturnStrip draws ONE combined unfolded RETURN strip page for a
// group of face runs sharing a RacewayID.
//
// THE NAME IS THE POINT (Tier 2 #104). This was called emitRacewayStrip and
// it never emitted a raceway: it concatenates the unfolded LETTER PERIMETER
// bands of several faces onto one piece of coil stock — width = the sum of
// those perimeters, height = the deepest letter. That is return-strip
// nesting. A raceway is one rectangular box sized to the sign's overall
// extent, following no letter's perimeter; it is emitted by emitRacewayPage
// in racewaypage.go, and it is ~203 mm deep because a transformer has to fit
// inside, where these strips are ~100 mm deep because that is how far the
// letter projects. Two objects, two depths, one name — see
// docs/neon-rules/raceway.md, "Terminology collision".
//
// The GROUPING is correct and stays: nesting the returns of letters that
// share a raceway is exactly what a shop does with a coil. Only the name
// moved, and Run.RacewayID keeps its name because it means what it says.
//
// Layout:
//
//   - Header: "Nested return strip — raceway {gid}" + per-run breakdown
//   - The strip itself: width = sum of contributing perimeters,
//     height = max(per-run depth) across the group (so the strip is one
//     rectangle big enough for every contribution).
//   - At each run boundary, a heavy dashed vertical line at the
//     cumulative-perimeter offset, labelled with the run id and its
//     contribution length.
//   - At every bend mark within each run's contribution, a regular
//     vertical tick (same convention as emitReturnStrip).
//   - A dashed shear line `opts.StripOverlapMM` from the right end
//     showing where the fabricator should cut for the seam overlap.
//   - Footer: total length, per-run depths, operator note about the
//     overlap allowance.
//
// The page scale matches emitReturnStrip's logic — 1:1 if it fits,
// otherwise uniformly scaled with a "scale 1:N" callout. Labels show
// actual mm values regardless of scale.
func emitNestedReturnStrip(pdf *gofpdf.Fpdf, opts Options, racewayID string, runs []designdoc.Run, projectDepthMM float64) {
	if len(runs) == 0 {
		return
	}
	pdf.AddPage()

	pageW, pageH := opts.Paper.WidthMM, opts.Paper.HeightMM
	if opts.Landscape {
		pageW, pageH = pageH, pageW
	}
	mx := opts.MarginMM
	contentW := pageW - 2*mx
	contentH := pageH - 2*mx

	overlapMM := opts.StripOverlapMM
	if overlapMM <= 0 {
		overlapMM = 12.7
	}

	// Per-run perimeter + depth + bend marks. Cumulative offset gives
	// each run's strip-X start.
	type runContribution struct {
		ID            string
		PerimeterMM   float64
		DepthMM       float64
		Marks         []returnStripBendMark
		StartOffsetMM float64
		Closed        bool
	}
	contributions := make([]runContribution, 0, len(runs))
	var totalPerimeter, maxDepth float64
	for _, run := range runs {
		closed := run.Polyline.Closed
		// Arc-aware, same as the single-run strip: an arc contributes its true
		// length and one bend mark per real vertex, not one per flattened
		// sample (Tier 3 #78).
		perim := run.Polyline.LengthMM()
		marks := returnStripBendMarks(&run.Polyline, closed)
		depth := runDepthMM(run, projectDepthMM)
		contributions = append(contributions, runContribution{
			ID:            run.ID,
			PerimeterMM:   perim,
			DepthMM:       depth,
			Marks:         marks,
			StartOffsetMM: totalPerimeter,
			Closed:        closed,
		})
		totalPerimeter += perim
		if depth > maxDepth {
			maxDepth = depth
		}
	}
	if totalPerimeter <= 0 || maxDepth <= 0 {
		// Degenerate group (all empty polylines) — skip silently.
		return
	}

	// Header.
	pdf.SetFont("Helvetica", "B", 14)
	pdf.Text(mx, mx+8, fmt.Sprintf("Nested return strip — raceway %s", racewayID))
	pdf.SetFont("Helvetica", "", 10)
	subhdr := fmt.Sprintf("%s — %s", opts.ProjectName, opts.DesignVersionLabel)
	if subhdr != " — " {
		pdf.Text(mx, mx+14, subhdr)
	}
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(mx, mx+20,
		fmt.Sprintf("%d run%s  ·  Total perimeter %.1f mm  ·  Max depth %.1f mm  ·  Overlap %.1f mm",
			len(contributions), pluralize(len(contributions)), totalPerimeter, maxDepth, overlapMM))

	// Layout: same headerHeightMM / tickLabelMM / footerMM split as
	// emitReturnStrip so a single-run raceway looks like a per-run
	// strip with a different title.
	const headerHeightMM = 30
	const tickLabelMM = 8
	const footerMM = 22 // a bit more room for per-run breakdown footer
	stripAreaW := contentW
	stripAreaH := contentH - headerHeightMM - tickLabelMM - footerMM
	if stripAreaH < maxDepth {
		stripAreaH = maxDepth
	}
	scale := 1.0
	if totalPerimeter > stripAreaW {
		scale = stripAreaW / totalPerimeter
	}
	if maxDepth*scale > stripAreaH {
		scale = stripAreaH / maxDepth
	}

	stripWidthOnPage := totalPerimeter * scale
	stripHeightOnPage := maxDepth * scale
	stripX := mx
	stripY := mx + headerHeightMM + tickLabelMM

	if scale < 1 {
		pdf.SetFont("Helvetica", "I", 9)
		pdf.Text(mx, mx+25, fmt.Sprintf("Drawing scale 1:%.0f — labels show actual mm values", 1/scale))
		pdf.SetFont("Helvetica", "", 9)
	}

	// Strip rectangle.
	pdf.SetDrawColor(0, 0, 0)
	pdf.SetLineWidth(opts.StrokeMM)
	pdf.Rect(stripX, stripY, stripWidthOnPage, stripHeightOnPage, "D")

	// Per-run depth indicator: when contributions don't all share the
	// max depth, draw a faint horizontal dotted line at each lower
	// depth so the operator sees where their strip "actually" ends
	// even though the printed rectangle is the union envelope.
	for _, c := range contributions {
		if c.DepthMM >= maxDepth-0.01 {
			continue
		}
		pdf.SetDashPattern([]float64{1, 1}, 0)
		pdf.SetLineWidth(0.2)
		x0 := stripX + c.StartOffsetMM*scale
		x1 := stripX + (c.StartOffsetMM+c.PerimeterMM)*scale
		yLine := stripY + c.DepthMM*scale
		pdf.Line(x0, yLine, x1, yLine)
		pdf.SetDashPattern([]float64{}, 0)
		pdf.SetLineWidth(opts.StrokeMM)
	}

	// Run-boundary dashed verticals at each cumulative offset (skip
	// the leading 0 boundary; the strip's left edge is already a line).
	pdf.SetFont("Helvetica", "B", 7)
	pdf.SetDashPattern([]float64{2, 1}, 0)
	pdf.SetLineWidth(0.45)
	for i, c := range contributions {
		if i == 0 {
			// Label the first run id at the left edge for context.
			pdf.Text(stripX+0.5, stripY-2, fmt.Sprintf("[%s] 0.0 mm", c.ID))
			continue
		}
		x := stripX + c.StartOffsetMM*scale
		pdf.Line(x, stripY-1, x, stripY+stripHeightOnPage+1)
		label := fmt.Sprintf("[%s] %.1f mm", c.ID, c.StartOffsetMM)
		tw := pdf.GetStringWidth(label)
		pdf.Text(x-tw/2, stripY-2, label)
	}
	pdf.SetDashPattern([]float64{}, 0)

	// Bend ticks within each run's contribution.
	pdf.SetFont("Helvetica", "", 7)
	pdf.SetLineWidth(0.3)
	for _, c := range contributions {
		base := c.StartOffsetMM
		for _, m := range c.Marks {
			abs := base + m.ArcLengthMM
			x := stripX + abs*scale
			// Skip tick at exactly the run boundary — that's a heavier
			// dashed boundary line already drawn above.
			if m.ArcLengthMM <= 0.001 {
				continue
			}
			pdf.Line(x, stripY, x, stripY+stripHeightOnPage)
			label := fmt.Sprintf("%.1f mm | %+.0f°", abs, m.AngleDeg)
			tw := pdf.GetStringWidth(label)
			pdf.Text(x-tw/2, stripY+stripHeightOnPage+5, label)
		}
	}

	// Shear line for the strip-overlap allowance, drawn `overlapMM`
	// in from the right end. Chosen to be the right end (not left)
	// so the fabricator's cut sequence reads "left edge first, shear
	// here at the end" — a small UX choice; both ends are valid in
	// trade practice. The footer note continues to display the value.
	if overlapMM > 0 && overlapMM*scale < stripWidthOnPage {
		shearX := stripX + stripWidthOnPage - overlapMM*scale
		pdf.SetDashPattern([]float64{2, 2}, 0)
		pdf.SetLineWidth(0.45)
		pdf.Line(shearX, stripY-2, shearX, stripY+stripHeightOnPage+2)
		pdf.SetDashPattern([]float64{}, 0)
		pdf.SetLineWidth(opts.StrokeMM)
		pdf.SetFont("Helvetica", "I", 7)
		shearLabel := fmt.Sprintf("shear here · %.1f mm overlap", overlapMM)
		pdf.Text(shearX+1, stripY+stripHeightOnPage-2, shearLabel)
	}

	// Footer with per-run breakdown.
	footerY := stripY + stripHeightOnPage + 11
	pdf.SetFont("Helvetica", "", 9)
	pdf.Text(stripX, footerY,
		fmt.Sprintf("Total length: %.1f mm. Bend at each tick. Shear at the dashed line for %.1f mm overlap.",
			totalPerimeter, overlapMM))
	pdf.SetFont("Helvetica", "", 8)
	footerY += 5
	for _, c := range contributions {
		closedNote := "open"
		if c.Closed {
			closedNote = "closed"
		}
		line := fmt.Sprintf("  %s — %.1f mm @ depth %.1f mm (%s)",
			c.ID, c.PerimeterMM, c.DepthMM, closedNote)
		pdf.Text(stripX, footerY, line)
		footerY += 4
	}
}
