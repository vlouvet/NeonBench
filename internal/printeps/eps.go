// Package printeps emits a minimal Encapsulated PostScript (EPS)
// representation of a designdoc.Doc, suitable for round-tripping into
// Adobe Illustrator / CorelDRAW / any other vector editor that imports
// EPS (which, in practice, is all of them).
//
// Why EPS at all (we already have SVG)?
//   - The trade graphic-design suite (Illustrator, FreeHand legacy
//     files, CorelDRAW) treats EPS as a first-class roundtrip format.
//     Several shops in the field still send EPS to their prepress
//     workflow because their downstream RIPs ingest PostScript
//     natively. SVG is a poor substitute for those specific tools.
//   - EPS is plain ASCII PostScript with a bounding-box header. We
//     don't need a heavyweight PDF/PS library — emitting it by hand
//     is ~150 lines, fewer than the equivalent SVG plumbing.
//
// Why no layer support?
//   - PostScript is procedural — there's no native "layer" concept the
//     way DXF or SVG have. AI's own internal extension uses
//     "Adobe_Illustrator_AI3" comment markers for layers, but that's
//     an Adobe-specific extension that other importers ignore. We
//     don't try to fake layers because the resulting file would be
//     non-portable (only Illustrator round-trips it cleanly) while
//     looking layered in the editor — a worse failure mode than
//     "EPS doesn't support layers, use SVG for that". Operators who
//     need layer filtering should use the SVG export; EPS is the
//     "fits in a single drawing context" sibling.
//
// Why per-doc bounding-box (not per-page)?
//   - EPS is single-page by definition (the "Encapsulated" in EPS).
//     Multi-page output is a separate format (.ps). Our bounding box
//     is the design's bbox in mm, converted to PostScript points
//     (1 mm = 2.834645669 pt). Honoring the doc's mm coordinates as
//     PS points would shrink everything to ~35% scale; the scale
//     factor is applied via a `mm` PostScript procedure so the rest
//     of the drawing code reads in mm.
//
// All coordinates in the output PS source are in mm-units inside a
// "mm" PostScript procedure (definition: 2.834645669 mul); the
// emitter feeds raw mm values into the procedure. The bounding box
// stays in PostScript points (the %%BoundingBox spec).
package printeps

