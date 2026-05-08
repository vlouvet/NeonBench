// Package printdxf emits a minimal AutoCAD R12 ASCII DXF representation of
// a designdoc.Doc, suitable for feeding to CNC tube benders.
//
// V1 scope was geometry only (one LWPOLYLINE per Run.Polyline, layered per
// run id). Tier 3 #21 extended this with three annotation entity types:
// electrode markers (CIRCLE on layer ELECTRODES), human-readable run+free-form
// labels (TEXT on layer LABELS), and dimension lines with measured text
// (LINE+TEXT pairs on layer DIMENSIONS). Tier 3 #38a adds two more annotation
// categories: per-Run.Annotations point markers (CIRCLE+TEXT on layer MARKERS)
// and per-Run.Blockouts dashed traces (LWPOLYLINE on layer BLOCKOUTS).
//
// Why R12 (AC1009) by default?
//   - Lowest-common-denominator dialect; every tube-bender CAM importer
//     accepts it. Newer dialects (R2000+) require an OBJECTS section,
//     handle tables, and class definitions that the bender doesn't care
//     about.
//   - LWPOLYLINE first appeared in R14 strictly speaking, but in practice
//     R12 ASCII files containing LWPOLYLINE entities are what every CAM
//     package on the market parses without complaint — including legacy
//     Pines and Eagle controllers. Sticking to LWPOLYLINE keeps each run
//     a single entity rather than an exploded LINE chain.
//
// R2000 dialect (Tier 3 #38a). EmitDXFDialect lets a caller choose AC1015
// (R2000) instead of AC1009 (R12). The output is otherwise structurally
// identical — we don't add OBJECTS, CLASSES, or BLOCK_RECORD plumbing,
// because the only meaningful difference for our entity set is the version
// string in $ACADVER and the fact that LWPOLYLINE is officially supported
// in R2000+ rather than tolerated. R2000 is the lowest dialect that has
// proper LWPOLYLINE width support and DEFPOINTS, which a few high-end
// drafting packages prefer to see when round-tripping our DXF through their
// editor before re-exporting to the bender. We don't expose R2018/R2024
// because they add nothing the shop floor cares about.
//
// Why not real DIMENSION entities for measured callouts?
//   R12 DIMENSION requires a BLOCK reference for the leader/arrow geometry
//   (group code 2 names a *DimXX block in the BLOCKS section), plus a
//   matching *DimXX *MODEL_SPACE entry, plus a DIMSTYLE. That's ~5x the
//   code and table-section plumbing we'd otherwise skip in R12 ASCII —
//   and every CAM importer on the market renders LINE+TEXT identically to
//   a parsed DIMENSION for visual purposes. Bender controllers ignore
//   DIMENSION entities anyway (they only consume the LWPOLYLINE feed).
//   So we emit LINE+TEXT and document the deliberate choice. If a future
//   user wants printed shop drawings with proper extension lines and
//   arrowheads, that's a separate effort (and likely belongs in the PDF
//   pipeline).
//
// Why entity-level linetypes (group code 6) for markers/blockouts?
//   R12 strictly requires LTYPE entries declared in a TABLES section before
//   any entity references them. In practice every CAM importer on the
//   market accepts an undefined linetype name, falling back to CONTINUOUS.
//   The bender only consumes the geometry feed (RUN_* layer LWPOLYLINEs)
//   anyway — markers and blockouts are operator-facing aids that just need
//   to be visually distinct in the CAM viewer. Emitting bare group code 6
//   keeps the file small and avoids hand-rolling a TABLES section. If a
//   future importer rejects undefined linetypes, we'll add the LTYPE table.
//
// All coordinates are millimeters ($INSUNITS = 4).
package printdxf

