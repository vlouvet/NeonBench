package designdoc

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestElectrodeHousingRoundTrip verifies the new Electrode housing
// fields (Tier 3 #62) survive a JSON round-trip and that the
// `omitempty` tags keep old design-doc blobs deserializing cleanly
// (no spurious "" / 0 keys re-emerge after a re-marshal).
//
// Lives in the designdoc package because the parallel Tier 3 #51
// agent owns internal/server/integration_test.go this round; routing
// the round-trip into the package that owns the schema actually
// lines up better with the rest of the test layout (each
// designdoc-typed package tests its own marshaling).
func TestElectrodeHousingRoundTrip(t *testing.T) {
	original := Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []Run{{
			ID: "r1",
			Polyline: Polyline{
				Points: [][2]float64{{0, 0}, {100, 0}},
			},
			Electrodes: []Electrode{
				// Bare electrode — no housing set, all three fields
				// should serialize as omitempty.
				{PointIndex: 0},
				// Stock 15-shell with elevation. BoreDiameterMM
				// stays 0 (frontend convention: library is
				// authoritative for stock shells, doc bore unused).
				{PointIndex: 1, HousingType: "shell-15", ElevationMM: 50},
				// Custom housing with all three fields populated.
				{PointIndex: 1, HousingType: "custom", BoreDiameterMM: 11.0, ElevationMM: 75},
			},
		}},
	}

	// Marshal then unmarshal.
	raw, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got Doc
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if len(got.Runs) != 1 || len(got.Runs[0].Electrodes) != 3 {
		t.Fatalf("unexpected shape after round-trip: %+v", got)
	}

	bare := got.Runs[0].Electrodes[0]
	if bare.HousingType != "" || bare.BoreDiameterMM != 0 || bare.ElevationMM != 0 {
		t.Errorf("bare electrode picked up housing fields: %+v", bare)
	}

	stock := got.Runs[0].Electrodes[1]
	if stock.HousingType != "shell-15" {
		t.Errorf("stock housing_type: got %q, want shell-15", stock.HousingType)
	}
	if stock.BoreDiameterMM != 0 {
		t.Errorf("stock bore should be zero on the doc (library is authoritative): got %v", stock.BoreDiameterMM)
	}
	if stock.ElevationMM != 50 {
		t.Errorf("stock elevation: got %v, want 50", stock.ElevationMM)
	}

	custom := got.Runs[0].Electrodes[2]
	if custom.HousingType != "custom" || custom.BoreDiameterMM != 11.0 || custom.ElevationMM != 75 {
		t.Errorf("custom housing did not survive round-trip: %+v", custom)
	}

	// Verify omitempty: a bare electrode in the JSON should NOT
	// contain housing keys. Use string search rather than re-parsing
	// — a positive match means the keys leaked into the JSON.
	bareJSON, err := json.Marshal(Electrode{PointIndex: 7})
	if err != nil {
		t.Fatalf("marshal bare electrode: %v", err)
	}
	if strings.Contains(string(bareJSON), "housing_type") {
		t.Errorf("bare electrode JSON leaked housing_type: %s", bareJSON)
	}
	if strings.Contains(string(bareJSON), "bore_diameter_mm") {
		t.Errorf("bare electrode JSON leaked bore_diameter_mm: %s", bareJSON)
	}
	if strings.Contains(string(bareJSON), "elevation_mm") {
		t.Errorf("bare electrode JSON leaked elevation_mm: %s", bareJSON)
	}
}