import (
	"fmt"
	"io"
	"math"
	"strings"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// mmToPS is the points-per-millimetre conversion (1 in = 72 pt; 1 in
// = 25.4 mm; therefore 1 mm = 72/25.4 = 2.834645669 pt). Used for the
// %%BoundingBox header — the rest of the drawing code lives in mm
// coordinates via the `mm` PS procedure.
const mmToPS = 72.0 / 25.4

// Annotation geometry constants — mirror printsvg / printdxf so the
// three emitters render at the same physical scale.
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

// Line widths in millimetres (PS converts them via the `mm` proc).
const (
	lineWidthRun       = 0.5
	lineWidthMarker    = 0.4
	lineWidthBlockout  = 0.6
	lineWidthDimension = 0.4
	lineWidthElectrode = 0.3
)

// Options controls the EPS emission. Mirror matches the SVG /
// PDF / DXF convention so the trio of vector exports honor the same
// transformation flag.
type Options struct {
	Mirror bool
}

// EmitEPS writes an EPS representation of doc to w. Default options
// (no mirror). Convenience wrapper.
func EmitEPS(w io.Writer, doc *designdoc.Doc) error {
	return EmitEPSWithOptions(w, doc, Options{})
}

// EmitEPSWithOptions writes the EPS to w, honoring the requested
// options. Layout:
//
//	%!PS-Adobe-3.0 EPSF-3.0
//	%%BoundingBox: <llx> <lly> <urx> <ury>      (in PostScript points)
//	%%Pages: 1
//	%%EndComments
//	/mm { 2.834645669 mul } def                  (mm → points)
//	/circ { ... } def                            (filled-circle helper)
//	% --- drawing ---
//	<paths> stroke
//	<annotations>
//	%%EOF
//
// EmitEPSWithOptions returns an error only if the underlying writer
// fails. A doc with zero runs is not an error — the resulting EPS is
// a valid (empty) drawing.
func EmitEPSWithOptions(w io.Writer, doc *designdoc.Doc, opts Options) error {
	if doc == nil {
		return fmt.Errorf("printeps: nil doc")
	}

	var b strings.Builder
	approxPoints := 0
	for _, r := range doc.Runs {
		approxPoints += len(r.Polyline.Points)
	}
	b.Grow(512 + approxPoints*30 + 512)

	// Resolve a bbox for the %%BoundingBox header. EPS requires
	// integer pt values for compatibility with older RIPs (Adobe Tech
	// Note 5002 §3.6.2). We round up the URL corners and down the LL
	// corners so the box never clips the geometry.
	x, y, wMM, hMM := resolveViewBox(doc)
	llx := int(math.Floor(x * mmToPS))
	lly := int(math.Floor(y * mmToPS))
	urx := int(math.Ceil((x + wMM) * mmToPS))
	ury := int(math.Ceil((y + hMM) * mmToPS))

	// EPS prelude — these comment lines are normative (Adobe DSC).
	// Order matters; %%BoundingBox MUST appear before %%EndComments
	// or older parsers refuse the file.
	fmt.Fprintf(&b,
		"%%!PS-Adobe-3.0 EPSF-3.0\n"+
			"%%%%BoundingBox: %d %d %d %d\n"+
			"%%%%Pages: 1\n"+
			"%%%%Creator: NeonBench\n"+
			"%%%%EndComments\n",
		llx, lly, urx, ury,
	)

	// PostScript helpers. `mm` converts a numeric operand from mm to
	// PostScript points; `circ` draws a filled circle (x y r); `ocirc`
	// strokes an open circle. Defining them once at the top keeps the
	// per-vertex emission compact.
	b.WriteString(
		"/mm { 2.834645669 mul } def\n" +
			"/circ { newpath 3 -1 roll mm 2 index mm 1 index 0 360 arc fill } def\n" +
			"/ocirc { newpath 3 -1 roll mm 2 index mm 1 index 0 360 arc stroke } def\n" +
			"1 setlinejoin 1 setlinecap\n",
	)

	// Mirror is applied as a PostScript CTM op so downstream tools see
	// the geometry source-untouched. matrix [-1 0 0 1 2*cx 0] reflects
	// horizontally about the bbox's vertical midline.
	if opts.Mirror {
		cx := x + wMM/2.0
		// Note: the transform's translation is in PS points, so we
		// convert mm → points inline rather than going through the
		// `mm` procedure (which is for stack arguments only).
		fmt.Fprintf(&b, "[ -1 0 0 1 %s 0 ] concat\n", fmtFloat(2*cx*mmToPS))
	}

	// Runs: one stroked path per non-empty Run.
	for _, run := range doc.Runs {
		// Tier 3 #78 — flattened so a stroked arc follows the curve. Only the
		// DRAWING flattens; anything resolving an electrode or annotation index
		// keeps reading Polyline.Points, whose indices flattening would shift.
		pts := run.Polyline.FlatPoints()
		if len(pts) == 0 {
			continue
		}
		emitPolylinePath(&b, pts, run.Polyline.Closed, lineWidthRun)
	}

	// Annotations: fixed order matching DXF / SVG (electrodes →
	// labels → dimensions → markers → blockouts). PostScript has no
	// native layer concept (see package docstring), so we just emit
	// the drawing ops in sequence — the result is a single visually
	// flat picture.
	if hasElectrodes(doc) {
		emitElectrodes(&b, doc)
	}
	if hasLabels(doc) {
		emitLabels(&b, doc)
	}
	if hasDimensions(doc) {
		emitDimensions(&b, doc)
	}
	if hasMarkers(doc) {
		emitMarkers(&b, doc)
	}
	if hasBlockouts(doc) {
		emitBlockouts(&b, doc)
	}

	b.WriteString("%%EOF\n")

	_, err := io.WriteString(w, b.String())
	return err
}

// resolveViewBox mirrors the printsvg helper. Returns the doc's
// stored ViewBoxMM when non-degenerate, otherwise the geometry bbox,
// otherwise a 1×1 fallback so the EPS still has a valid bounding box.
func resolveViewBox(doc *designdoc.Doc) (x, y, w, h float64) {
	vb := doc.ViewBoxMM
	if vb[2] > 0 && vb[3] > 0 {
		return vb[0], vb[1], vb[2], vb[3]
	}
	minX, minY, maxX, maxY, ok := geometryBBox(doc)
	if !ok {
		return 0, 0, 1, 1
	}
	return minX, minY, maxX - minX, maxY - minY
}

func geometryBBox(doc *designdoc.Doc) (minX, minY, maxX, maxY float64, ok bool) {
	minX, minY = math.Inf(1), math.Inf(1)
	maxX, maxY = math.Inf(-1), math.Inf(-1)
	for _, run := range doc.Runs {
		// An arc bulges outside the hull of its endpoints, so the bbox has to
		// see the flattened curve or the page clips it.
		for _, p := range run.Polyline.FlatPoints() {
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

// emitPolylinePath writes a single stroked path: moveto first vertex,
// lineto the rest, optional closepath, set the stroke width, then
// stroke. PostScript leaves the path state empty after stroke so
// successive runs don't accumulate.
func emitPolylinePath(b *strings.Builder, pts [][2]float64, closed bool, widthMM float64) {
	if len(pts) == 0 {
		return
	}
	fmt.Fprintf(b, "%s mm setlinewidth\n", fmtFloat(widthMM))
	fmt.Fprintf(b, "newpath %s mm %s mm moveto\n",
		fmtFloat(pts[0][0]), fmtFloat(pts[0][1]),
	)
	for _, p := range pts[1:] {
		fmt.Fprintf(b, "%s mm %s mm lineto\n",
			fmtFloat(p[0]), fmtFloat(p[1]),
		)
	}
	if closed {
		b.WriteString("closepath\n")
	}
	b.WriteString("stroke\n")
}

func hasElectrodes(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Electrodes) > 0 {
			return true
		}
	}
	return false
}

func hasLabels(doc *designdoc.Doc) bool {
	if len(doc.Labels) > 0 {
		return true
	}
	return hasAnyAnnotationContent(doc)
}

func hasDimensions(doc *designdoc.Doc) bool {
	return len(doc.Dimensions) > 0
}

func hasMarkers(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Annotations) > 0 {
			return true
		}
	}
	return false
}