import (
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// Layer-name constants. These are stable contracts: bender CAM operators
// rely on layer filtering to isolate the geometry feed from annotations.
// Uppercase, no prefix — matches the existing RUN_<id> convention's
// uppercase head.
const (
	layerElectrodes = "ELECTRODES"
	layerLabels     = "LABELS"
	layerDimensions = "DIMENSIONS"
	layerMarkers    = "MARKERS"
	layerBlockouts  = "BLOCKOUTS"
)

// Annotation geometry constants. Magic numbers extracted so future
// adjustments (or per-shop overrides) have a single place to land.
const (
	electrodeRadiusMM    = 3.0
	annotationTextHeight = 5.0
	dimensionTextOffset  = 5.0  // perpendicular offset, mm; one text-height
	dimensionMinLengthMM = 0.01 // shorter dims are skipped as degenerate

	// Per-kind marker radii (Tier 3 #38a). Chosen to give the operator a
	// quick visual ranking on the CAM screen: doubleback (largest) >
	// jump > support. Sizes also map to the relative shop-floor effort
	// each annotation implies — a doubleback bend is the most fiddly,
	// a jump needs deliberate clearance, a support is just a clip.
	markerRadiusJump       = 4.0
	markerRadiusSupport    = 3.0
	markerRadiusDoubleback = 5.0

	// Marker text offset = one text-height along the right-hand normal,
	// matching the dimensions convention so the operator's eye reads the
	// label position consistently across annotation categories.
	markerTextOffset = annotationTextHeight
)

// Linetype names referenced on entities via group code 6. R12 expects
// these to be declared in an LTYPE table; in practice every CAM importer
// tolerates undefined names (falling back to CONTINUOUS). See package
// docstring for the full rationale.
const (
	lineTypeContinuous = "CONTINUOUS"
	lineTypeDashed     = "DASHED"
	lineTypeDashdot    = "DASHDOT"
)

// Dialect selects the DXF version string. R12 (AC1009) is the historical
// default and the byte-compat baseline. R2000 (AC1015) is offered for
// shops whose drafting front-end prefers a newer dialect; it changes only
// the $ACADVER value, not the entity layout.
type Dialect int

const (
	DialectR12   Dialect = iota // AC1009 — default
	DialectR2000                // AC1015
)

// acadVer returns the $ACADVER token string for the dialect.
func (d Dialect) acadVer() string {
	if d == DialectR2000 {
		return "AC1015"
	}
	return "AC1009"
}

// EmitDXF writes an AutoCAD R12 (AC1009) ASCII DXF representation of doc
// to w. Equivalent to EmitDXFDialect(w, doc, DialectR12). See that
// function's docstring for entity layout details.
func EmitDXF(w io.Writer, doc *designdoc.Doc) error {
	return EmitDXFDialect(w, doc, DialectR12)
}

// EmitDXFDialect writes an AutoCAD ASCII DXF representation of doc to w
// in the requested dialect (R12 or R2000). One LWPOLYLINE per non-empty
// Run.Polyline; closed runs use the closed flag (group code 70 = 1).
// Layer name is "RUN_<id>", sanitized to the DXF name-character set.
// Units are millimeters.
//
// Annotations follow the polylines in the ENTITIES section in a fixed
// order: electrodes, run labels, free-form labels, dimensions, markers,
// blockouts. Predictable ordering keeps regression diffs readable.
//
// EmitDXFDialect returns an error only if the underlying writer fails. A
// doc with zero runs is not an error — the resulting file is a valid (if
// empty) DXF that bender CAM software opens cleanly.
//
// Byte-compat invariant. For docs with no annotation content of any kind
// (no electrodes, no labels, no dimensions, no run-annotations, no
// blockouts), R12 output is byte-identical to the pre-Tier-3 #21 emitter.
// R2000 output differs only in the $ACADVER value. This preserves the
// regression contract for the large fleet of legacy design versions in
// the field.
func EmitDXFDialect(w io.Writer, doc *designdoc.Doc, dialect Dialect) error {
	if doc == nil {
		return fmt.Errorf("printdxf: nil doc")
	}

	var b strings.Builder
	// Pre-grow: ~200 bytes header + ~50 bytes per polyline point + a small
	// allowance for annotations (each is a few hundred bytes at most).
	approxPoints := 0
	for _, r := range doc.Runs {
		approxPoints += len(r.Polyline.Points)
	}
	b.Grow(256 + approxPoints*40 + 256)

	// HEADER section: declare dialect + millimeter units.
	pair(&b, 0, "SECTION")
	pair(&b, 2, "HEADER")
	pair(&b, 9, "$ACADVER")
	pair(&b, 1, dialect.acadVer())
	pair(&b, 9, "$INSUNITS")
	pairInt(&b, 70, 4) // 4 = millimeters
	pair(&b, 0, "ENDSEC")

	// ENTITIES section: one LWPOLYLINE per run, then annotations.
	pair(&b, 0, "SECTION")
	pair(&b, 2, "ENTITIES")
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) == 0 {
			continue
		}
		layer := layerName(run.ID)
		pair(&b, 0, "LWPOLYLINE")
		pair(&b, 8, layer)
		// 70 = polyline flag; 1 = closed, 0 = open. Tube benders honor
		// this to know whether to bend a return-to-origin segment.
		if run.Polyline.Closed {
			pairInt(&b, 70, 1)
		} else {
			pairInt(&b, 70, 0)
		}
		// 90 = vertex count (R14+ extension to LWPOLYLINE; R12 importers
		// that don't recognize it ignore it harmlessly, while modern CAM
		// uses it to pre-allocate).
		pairInt(&b, 90, len(pts))
		for _, p := range pts {
			pairFloat(&b, 10, p[0])
			pairFloat(&b, 20, p[1])
		}
	}

	// Annotations: append-only, fixed order so regression diffs stay tidy.
	// The whole annotation block is gated on the doc having any annotation
	// content. When none of those exist, the DXF stays geometry-only and
	// byte-identical to the pre-Tier-3 #21 output — preserving the
	// contract for the large fleet of legacy design versions that predate
	// annotations. This includes the per-run "Run N" labels: they're a
	// recognition aid that's only useful when the operator is also
	// looking at electrodes/labels/dims/markers/blockouts, and emitting
	// them unconditionally would break byte-compat for existing DXFs in
	// the wild.
	if hasAnnotations(doc) {
		emitElectrodes(&b, doc)
		emitRunLabels(&b, doc)
		emitFreeFormLabels(&b, doc)
		emitDimensions(&b, doc)
		emitMarkers(&b, doc)
		emitBlockouts(&b, doc)
	}

	pair(&b, 0, "ENDSEC")

	pair(&b, 0, "EOF")

	_, err := io.WriteString(w, b.String())
	return err
}

