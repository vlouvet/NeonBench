package designdoc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

// TestCircuitRoundTrip pins the Tier 2 #136 schema addition: Doc.Circuits plus
// the Run.CircuitID FK survive a JSON round-trip, and an unassigned run emits
// no key at all. The fields ride on the existing design_doc blob — there is no
// SQLite migration — so this round-trip IS the persistence contract, and it is
// also the shape the TypeScript side has to emit or every save 400s under
// DisallowUnknownFields.
func TestCircuitRoundTrip(t *testing.T) {
	original := Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []Run{
			{ID: "r1", Polyline: Polyline{Points: [][2]float64{{0, 0}, {100, 0}}}},
			{ID: "r2", CircuitID: "c1", Polyline: Polyline{Points: [][2]float64{{0, 10}, {100, 10}}}},
			{ID: "r3", CircuitID: "c1", Polyline: Polyline{Points: [][2]float64{{0, 20}, {100, 20}}}},
		},
		Circuits: []Circuit{{ID: "c1", Name: "Main"}},
	}

	raw, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), `"circuit_id":""`) {
		t.Errorf("unassigned run leaked a circuit_id:\"\" key: %s", raw)
	}
	if got, want := strings.Count(string(raw), `"circuit_id":"c1"`), 2; got != want {
		t.Errorf("expected %d circuit_id=c1 keys, got %d: %s", want, got, raw)
	}
	if !strings.Contains(string(raw), `"circuits":[{"id":"c1","name":"Main"}]`) {
		t.Errorf("expected Doc.Circuits entry in marshaled JSON: %s", raw)
	}

	var got Doc
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got.Runs[0].CircuitID != "" {
		t.Errorf("unassigned run picked up a circuit_id: %q", got.Runs[0].CircuitID)
	}
	if got.Runs[1].CircuitID != "c1" || got.Runs[2].CircuitID != "c1" {
		t.Errorf("assigned runs lost their circuit_id: %+v / %+v", got.Runs[1], got.Runs[2])
	}
	if len(got.Circuits) != 1 || got.Circuits[0].ID != "c1" || got.Circuits[0].Name != "Main" {
		t.Errorf("Doc.Circuits did not survive round-trip: %+v", got.Circuits)
	}
}

// TestCircuitNameOmittedWhenEmpty — an unnamed circuit is legal (the editor
// labels it by id), and omitempty keeps the blob minimal.
func TestCircuitNameOmittedWhenEmpty(t *testing.T) {
	d := Doc{Version: 1, Circuits: []Circuit{{ID: "c1"}}}
	raw, err := json.Marshal(&d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"circuits":[{"id":"c1"}]`) {
		t.Errorf("unnamed circuit should marshal without a name key: %s", raw)
	}
}

// TestCircuitBackwardsCompat is the back-compat invariant the whole design
// hangs off: a pre-#136 blob deserializes with no circuits and no FKs, and
// re-marshals without emitting either key. Every stored design, every stored
// validation_report and the golden PDF digests depend on this.
func TestCircuitBackwardsCompat(t *testing.T) {
	old := []byte(`{
        "version": 1,
        "view_box_mm": [0, 0, 100, 50],
        "runs": [
          {"id": "r1", "polyline": {"points": [[0,0],[10,0]], "closed": false}},
          {"id": "r2", "polyline": {"points": [[0,5],[10,5]], "closed": false}}
        ]
      }`)
	var doc Doc
	if err := json.Unmarshal(old, &doc); err != nil {
		t.Fatalf("unmarshal pre-circuits doc: %v", err)
	}
	if doc.Circuits != nil {
		t.Errorf("Doc.Circuits picked up entries from old JSON: %+v", doc.Circuits)
	}
	for i, r := range doc.Runs {
		if r.CircuitID != "" {
			t.Errorf("run %d picked up a CircuitID from old JSON: %q", i, r.CircuitID)
		}
	}
	raw, err := json.Marshal(&doc)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), `"circuits":`) {
		t.Errorf("circuitless doc leaked a circuits key after re-marshal: %s", raw)
	}
	if strings.Contains(string(raw), `"circuit_id":`) {
		t.Errorf("circuitless doc leaked a circuit_id key after re-marshal: %s", raw)
	}
}

// TestCircuitDecodeRejections covers the failure mode Tier 3 #140 records: an
// FK relationship that is obvious in the Go source and invisible from the API.
// Each message has to name the offending object AND the rule, because the
// client sees only the 400.
func TestCircuitDecodeRejections(t *testing.T) {
	cases := []struct {
		name string
		blob string
		want string
	}{
		{
			name: "run points at a circuit that does not exist",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],
			        "runs":[{"id":"r1","circuit_id":"c9","polyline":{"points":[[0,0],[1,0]],"closed":false}}]}`,
			want: `run "r1": circuit_id "c9" names no circuit`,
		},
		{
			name: "duplicate circuit id",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],
			        "circuits":[{"id":"c1"},{"id":"c1","name":"again"}]}`,
			want: `circuit "c1": duplicated`,
		},
		{
			name: "empty circuit id",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],"circuits":[{"id":""}]}`,
			want: "empty id",
		},
		{
			name: "unknown field inside a circuit",
			blob: `{"version":1,"view_box_mm":[0,0,10,10],"runs":[],
			        "circuits":[{"id":"c1","transformer":"10kV"}]}`,
			want: "unknown field",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var d Doc
			err := json.Unmarshal([]byte(tc.blob), &d)
			if err == nil {
				t.Fatalf("expected an error, got %+v", d)
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Errorf("error %q does not mention %q", err, tc.want)
			}
		})
	}
}