func hasBlockouts(doc *designdoc.Doc) bool {
	for _, r := range doc.Runs {
		if len(r.Blockouts) > 0 {
			return true
		}
	}
	return false
}

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

// emitElectrodes writes one filled circle per in-range Electrode.
// Bounds-check discipline matches DXF / SVG.
func emitElectrodes(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, "%s mm setlinewidth\n", fmtFloat(lineWidthElectrode))
	for _, run := range doc.Runs {
		pts := run.Polyline.Points
		for _, e := range run.Electrodes {
			if e.PointIndex < 0 || e.PointIndex >= len(pts) {
				continue
			}
			p := pts[e.PointIndex]
			// circ args: x y r → procedure does mm-conversion internally.
			fmt.Fprintf(b, "%s %s %s circ\n",
				fmtFloat(p[0]), fmtFloat(p[1]), fmtFloat(electrodeRadiusMM),
			)
		}
	}
}

// emitLabels writes the per-run "Run N" labels and free-form
// Doc.Labels using the Helvetica font (standard 13 PostScript fonts;
// every interpreter has it). Font size is `annotationTextHeight` mm
// converted to points.
func emitLabels(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, "/Helvetica findfont %s mm scalefont setfont\n",
		fmtFloat(annotationTextHeight),
	)
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
	for _, l := range doc.Labels {
		emitText(b, l.X, l.Y, l.Text)
	}
}