// hasAnnotations reports whether doc carries any annotation content that
// should trigger the annotation-emission block. Returns false for legacy
// docs (no electrodes, no free-form labels, no dimensions, no run
// annotations, no blockouts), preserving byte-identical R12 output for
// pre-Tier-3 design versions.
func hasAnnotations(doc *designdoc.Doc) bool {
	if len(doc.Labels) > 0 || len(doc.Dimensions) > 0 {
		return true
	}
	for _, r := range doc.Runs {
		if len(r.Electrodes) > 0 || len(r.Annotations) > 0 || len(r.Blockouts) > 0 {
			return true
		}
	}
	return false
}

// emitElectrodes writes one CIRCLE per Run.Electrodes[i] on layer
// ELECTRODES, centered on the referenced polyline point. Out-of-range
// PointIndex values are silently skipped (storage validation should
// already prevent them, but a defensive bounds check costs nothing and
// keeps a corrupt doc from producing malformed DXF).
func emitElectrodes(b *strings.Builder, doc *designdoc.Doc) {
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		for _, e := range run.Electrodes {
			if e.PointIndex < 0 || e.PointIndex >= len(pts) {
				continue
			}
			p := pts[e.PointIndex]
			pair(b, 0, "CIRCLE")
			pair(b, 8, layerElectrodes)
			pairFloat(b, 10, p[0])
			pairFloat(b, 20, p[1])
			pairFloat(b, 40, electrodeRadiusMM)
		}
	}
}

// emitRunLabels writes one TEXT per non-empty run on layer LABELS,
// content "Run N" (1-based index in Doc.Runs), inserted at the run's
// first polyline point. The full canonical run ID stays on the
// LWPOLYLINE's layer name (RUN_<id>), so anyone needing the unique
// identifier still has it; the human-readable "Run N" is for shop-floor
// recognition without squinting at long IDs.
func emitRunLabels(b *strings.Builder, doc *designdoc.Doc) {
	for i, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) == 0 {
			continue
		}
		p := pts[0]
		writeText(b, layerLabels, p[0], p[1], annotationTextHeight,
			fmt.Sprintf("Run %d", i+1))
	}
}

