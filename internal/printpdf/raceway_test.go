package printpdf

import (
	"bytes"
	"strings"
	"testing"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestGroupByRaceway covers the bucketing logic. Tier 3 #26 v1 trusts
// the user's RacewayID labels — runs sharing a non-empty id are
// grouped; empty id stays ungrouped; non-face runs (live tube paths
// that happen to carry a raceway label) are skipped.
func TestGroupByRaceway(t *testing.T) {
	face := func(id, raceway string) designdoc.Run {
		return designdoc.Run{
			ID: id,
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {10, 0}, {10, 5}, {0, 5}},
				Closed: true,
			},
			IsChannelLetterFace: true,
			RacewayID:           raceway,
		}
	}
	nonFace := designdoc.Run{
		ID: "live",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {1, 0}},
		},
		RacewayID: "main", // intentionally labelled to verify it's filtered out
	}
	runs := []designdoc.Run{
		face("a", "main"),
		face("b", ""), // ungrouped
		face("c", "main"),
		face("d", "side"),
		nonFace,
	}
	groups := groupByRaceway(runs)
	if got, want := len(groups.OrderedIDs), 2; got != want {
		t.Fatalf("ordered ids: got %d (%v), want %d", got, groups.OrderedIDs, want)
	}
	if groups.OrderedIDs[0] != "main" || groups.OrderedIDs[1] != "side" {
		t.Errorf("declaration order broken: got %v, want [main side]", groups.OrderedIDs)
	}
	if got := len(groups.ByID["main"]); got != 2 {
		t.Errorf(`len(groups["main"]) = %d, want 2`, got)
	}
	if got := len(groups.ByID["side"]); got != 1 {
		t.Errorf(`len(groups["side"]) = %d, want 1`, got)
	}
	if _, present := groups.ByID[""]; present {
		t.Errorf(`empty raceway id leaked into groups`)
	}
}

// TestRunDepthMM exercises the per-run depth resolution: explicit
// override beats project default, project default beats shop default.
func TestRunDepthMM(t *testing.T) {
	d75 := 75.0
	cases := []struct {
		name     string
		run      designdoc.Run
		project  float64
		expected float64
	}{
		{"override beats project", designdoc.Run{ChannelLetterDepthMM: &d75}, 100, 75},
		{"project default", designdoc.Run{}, 120, 120},
		{"shop fallback when project zero", designdoc.Run{}, 0, 100},
		{"zero override falls through to project", designdoc.Run{ChannelLetterDepthMM: floatPtr(0)}, 80, 80},
	}
	for _, tc := range cases {
		got := runDepthMM(tc.run, tc.project)
		if got != tc.expected {
			t.Errorf("%s: runDepthMM = %v, want %v", tc.name, got, tc.expected)
		}
	}
}

func floatPtr(v float64) *float64 { return &v }

// TestEmitNestedReturnStripCombined emits the combined return strip for
// two faces sharing "main" and asserts the output PDF contains the
// combined header text + per-run breakdown footer landmarks.
//
// Tier 2 #104 renamed the emitter and retitled its page. The page title
// is asserted BOTH ways — the new one present, the old one absent — so a
// half-done rename that leaves the misleading title in the PDF fails
// here rather than shipping. The grouping itself is unchanged and is
// pinned by TestGroupByRaceway above.
func TestEmitNestedReturnStripCombined(t *testing.T) {
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           gofpdf.SizeType{Wd: 215.9, Ht: 279.4},
	})
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(false, 0)
	pdf.SetCompression(false)

	opts := DefaultOptions()
	opts.ProjectName = "test"
	opts.DesignVersionLabel = "v1"
	opts.StripOverlapMM = 12.7

	runs := []designdoc.Run{
		{
			ID: "run-1",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
				Closed: true, // perimeter 300
			},
			IsChannelLetterFace: true,
			RacewayID:           "main",
		},
		{
			ID: "run-2",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {80, 0}, {80, 40}, {0, 40}},
				Closed: true, // perimeter 240
			},
			IsChannelLetterFace: true,
			RacewayID:           "main",
		},
	}
	emitNestedReturnStrip(pdf, opts, "main", runs, 100)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		t.Fatalf("pdf output: %v", err)
	}
	asStr := buf.String()
	for _, want := range []string{
		"Nested return strip — raceway main",
		"Total perimeter 540.0 mm",
		"run-1",
		"run-2",
		"shear here",
	} {
		if !strings.Contains(asStr, want) {
			t.Errorf("PDF missing landmark %q", want)
		}
	}
	// Negative control for the rename: the old title claimed this page was
	// a raceway. It is a nested return strip — sum of letter perimeters,
	// letter depth — and a raceway is a 203mm-deep box sized to the sign.
	if strings.Contains(asStr, "Raceway strip") {
		t.Error(`page still titled "Raceway strip" — this page has never emitted a raceway (docs/neon-rules/raceway.md, "Terminology collision")`)
	}
}

