// Package printdxf emits a minimal AutoCAD R12 ASCII DXF representation of
// a designdoc.Doc, suitable for feeding to CNC tube benders.
//
// V1 scope is geometry only: one LWPOLYLINE per Run.Polyline, layered per
// run id ("RUN_<id>"). Annotations (electrodes, labels, dimensions, bends,
// blockouts) are intentionally NOT emitted — DXF here is the bender feed,
// not the print pattern. The PDF pipeline at internal/printpdf/ remains
// the human-readable artefact for the shop floor.
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
// All coordinates are millimeters ($INSUNITS = 4).
package printdxf

import (
	"fmt"
	"io"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// EmitDXF writes an AutoCAD R12 ASCII DXF representation of doc to w.
// One LWPOLYLINE per non-empty Run.Polyline; closed runs use the closed
// flag (group code 70 = 1). Layer name is "RUN_<id>", sanitized to the
// DXF name-character set. Units are millimeters.
//
// EmitDXF returns an error only if the underlying writer fails. A doc
// with zero runs is not an error — the resulting file is a valid (if
// empty) DXF that bender CAM software opens cleanly.
func EmitDXF(w io.Writer, doc *designdoc.Doc) error {
	if doc == nil {
		return fmt.Errorf("printdxf: nil doc")
	}

	var b strings.Builder
	// Pre-grow: ~200 bytes header + ~50 bytes per polyline point.
	approxPoints := 0
	for _, r := range doc.Runs {
		approxPoints += len(r.Polyline.Points)
	}
	b.Grow(256 + approxPoints*40)

	// HEADER section: declare R12 + millimeter units.
	pair(&b, 0, "SECTION")
	pair(&b, 2, "HEADER")
	pair(&b, 9, "$ACADVER")
	pair(&b, 1, "AC1009")
	pair(&b, 9, "$INSUNITS")
	pairInt(&b, 70, 4) // 4 = millimeters
	pair(&b, 0, "ENDSEC")

	// ENTITIES section: one LWPOLYLINE per run.
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
	pair(&b, 0, "ENDSEC")

	pair(&b, 0, "EOF")

	_, err := io.WriteString(w, b.String())
	return err
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