// emitFreeFormLabels writes one TEXT per Doc.Labels[i] at its (X, Y) on
// layer LABELS — same layer as run labels because they're the same
// conceptual category from a CAM-filter perspective.
func emitFreeFormLabels(b *strings.Builder, doc *designdoc.Doc) {
	for _, l := range doc.Labels {
		writeText(b, layerLabels, l.X, l.Y, annotationTextHeight, l.Text)
	}
}

// emitDimensions writes one LINE + one TEXT per Doc.Dimensions[i] on
// layer DIMENSIONS. Text content is "<length> mm" or
// "<length> mm (<note>)" if Dimension.Note is non-empty, where length is
// math.Hypot(dx, dy) at 1 decimal place. Text is offset perpendicular to
// the line by one text-height (5 mm) along the right-hand normal
// (rotate the direction vector -90°: (dx, dy) → (dy, -dx) / length) so
// it doesn't sit directly on top of the line. Degenerate dimensions —
// length below dimensionMinLengthMM — are skipped entirely; emitting a
// TEXT-only marker without a line would mislead the operator.
//
// Right-hand offset convention rationale: dimensions read left-to-right
// from start to end, so the "right" side of the direction vector is the
// natural place a Western reader expects an offset label, and it's
// stable under reversed endpoints (the offset just flips to the other
// side of the line, which is symmetric and equally legible).
func emitDimensions(b *strings.Builder, doc *designdoc.Doc) {
	for _, d := range doc.Dimensions {
		dx := d.X2 - d.X1
		dy := d.Y2 - d.Y1
		length := math.Hypot(dx, dy)
		if length < dimensionMinLengthMM {
			continue
		}

		// LINE entity.
		pair(b, 0, "LINE")
		pair(b, 8, layerDimensions)
		pairFloat(b, 10, d.X1)
		pairFloat(b, 20, d.Y1)
		pairFloat(b, 11, d.X2)
		pairFloat(b, 21, d.Y2)

		// TEXT entity at the perpendicularly-offset midpoint.
		mx := (d.X1 + d.X2) / 2.0
		my := (d.Y1 + d.Y2) / 2.0
		// Right-hand unit normal: (dy, -dx) / length.
		nx := dy / length
		ny := -dx / length
		tx := mx + dimensionTextOffset*nx
		ty := my + dimensionTextOffset*ny

		var content string
		if d.Note == "" {
			content = fmt.Sprintf("%.1f mm", length)
		} else {
			content = fmt.Sprintf("%.1f mm (%s)", length, d.Note)
		}
		writeText(b, layerDimensions, tx, ty, annotationTextHeight, content)
	}
}

// markerStyle resolves a Run.Annotation kind to its CIRCLE radius and
// linetype. Unknown kinds fall back to support-style (small CONTINUOUS
// circle) — defensive: storage validation should already restrict values,
// but a future kind landing in the schema before this switch would
// otherwise silently drop the annotation.
func markerStyle(kind string) (radius float64, lineType, label string) {
	switch kind {
	case "jump":
		return markerRadiusJump, lineTypeDashed, "Jump"
	case "support":
		return markerRadiusSupport, lineTypeContinuous, "Support"
	case "doubleback":
		// Doubleback rendering (spec was silent on this kind):
		// largest radius (5 mm) to flag the most fiddly annotation
		// category, DASHDOT linetype to read distinctly from jump's
		// pure DASHED. The bender's eye picks doubleback first when
		// scanning the layer at zoom levels where text is illegible,
		// which matches its real-world priority on the shop floor.
		return markerRadiusDoubleback, lineTypeDashdot, "Doubleback"
	default:
		return markerRadiusSupport, lineTypeContinuous, kind
	}
}