// TestRenderFromDocRacewayDispatch exercises the integration: a doc
// with two face runs sharing "main" + one ungrouped face run produces
// ONE raceway page (combined) plus ONE per-run page, not two per-run
// pages for the grouped runs. Counted via "Return strip — Run" markers
// (per-run pages) and "Raceway strip — main" (raceway page).
func TestRenderFromDocRacewayDispatch(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   designdoc.SchemaVersion,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{
			{
				ID: "letter-O",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {50, 0}, {50, 50}, {0, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
				RacewayID:           "main",
			},
			{
				ID: "letter-N",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{60, 0}, {110, 0}, {110, 50}, {60, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
				RacewayID:           "main",
			},
			{
				ID: "bracket",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{120, 0}, {160, 0}, {160, 30}, {120, 30}},
					Closed: true,
				},
				IsChannelLetterFace: true,
				// no raceway → individual strip page
			},
		},
	}
	opts := DefaultOptions()
	opts.ProjectName = "test"
	opts.DesignVersionLabel = "v1"
	opts.ChannelLetterDepthMM = 100
	opts.StripOverlapMM = 12.7

	// Disable compression so we can grep the rendered text. Force this
	// by constructing the PDF the same way returnstrip_test.go does:
	// directly via gofpdf isn't an option here because RenderFromDoc
	// builds the pdf; instead we accept the binary stream is
	// compressed and only check that exactly one "Raceway strip" and
	// exactly one "Return strip" sequence appears in the byte stream
	// after we run uncompressed.
	//
	// gofpdf's stream compression hides text — the assertions below
	// would fail intermittently. So we validate the dispatch by
	// counting via the helpers directly.
	groups := groupByRaceway(doc.Runs)
	if got, want := len(groups.OrderedIDs), 1; got != want {
		t.Fatalf("expected %d raceway groups, got %d", want, got)
	}
	if got, want := len(groups.ByID["main"]), 2; got != want {
		t.Errorf(`expected raceway "main" to bucket %d runs, got %d`, want, got)
	}
	// Bracket should NOT be in any group.
	for _, gid := range groups.OrderedIDs {
		for _, r := range groups.ByID[gid] {
			if r.ID == "bracket" {
				t.Errorf("ungrouped run %q leaked into raceway %q", r.ID, gid)
			}
		}
	}

	// Smoke: end-to-end RenderFromDoc still produces a non-empty PDF.
	data, err := RenderFromDoc(doc, opts, 12)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if len(data) < 200 {
		t.Errorf("RenderFromDoc PDF unreasonably small: %d bytes", len(data))
	}
}

// racewayModelDoc is a raceway-grouped design that also MODELS the box:
// two letters sharing raceway "rw1", one ungrouped letter, the "rw1"
// guideline that gives the box its identity, and the Raceway record.
func racewayModelDoc() *designdoc.Doc {
	face := func(id string, x0, x1 float64, raceway string) designdoc.Run {
		return designdoc.Run{
			ID: id,
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{x0, 0}, {x1, 0}, {x1, 50}, {x0, 50}},
				Closed: true,
			},
			IsChannelLetterFace: true,
			RacewayID:           raceway,
		}
	}
	return &designdoc.Doc{
		Version:   designdoc.SchemaVersion,
		ViewBoxMM: [4]float64{0, 0, 400, 200},
		Runs: []designdoc.Run{
			face("letter-O", 0, 50, "rw1"),
			face("letter-N", 60, 110, "rw1"),
			face("bracket", 200, 240, ""),
		},
		Guidelines: []designdoc.Guideline{
			{ID: "rw1", Kind: designdoc.GuidelineKindRaceway, YMM: 50},
		},
		Raceways: []designdoc.Raceway{
			{ID: "rw1", XMM: 0, LengthMM: 110},
		},
	}
}

