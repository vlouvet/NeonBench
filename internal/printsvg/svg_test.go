package printsvg

import (
	"bytes"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestEmitSVGTwoRuns is the golden-path coverage: an open run and a
// closed run produce a valid SVG with one <g class="run run-..."> per
// run, the right vertex coordinates, the closed run's first vertex
// repeated, and an mm-unit viewBox / width / height that matches
// doc.ViewBoxMM.
func TestEmitSVGTwoRuns(t *testing.T) {
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
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()

	// XML prologue.
	if !strings.HasPrefix(out, `<?xml version="1.0" encoding="UTF-8"?>`) {
		t.Errorf("expected XML prologue, got start: %q", first(out, 60))
	}

	// SVG root with mm viewBox + width + height.
	if !strings.Contains(out, `viewBox="0 0 300 200"`) {
		t.Errorf("expected viewBox=0 0 300 200; got\n%s", first(out, 400))
	}
	if !strings.Contains(out, `width="300mm"`) || !strings.Contains(out, `height="200mm"`) {
		t.Errorf("expected width=300mm height=200mm")
	}

	// Both runs emitted, one <g class="run run-..."> each.
	if got := strings.Count(out, `class="run run-`); got != 2 {
		t.Errorf("want 2 run groups, got %d\n%s", got, out)
	}
	if !strings.Contains(out, `class="run run-open-1"`) {
		t.Errorf("missing class for open-1; got:\n%s", out)
	}
	if !strings.Contains(out, `class="run run-closed-1"`) {
		t.Errorf("missing class for closed-1")
	}
	if !strings.Contains(out, `data-run-id="open-1"`) {
		t.Errorf("missing data-run-id attr for open-1")
	}

	// Open polyline points: "0,0 100,50 200,0" (no trailing repeated vertex).
	if !strings.Contains(out, `points="0,0 100,50 200,0"`) {
		t.Errorf("missing open polyline points; got:\n%s", out)
	}

	// Closed polyline repeats the first vertex at the end for stroke closure:
	// "10,10 50,10 50,50 10,50 10,10".
	if !strings.Contains(out, `points="10,10 50,10 50,50 10,50 10,10"`) {
		t.Errorf("missing closed polyline points (repeat-first-vertex pattern); got:\n%s", out)
	}

	// Closing </svg> terminator.
	if !strings.HasSuffix(strings.TrimSpace(out), `</svg>`) {
		t.Errorf("expected SVG to end with </svg>; got last:\n%s", last(out, 60))
	}
}

// TestEmitSVGEmptyDoc — a doc with no runs is well-formed: it gets a
// fallback viewBox so downstream tools render it as an empty 1×1
// canvas rather than choking on missing dimensions.
func TestEmitSVGEmptyDoc(t *testing.T) {
	doc := &designdoc.Doc{Version: 1}
	var buf bytes.Buffer
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG empty: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `viewBox="0 0 1 1"`) {
		t.Errorf("empty doc: expected fallback viewBox=0 0 1 1; got:\n%s", out)
	}
	if strings.Contains(out, `class="run`) {
		t.Errorf("empty doc: should not contain any run groups")
	}
	if !strings.HasSuffix(strings.TrimSpace(out), `</svg>`) {
		t.Errorf("empty doc: expected </svg> terminator")
	}
}

// TestEmitSVGNilDoc — a nil doc is a programming error.
func TestEmitSVGNilDoc(t *testing.T) {
	var buf bytes.Buffer
	if err := EmitSVG(&buf, nil); err == nil {
		t.Errorf("EmitSVG(nil) should error")
	}
}

// TestEmitSVGElectrodes covers the electrodes layer: one <circle> per
// in-range Electrode.PointIndex on layer-electrodes, with the correct
// radius (3.0 mm). Out-of-range indices are silently skipped, matching
// the DXF emitter's defensive guard.
func TestEmitSVGElectrodes(t *testing.T) {
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
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()

	if !strings.Contains(out, `<g class="layer-electrodes">`) {
		t.Errorf("missing electrodes layer group")
	}
	// Exactly two electrodes (third is out of range).
	if got := strings.Count(out, `<circle cx=`); got < 2 {
		t.Errorf("want >=2 circles for electrodes, got %d\n%s", got, out)
	}
	if !strings.Contains(out, `<circle cx="0" cy="0" r="3"/>`) {
		t.Errorf("missing electrode circle at (0,0); got:\n%s", out)
	}
	if !strings.Contains(out, `<circle cx="20" cy="0" r="3"/>`) {
		t.Errorf("missing electrode circle at (20,0)")
	}
}