// emitMarkers writes one CIRCLE + one TEXT per Run.Annotations[i] on
// layer MARKERS (Tier 3 #38a). The circle is centered on the polyline
// point referenced by the annotation's live-arc index; the label sits
// one text-height (5 mm) along the right-hand normal of the polyline
// tangent at that point. Per-kind radii and linetypes (see markerStyle)
// give the operator a quick visual ranking without reading text.
//
// Live-arc index → polyline index conversion uses
// designdoc.LiveArcIndices, the shared helper used by the SVG/PDF
// pipelines, so a marker shows up at the same physical spot in DXF as
// it does on the printed pattern.
//
// Out-of-range LiveIndex values are silently skipped (defensive — the
// editor and storage validation should already prevent it).
func emitMarkers(b *strings.Builder, doc *designdoc.Doc) {
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) == 0 || len(run.Annotations) == 0 {
			continue
		}
		liveIndices, _ := designdoc.LiveArcIndices(run)
		if len(liveIndices) == 0 {
			continue
		}
		for _, a := range run.Annotations {
			if a.LiveIndex < 0 || a.LiveIndex >= len(liveIndices) {
				continue
			}
			pidx := liveIndices[a.LiveIndex]
			if pidx < 0 || pidx >= len(pts) {
				continue
			}
			p := pts[pidx]
			radius, lineType, label := markerStyle(a.Kind)

			// CIRCLE entity.
			pair(b, 0, "CIRCLE")
			pair(b, 8, layerMarkers)
			pair(b, 6, lineType)
			pairFloat(b, 10, p[0])
			pairFloat(b, 20, p[1])
			pairFloat(b, 40, radius)

			// TEXT label, offset by one text-height along the right-hand
			// normal of the polyline tangent. Right-hand convention
			// matches emitDimensions for consistency.
			tx, ty := offsetAlongRightHandNormal(pts, pidx, markerTextOffset)
			writeText(b, layerMarkers, tx, ty, annotationTextHeight, label)
		}
	}
}

// emitBlockouts writes one LWPOLYLINE per Run.Blockouts[i] on layer
// BLOCKOUTS (Tier 3 #38a). The polyline traces the blockout's live-arc
// indices end-to-end, using DASHED linetype so CAM viewers render it
// visually distinct from the live tube feed on RUN_*. Closed-loop
// blockouts that wrap the seam are emitted as multi-vertex open polylines
// in live-arc traversal order — closing them would draw a chord across
// the unrelated live segment.
//
// Why a polyline rather than a series of LINE segments: keeps each
// blockout one entity per row, which makes CAM-side filtering and
// layer-toggle behavior identical to how the run polylines are filtered.
//
// Degenerate blockouts (fewer than 2 distinct vertices after the live-
// arc walk) are skipped — emitting a 1-point LWPOLYLINE would be valid
// but visually meaningless.
func emitBlockouts(b *strings.Builder, doc *designdoc.Doc) {
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) == 0 || len(run.Blockouts) == 0 {
			continue
		}
		liveIndices, closed := designdoc.LiveArcIndices(run)
		nLive := len(liveIndices)
		if nLive == 0 {
			continue
		}
		for _, blk := range run.Blockouts {
			indices := walkBlockoutIndices(liveIndices, blk, closed)
			if len(indices) < 2 {
				continue
			}
			pair(b, 0, "LWPOLYLINE")
			pair(b, 8, layerBlockouts)
			pair(b, 6, lineTypeDashed)
			// Blockouts are always emitted as open polylines: even when
			// the run is closed and the blockout wraps the seam, the
			// blockout itself is conceptually a span on the live arc,
			// not a loop.
			pairInt(b, 70, 0)
			pairInt(b, 90, len(indices))
			for _, idx := range indices {
				if idx < 0 || idx >= len(pts) {
					continue
				}
				p := pts[idx]
				pairFloat(b, 10, p[0])
				pairFloat(b, 20, p[1])
			}
		}
	}
}

// walkBlockoutIndices resolves a Blockout's live-arc start/end pair to
// the ordered slice of polyline indices that the blockout covers,
// inclusive of both endpoints. For open arcs the walk is straight
// forward; for closed arcs it wraps from n-1 back to 0 if the blockout
// straddles the seam (matching the splitByBlockouts behavior in
// designdoc/convert.go).
func walkBlockoutIndices(liveIndices []int, blk designdoc.Blockout, closed bool) []int {
	n := len(liveIndices)
	if n == 0 {
		return nil
	}
	s := clampIdx(blk.StartLiveIndex, n)
	e := clampIdx(blk.EndLiveIndex, n)
	if s == e {
		return []int{liveIndices[s]}
	}
	out := make([]int, 0, n)
	i := s
	for {
		out = append(out, liveIndices[i])
		if i == e {
			break
		}
		i++
		if i >= n {
			if !closed {
				break
			}
			i = 0
		}
	}
	return out
}