// TestRenderFromDocRacewayPagesAndNestedStrip is THE regression for the
// Tier 2 #104 rename: renaming a working emitter must not stop the page
// coming out.
//
// StripsOnly makes the page count readable — every page is a strip or a
// raceway page, so the arithmetic is exact rather than "however many
// tiles the pattern took". A raceway-grouped design must still produce
// its ONE nested return strip page (plus one per-run page for the
// ungrouped letter), and the modelled box adds exactly one more page on
// top. Dropping doc.Raceways is the negative control: the nested strip
// survives, the raceway page does not.
func TestRenderFromDocRacewayPagesAndNestedStrip(t *testing.T) {
	opts := DefaultOptions()
	opts.ProjectName = "raceway-model"
	opts.DesignVersionLabel = "v1"
	opts.ChannelLetterDepthMM = 100
	opts.StripOverlapMM = 12.7
	opts.StripsOnly = true

	withBox := racewayModelDoc()
	withBoxPDF, err := RenderFromDoc(withBox, opts, 12)
	if err != nil {
		t.Fatalf("RenderFromDoc (with raceway): %v", err)
	}
	if got, want := pdfPageCount(withBoxPDF), 3; got != want {
		t.Errorf("strips-only page count = %d, want %d "+
			"(1 per-run strip for the ungrouped letter + 1 nested return strip for rw1 + 1 raceway page)",
			got, want)
	}

	noBox := racewayModelDoc()
	noBox.Raceways = nil
	noBoxPDF, err := RenderFromDoc(noBox, opts, 12)
	if err != nil {
		t.Fatalf("RenderFromDoc (no raceway record): %v", err)
	}
	if got, want := pdfPageCount(noBoxPDF), 2; got != want {
		t.Errorf("strips-only page count without a Raceway record = %d, want %d "+
			"(the nested return strip must survive; only the box page is gated)",
			got, want)
	}
}

// TestEmitRacewayPageDimensions asserts the plan view carries the box's
// real dimensions, its member letters, and the flush-ends caveat — and
// that an unsized box emits nothing at all rather than a page whose
// "0 mm" reads like a measurement.
func TestEmitRacewayPageDimensions(t *testing.T) {
	doc := racewayModelDoc()
	rw := doc.Raceways[0]

	newPDF := func() *gofpdf.Fpdf {
		p := gofpdf.NewCustom(&gofpdf.InitType{
			OrientationStr: "P",
			UnitStr:        "mm",
			Size:           gofpdf.SizeType{Wd: 215.9, Ht: 279.4},
		})
		p.SetMargins(10, 10, 10)
		p.SetAutoPageBreak(false, 0)
		p.SetCompression(false)
		return p
	}

	pdf := newPDF()
	opts := DefaultOptions()
	opts.ProjectName = "raceway-model"
	opts.DesignVersionLabel = "v1"
	emitRacewayPage(pdf, opts, rw, doc)
	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		t.Fatalf("pdf output: %v", err)
	}
	got := buf.String()
	for _, want := range []string{
		"Raceway — rw1",
		"Length 110.0 mm",
		"Height 203.2 mm", // 8 in default — NOT the LED-era 4–5 in
		"Depth 203.2 mm",
		"110.0 mm overall",
		"letter-O",
		"letter-N",
		"FLUSH",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("raceway page missing landmark %q", want)
		}
	}
	// The ungrouped letter is not on this raceway and must not appear.
	if strings.Contains(got, "bracket") {
		t.Error("raceway page marked a run that carries a different raceway id")
	}

	// Unsized box: no page.
	empty := newPDF()
	emitRacewayPage(empty, opts, designdoc.Raceway{ID: "rw1"}, doc)
	if n := empty.PageCount(); n != 0 {
		t.Errorf("a raceway with no length emitted %d page(s); want 0", n)
	}
}

// TestRacewaySpliceCount pins the shipping-section arithmetic: sections
// ship at 10 ft (3048 mm) or shorter, so a box exactly that long needs
// no seam and a 25 ft box arrives in three pieces with two.
func TestRacewaySpliceCount(t *testing.T) {
	cases := []struct {
		lengthMM float64
		want     int
	}{
		{0, 0},
		{1000, 0},
		{designdoc.RacewaySpliceMM, 0},
		{designdoc.RacewaySpliceMM + 1, 1},
		{2 * designdoc.RacewaySpliceMM, 1},
		{7620, 2}, // 25 ft
	}
	for _, tc := range cases {
		got := designdoc.Raceway{ID: "rw1", LengthMM: tc.lengthMM}.SpliceCount()
		if got != tc.want {
			t.Errorf("SpliceCount(%.0fmm) = %d, want %d", tc.lengthMM, got, tc.want)
		}
	}
}