// emitDimensions writes one line + one text per Doc.Dimensions[i]
// — geometry / offset convention identical to printdxf / printsvg.
func emitDimensions(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, "%s mm setlinewidth\n", fmtFloat(lineWidthDimension))
	fmt.Fprintf(b, "/Helvetica findfont %s mm scalefont setfont\n",
		fmtFloat(annotationTextHeight),
	)
	for _, d := range doc.Dimensions {
		dx := d.X2 - d.X1
		dy := d.Y2 - d.Y1
		length := math.Hypot(dx, dy)
		if length < dimensionMinLengthMM {
			continue
		}
		fmt.Fprintf(b, "newpath %s mm %s mm moveto %s mm %s mm lineto stroke\n",
			fmtFloat(d.X1), fmtFloat(d.Y1),
			fmtFloat(d.X2), fmtFloat(d.Y2),
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
}

// markerStyle resolves a Run.Annotation kind to its EPS marker
// attributes. PostScript has no dash pattern shorthand we can scope
// per-shape easily without resetting the dash; we emit the dash via
// `setdash` before each marker stroke. Radii / labels mirror DXF /
// SVG.
func markerStyle(kind string) (radius float64, dashPattern, label string) {
	switch kind {
	case "jump":
		return markerRadiusJump, "[2 1]", "Jump"
	case "support":
		return markerRadiusSupport, "[]", "Support"
	case "doubleback":
		return markerRadiusDoubleback, "[3 1 1 1]", "Doubleback"
	default:
		return markerRadiusSupport, "[]", kind
	}
}

// emitMarkers writes one circle + one label per Run.Annotation. We
// reset `setdash` to [] after each marker so subsequent dash settings
// (the blockouts layer in particular) don't inherit a per-marker
// stride.
func emitMarkers(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, "%s mm setlinewidth\n", fmtFloat(lineWidthMarker))
	fmt.Fprintf(b, "/Helvetica findfont %s mm scalefont setfont\n",
		fmtFloat(annotationTextHeight),
	)
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
			radius, dashPattern, label := markerStyle(a.Kind)

			fmt.Fprintf(b, "%s 0 setdash\n", dashPattern)
			fmt.Fprintf(b, "%s %s %s ocirc\n",
				fmtFloat(p[0]), fmtFloat(p[1]), fmtFloat(radius),
			)
			tx, ty := offsetAlongRightHandNormal(pts, pidx, markerTextOffset)
			emitText(b, tx, ty, label)
		}
	}
	// Reset the dash so subsequent layers (blockouts) start from a
	// known state.
	b.WriteString("[] 0 setdash\n")
}

// emitBlockouts writes the dashed-stroke polyline trace per
// Run.Blockouts[i]. Same live-arc walk as printdxf / printsvg.
func emitBlockouts(b *strings.Builder, doc *designdoc.Doc) {
	fmt.Fprintf(b, "%s mm setlinewidth\n", fmtFloat(lineWidthBlockout))
	b.WriteString("[2 1] 0 setdash\n")
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
			fmt.Fprintf(b, "newpath %s mm %s mm moveto\n",
				fmtFloat(coords[0][0]), fmtFloat(coords[0][1]),
			)
			for _, p := range coords[1:] {
				fmt.Fprintf(b, "%s mm %s mm lineto\n",
					fmtFloat(p[0]), fmtFloat(p[1]),
				)
			}
			b.WriteString("stroke\n")
		}
	}
	b.WriteString("[] 0 setdash\n")
}

// walkBlockoutIndices mirrors printsvg / printdxf.
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

// offsetAlongRightHandNormal mirrors the printsvg / printdxf helper.
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

// emitText writes a `moveto + show` pair for the given content at
// the given mm position. Strings are encoded as PostScript literals
// with backslash-escapes for the three reserved characters: `(`,
// `)`, and `\`.
func emitText(b *strings.Builder, x, y float64, content string) {
	fmt.Fprintf(b, "%s mm %s mm moveto (%s) show\n",
		fmtFloat(x), fmtFloat(y), escapePSString(content),
	)
}

// escapePSString turns a free-form string into a PostScript literal
// body (without the surrounding parentheses). The grammar requires
// escaping `(`, `)`, and `\`; we also strip control characters that
// would confuse parsers.
func escapePSString(s string) string {
	var out strings.Builder
	out.Grow(len(s))
	for _, r := range s {
		switch r {
		case '(':
			out.WriteString(`\(`)
		case ')':
			out.WriteString(`\)`)
		case '\\':
			out.WriteString(`\\`)
		default:
			if r < 0x20 && r != '\t' && r != '\n' {
				continue
			}
			out.WriteRune(r)
		}
	}
	return out.String()
}

// fmtFloat formats a float at 1 decimal place, dropping a trailing
// ".0" to keep the EPS source compact. PostScript's number grammar
// tolerates both forms.
func fmtFloat(v float64) string {
	s := fmt.Sprintf("%.1f", v)
	if strings.HasSuffix(s, ".0") {
		return s[:len(s)-2]
	}
	return s
}
