// Package printsvg emits a vector-graphics SVG representation of a
// designdoc.Doc, suitable for round-tripping into Inkscape, Illustrator,
// or any other modern vector editor. Sister package to printdxf — same
// geometry, different wire format.
//
// Why SVG (vs the existing DXF + PDF exporters)?
//   - DXF is the bender's CAM input — geometry only, single layer per
//     run, no styling. SVG is the design-shop input — every layer is
//     a CSS-stylable group so the operator can isolate annotations,
//     blockouts, and electrodes independently.
//   - PDF is the printed pattern (paper layout, page breaks, bend list).
//     SVG is a vector reflow of the same design without paper layout —
//     drag it into a layout tool, paste it into a slide deck, archive
//     it.
//   - The bundle export gives you a .neonbench archive of SVG sources
//     for every version, but those are the FRONT-END's SVG (drawn by
//     the editor). printsvg emits the BACK-END's canonical SVG built
//     directly from the design doc — so a freshly drawn-from-scratch
//     design has an SVG export even if it never had a source SVG to
//     start with.
//
// Layer convention mirrors the DXF emitter (printdxf.PR #94). Each Run
// becomes a `<g class="run run-<sanitized-id>">`. Annotations
// (electrodes, run labels, free-form labels, dimensions, markers,
// blockouts) land on dedicated `<g class="layer-electrodes">`,
// `<g class="layer-labels">`, `<g class="layer-dimensions">`,
// `<g class="layer-markers">`, `<g class="layer-blockouts">` groups
// so downstream tools can toggle each category with a single CSS
// `display: none`. Aligning with the DXF layer naming keeps the shop's
// mental model consistent across formats: ELECTRODES / LABELS /
// DIMENSIONS / MARKERS / BLOCKOUTS are the five "extra" layers, RUN_*
// is the geometry, and that's what the bender / designer sees in
// both DXF and SVG.
//
// All coordinates are millimeters. The root `<svg>` declares
// `viewBox`, `width`, and `height` in mm so a tool that respects the
// unit (Inkscape, modern Chrome with `transform-box: fill-box`) shows
// the design at true physical size.
//
// Mirror (?mirror=1) follows the same convention as the PDF and DXF
// exporters: an optional horizontal flip about the bbox's vertical
// midline. Implemented by an outer `<g transform="...">` so the
// underlying geometry remains untouched in source order — a downstream
// tool reading the file can ignore the wrapper if it doesn't want the
// flip.
package printsvg

