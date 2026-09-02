package printpdf

import (
	"bytes"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestHousingsForRun verifies the helper that builds the "Housings"
// subsection lines on the bend list page (Tier 3 #62). Every electrode
// with HousingType != "" should produce one line; electrodes without
// a housing should be skipped; stock shells should ignore the
// doc-supplied bore (the library is authoritative; matches the
// frontend's setElectrodeHousing op).
func TestHousingsForRun(t *testing.T) {
	cases := []struct {
		name string
		run  designdoc.Run
		want []string
	}{
		{
			name: "no electrodes -> no lines",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
			},
			want: nil,
		},
		{
			name: "electrodes without housings -> no lines",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0},
					{PointIndex: 1},
				},
			},
			want: nil,
		},
		{
			name: "shell-15 stock housing",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0, HousingType: "shell-15", ElevationMM: 50},
				},
			},
			want: []string{
				"E1 - 15-shell (3/8\" x 1-5/16\") (bore 9.5 mm, elev 50.0 mm)",
			},
		},
		{
			name: "stock shell ignores doc-supplied bore (library is authoritative)",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0, HousingType: "shell-19", BoreDiameterMM: 99},
				},
			},
			want: []string{
				// Bore is 12.7 from the library, NOT 99.
				"E1 - 19-shell (1/2\" x 1-5/8\") (bore 12.7 mm)",
			},
		},
		{
			name: "custom housing reports doc-supplied bore",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0, HousingType: "custom", BoreDiameterMM: 11.0, ElevationMM: 75},
				},
			},
			want: []string{
				"E1 - Custom (bore 11.0 mm, elev 75.0 mm)",
			},
		},
		{
			name: "mixed electrodes — only configured ones appear, indexed by run order",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0, HousingType: "shell-15"},
					{PointIndex: 1}, // skipped
					{PointIndex: 2, HousingType: "custom", BoreDiameterMM: 11},
				},
			},
			want: []string{
				"E1 - 15-shell (3/8\" x 1-5/16\") (bore 9.5 mm)",
				"E3 - Custom (bore 11.0 mm)",
			},
		},
	}

	for _, tc := range cases {
		tc := tc
		t.Run(tc.name, func(t *testing.T) {
			got := housingsForRun(tc.run)
			if len(got) != len(tc.want) {
				t.Fatalf("got %d lines (%v), want %d (%v)", len(got), got, len(tc.want), tc.want)
			}
			for i := range got {
				if got[i] != tc.want[i] {
					t.Errorf("line %d:\n  got  %q\n  want %q", i, got[i], tc.want[i])
				}
			}
		})
	}
}

// TestRenderFromDocWithHousings is a smoke test that the bend list
// page emits without panicking when housings are configured, and that
// the produced PDF byte stream is a syntactically-valid PDF starting
// with "%PDF-". Structural rather than golden-byte: the codebase's
// other render tests (returnstrip_test.go, raceway_test.go) follow
// the same approach — we trust gofpdf's own correctness for layout
// fidelity and exercise our wiring instead.
func TestRenderFromDocWithHousings(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{{
			ID: "r1",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{
					{0, 0}, {50, 0}, {100, 50}, {150, 0}, {200, 0},
				},
			},
			Electrodes: []designdoc.Electrode{
				{PointIndex: 0, HousingType: "shell-15", ElevationMM: 50},
				{PointIndex: 4, HousingType: "custom", BoreDiameterMM: 11.0, ElevationMM: 75},
			},
			TubeDiameterMM: 10,
		}},
	}
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"
	opts.DesignVersionLabel = "v1"

	out, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Errorf("output is not a PDF (first 8 bytes: %q)", string(out[:min(8, len(out))]))
	}
	if len(out) < 1024 {
		t.Errorf("output suspiciously small (%d bytes); expected the bend list page to add several KB", len(out))
	}
}

// TestRenderFromDocSkipsHousingsWhenNoneConfigured verifies the
// bend-list "Housings" subsection only appears when at least one
// electrode has a housing — matches the spec contract that the
// section is skipped entirely otherwise.
func TestRenderFromDocSkipsHousingsWhenNoneConfigured(t *testing.T) {
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{{
			ID: "r1",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {50, 0}, {100, 50}, {150, 0}, {200, 0}},
			},
			Electrodes: []designdoc.Electrode{
				{PointIndex: 0},
				{PointIndex: 4},
			},
			TubeDiameterMM: 10,
		}},
	}
	opts := DefaultOptions()
	opts.ProjectName = "TestProj"

	got := housingsForRun(doc.Runs[0])
	if len(got) != 0 {
		t.Errorf("expected zero housings lines, got %d: %v", len(got), got)
	}

	// Render to make sure no panic when iterating the empty case.
	out, err := RenderFromDoc(doc, opts, 10)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	if !bytes.HasPrefix(out, []byte("%PDF-")) {
		t.Errorf("not a PDF")
	}
	// There used to be a `strings.Contains(string(out), "Housings:")` check
	// here, justified by a comment claiming "this codebase uses the
	// uncompressed default, so a substring check is reliable". It does not:
	// gofpdf Flate-compresses page content streams and RenderFromDoc leaves
	// that at its default, so the literal is absent from the bytes whether the
	// subsection was emitted or not — the assertion passed by construction and
	// would have gone on passing if the gate broke. Removed by Tier 3 #122.
	// The load-bearing assertion is housingsForRun above: it is the gate
	// drawBendListPage tests before drawing the subsection at all.
}
