package designdoc

import (
	"encoding/json"
	"math"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

// racewayDoc is a two-letter sign on one modelled raceway. The second
// letter's top edge is an ARC, which bows outside its own vertices — that is
// what makes the extent tests mean something.
func racewayDoc() Doc {
	return Doc{
		Version:   SchemaVersion,
		ViewBoxMM: [4]float64{0, 0, 400, 200},
		Runs: []Run{
			{
				ID: "letter-O",
				Polyline: Polyline{
					Points: [][2]float64{{0, 0}, {50, 0}, {50, 50}, {0, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
				RacewayID:           "rw1",
			},
			{
				ID: "letter-N",
				Polyline: Polyline{
					Points: [][2]float64{{60, 0}, {110, 0}, {110, 50}, {60, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
				RacewayID:           "rw1",
			},
		},
		Guidelines: []Guideline{
			{ID: "rw1", Kind: GuidelineKindRaceway, YMM: 50},
		},
		Raceways: []Raceway{
			{ID: "rw1", XMM: 0, LengthMM: 110},
		},
	}
}

// TestRacewayRoundTrip covers the schema: a doc with raceways survives a
// marshal/unmarshal round trip with every field intact, and the two
// "0 = shop default" fields stay absent from the JSON when unset.
func TestRacewayRoundTrip(t *testing.T) {
	in := racewayDoc()
	in.Raceways[0].HeightMM = 150
	raw, err := json.Marshal(&in)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"raceways":[{"id":"rw1","x_mm":0,"length_mm":110,"height_mm":150}]`) {
		t.Errorf("raceway JSON shape unexpected: %s", raw)
	}
	if strings.Contains(string(raw), `"depth_mm"`) {
		t.Errorf("unset depth_mm should be omitted, got %s", raw)
	}

	var out Doc
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(out.Raceways) != 1 {
		t.Fatalf("raceways = %d, want 1", len(out.Raceways))
	}
	got := out.Raceways[0]
	if got.ID != "rw1" || got.XMM != 0 || got.LengthMM != 110 || got.HeightMM != 150 {
		t.Errorf("raceway round-trip lost data: %+v", got)
	}
	if got.EffectiveHeightMM() != 150 {
		t.Errorf("explicit height override ignored: %v", got.EffectiveHeightMM())
	}
	if got.EffectiveDepthMM() != RacewayDefaultDepthMM {
		t.Errorf("unset depth = %v, want the %v shop default", got.EffectiveDepthMM(), RacewayDefaultDepthMM)
	}
}

// TestRacewayAbsentBytesIdentical is the back-compat invariant. Every doc
// saved before Tier 2 #104 must come back out byte-for-byte as it went in;
// omitempty on Doc.Raceways is the whole reason that holds, and the server's
// decoder runs with DisallowUnknownFields, so a drift here is a 400 on every
// save rather than a cosmetic diff.
func TestRacewayAbsentBytesIdentical(t *testing.T) {
	const legacy = `{"version":1,"view_box_mm":[0,0,200,100],` +
		`"runs":[{"id":"r1","polyline":{"points":[[0,0],[100,0]],"closed":false},"raceway_id":"rw1"}],` +
		`"guidelines":[{"id":"rw1","kind":"raceway","y_mm":42.5}]}`

	var doc Doc
	if err := json.Unmarshal([]byte(legacy), &doc); err != nil {
		t.Fatalf("unmarshal legacy doc: %v", err)
	}
	if doc.Raceways != nil {
		t.Errorf("legacy doc grew raceways from nowhere: %+v", doc.Raceways)
	}
	raw, err := json.Marshal(&doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if string(raw) != legacy {
		t.Errorf("legacy doc JSON changed shape:\n got %s\nwant %s", raw, legacy)
	}
}

// TestRacewayRequiresItsGuideline pins the identity decision. A Raceway is
// the hardware hanging off a "raceway" guideline; it has no id space of its
// own, so a box whose id names no such guideline is meaningless and is
// rejected at the door rather than reaching the PDF.
func TestRacewayRequiresItsGuideline(t *testing.T) {
	cases := []struct {
		name string
		blob string
		want string
	}{
		{
			name: "no guideline at all",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],` +
				`"raceways":[{"id":"rw9","x_mm":0,"length_mm":100}]}`,
			want: "no guideline with that id",
		},
		{
			name: "id belongs to a construction guide",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],` +
				`"guidelines":[{"id":"rw1","kind":"construction","y_mm":5}],` +
				`"raceways":[{"id":"rw1","x_mm":0,"length_mm":100}]}`,
			want: "no guideline with that id",
		},
		{
			name: "two boxes on one guideline",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],` +
				`"guidelines":[{"id":"rw1","kind":"raceway","y_mm":5}],` +
				`"raceways":[{"id":"rw1","x_mm":0,"length_mm":100},{"id":"rw1","x_mm":0,"length_mm":50}]}`,
			want: "duplicated",
		},
		{
			name: "unknown field on the raceway",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],` +
				`"guidelines":[{"id":"rw1","kind":"raceway","y_mm":5}],` +
				`"raceways":[{"id":"rw1","x_mm":0,"length_mm":100,"colour":"red"}]}`,
			want: "unknown field",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var doc Doc
			err := json.Unmarshal([]byte(tc.blob), &doc)
			if err == nil {
				t.Fatalf("expected an error, got %+v", doc)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}

	// Positive control: the same shape WITH its raceway guideline is
	// accepted, so the rejections above are the rule firing rather than the
	// decoder refusing raceways outright.
	const ok = `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],` +
		`"guidelines":[{"id":"rw1","kind":"raceway","y_mm":5}],` +
		`"raceways":[{"id":"rw1","x_mm":0,"length_mm":100}]}`
	var doc Doc
	if err := json.Unmarshal([]byte(ok), &doc); err != nil {
		t.Fatalf("valid raceway rejected: %v", err)
	}
}

// TestDocUnmarshalStillRejectsUnknownFields guards the trap in adding a
// custom Doc.UnmarshalJSON at all: the server's decoder sets
// DisallowUnknownFields on the request, and a custom unmarshaller that did
// not re-set it on its own nested decoder would silently re-open the WHOLE
// document to typo'd keys (recurring bug class 2).
func TestDocUnmarshalStillRejectsUnknownFields(t *testing.T) {
	const blob = `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],"raceway":[]}`
	var doc Doc
	err := json.Unmarshal([]byte(blob), &doc)
	if err == nil {
		t.Fatal("a typo'd top-level key was accepted")
	}
	if !strings.Contains(err.Error(), "unknown field") {
		t.Errorf("error %q does not mention an unknown field", err)
	}
}

// TestRacewayExtentIsArcAware is the arc invariant. An arc bows outside the
// hull of its own two vertices, so an extent measured from raw points is too
// small — and a box fitted to it would stop short of the glass.
func TestRacewayExtentIsArcAware(t *testing.T) {
	doc := racewayDoc()
	// A vertical chord: the arc bows sideways in X, past both vertices.
	// "arc_r" bows to the RIGHT of travel — travel here is +Y, so the bow
	// falls on +X and pushes the extent past the vertices' own 110.
	doc.Runs = append(doc.Runs, Run{
		ID: "bowed",
		Polyline: Polyline{
			Points:       [][2]float64{{110, 0}, {110, 100}},
			SegmentTypes: []string{SegmentArcR},
		},
		RacewayID: "rw1",
	})

	_, maxXFlat, ok := RacewayMemberExtentMM(&doc, "rw1")
	if !ok {
		t.Fatal("no extent for rw1")
	}
	// Raw-vertex maximum is 110; the bow has to push past it.
	if maxXFlat <= 110+0.5 {
		t.Errorf("extent %.3f ignores the arc bow — a raw-vertex box would stop at 110", maxXFlat)
	}
	// The sagitta of the standard bulge is ArcBulge * half-chord = 25 mm on a
	// 100 mm chord, so the true maximum is ~135.
	if math.Abs(maxXFlat-135) > 1 {
		t.Errorf("extent %.3f is not the arc's true reach (~135)", maxXFlat)
	}
}

// TestFitRacewayToRunsIsFlush pins the flagged assumption: V1 stops the box
// flush with the outermost glass, because no source says it overhangs. If
// RacewayEndMarginMM is ever answered by a shop, this test is where the new
// expectation gets written down.
func TestFitRacewayToRunsIsFlush(t *testing.T) {
	if RacewayEndMarginMM != 0 {
		t.Fatalf("RacewayEndMarginMM = %v; this test encodes the flush V1 assumption", RacewayEndMarginMM)
	}
	doc := racewayDoc()
	// Move the box somewhere wrong, then fit it back.
	doc.Raceways[0] = Raceway{ID: "rw1", XMM: -500, LengthMM: 20, HeightMM: 150, DepthMM: 180}
	got, ok := FitRacewayToRuns(&doc, doc.Raceways[0])
	if !ok {
		t.Fatal("fit found no member runs")
	}
	if got.XMM != 0 || got.LengthMM != 110 {
		t.Errorf("fit = x %.3f len %.3f, want flush x 0 len 110", got.XMM, got.LengthMM)
	}
	// Auto-fit answers "where and how long", never "made of what".
	if got.HeightMM != 150 || got.DepthMM != 180 {
		t.Errorf("fit clobbered the operator's stock dimensions: %+v", got)
	}

	// Runs on a different raceway must not drag the box wider.
	doc.Runs = append(doc.Runs, Run{
		ID:        "other",
		Polyline:  Polyline{Points: [][2]float64{{900, 0}, {950, 0}}},
		RacewayID: "rw2",
	})
	again, _ := FitRacewayToRuns(&doc, doc.Raceways[0])
	if again.LengthMM != 110 {
		t.Errorf("a run on another raceway widened the fit to %.3f", again.LengthMM)
	}
}

// TestRacewayTransformerCount mirrors takeoff's electrode-pair arithmetic:
// ceil(electrodes / 2), jumpers excluded, per raceway.
func TestRacewayTransformerCount(t *testing.T) {
	doc := racewayDoc()
	doc.Runs[0].Electrodes = []Electrode{{PointIndex: 0}, {PointIndex: 1}}
	doc.Runs[1].Electrodes = []Electrode{{PointIndex: 0}, {PointIndex: 1}, {PointIndex: 2}}
	doc.Runs = append(doc.Runs, Run{
		ID:         "splice",
		Kind:       "jumper",
		Polyline:   Polyline{Points: [][2]float64{{50, 25}, {60, 25}}},
		Electrodes: []Electrode{{PointIndex: 0}, {PointIndex: 1}},
		RacewayID:  "rw1",
	})
	if got, want := RacewayTransformerCount(&doc, "rw1"), 3; got != want {
		t.Errorf("transformer count = %d, want %d (5 electrodes → 3 pairs; the jumper's 2 do not count)", got, want)
	}
	if got := RacewayTransformerCount(&doc, "rw2"); got != 0 {
		t.Errorf("unknown raceway id counted %d transformers", got)
	}
}

// TestTransformerLengthTwinsAgree pins the Go-side twin: the validator has
// its own copy of the transformer length because it cannot import this
// package, and a silent drift would move the rule's threshold away from the
// dimension the rest of the model uses (recurring bug class 4).
func TestTransformerLengthTwinsAgree(t *testing.T) {
	if TransformerLengthMM != validate.RacewayTransformerLengthMM {
		t.Errorf("designdoc.TransformerLengthMM = %v but validate.RacewayTransformerLengthMM = %v",
			TransformerLengthMM, validate.RacewayTransformerLengthMM)
	}
}

// TestRacewayInputsFeedTheValidator checks the bridge: every modelled box
// reaches the validator with its member extent, its guideline's Y, and the
// transformer count, and a doc with no raceways produces nothing at all.
func TestRacewayInputsFeedTheValidator(t *testing.T) {
	doc := racewayDoc()
	doc.Runs[0].Electrodes = []Electrode{{PointIndex: 0}, {PointIndex: 1}}
	in := RacewayInputs(&doc)
	if len(in) != 1 {
		t.Fatalf("inputs = %d, want 1", len(in))
	}
	got := in[0]
	if got.ID != "rw1" || !got.HasMembers || got.MemberMinXMM != 0 || got.MemberMaxXMM != 110 {
		t.Errorf("member extent wrong: %+v", got)
	}
	if got.YMM != 50 {
		t.Errorf("guideline Y = %v, want 50 — the box's top edge comes from its guideline", got.YMM)
	}
	if got.TransformerCount != 1 || got.TransformerLengthMM != TransformerLengthMM {
		t.Errorf("transformer facts wrong: %+v", got)
	}

	doc.Raceways = nil
	if in := RacewayInputs(&doc); in != nil {
		t.Errorf("a doc with no raceways produced %d inputs", len(in))
	}
}
