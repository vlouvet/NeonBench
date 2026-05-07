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
