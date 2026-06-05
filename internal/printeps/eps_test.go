package printeps

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestEmitEPSTwoRuns is the golden-path coverage: an open + a closed
// run produce a valid EPS with the required %!PS-Adobe-3.0 EPSF-3.0
// preamble, %%BoundingBox header, /mm helper, and one moveto +
// linetos per run.
func TestEmitEPSTwoRuns(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 300, 200},
		Runs: []designdoc.Run{
			{
				ID: "open-1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {100, 50}, {200, 0}},
					Closed: false,
				},
			},
			{
				ID: "closed-1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{10, 10}, {50, 10}, {50, 50}, {10, 50}},
					Closed: true,
				},
			},
		},
	}

	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()

	// EPS preamble — required by the DSC. Must be byte-zero of the file
	// (some legacy RIPs sniff exactly the first 12 chars).
	if !strings.HasPrefix(out, "%!PS-Adobe-3.0 EPSF-3.0\n") {
		t.Errorf("expected EPS preamble; got start: %q", first(out, 40))
	}

	// BoundingBox: 300 mm wide → 851 pt (ceil(300 * 72/25.4) = ceil(850.39) = 851),
	// 200 mm tall → 567 pt (ceil(200 * 72/25.4) = ceil(566.93) = 567).
	if !strings.Contains(out, "\n%%BoundingBox: 0 0 851 567\n") {
		t.Errorf("expected BoundingBox 0 0 851 567; got:\n%s", first(out, 200))
	}

	// %%Pages declares we're single-page (the "E" in EPS).
	if !strings.Contains(out, "%%Pages: 1") {
		t.Errorf("missing %%Pages: 1 declaration")
	}

	// /mm helper definition must be present once.
	if got := strings.Count(out, "/mm { 2.834645669 mul } def"); got != 1 {
		t.Errorf("want 1 /mm definition, got %d", got)
	}

	// Each run: moveto + lineto pairs. Spot-check the first vertex of
	// the open run (0,0) → "newpath 0 mm 0 mm moveto", and the closed
	// run's first vertex (10,10) → "newpath 10 mm 10 mm moveto".
	if !strings.Contains(out, "newpath 0 mm 0 mm moveto") {
		t.Errorf("missing open run moveto; got:\n%s", out)
	}
	if !strings.Contains(out, "newpath 10 mm 10 mm moveto") {
		t.Errorf("missing closed run moveto")
	}

	// Closed run uses closepath.
	if !strings.Contains(out, "closepath") {
		t.Errorf("missing closepath for closed run")
	}

	// stroke ops per run.
	if got := strings.Count(out, "\nstroke\n"); got < 2 {
		t.Errorf("want >=2 stroke ops (one per run), got %d", got)
	}

	// %%EOF terminator.
	if !strings.HasSuffix(out, "%%EOF\n") {
		t.Errorf("expected %%EOF terminator; got last:\n%s", last(out, 40))
	}
}

// TestEmitEPSEmptyDoc — zero-run doc still produces a valid EPS with
// a 1×1 fallback bbox.
func TestEmitEPSEmptyDoc(t *testing.T) {
	doc := &designdoc.Doc{Version: 1}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS empty: %v", err)
	}
	out := buf.String()
	// 1 mm = ceil(1 * 72/25.4) = 3 pt for the URX/URY corner.
	if !strings.Contains(out, "%%BoundingBox: 0 0 3 3") {
		t.Errorf("empty doc: expected 1mm fallback bbox '0 0 3 3'; got:\n%s", first(out, 200))
	}
	if strings.Contains(out, "moveto") {
		t.Errorf("empty doc: should not contain any drawing commands")
	}
	if !strings.HasSuffix(out, "%%EOF\n") {
		t.Errorf("empty doc: expected %%EOF terminator")
	}
}

// TestEmitEPSNilDoc — nil is a programming error.
func TestEmitEPSNilDoc(t *testing.T) {
	var buf bytes.Buffer
	if err := EmitEPS(&buf, nil); err == nil {
		t.Errorf("EmitEPS(nil) should error")
	}
}