import (
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// Layer / class-name constants. These are stable contracts: downstream
// consumers (Inkscape extensions, hand-coded CSS overrides) key off
// these strings, so renaming requires a coordinated release. Names
// mirror the DXF layer convention from printdxf (uppercase DXF →
// lowercase CSS-style class).
const (
	classRun        = "run"
	classElectrodes = "layer-electrodes"
	classLabels     = "layer-labels"
	classDimensions = "layer-dimensions"
	classMarkers    = "layer-markers"
	classBlockouts  = "layer-blockouts"
)

// Annotation geometry constants. Matched to printdxf where it makes
// sense so the two emitters render identically at a glance — text
// height + electrode radius + marker radii are shared trade-shop
// conventions, no reason for the SVG to diverge.
const (
	electrodeRadiusMM    = 3.0
	annotationTextHeight = 5.0
	dimensionTextOffset  = 5.0
	dimensionMinLengthMM = 0.01

	markerRadiusJump       = 4.0
	markerRadiusSupport    = 3.0
	markerRadiusDoubleback = 5.0

	markerTextOffset = annotationTextHeight
)

// Stroke widths are SVG-only — DXF defers stroke rendering to the CAM
// importer. Chosen to render legibly on a screen-sized preview
// without overwhelming small designs (~150 mm wide). Operators who
// want different weights override via CSS on the emitted classes.
const (
	strokeWidthRun       = 0.5
	strokeWidthMarker    = 0.4
	strokeWidthBlockout  = 0.6
	strokeWidthDimension = 0.4
	strokeWidthElectrode = 0.3
)

// Options controls the SVG emission. Currently a single toggle
// (mirror) but kept as a struct so future per-kind layer flags or
// stroke-width overrides have an obvious place to land.
type Options struct {
	// Mirror flips the design horizontally about the bbox's vertical
	// midline. Same convention as the DXF and PDF emitters.
	Mirror bool
}

// EmitSVG writes a vector-graphics SVG representation of doc to w.
// Default options (no mirror). Convenience wrapper for callers that
// don't need to set the mirror flag.
func EmitSVG(w io.Writer, doc *designdoc.Doc) error {
	return EmitSVGWithOptions(w, doc, Options{})
}

// EmitSVGWithOptions writes the SVG to w, honoring the requested
// options. One `<g class="run run-<id>">` per non-empty Run, then
// five dedicated annotation layer groups in fixed order
// (electrodes → labels → dimensions → markers → blockouts).
// Predictable ordering keeps regression diffs readable, matching the
// printdxf emitter's per-section discipline.
//
// EmitSVGWithOptions returns an error only if the underlying writer
// fails. A doc with zero runs is not an error — the resulting SVG is
// valid (empty viewport) and downstream tools open it cleanly.
func EmitSVGWithOptions(w io.Writer, doc *designdoc.Doc, opts Options) error {
	if doc == nil {
		return fmt.Errorf("printsvg: nil doc")
	}

	var b strings.Builder
	// Pre-grow: header ~400 bytes + per-vertex ~25 bytes + per-annotation
	// ~120 bytes. Approximations; SVG is verbose enough that a small
	// over-allocation is cheap.
	approxPoints := 0
	for _, r := range doc.Runs {
		approxPoints += len(r.Polyline.Points)
	}
	b.Grow(400 + approxPoints*25 + 512)

	// Resolve the viewBox. Prefer the doc's stored ViewBoxMM; fall back
	// to the geometry's bounding box when ViewBoxMM is zero (a fresh
	// doc, or one created before the editor populated it).
	x, y, wMM, hMM := resolveViewBox(doc)

	// Doc-level prelude. xmlns is mandatory (otherwise browsers refuse
	// to render); we add no extra namespaces — every element we emit
	// is plain SVG core.
	fmt.Fprintf(&b,
		`<?xml version="1.0" encoding="UTF-8"?>`+"\n"+
			`<svg xmlns="http://www.w3.org/2000/svg" version="1.1" `+
			`viewBox="%s %s %s %s" width="%smm" height="%smm">`+"\n",
		fmtFloat(x), fmtFloat(y), fmtFloat(wMM), fmtFloat(hMM),
		fmtFloat(wMM), fmtFloat(hMM),
	)

	// A small `<style>` block ships sensible defaults for the per-layer
	// classes. Downstream consumers can override with their own
	// stylesheet — every class is selectable. Stroke / fill choices
	// match the on-screen editor preview (run = black 0.5 mm,
	// blockout = dashed, markers = open circle, electrodes = filled
	// black dot).
	emitStyle(&b)

	// Optional mirror wrapper. Implemented as `transform="matrix(-1 0 0 1
	// 2*cx 0)"` where cx is the bbox's horizontal midline, which is the
	// usual "scale(-1, 1) translate(-2cx, 0)" identity in one matrix
	// op so downstream tools don't have to compose the two.
	if opts.Mirror {
		cx := x + wMM/2.0
		fmt.Fprintf(&b, `<g transform="matrix(-1 0 0 1 %s 0)">`+"\n",
			fmtFloat(2*cx),
		)
	}

	// Runs: one <g class="run run-<id>"> per non-empty Run. The class
	// list carries both the generic "run" (for CSS rules that target
	// every run) and the specific "run-<id>" (for selecting a single
	// run). data-run-id duplicates the ID as an attribute so JS
	// consumers don't have to parse the class list.
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		if len(pts) == 0 {
			continue
		}
		fmt.Fprintf(&b, `<g class="%s %s" data-run-id="%s">`+"\n",
			classRun, runClassName(run.ID), escapeAttr(run.ID),
		)
		// One <polyline> per run; <polygon> would be more semantic for
		// closed runs but <polyline points="..."> + stroke + open is
		// what every importer round-trips identically, so we keep one
		// shape per run for diff simplicity.
		emitPolyline(&b, pts, run.Polyline.Closed, strokeWidthRun, "none", "currentColor")
		fmt.Fprintln(&b, `</g>`)
	}

	// Annotations: one dedicated layer group per category, in fixed
	// order so regression diffs stay tidy. Each group is gated on
	// presence so a doc with no annotations of that kind doesn't
	// emit an empty <g> — keeps the file lean and round-trips
	// identical between docs without annotations.
	if hasElectrodes(doc) {
		emitElectrodesLayer(&b, doc)
	}
	if hasLabels(doc) {
		emitLabelsLayer(&b, doc)
	}
	if hasDimensions(doc) {
		emitDimensionsLayer(&b, doc)
	}
	if hasMarkers(doc) {
		emitMarkersLayer(&b, doc)
	}
	if hasBlockouts(doc) {
		emitBlockoutsLayer(&b, doc)
	}

	if opts.Mirror {
		fmt.Fprintln(&b, `</g>`)
	}

	fmt.Fprintln(&b, `</svg>`)

	_, err := io.WriteString(w, b.String())
	return err
}