// TestElectrodeBackwardsCompat verifies that an old design-doc blob
// (one without housing fields) deserializes into an Electrode whose
// housing fields are zero-valued — confirming we can ship the new
// fields with no data migration. The "old" JSON is hand-written so
// the test would catch a regression that depended on encoding
// behavior (e.g. a future "required field" tag on HousingType).
func TestElectrodeBackwardsCompat(t *testing.T) {
	old := []byte(`{
        "version": 1,
        "view_box_mm": [0, 0, 100, 50],
        "runs": [{
          "id": "r1",
          "polyline": {"points": [[0,0],[10,0]], "closed": false},
          "electrodes": [{"point_index": 0}, {"point_index": 1}]
        }]
      }`)
	var doc Doc
	if err := json.Unmarshal(old, &doc); err != nil {
		t.Fatalf("unmarshal pre-housings doc: %v", err)
	}
	if len(doc.Runs) != 1 || len(doc.Runs[0].Electrodes) != 2 {
		t.Fatalf("unexpected shape: %+v", doc)
	}
	for i, e := range doc.Runs[0].Electrodes {
		if e.HousingType != "" {
			t.Errorf("electrode %d picked up a housing_type from old JSON: %q", i, e.HousingType)
		}
		if e.BoreDiameterMM != 0 {
			t.Errorf("electrode %d picked up a bore_diameter_mm from old JSON: %v", i, e.BoreDiameterMM)
		}
		if e.ElevationMM != 0 {
			t.Errorf("electrode %d picked up an elevation_mm from old JSON: %v", i, e.ElevationMM)
		}
	}
}

// TestRunKindRoundTrip verifies the new Run.Kind field (Tier 3 #60 /
// NW #125) survives a JSON round-trip and that omitempty keeps old
// design-doc blobs deserializing cleanly to "" (primary tube). The
// new field rides on the existing design_doc JSON blob — there is no
// schema migration, so the round-trip in this test IS the contract
// the persistence layer provides.
func TestRunKindRoundTrip(t *testing.T) {
	original := Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []Run{
			{
				ID:       "r1",
				Polyline: Polyline{Points: [][2]float64{{0, 0}, {100, 0}}},
				// Kind left empty: primary tube. omitempty should keep
				// the key out of the encoded form.
			},
			{
				ID:       "j1",
				Kind:     "jumper",
				Polyline: Polyline{Points: [][2]float64{{100, 0}, {120, 5}}},
			},
		},
	}

	raw, err := json.Marshal(&original)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// Primary run should not leak `"kind"` into the JSON; jumper run
	// should serialize the field. We slice the encoded blob into the
	// per-run sub-strings to keep this assertion robust against
	// reordering of unrelated fields.
	if strings.Count(string(raw), `"kind":"jumper"`) != 1 {
		t.Errorf("expected exactly one kind=jumper key in marshaled doc, got: %s", raw)
	}
	if strings.Contains(string(raw), `"kind":""`) {
		t.Errorf("primary run leaked a kind:\"\" key into the marshaled doc: %s", raw)
	}

	var got Doc
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Runs) != 2 {
		t.Fatalf("unexpected run count: %d", len(got.Runs))
	}
	if got.Runs[0].Kind != "" {
		t.Errorf("primary run picked up a kind: %q", got.Runs[0].Kind)
	}
	if got.Runs[1].Kind != "jumper" {
		t.Errorf("jumper run lost its kind: %q", got.Runs[1].Kind)
	}
}

// TestRunKindBackwardsCompat verifies an old design-doc blob (one
// without the kind field) deserializes into a Run whose Kind is "".
// Confirms the new field requires no data migration — the persistence
// layer keeps storing JSON blobs and the deserializer fills in zero
// for any field the blob omitted.
func TestRunKindBackwardsCompat(t *testing.T) {
	old := []byte(`{
        "version": 1,
        "view_box_mm": [0, 0, 100, 50],
        "runs": [{
          "id": "r1",
          "polyline": {"points": [[0,0],[10,0]], "closed": false}
        }]
      }`)
	var doc Doc
	if err := json.Unmarshal(old, &doc); err != nil {
		t.Fatalf("unmarshal pre-kind doc: %v", err)
	}
	if len(doc.Runs) != 1 {
		t.Fatalf("unexpected shape: %+v", doc)
	}
	if doc.Runs[0].Kind != "" {
		t.Errorf("run picked up a Kind from old JSON: %q", doc.Runs[0].Kind)
	}
}