// TestEmitEPSElectrodes covers the filled-circle emission for
// electrodes — `circ` procedure invoked once per in-range Electrode,
// out-of-range silently skipped.
func TestEmitEPSElectrodes(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 5}, {20, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0},
					{PointIndex: 2},
					{PointIndex: 99}, // out of range
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()
	// /circ is the filled-circle helper. Exactly two invocations
	// (the 99 PointIndex is skipped).
	if got := strings.Count(out, " circ\n"); got != 2 {
		t.Errorf("want 2 circ invocations, got %d\n%s", got, out)
	}
	// Spot-check the coordinates: "0 0 3 circ" for the first
	// electrode, "20 0 3 circ" for the third.
	if !strings.Contains(out, "0 0 3 circ\n") {
		t.Errorf("missing electrode at (0,0); got:\n%s", out)
	}
	if !strings.Contains(out, "20 0 3 circ\n") {
		t.Errorf("missing electrode at (20,0)")
	}
}

// TestEmitEPSRunLabelsAndLabels — run labels + free-form labels both
// use Helvetica via findfont. Run-label gate matches DXF/SVG (any
// annotation content opens the gate).
func TestEmitEPSRunLabelsAndLabels(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID:         "r1",
				Polyline:   designdoc.Polyline{Points: [][2]float64{{1, 2}, {3, 4}}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}}, // gate
			},
		},
		Labels: []designdoc.Label{
			{X: 50, Y: 60, Text: "transformer"},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "/Helvetica findfont") {
		t.Errorf("missing Helvetica findfont")
	}
	if !strings.Contains(out, "(Run 1) show") {
		t.Errorf("missing 'Run 1' label; got:\n%s", out)
	}
	if !strings.Contains(out, "(transformer) show") {
		t.Errorf("missing 'transformer' free-form label")
	}
}

// TestEmitEPSDimensions covers per-dimension line + text emission.
func TestEmitEPSDimensions(t *testing.T) {
	doc := &designdoc.Doc{
		Dimensions: []designdoc.Dimension{
			{X1: 0, Y1: 0, X2: 100, Y2: 0, Note: ""},
			{X1: 0, Y1: 0, X2: 50, Y2: 50, Note: "centerline"},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()
	// Dimension 1: horizontal 100 mm long, text "100.0 mm".
	if !strings.Contains(out, "(100.0 mm) show") {
		t.Errorf("missing dimension label '100.0 mm'; got:\n%s", out)
	}
	// Dimension 2 carries a note → "70.7 mm (centerline)" in the source
	// text, but PS string literals require the parens to be escaped, so
	// the on-wire form is "70.7 mm \(centerline\)".
	if !strings.Contains(out, `70.7 mm \(centerline\)`) {
		t.Errorf("missing dimension label with escaped note 'centerline'; got:\n%s", out)
	}
	// Both dimensions traced.
	if got := strings.Count(out, "lineto stroke"); got < 2 {
		t.Errorf("want >=2 line+stroke ops, got %d", got)
	}
}

// TestEmitEPSMarkers covers per-kind dash-pattern + label emission
// for run annotations.
func TestEmitEPSMarkers(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}, {30, 0}, {40, 0}},
				},
				Annotations: []designdoc.Annotation{
					{Kind: "jump", LiveIndex: 1},
					{Kind: "support", LiveIndex: 2},
					{Kind: "doubleback", LiveIndex: 3},
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()

	// Each kind's label appears.
	for _, label := range []string{"(Jump) show", "(Support) show", "(Doubleback) show"} {
		if !strings.Contains(out, label) {
			t.Errorf("missing %q label; got:\n%s", label, out)
		}
	}

	// Per-kind dash patterns precede the marker. The dash setdash op
	// is unique to the markers / blockouts layers.
	if !strings.Contains(out, "[2 1] 0 setdash") {
		t.Errorf("missing jump dash pattern '[2 1]'")
	}
	if !strings.Contains(out, "[3 1 1 1] 0 setdash") {
		t.Errorf("missing doubleback dash pattern '[3 1 1 1]'")
	}

	// Reset of setdash at end of the markers layer so subsequent
	// blockouts / strokes start clean.
	if !strings.Contains(out, "[] 0 setdash") {
		t.Errorf("missing setdash reset")
	}
}