// TestCircuitAcceptedWhenReferentExists is the negative control for the test
// above: the same shape with the circuit present must decode. Without it the
// rejection test could be passing because the decoder rejects everything.
func TestCircuitAcceptedWhenReferentExists(t *testing.T) {
	blob := `{"version":1,"view_box_mm":[0,0,10,10],
	          "runs":[{"id":"r1","circuit_id":"c1","polyline":{"points":[[0,0],[1,0]],"closed":false}}],
	          "circuits":[{"id":"c1","name":"Main"}]}`
	var d Doc
	if err := json.Unmarshal([]byte(blob), &d); err != nil {
		t.Fatalf("well-formed circuit doc rejected: %v", err)
	}
	if d.Runs[0].CircuitID != "c1" {
		t.Errorf("circuit_id lost: %+v", d.Runs[0])
	}
}

// TestRacewayTransformerCountCollapsesToCircuits is the reduced Chachi case:
// a connected script that fragmented into many runs, each carrying a
// designer's electrode pair, so the raceway saw one transformer per fragment.
// Declaring them one circuit has to collapse that to one — WITHOUT touching a
// single electrode, which is the whole claim of Tier 2 #136.
func TestRacewayTransformerCountCollapsesToCircuits(t *testing.T) {
	doc := &Doc{Version: 1}
	for i := 0; i < 17; i++ {
		doc.Runs = append(doc.Runs, Run{
			ID:        "r" + string(rune('a'+i)),
			RacewayID: "rw1",
			Polyline:  Polyline{Points: [][2]float64{{0, 0}, {100, 0}}},
			Electrodes: []Electrode{
				{PointIndex: 0}, {PointIndex: 1},
			},
		})
	}
	if got := RacewayTransformerCount(doc, "rw1"); got != 17 {
		t.Fatalf("pre-circuit transformer count = %d, want 17 (the artifact this row exists to fix)", got)
	}

	// The only change: one circuit, and every run assigned to it.
	doc.Circuits = []Circuit{{ID: "c1", Name: "Script"}}
	total := 0
	for i := range doc.Runs {
		doc.Runs[i].CircuitID = "c1"
		total += len(doc.Runs[i].Electrodes)
	}
	if total != 34 {
		t.Fatalf("fixture lost electrodes: %d", total)
	}
	if got := RacewayTransformerCount(doc, "rw1"); got != 1 {
		t.Errorf("circuit transformer count = %d, want 1", got)
	}
	// Electrodes are untouched: a circuit caps a DERIVATION, it does not
	// edit the document.
	for _, r := range doc.Runs {
		if len(r.Electrodes) != 2 {
			t.Fatalf("run %s lost electrodes: %+v", r.ID, r.Electrodes)
		}
	}
}

// TestRacewayTransformerCountMixesCircuitedAndFree — a run that is not in any
// circuit keeps its own pair, so partial grouping degrades smoothly instead of
// falling off a cliff.
func TestRacewayTransformerCountMixesCircuitedAndFree(t *testing.T) {
	pair := []Electrode{{PointIndex: 0}, {PointIndex: 1}}
	doc := &Doc{
		Version:  1,
		Circuits: []Circuit{{ID: "c1"}},
		Runs: []Run{
			{ID: "r1", RacewayID: "rw1", CircuitID: "c1", Electrodes: pair},
			{ID: "r2", RacewayID: "rw1", CircuitID: "c1", Electrodes: pair},
			{ID: "r3", RacewayID: "rw1", Electrodes: pair},
			// Jumpers never carried electrodes for this count and still don't.
			{ID: "r4", RacewayID: "rw1", Kind: "jumper", Electrodes: pair},
			// Another box entirely.
			{ID: "r5", RacewayID: "rw2", Electrodes: pair},
		},
	}
	if got := RacewayTransformerCount(doc, "rw1"); got != 2 {
		t.Errorf("count = %d, want 2 (one circuit + one free run)", got)
	}
	if got := RacewayTransformerCount(doc, "rw2"); got != 1 {
		t.Errorf("other raceway count = %d, want 1", got)
	}
}