// resolveViewBox returns the viewBox values (x, y, w, h) for the SVG
// root. Prefers doc.ViewBoxMM; falls back to the runs' bounding box
// when ViewBoxMM is zero (a brand-new doc, or one whose viewbox was
// never set). A zero-run doc with no viewbox falls back to a 1×1
// placeholder so the SVG is still well-formed.
func resolveViewBox(doc *designdoc.Doc) (x, y, w, h float64) {
	vb := doc.ViewBoxMM
	if vb[2] > 0 && vb[3] > 0 {
		return vb[0], vb[1], vb[2], vb[3]
	}
	// Fall back to a geometry bbox.
	minX, minY, maxX, maxY, ok := geometryBBox(doc)
	if !ok {
		return 0, 0, 1, 1
	}
	return minX, minY, maxX - minX, maxY - minY
}

// geometryBBox computes the bounding box across every run's polyline
// vertices. Returns ok=false when no runs have any vertices.
func geometryBBox(doc *designdoc.Doc) (minX, minY, maxX, maxY float64, ok bool) {
	minX, minY = math.Inf(1), math.Inf(1)
	maxX, maxY = math.Inf(-1), math.Inf(-1)
	for _, run := range doc.Runs {
		for _, p := range run.Polyline.Points {
			if p[0] < minX {
				minX = p[0]
			}
			if p[1] < minY {
				minY = p[1]
			}
			if p[0] > maxX {
				maxX = p[0]
			}
			if p[1] > maxY {
				maxY = p[1]
			}
			ok = true
		}
	}
	return minX, minY, maxX, maxY, ok
}

// emitStyle writes the default per-class CSS into a <style> block.
// Every selector targets a class name our emitter applies; nothing
// here is required for the file to render, but the defaults are what
// makes a freshly opened SVG look like the editor preview.
func emitStyle(b *strings.Builder) {
	fmt.Fprintf(b, `<style>
.run { fill: none; stroke: black; stroke-width: %smm; stroke-linejoin: round; stroke-linecap: round; }
.layer-electrodes circle { fill: black; stroke: black; stroke-width: %smm; }
.layer-labels text { font-family: sans-serif; font-size: %smm; fill: black; }
.layer-dimensions line { stroke: #555; stroke-width: %smm; }
.layer-dimensions text { font-family: sans-serif; font-size: %smm; fill: #555; }
.layer-markers circle { fill: none; stroke: #c33; stroke-width: %smm; }
.layer-markers text { font-family: sans-serif; font-size: %smm; fill: #c33; }
.layer-blockouts polyline { fill: none; stroke: #888; stroke-width: %smm; stroke-dasharray: 2,1; }
</style>
`,
		fmtFloat(strokeWidthRun),
		fmtFloat(strokeWidthElectrode),
		fmtFloat(annotationTextHeight),
		fmtFloat(strokeWidthDimension),
		fmtFloat(annotationTextHeight),
		fmtFloat(strokeWidthMarker),
		fmtFloat(annotationTextHeight),
		fmtFloat(strokeWidthBlockout),
	)
}

