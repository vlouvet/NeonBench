package printdxf

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestEmitDXFTwoPolylines is the golden-path coverage: an open polyline
// and a closed polyline emit a valid R12 ASCII DXF whose header, entity
// count, closed-flag values, and coordinates match expectations.
func TestEmitDXFTwoPolylines(t *testing.T) {
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
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()

	// (a) DXF header preamble.
	if !strings.HasPrefix(out, "0\nSECTION\n2\nHEADER\n") {
		t.Errorf("expected DXF to start with HEADER section preamble, got:\n%s", first(out, 80))
	}

	// R12 dialect declared.
	if !strings.Contains(out, "$ACADVER\n1\nAC1009\n") {
		t.Errorf("missing $ACADVER=AC1009 in header")
	}

	// Millimeters declared.
	if !strings.Contains(out, "$INSUNITS\n70\n4\n") {
		t.Errorf("missing $INSUNITS=4 (mm) in header")
	}

	// (b) Exactly two LWPOLYLINE entities.
	if got := strings.Count(out, "LWPOLYLINE"); got != 2 {
		t.Errorf("LWPOLYLINE count: want 2, got %d\n%s", got, out)
	}

	// (c) Closed flag values: open polyline → "70\n0", closed → "70\n1".
	// We expect both forms to appear at least once.
	if !strings.Contains(out, "\n70\n0\n") {
		t.Errorf("expected an open-polyline flag (70\\n0\\n) in output:\n%s", out)
	}
	if !strings.Contains(out, "\n70\n1\n") {
		t.Errorf("expected a closed-polyline flag (70\\n1\\n) in output:\n%s", out)
	}

	// (d) Expected coordinates at 1 decimal place. Spot-check one from
	// each polyline.
	for _, want := range []string{
		"10\n0.0\n20\n0.0\n",     // open run, first vertex
		"10\n100.0\n20\n50.0\n",  // open run, mid vertex
		"10\n200.0\n20\n0.0\n",   // open run, last vertex
		"10\n10.0\n20\n10.0\n",   // closed run, first vertex
		"10\n50.0\n20\n50.0\n",   // closed run, mid vertex
	} {
		if !strings.Contains(out, want) {
			t.Errorf("expected coordinate pair %q in output", want)
		}
	}

	// Layer names use RUN_ prefix.
	if !strings.Contains(out, "8\nRUN_open-1\n") {
		t.Errorf("expected layer RUN_open-1 in output")
	}
	if !strings.Contains(out, "8\nRUN_closed-1\n") {
		t.Errorf("expected layer RUN_closed-1 in output")
	}

	// Vertex counts (group code 90).
	if !strings.Contains(out, "90\n3\n") {
		t.Errorf("expected vertex count 3 for open polyline")
	}
	if !strings.Contains(out, "90\n4\n") {
		t.Errorf("expected vertex count 4 for closed polyline")
	}

	// EOF terminator.
	if !strings.HasSuffix(strings.TrimRight(out, "\n"), "0\nEOF") {
		t.Errorf("expected DXF to end with 0\\nEOF, got:\n%s", last(out, 40))
	}
}

// TestEmitDXFEmptyDoc covers the zero-run case: a valid DXF file with no
// entities, which CAM software opens as an empty drawing rather than
// erroring.
func TestEmitDXFEmptyDoc(t *testing.T) {
	doc := &designdoc.Doc{Version: 1}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF empty: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, "SECTION\n2\nENTITIES\n") {
		t.Errorf("empty doc: expected ENTITIES section header")
	}
	if strings.Contains(out, "LWPOLYLINE") {
		t.Errorf("empty doc: should not contain any LWPOLYLINE entities")
	}
	if !strings.HasSuffix(strings.TrimRight(out, "\n"), "0\nEOF") {
		t.Errorf("empty doc: expected EOF terminator")
	}
}

// TestEmitDXFNilDoc guards the API: a nil doc is a programming error.
func TestEmitDXFNilDoc(t *testing.T) {
	var buf bytes.Buffer
	if err := EmitDXF(&buf, nil); err == nil {
		t.Errorf("EmitDXF(nil) should error")
	}
}

