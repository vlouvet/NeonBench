package printpdf

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// goldenDoc is the representative document behind TestRenderFromDocGoldenBytes.
// It is deliberately broad: it exercises every branch of the main pattern's
// run-drawing loop (straight segments, forward and reversed arcs, a closed run
// whose CLOSING segment is an arc, blockout sleeves, a jumper's dashed stroke
// and midpoint label), plus the surrounding page furniture (electrodes, bend
// apex markers, doc labels, dimensions, return-strip pages, a nested raceway
// strip, a raceway box plan and the bend-list summary) across a multi-tile,
// multi-copy page set.
func goldenDoc() *designdoc.Doc {
	depth := 120.0
	return &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 400, 300},
		Runs: []designdoc.Run{
			{
				// Open run: mixed line / arc / reversed-arc segments,
				// a blockout in the middle, two electrodes with
				// housings, notes, and enough turning to produce bends.
				ID: "run-1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{
						{10, 10}, {90, 10}, {150, 60}, {150, 140}, {60, 190}, {10, 120},
					},
					SegmentTypes: []string{"line", "arc", "line", "arc_r", "line"},
				},
				Electrodes: []designdoc.Electrode{
					{PointIndex: 0, HousingType: "standard"},
					{PointIndex: 5, BoreDiameterMM: 22, ElevationMM: 8},
				},
				Blockouts:      []designdoc.Blockout{{StartLiveIndex: 2, EndLiveIndex: 3}},
				TubeDiameterMM: 12,
				Color:          "6500K white",
				Notes:          "15mA transformer\nneon, clear",
			},
			{
				// Closed run with two electrodes, so it draws as the
				// live arc BETWEEN them rather than as a full loop —
				// the wrap-around walk, where SegmentIndexBetween has
				// to resolve a step that runs backwards. Also a
				// channel-letter face bound to a raceway, so it reaches
				// the nested-strip emitter.
				ID: "run-2",
				Polyline: designdoc.Polyline{
					Points:       [][2]float64{{220, 20}, {360, 20}, {360, 140}, {220, 140}},
					Closed:       true,
					SegmentTypes: []string{"line", "arc", "line", "arc"},
				},
				Electrodes:           []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
				TubeDiameterMM:       12,
				IsChannelLetterFace:  true,
				ChannelLetterDepthMM: &depth,
				RacewayID:            "rw-1",
				Annotations: []designdoc.Annotation{
					{Kind: "jump", LiveIndex: 1},
					{Kind: "drop_bend", LiveIndex: 2},
				},
			},
			{
				// Closed loop with NO electrodes, so the whole polyline
				// is one live arc and the closing segment is drawn —
				// and that closing segment is an arc, which is the
				// Bug #18 shape. Reverting the fix has to move this
				// digest; if it does not, the golden is not covering
				// the case its comment claims. Also an ungrouped
				// channel-letter face, so it gets a strip page of its
				// own.
				ID: "run-3",
				Polyline: designdoc.Polyline{
					Points:       [][2]float64{{40, 230}, {160, 230}, {160, 285}, {40, 285}},
					Closed:       true,
					SegmentTypes: []string{"line", "arc", "line", "arc"},
				},
				TubeDiameterMM:      12,
				IsChannelLetterFace: true,
			},
			{
				// Jumper: dashed stroke plus the midpoint label, and
				// excluded from the bend list.
				ID:   "jmp-1",
				Kind: "jumper",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{150, 140}, {220, 140}},
				},
			},
		},
		Labels: []designdoc.Label{
			{X: 30, Y: 210, Text: "left panel"},
			{X: 280, Y: 210, Text: "right panel"},
		},
		Dimensions: []designdoc.Dimension{
			{X1: 10, Y1: 295, X2: 390, Y2: 295, Note: "overall"},
		},
		Guidelines: []designdoc.Guideline{
			{ID: "rw-1", Kind: designdoc.GuidelineKindRaceway, YMM: 150},
		},
		Raceways: []designdoc.Raceway{
			{ID: "rw-1", XMM: 200, LengthMM: 180, HeightMM: 90, DepthMM: 130},
		},
	}
}

func goldenOptions() Options {
	opts := DefaultOptions()
	opts.ProjectName = "Golden"
	opts.DesignVersionLabel = "v3"
	opts.ChannelLetterDepthMM = 100
	opts.Copies = 2
	return opts
}

// goldenPDFSHA256 is the digest of the PDF goldenDoc renders to, taken from
// `main` at 17c9dec (the commit this branch was cut from) with compression left
// at its default.
//
// TestRenderFromDocGoldenBytes is the non-negotiable invariant of Tier 3 #122:
// making the drawn geometry assertable must not change a single byte of what
// the bender is handed. The init() in render_test.go pins gofpdf's two sources
// of nondeterminism (creation / modification dates, and catalog map order),
// which is what makes a cross-process digest meaningful at all.
//
// If this fails after a deliberate rendering change, re-take the digest and say
// so in the commit message — do not silence it.
const goldenPDFSHA256 = "43d9a82bf4f95681ae3c35531733a79de3738be233db030f5d30c465569557de"

func TestRenderFromDocGoldenBytes(t *testing.T) {
	out, err := RenderFromDoc(goldenDoc(), goldenOptions(), 12)
	if err != nil {
		t.Fatalf("RenderFromDoc: %v", err)
	}
	sum := sha256.Sum256(out)
	got := hex.EncodeToString(sum[:])
	if got != goldenPDFSHA256 {
		t.Errorf("rendered PDF digest = %s (%d bytes), want %s — the renderer's output changed",
			got, len(out), goldenPDFSHA256)
	}
}