// emitPolyline writes a single <polyline points="..."> with the given
// stroke / fill / stroke-width attributes. Closed polylines repeat the
// first vertex at the end so the stroke visually closes — using
// <polygon> would force a fill, which we don't want for closed neon
// loops (the inside of a loop isn't "fillable" — there's no plate).
func emitPolyline(b *strings.Builder, pts [][2]float64, closed bool, strokeWidth float64, fill, stroke string) {
	b.WriteString(`<polyline points="`)
	for i, p := range pts {
		if i > 0 {
			b.WriteByte(' ')
		}
		fmt.Fprintf(b, "%s,%s", fmtFloat(p[0]), fmtFloat(p[1]))
	}
	if closed && len(pts) > 0 {
		// Close visually by repeating the first vertex.
		fmt.Fprintf(b, " %s,%s", fmtFloat(pts[0][0]), fmtFloat(pts[0][1]))
	}
	fmt.Fprintf(b, `" fill="%s" stroke="%s" stroke-width="%s"/>`+"\n",
		fill, stroke, fmtFloat(strokeWidth),
	)
}

// hasElectrodes reports whether any run carries at least one electrode.
func hasElectrodes(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Electrodes) > 0 {
			return true
		}
	}
	return false
}

// hasLabels reports whether the doc has any free-form Doc.Labels OR
// any non-empty run (run labels are emitted whenever runs exist and
// any annotation content is present — see emitLabelsLayer for the
// "run label gate" logic).
func hasLabels(doc *designdoc.Doc) bool {
	if len(doc.Labels) > 0 {
		return true
	}
	// Run labels are emitted ONLY when at least one annotation category
	// is present anywhere in the doc — matches the DXF emitter's
	// hasAnnotations() gate so the two formats agree on when the
	// recognition-aid label set appears. Otherwise a clean
	// geometry-only doc would gain noisy "Run 1 / Run 2" overlays.
	return hasAnyAnnotationContent(doc)
}

// hasDimensions reports whether the doc has any measured dimensions.
func hasDimensions(doc *designdoc.Doc) bool {
	return len(doc.Dimensions) > 0
}

// hasMarkers reports whether any run carries a non-empty Annotations
// slice (jump / support / doubleback markers).
func hasMarkers(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Annotations) > 0 {
			return true
		}
	}
	return false
}

// hasBlockouts reports whether any run carries a non-empty Blockouts
// slice.
func hasBlockouts(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Blockouts) > 0 {
			return true
		}
	}
	return false
}

// hasAnyAnnotationContent matches printdxf.hasAnnotations: returns
// true if the doc carries any annotation-category content. Drives the
// "should we emit the per-run 'Run N' recognition labels" decision —
// they're only useful next to other annotation overlays, so a
// geometry-only doc skips them.
func hasAnyAnnotationContent(doc *designdoc.Doc) bool {
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

// emitElectrodesLayer writes one <circle> per Electrode on the
// layer-electrodes group. Mirrors printdxf.emitElectrodes' bounds-
// check discipline: out-of-range PointIndex values are silently
// dropped.
func emitElectrodesLayer(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, `<g class="%s">`+"\n", classElectrodes)
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		for _, e := range run.Electrodes {
			if e.PointIndex < 0 || e.PointIndex >= len(pts) {
				continue
			}
			p := pts[e.PointIndex]
			fmt.Fprintf(b, `<circle cx="%s" cy="%s" r="%s"/>`+"\n",
				fmtFloat(p[0]), fmtFloat(p[1]), fmtFloat(electrodeRadiusMM),
			)
		}
	}
	fmt.Fprintln(b, `</g>`)
}

