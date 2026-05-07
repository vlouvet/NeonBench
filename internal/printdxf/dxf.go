// Package printdxf emits a minimal AutoCAD R12 ASCII DXF representation of
// a designdoc.Doc, suitable for feeding to CNC tube benders.
//
// V1 scope was geometry only (one LWPOLYLINE per Run.Polyline, layered per
// run id). Tier 3 #21 extends this with three annotation entity types:
// electrode markers (CIRCLE on layer ELECTRODES), human-readable run+free-form
// labels (TEXT on layer LABELS), and dimension lines with measured text
// (LINE+TEXT pairs on layer DIMENSIONS).
//
// Why R12 (AC1009)?
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
)

// Annotation geometry constants. Magic numbers extracted so future
// adjustments (or per-shop overrides) have a single place to land.
const (
	electrodeRadiusMM    = 3.0
	annotationTextHeight = 5.0
	dimensionTextOffset  = 5.0  // perpendicular offset, mm; one text-height
	dimensionMinLengthMM = 0.01 // shorter dims are skipped as degenerate
)

// EmitDXF writes an AutoCAD R12 ASCII DXF representation of doc to w.
// One LWPOLYLINE per non-empty Run.Polyline; closed runs use the closed
// flag (group code 70 = 1). Layer name is "RUN_<id>", sanitized to the
// DXF name-character set. Units are millimeters.
//
// Annotations follow the polylines in the ENTITIES section in a fixed
// order: electrodes, run labels, free-form labels, dimensions. Predictable
// ordering keeps regression diffs readable.
//
// EmitDXF returns an error only if the underlying writer fails. A doc
// with zero runs is not an error — the resulting file is a valid (if
// empty) DXF that bender CAM software opens cleanly.
func EmitDXF(w io.Writer, doc *designdoc.Doc) error {
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

	// HEADER section: declare R12 + millimeter units.
	pair(&b, 0, "SECTION")
	pair(&b, 2, "HEADER")
	pair(&b, 9, "$ACADVER")
	pair(&b, 1, "AC1009")
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
	// content (electrodes, free-form labels, or dimensions). When none of
	// those exist, the DXF stays geometry-only and byte-identical to the
	// pre-Tier-3 #21 output — preserving the contract for the large fleet
	// of legacy design versions that predate annotations. This includes
	// the per-run "Run N" labels: they're a recognition aid that's only
	// useful when the operator is also looking at electrodes/labels/dims,
	// and emitting them unconditionally would break byte-compat for
	// existing DXFs in the wild.
	if hasAnnotations(doc) {
		emitElectrodes(&b, doc)
		emitRunLabels(&b, doc)
		emitFreeFormLabels(&b, doc)
		emitDimensions(&b, doc)
	}

	pair(&b, 0, "ENDSEC")

	pair(&b, 0, "EOF")

	_, err := io.WriteString(w, b.String())
	return err
}

// hasAnnotations reports whether doc carries any annotation content that
// should trigger the annotation-emission block. Returns false for legacy
// docs (no electrodes, no free-form labels, no dimensions), preserving
// byte-identical output for pre-Tier-3-#21 design versions.
func hasAnnotations(doc *designdoc.Doc) bool {
	if len(doc.Labels) > 0 || len(doc.Dimensions) > 0 {
		return true
	}
	for _, r := range doc.Runs {
		if len(r.Electrodes) > 0 {
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