// TestEmitDXFSkipsEmptyPolylines ensures runs with zero points are
// dropped rather than emitted as malformed entities.
func TestEmitDXFSkipsEmptyPolylines(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{ID: "empty", Polyline: designdoc.Polyline{}},
			{ID: "good", Polyline: designdoc.Polyline{
				Points: [][2]float64{{1, 1}, {2, 2}},
			}},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()
	if got := strings.Count(out, "LWPOLYLINE"); got != 1 {
		t.Errorf("want 1 LWPOLYLINE (empty run dropped), got %d", got)
	}
	if strings.Contains(out, "RUN_empty") {
		t.Errorf("empty-run layer should not appear: %s", out)
	}
}

// TestLayerNameSanitization covers the DXF-name-character constraint:
// spaces, slashes, and other prohibited characters become underscores.
func TestLayerNameSanitization(t *testing.T) {
	cases := map[string]string{
		"":               "RUN",
		"abc":            "RUN_abc",
		"id-1":           "RUN_id-1",
		"a b/c":          "RUN_a_b_c",
		"weird@chars!":   "RUN_weird_chars_",
		"123":            "RUN_123",
	}
	for in, want := range cases {
		if got := layerName(in); got != want {
			t.Errorf("layerName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEmitDXFElectrodes verifies the CIRCLE entities on layer ELECTRODES:
// one per in-range Electrode.PointIndex, centered on the referenced
// polyline point, radius 3.0 mm. Out-of-range indices are silently
// skipped — storage validation should already prevent that condition,
// but the emitter is defensive.
func TestEmitDXFElectrodes(t *testing.T) {
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
					{PointIndex: 99}, // out of range, must be skipped
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()

	if got := strings.Count(out, "\n0\nCIRCLE\n"); got != 2 {
		t.Errorf("CIRCLE count: want 2, got %d\n%s", got, out)
	}
	if got := strings.Count(out, "8\nELECTRODES\n"); got != 2 {
		t.Errorf("ELECTRODES layer count: want 2, got %d", got)
	}
	// First electrode at (0, 0), radius 3.0.
	if !strings.Contains(out, "0\nCIRCLE\n8\nELECTRODES\n10\n0.0\n20\n0.0\n40\n3.0\n") {
		t.Errorf("missing CIRCLE at (0,0) radius 3.0:\n%s", out)
	}
	// Second electrode at (20, 0), radius 3.0.
	if !strings.Contains(out, "0\nCIRCLE\n8\nELECTRODES\n10\n20.0\n20\n0.0\n40\n3.0\n") {
		t.Errorf("missing CIRCLE at (20,0) radius 3.0:\n%s", out)
	}
}

// TestEmitDXFRunLabels covers the per-run "Run N" labels. We include a
// minimal sentinel electrode to flip the annotation-gate on; the test's
// focus is on the run-label emission itself (count, layer, content,
// insert points).
func TestEmitDXFRunLabels(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "first",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{1, 2}, {3, 4}},
				},
				// Sentinel: any annotation content opts the doc into the
				// annotation block (see hasAnnotations / emitter docs).
				Electrodes: []designdoc.Electrode{{PointIndex: 0}},
			},
			{
				ID: "second",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{50, 60}, {70, 80}},
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()

	// "Run 1" TEXT at the first run's first vertex (1, 2).
	if !strings.Contains(out, "0\nTEXT\n8\nLABELS\n10\n1.0\n20\n2.0\n40\n5.0\n1\nRun 1\n") {
		t.Errorf("missing 'Run 1' TEXT at (1,2):\n%s", out)
	}
	// "Run 2" TEXT at the second run's first vertex (50, 60).
	if !strings.Contains(out, "0\nTEXT\n8\nLABELS\n10\n50.0\n20\n60.0\n40\n5.0\n1\nRun 2\n") {
		t.Errorf("missing 'Run 2' TEXT at (50,60):\n%s", out)
	}
	// Exactly two run-label TEXTs.
	if got := strings.Count(out, "1\nRun "); got != 2 {
		t.Errorf("Run-label TEXT count: want 2, got %d", got)
	}
}

// TestEmitDXFFreeFormLabels covers Doc.Labels emission on the LABELS
// layer.
func TestEmitDXFFreeFormLabels(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
			},
		},
		Labels: []designdoc.Label{
			{X: 50, Y: 50, Text: "transformer"},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()

	// The free-form label TEXT at (50, 50) with content "transformer".
	if !strings.Contains(out, "0\nTEXT\n8\nLABELS\n10\n50.0\n20\n50.0\n40\n5.0\n1\ntransformer\n") {
		t.Errorf("missing free-form label TEXT:\n%s", out)
	}
}