// emitLabelsLayer writes per-run "Run N" labels and free-form
// Doc.Labels on the layer-labels group. Same fixed order as the DXF
// emitter (run labels first, then free-form) so the two formats
// produce diff-comparable output for the same input.
func emitLabelsLayer(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, `<g class="%s">`+"\n", classLabels)

	// Run labels — only when the annotation gate is open (see
	// hasLabels). Matches the printdxf behaviour: a geometry-only doc
	// produces no "Run N" overlays.
	if hasAnyAnnotationContent(doc) {
		for i, run := range doc.Runs {
			pts := run.Polyline.Points
			if len(pts) == 0 {
				continue
			}
			p := pts[0]
			emitText(b, p[0], p[1], fmt.Sprintf("Run %d", i+1))
		}
	}

	// Free-form labels.
	for _, l := range doc.Labels {
		emitText(b, l.X, l.Y, l.Text)
	}

	fmt.Fprintln(b, `</g>`)
}

// emitDimensionsLayer writes one <line> + one <text> per dimension on
// the layer-dimensions group. Geometry and text-offset convention
// match printdxf.emitDimensions exactly (right-hand normal, midpoint
// offset by one text-height).
func emitDimensionsLayer(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, `<g class="%s">`+"\n", classDimensions)
	for _, d := range doc.Dimensions {
		dx := d.X2 - d.X1
		dy := d.Y2 - d.Y1
		length := math.Hypot(dx, dy)
		if length < dimensionMinLengthMM {
			continue
		}
		fmt.Fprintf(b, `<line x1="%s" y1="%s" x2="%s" y2="%s"/>`+"\n",
			fmtFloat(d.X1), fmtFloat(d.Y1), fmtFloat(d.X2), fmtFloat(d.Y2),
		)
		mx := (d.X1 + d.X2) / 2.0
		my := (d.Y1 + d.Y2) / 2.0
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
		emitText(b, tx, ty, content)
	}
	fmt.Fprintln(b, `</g>`)
}

// markerStyle resolves a Run.Annotation kind to its SVG marker
// attributes. Radii + labels match printdxf.markerStyle so the two
// formats render the same shape at the same size. Stroke-dasharray
// is the SVG equivalent of DXF's linetype names; we encode it inline
// because per-element style overrides are simpler than a global CSS
// rule keyed off a data-kind attribute (downstream consumers can
// still override via the class on the parent group).
func markerStyle(kind string) (radius float64, dashArray, label string) {
	switch kind {
	case "jump":
		return markerRadiusJump, "2,1", "Jump"
	case "support":
		return markerRadiusSupport, "", "Support"
	case "doubleback":
		return markerRadiusDoubleback, "3,1,1,1", "Doubleback"
	default:
		return markerRadiusSupport, "", kind
	}
}

// emitMarkersLayer writes per-run jump / support / doubleback
// markers on the layer-markers group. data-kind attribute preserves
// the annotation kind for downstream JS consumers; matches the DXF
// emitter's per-kind dispatch.
func emitMarkersLayer(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, `<g class="%s">`+"\n", classMarkers)
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
			radius, dashArray, label := markerStyle(a.Kind)

			// Inline stroke-dasharray for per-kind distinction.
			if dashArray == "" {
				fmt.Fprintf(b, `<circle cx="%s" cy="%s" r="%s" data-kind="%s"/>`+"\n",
					fmtFloat(p[0]), fmtFloat(p[1]), fmtFloat(radius),
					escapeAttr(a.Kind),
				)
			} else {
				fmt.Fprintf(b, `<circle cx="%s" cy="%s" r="%s" stroke-dasharray="%s" data-kind="%s"/>`+"\n",
					fmtFloat(p[0]), fmtFloat(p[1]), fmtFloat(radius),
					dashArray, escapeAttr(a.Kind),
				)
			}

			tx, ty := offsetAlongRightHandNormal(pts, pidx, markerTextOffset)
			emitText(b, tx, ty, label)
		}
	}
	fmt.Fprintln(b, `</g>`)
}