// TestEmitSVGAnnotationLayers verifies the dedicated <g class="layer-..">
// groups appear in fixed order so regression diffs stay readable.
// Same fixed order as the DXF emitter: electrodes → labels →
// dimensions → markers → blockouts.
func TestEmitSVGAnnotationLayers(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}, {30, 0}},
				},
				Electrodes:  []designdoc.Electrode{{PointIndex: 0}},
				Annotations: []designdoc.Annotation{{Kind: "jump", LiveIndex: 1}},
				Blockouts:   []designdoc.Blockout{{StartLiveIndex: 1, EndLiveIndex: 2}},
			},
		},
		Labels:     []designdoc.Label{{X: 50, Y: 50, Text: "transformer"}},
		Dimensions: []designdoc.Dimension{{X1: 0, Y1: 0, X2: 100, Y2: 0}},
	}

	var buf bytes.Buffer
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()

	// Each layer's <g> appears exactly once.
	for _, cls := range []string{
		"layer-electrodes",
		"layer-labels",
		"layer-dimensions",
		"layer-markers",
		"layer-blockouts",
	} {
		if got := strings.Count(out, `class="`+cls+`"`); got != 1 {
			t.Errorf("want 1 %q group, got %d", cls, got)
		}
	}

	// Fixed order: electrodes → labels → dimensions → markers → blockouts.
	order := []string{
		`class="layer-electrodes"`,
		`class="layer-labels"`,
		`class="layer-dimensions"`,
		`class="layer-markers"`,
		`class="layer-blockouts"`,
	}
	last := -1
	for _, key := range order {
		pos := strings.Index(out, key)
		if pos < 0 {
			t.Fatalf("missing %s", key)
		}
		if pos <= last {
			t.Errorf("layer order violated: %s appeared before previous layer", key)
		}
		last = pos
	}
}

// TestEmitSVGGeometryOnlyHasNoAnnotationLayers — a doc with no
// annotation content (no electrodes, labels, dimensions, markers,
// blockouts) must not emit any of the five annotation layer groups.
// Matches the DXF "byte-compat for legacy docs" gate so geometry-only
// designs render compactly in both formats.
func TestEmitSVGGeometryOnlyHasNoAnnotationLayers(t *testing.T) {
	doc := &designdoc.Doc{
		ViewBoxMM: [4]float64{0, 0, 100, 100},
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 5}},
				},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()
	for _, cls := range []string{
		"layer-electrodes", "layer-labels", "layer-dimensions",
		"layer-markers", "layer-blockouts",
	} {
		if strings.Contains(out, `class="`+cls+`"`) {
			t.Errorf("geometry-only doc unexpectedly emitted %s layer", cls)
		}
	}
}

// TestEmitSVGRunLabels covers per-run "Run N" emission. Gated on any
// annotation content existing — without that gate, geometry-only docs
// would gain noisy overlays.
func TestEmitSVGRunLabels(t *testing.T) {
	doc := &designdoc.Doc{
		Runs: []designdoc.Run{
			{
				ID:         "first",
				Polyline:   designdoc.Polyline{Points: [][2]float64{{1, 2}, {3, 4}}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}}, // open gate
			},
			{
				ID:       "second",
				Polyline: designdoc.Polyline{Points: [][2]float64{{50, 60}, {70, 80}}},
			},
		},
	}
	var buf bytes.Buffer
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `<text x="1" y="2">Run 1</text>`) {
		t.Errorf("missing 'Run 1' label at (1,2); got:\n%s", out)
	}
	if !strings.Contains(out, `<text x="50" y="60">Run 2</text>`) {
		t.Errorf("missing 'Run 2' label at (50,60)")
	}
}