// TestEmitDXFDimensions covers Doc.Dimensions emission: one LINE + one
// TEXT per dimension on the DIMENSIONS layer, with text content
// "<length> mm" or "<length> mm (<note>)".
func TestEmitDXFDimensions(t *testing.T) {
	doc := &designdoc.Doc{
		Dimensions: []designdoc.Dimension{
			{X1: 0, Y1: 0, X2: 100, Y2: 0, Note: ""},
			{X1: 0, Y1: 0, X2: 0, Y2: 50, Note: "centerline"},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()

	if got := strings.Count(out, "\n0\nLINE\n"); got != 2 {
		t.Errorf("LINE count: want 2, got %d\n%s", got, out)
	}
	if got := strings.Count(out, "8\nDIMENSIONS\n"); got != 4 {
		// Two LINEs + two TEXTs all on DIMENSIONS = four occurrences.
		t.Errorf("DIMENSIONS layer count: want 4 (2 LINE + 2 TEXT), got %d", got)
	}

	// Horizontal 100 mm dimension: LINE from (0,0) to (100,0).
	if !strings.Contains(out, "0\nLINE\n8\nDIMENSIONS\n10\n0.0\n20\n0.0\n11\n100.0\n21\n0.0\n") {
		t.Errorf("missing horizontal LINE entity:\n%s", out)
	}
	// "100.0 mm" text.
	if !strings.Contains(out, "1\n100.0 mm\n") {
		t.Errorf("missing '100.0 mm' TEXT:\n%s", out)
	}

	// Vertical 50 mm dimension with note: LINE from (0,0) to (0,50).
	if !strings.Contains(out, "0\nLINE\n8\nDIMENSIONS\n10\n0.0\n20\n0.0\n11\n0.0\n21\n50.0\n") {
		t.Errorf("missing vertical LINE entity:\n%s", out)
	}
	// "50.0 mm (centerline)" text.
	if !strings.Contains(out, "1\n50.0 mm (centerline)\n") {
		t.Errorf("missing '50.0 mm (centerline)' TEXT:\n%s", out)
	}
}

// TestEmitDXFDegenerateDimensionSkipped verifies dimensions shorter than
// 0.01 mm are dropped entirely — emitting a TEXT-only marker with no
// line would mislead the operator about what's being measured.
func TestEmitDXFDegenerateDimensionSkipped(t *testing.T) {
	doc := &designdoc.Doc{
		Dimensions: []designdoc.Dimension{
			{X1: 0, Y1: 0, X2: 0.001, Y2: 0},
		},
	}
	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	out := buf.String()
	if strings.Contains(out, "\n0\nLINE\n") {
		t.Errorf("degenerate dimension should not produce a LINE:\n%s", out)
	}
	if strings.Contains(out, " mm") {
		t.Errorf("degenerate dimension should not produce a measurement TEXT:\n%s", out)
	}
}

// TestEmitDXFBackwardsCompatible asserts byte-identical output for the
// exact doc from TestEmitDXFTwoPolylines: no electrodes, no free-form
// labels, no dimensions. This is the regression guard for the legacy
// design-version corpus — any future change to layer ordering, whitespace,
// or annotation-gate logic that perturbs byte-level output for the
// pre-Tier-3-#21 case will fire this test.
func TestEmitDXFBackwardsCompatible(t *testing.T) {
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
	const wantOutput = "0\nSECTION\n2\nHEADER\n9\n$ACADVER\n1\nAC1009\n9\n$INSUNITS\n70\n4\n0\nENDSEC\n0\nSECTION\n2\nENTITIES\n0\nLWPOLYLINE\n8\nRUN_open-1\n70\n0\n90\n3\n10\n0.0\n20\n0.0\n10\n100.0\n20\n50.0\n10\n200.0\n20\n0.0\n0\nLWPOLYLINE\n8\nRUN_closed-1\n70\n1\n90\n4\n10\n10.0\n20\n10.0\n10\n50.0\n20\n10.0\n10\n50.0\n20\n50.0\n10\n10.0\n20\n50.0\n0\nENDSEC\n0\nEOF\n"

	var buf bytes.Buffer
	if err := EmitDXF(&buf, doc); err != nil {
		t.Fatalf("EmitDXF: %v", err)
	}
	if got := buf.String(); got != wantOutput {
		t.Errorf("byte-identical regression broken.\n--- got ---\n%s\n--- want ---\n%s", got, wantOutput)
	}
}

func first(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func last(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}