// TestEmitEPSBlockouts covers Run.Blockouts emission as a dashed
// polyline tracing live-arc indices.
func TestEmitEPSBlockouts(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{
						{0, 0}, {10, 0}, {20, 0}, {30, 0}, {40, 0}, {50, 0},
					},
				},
				Blockouts: []designdoc.Blockout{
					{StartLiveIndex: 1, EndLiveIndex: 3},
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()
	// Dashed stroke pattern for blockouts.
	if !strings.Contains(out, "[2 1] 0 setdash") {
		t.Errorf("missing blockout dash pattern")
	}
	// Trace from index 1..3 → mm coords 10 0, 20 0, 30 0.
	if !strings.Contains(out, "newpath 10 mm 0 mm moveto") {
		t.Errorf("missing blockout moveto at (10,0); got:\n%s", out)
	}
	if !strings.Contains(out, "20 mm 0 mm lineto") {
		t.Errorf("missing blockout lineto to (20,0)")
	}
	if !strings.Contains(out, "30 mm 0 mm lineto") {
		t.Errorf("missing blockout lineto to (30,0)")
	}
}

// TestEmitEPSMirrorConcatsTransform — when Options.Mirror is true
// the geometry is wrapped in a horizontal-reflection CTM transform
// applied via `concat`.
func TestEmitEPSMirrorConcatsTransform(t *testing.T) {
	doc := &designdoc.Doc{
		ViewBoxMM: [4]float64{0, 0, 300, 200},
		Runs: []designdoc.Run{
			{
				ID:       "r1",
				Polyline: designdoc.Polyline{Points: [][2]float64{{0, 0}, {10, 5}}},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPSWithOptions(&buf, doc, Options{Mirror: true}); err != nil {
		t.Fatalf("EmitEPSWithOptions mirror: %v", err)
	}
	out := buf.String()
	// 2*cx in mm = 300; in points = 300 * 2.834645669 = 850.4 ≈ 850.4.
	// fmtFloat rounds to 1 decimal so we expect "850.4".
	if !strings.Contains(out, "[ -1 0 0 1 850.4 0 ] concat") {
		t.Errorf("missing mirror CTM transform; got:\n%s", out)
	}
}

// TestEscapePSString — `(`, `)`, `\` are the three reserved chars in
// a PostScript string literal; everything else must pass through
// unchanged.
func TestEscapePSString(t *testing.T) {
	cases := map[string]string{
		"":              "",
		"plain":         "plain",
		"with (paren)":  `with \(paren\)`,
		`back\slash`:    `back\\slash`,
		"5°":            "5°",
		"with\x00ctrl": "withctrl",
	}
	for in, want := range cases {
		if got := escapePSString(in); got != want {
			t.Errorf("escapePSString(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEmitEPSFallbackBboxFromGeometry — viewBox derives from
// geometry bbox when ViewBoxMM is zero.
func TestEmitEPSFallbackBboxFromGeometry(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{10, 20}, {110, 70}},
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitEPS(&buf, doc); err != nil {
		t.Fatalf("EmitEPS: %v", err)
	}
	out := buf.String()
	// bbox in mm: x=10 y=20 w=100 h=50 → pt: llx=28 lly=56 urx=341 ury=199.
	// Floor / ceil at the boundary: floor(10 * 2.834645669) = 28,
	// floor(20 * ...) = 56, ceil(110 * ...) = 312, ceil(70 * ...) = 199.
	if !strings.Contains(out, "%%BoundingBox: 28 56 312 199") {
		t.Errorf("missing bbox-derived BoundingBox; got:\n%s", first(out, 200))
	}
}

func first(s string, n int) string {
	if n > len(s) {
		n = len(s)
	}
	return s[:n]
}

func last(s string, n int) string {
	if n > len(s) {
		n = len(s)
	}
	return s[len(s)-n:]
}