// TestEmitSVGMarkers covers per-kind marker emission. Different radii +
// dash patterns + labels per Annotation.Kind, with data-kind for JS
// consumers.
func TestEmitSVGMarkers(t *testing.T) {
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
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()

	// One <circle> per annotation, each carrying data-kind="<kind>".
	for _, kind := range []string{"jump", "support", "doubleback"} {
		if !strings.Contains(out, `data-kind="`+kind+`"`) {
			t.Errorf("missing marker for kind=%s; got:\n%s", kind, out)
		}
	}

	// "Jump" / "Support" / "Doubleback" labels appear next to each marker.
	for _, label := range []string{"Jump", "Support", "Doubleback"} {
		if !strings.Contains(out, `>`+label+`</text>`) {
			t.Errorf("missing %s label", label)
		}
	}

	// Per-kind radii: jump=4, support=3, doubleback=5.
	if !strings.Contains(out, `r="4"`) {
		t.Errorf("expected jump radius r=4")
	}
	if !strings.Contains(out, `r="3"`) {
		t.Errorf("expected support radius r=3")
	}
	if !strings.Contains(out, `r="5"`) {
		t.Errorf("expected doubleback radius r=5")
	}
}

// TestEmitSVGBlockouts covers Run.Blockouts emission: one
// <polyline> per blockout on the layer-blockouts group, tracing the
// live-arc indices end-to-end with the dashed stroke styling.
func TestEmitSVGBlockouts(t *testing.T) {
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
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `<g class="layer-blockouts">`) {
		t.Errorf("missing layer-blockouts group")
	}
	// The blockout polyline walks indices 1..3 → points (10,0) (20,0) (30,0).
	if !strings.Contains(out, `points="10,0 20,0 30,0"`) {
		t.Errorf("missing blockout polyline points 10,0 20,0 30,0; got:\n%s", out)
	}
}

// TestEmitSVGMirrorWrapsInTransform — when Options.Mirror is true the
// output wraps the geometry in a <g transform="matrix(-1 0 0 1 ...)">
// so downstream tools can ignore the wrapper or apply it.
func TestEmitSVGMirrorWrapsInTransform(t *testing.T) {
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
	if err := EmitSVGWithOptions(&buf, doc, Options{Mirror: true}); err != nil {
		t.Fatalf("EmitSVGWithOptions mirror: %v", err)
	}
	out := buf.String()
	// 2*cx = 2 * (0 + 300/2) = 300.
	if !strings.Contains(out, `<g transform="matrix(-1 0 0 1 300 0)">`) {
		t.Errorf("missing mirror transform; got:\n%s", out)
	}
}

// TestEmitSVGEscapesText covers XML entity escaping in free-form
// strings — labels and notes may contain anything (<, >, &, '. ", a
// stray tab) and must produce a well-formed XML document.
func TestEmitSVGEscapesText(t *testing.T) {
	doc := &designdoc.Doc{
		Labels: []designdoc.Label{
			{X: 0, Y: 0, Text: `<script>"AT&T's" 5°`},
		},
	}
	var buf bytes.Buffer
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `&lt;script&gt;&quot;AT&amp;T&apos;s&quot; 5°`) {
		t.Errorf("text not properly escaped; got:\n%s", out)
	}
}

// TestRunClassNameSanitization — class names must conform to the CSS
// character set; non-conforming bytes (spaces, slashes, '@', '!')
// become hyphens. Empty ID falls back to "run-anon".
func TestRunClassNameSanitization(t *testing.T) {
	cases := map[string]string{
		"":             "run-anon",
		"abc":          "run-abc",
		"id-1":         "run-id-1",
		"a b/c":        "run-a-b-c",
		"weird@chars!": "run-weird-chars-",
		"123":          "run-123",
	}
	for in, want := range cases {
		if got := runClassName(in); got != want {
			t.Errorf("runClassName(%q) = %q, want %q", in, got, want)
		}
	}
}

// TestEmitSVGFallbackViewBoxFromGeometry — when ViewBoxMM is zero,
// the viewBox is computed from the geometry bbox so the SVG still
// renders at a sensible scale.
func TestEmitSVGFallbackViewBoxFromGeometry(t *testing.T) {
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
	if err := EmitSVG(&buf, doc); err != nil {
		t.Fatalf("EmitSVG: %v", err)
	}
	out := buf.String()
	if !strings.Contains(out, `viewBox="10 20 100 50"`) {
		t.Errorf("expected bbox-derived viewBox 10 20 100 50; got:\n%s", first(out, 400))
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