// TestUndeclaredCircuitIDFallsBackToPerRun — a run naming a circuit that is
// not in Doc.Circuits must behave exactly as it did before circuits existed.
// The decoder rejects that shape so it cannot arrive over the wire, but a doc
// assembled in memory must not lose its electrode pair to a typo'd id, and
// takeoff.Compute makes the same choice.
func TestUndeclaredCircuitIDFallsBackToPerRun(t *testing.T) {
	pair := []Electrode{{PointIndex: 0}, {PointIndex: 1}}
	doc := &Doc{
		Version: 1,
		Runs: []Run{
			{ID: "r1", RacewayID: "rw1", CircuitID: "ghost", Electrodes: pair},
			{ID: "r2", RacewayID: "rw1", CircuitID: "ghost", Electrodes: pair},
		},
	}
	if got := RacewayTransformerCount(doc, "rw1"); got != 2 {
		t.Errorf("count = %d, want 2 — an undeclared circuit id must cap nothing", got)
	}
	// Negative control: declaring it caps to one.
	doc.Circuits = []Circuit{{ID: "ghost"}}
	if got := RacewayTransformerCount(doc, "rw1"); got != 1 {
		t.Errorf("count = %d, want 1 once the circuit is declared", got)
	}
}

// TestCircuitFlipsRacewayTransformerFit is the end-to-end claim of Tier 2
// #136, driven through the exact bridge the server uses: RacewayInputs →
// validate.CheckRaceways. The fixture is the Chachi case reduced — a 2170 mm
// box under a script that traced into 17 fragments, each carrying an electrode
// pair, so the rule was asked to fit 17 transformers into it.
//
// Grouping is the ONLY change between the two halves of this test. No
// electrode moves, the box is not resized, and no run is joined.
func TestCircuitFlipsRacewayTransformerFit(t *testing.T) {
	const (
		boxLenMM   = 2170.0
		fragments  = 17
		fragmentMM = 120.0
	)
	build := func(circuited bool) Doc {
		d := Doc{
			Version:    SchemaVersion,
			ViewBoxMM:  [4]float64{0, 0, boxLenMM, 300},
			Guidelines: []Guideline{{ID: "rw1", Kind: GuidelineKindRaceway, YMM: 250}},
			Raceways:   []Raceway{{ID: "rw1", XMM: 0, LengthMM: boxLenMM}},
		}
		if circuited {
			d.Circuits = []Circuit{{ID: "c1", Name: "Script"}}
		}
		for i := 0; i < fragments; i++ {
			x := float64(i) * (boxLenMM / fragments)
			r := Run{
				ID:         "frag-" + string(rune('a'+i)),
				RacewayID:  "rw1",
				Polyline:   Polyline{Points: [][2]float64{{x, 0}, {x + fragmentMM, 0}}},
				Electrodes: []Electrode{{PointIndex: 0}, {PointIndex: 1}},
			}
			if circuited {
				r.CircuitID = "c1"
			}
			d.Runs = append(d.Runs, r)
		}
		return d
	}

	fitIssues := func(d Doc) []validate.Issue {
		var out []validate.Issue
		for _, iss := range validate.CheckRaceways(RacewayInputs(&d)) {
			if iss.Rule == validate.RuleRacewayTransformerFit {
				out = append(out, iss)
			}
		}
		return out
	}

	before := build(false)
	got := fitIssues(before)
	if len(got) != 1 {
		t.Fatalf("ungrouped fixture should trip raceway_transformer_fit exactly once, got %d", len(got))
	}
	if !strings.Contains(got[0].Message, "17 transformers") {
		t.Errorf("message should name the artifact count: %q", got[0].Message)
	}

	after := build(true)
	if got := fitIssues(after); len(got) != 0 {
		t.Errorf("grouping into one circuit should clear the fit warning, got %q", got[0].Message)
	}
	// The box, the electrodes and the runs are identical between the two.
	if len(before.Runs) != len(after.Runs) || before.Raceways[0].LengthMM != after.Raceways[0].LengthMM {
		t.Fatal("fixtures diverged beyond the circuit grouping")
	}
	for i := range before.Runs {
		if len(before.Runs[i].Electrodes) != len(after.Runs[i].Electrodes) {
			t.Fatalf("run %d electrode count changed", i)
		}
	}
}