// clampIdx mirrors designdoc.clampLiveIndex (private over there) so we
// don't reach into another package's internals just for a one-liner.
func clampIdx(i, n int) int {
	if n == 0 {
		return 0
	}
	if i < 0 {
		return 0
	}
	if i >= n {
		return n - 1
	}
	return i
}

// offsetAlongRightHandNormal returns the (x, y) point that sits `offset`
// mm to the right of the polyline tangent at index pidx. The tangent is
// estimated using the neighboring vertices: the central difference
// (P[pidx+1] - P[pidx-1]) for interior points, and the appropriate
// one-sided difference for endpoints. "Right" matches the dimensions-
// label convention: rotate the unit tangent (tx, ty) by -90° to (ty, -tx).
//
// If the tangent is degenerate (zero length — a polyline with a single
// point or repeated coincident vertices), the offset falls back to
// (+offset, 0) so the label still appears next to the marker rather
// than directly on top of it.
func offsetAlongRightHandNormal(pts [][2]float64, pidx int, offset float64) (float64, float64) {
	if pidx < 0 || pidx >= len(pts) {
		return 0, 0
	}
	p := pts[pidx]
	if len(pts) < 2 {
		return p[0] + offset, p[1]
	}
	var prev, next [2]float64
	switch {
	case pidx == 0:
		prev = pts[0]
		next = pts[1]
	case pidx == len(pts)-1:
		prev = pts[pidx-1]
		next = pts[pidx]
	default:
		prev = pts[pidx-1]
		next = pts[pidx+1]
	}
	dx := next[0] - prev[0]
	dy := next[1] - prev[1]
	length := math.Hypot(dx, dy)
	if length < 1e-9 {
		return p[0] + offset, p[1]
	}
	// Right-hand unit normal: rotate tangent -90° → (dy, -dx) / length.
	nx := dy / length
	ny := -dx / length
	return p[0] + offset*nx, p[1] + offset*ny
}

// writeText emits a single TEXT entity. Group codes:
//
//	0  TEXT
//	8  <layer>
//	10 <insert-X>
//	20 <insert-Y>
//	40 <text-height>
//	1  <string>
//
// The string is sanitized to plain ASCII — DXF R12 has no UTF-8 support
// and free-form Label.Text or Dimension.Note may contain anything. Non-
// ASCII (and any control char) becomes '?' so the file stays valid.
func writeText(b *strings.Builder, layer string, x, y, height float64, content string) {
	pair(b, 0, "TEXT")
	pair(b, 8, layer)
	pairFloat(b, 10, x)
	pairFloat(b, 20, y)
	pairFloat(b, 40, height)
	pair(b, 1, sanitizeText(content))
}

// sanitizeText replaces any byte outside printable ASCII (0x20..0x7E)
// with '?'. R12 ASCII DXF predates Unicode; embedding non-ASCII risks
// breaking importers that expect single-byte encoding.
func sanitizeText(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	for _, r := range s {
		if r >= 0x20 && r <= 0x7E {
			out.WriteRune(r)
		} else {
			out.WriteByte('?')
		}
	}
	return out.String()
}

// pair writes a DXF group-code/string-value pair: each occupies its own
// line, code first then value, both terminated with '\n'.
func pair(b *strings.Builder, code int, value string) {
	fmt.Fprintf(b, "%d\n%s\n", code, value)
}

func pairInt(b *strings.Builder, code, value int) {
	fmt.Fprintf(b, "%d\n%d\n", code, value)
}

// pairFloat writes a coordinate value at 1 decimal place. Tube-bender
// controllers truncate beyond 0.1mm anyway, and rounding here keeps file
// sizes sane. If a future shop needs higher precision we can promote
// this to a configurable.
func pairFloat(b *strings.Builder, code int, value float64) {
	fmt.Fprintf(b, "%d\n%.1f\n", code, value)
}

// layerName converts a Run.ID into a valid DXF layer name. The DXF spec
// (1014 §A.1) restricts layer names to letters, digits, dollar sign,
// underscore, and hyphen. Anything else gets replaced with underscore.
// Empty IDs become "RUN".
func layerName(id string) string {
	if id == "" {
		return "RUN"
	}
	var out strings.Builder
	out.Grow(len(id) + 4)
	out.WriteString("RUN_")
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '_', r == '-', r == '$':
			out.WriteRune(r)
		default:
			out.WriteRune('_')
		}
	}
	return out.String()
}