// emitBlockoutsLayer writes one <polyline> per Blockout on the
// layer-blockouts group. The polyline traces the blockout's live-arc
// indices end-to-end — same walk as printdxf.emitBlockouts so the
// two formats highlight the same spans.
func emitBlockoutsLayer(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, `<g class="%s">`+"\n", classBlockouts)
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
			coords := make([][2]float64, 0, len(indices))
			for _, idx := range indices {
				if idx < 0 || idx >= len(pts) {
					continue
				}
				coords = append(coords, pts[idx])
			}
			if len(coords) < 2 {
				continue
			}
			// Blockouts always rendered as open polylines, matching DXF.
			emitPolyline(b, coords, false, strokeWidthBlockout, "none", "currentColor")
		}
	}
	fmt.Fprintln(b, `</g>`)
}

// walkBlockoutIndices mirrors printdxf.walkBlockoutIndices: resolve a
// Blockout's start/end pair to the ordered slice of polyline indices
// the blockout covers, wrapping at the seam when closed.
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

// offsetAlongRightHandNormal mirrors printdxf's helper of the same
// name. Returns the (x, y) point one offset to the right of the
// polyline tangent at pidx. Right-hand convention matches the DXF
// emitter so dimensions / markers sit on the same side of the line
// in both formats.
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
	nx := dy / length
	ny := -dx / length
	return p[0] + offset*nx, p[1] + offset*ny
}

// emitText writes a single <text> element at (x, y) with the given
// content. Font size is set on the .layer-* parent via CSS so we
// don't repeat the attribute per element. The content is XML-escaped.
func emitText(b *strings.Builder, x, y float64, content string) {
	fmt.Fprintf(b, `<text x="%s" y="%s">%s</text>`+"\n",
		fmtFloat(x), fmtFloat(y), escapeText(content),
	)
}

// fmtFloat formats a float at 1 decimal place, dropping a trailing
// ".0" to keep the SVG compact. "100.0" → "100", "10.5" → "10.5".
// SVG's number grammar tolerates both forms.
func fmtFloat(v float64) string {
	s := fmt.Sprintf("%.1f", v)
	if strings.HasSuffix(s, ".0") {
		return s[:len(s)-2]
	}
	return s
}

// runClassName produces the per-run class fragment. The DXF emitter
// uses layer names with an RUN_ prefix; the SVG uses a class with a
// "run-" prefix (lowercase-with-dashes is the CSS convention) and
// sanitizes to the class-name character set: letters, digits, hyphen
// and underscore. Anything else becomes a hyphen.
func runClassName(id string) string {
	if id == "" {
		return "run-anon"
	}
	var out strings.Builder
	out.Grow(len(id) + 4)
	out.WriteString("run-")
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z',
			r >= 'A' && r <= 'Z',
			r >= '0' && r <= '9',
			r == '_', r == '-':
			out.WriteRune(r)
		default:
			out.WriteRune('-')
		}
	}
	return out.String()
}

// escapeText XML-escapes a free-form string for use as a text node
// body. Covers the five XML "predefined entities" that must always
// be escaped in element content (< > & ' "), plus a defensive pass
// that drops control characters which would break parsers.
func escapeText(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	for _, r := range s {
		switch r {
		case '<':
			out.WriteString("&lt;")
		case '>':
			out.WriteString("&gt;")
		case '&':
			out.WriteString("&amp;")
		case '\'':
			out.WriteString("&apos;")
		case '"':
			out.WriteString("&quot;")
		default:
			if r < 0x20 && r != '\t' && r != '\n' {
				// Drop other control characters — they'd otherwise
				// produce a malformed XML document.
				continue
			}
			out.WriteRune(r)
		}
	}
	return out.String()
}

// escapeAttr is the attribute-value variant of escapeText. Identical
// for our use-cases (no attribute embedded newlines / tabs), kept as
// a separate function so future divergence (e.g. CDATA-style attr
// handling) has a single edit site.
func escapeAttr(s string) string {
	return escapeText(s)
}
