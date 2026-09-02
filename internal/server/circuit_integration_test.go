package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
)

// Tier 2 #136 — circuits over the wire.
//
// Two things can only be proved at this level, and both are on CLAUDE.md's
// recurring-bug list:
//
//  1. `internal/server/json.go` sets DisallowUnknownFields, so a TS field
//     with no Go counterpart makes EVERY save 400. Saving a doc that carries
//     circuits is the only way to know web/src/api.ts and the Go struct
//     actually moved together.
//  2. "It returned 200, so it worked" — the transformer-fit assertions run
//     against a doc known to be DIRTY first, so the clean result afterwards
//     is a result rather than the default a wrong request key produces.
func TestCircuitRoundTripsThroughSaveAndValidate(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	mux := http.NewServeMux()
	registerAPI(mux, db, dir)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := srv.Client()
	base := srv.URL

	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	if len(specs) == 0 {
		t.Fatal("expected seeded tube specs, got none")
	}
	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "circuits, not runs",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	// The Chachi case reduced: one script that traced into eight fragments,
	// each carrying the electrode pair a designer drops on a run, over an
	// 800 mm raceway. Eight transformers want 8 × (159 + 25.4) = 1475 mm and
	// do not fit — which is the state the rule exists to catch, and which is
	// entirely an artifact of how the medial axis broke.
	const boxLen = 800.0
	build := func(circuited bool) designdoc.Doc {
		d := designdoc.Doc{
			Version:   designdoc.SchemaVersion,
			ViewBoxMM: [4]float64{0, 0, boxLen, 200},
			Guidelines: []designdoc.Guideline{
				{ID: "rw1", Kind: designdoc.GuidelineKindRaceway, YMM: 150},
			},
			Raceways: []designdoc.Raceway{{ID: "rw1", XMM: 0, LengthMM: boxLen}},
		}
		if circuited {
			d.Circuits = []designdoc.Circuit{{ID: "c1", Name: "Script"}}
		}
		for i := 0; i < 8; i++ {
			x := float64(i) * 100
			r := designdoc.Run{
				ID:         "frag-" + string(rune('a'+i)),
				RacewayID:  "rw1",
				Polyline:   designdoc.Polyline{Points: [][2]float64{{x, 0}, {x + 100, 0}}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
			}
			if circuited {
				r.CircuitID = "c1"
			}
			d.Runs = append(d.Runs, r)
		}
		return d
	}

	// 1) Ungrouped: the fit rule fires, and its message carries the count it
	// was handed.
	var dirty map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc",
		map[string]any{"design_doc": build(false)}, &dirty)
	fits := issuesWithRule(t, dirty, "raceway_transformer_fit")
	if len(fits) != 1 {
		t.Fatalf("expected raceway_transformer_fit on 8 fragments in an 800mm box, got %d (%v)",
			len(fits), dirty["issues"])
	}
	if msg, _ := fits[0]["message"].(string); !strings.Contains(msg, "8 transformers") {
		t.Errorf("message %q does not name the artifact count", msg)
	}

	// 2) Grouped into one circuit — the ONLY change — and the rule clears.
	circuited := build(true)
	var clean map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc",
		map[string]any{"design_doc": circuited}, &clean)
	if got := issuesWithRule(t, clean, "raceway_transformer_fit"); len(got) != 0 {
		t.Errorf("one circuit in an 800mm box still warns: %v", got)
	}

	// 3) SAVE. A 400 here means the Go struct and web/src/api.ts drifted.
	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions",
		map[string]any{"label": "circuits", "design_doc": circuited}, &version)
	vid := int64(version["id"].(float64))

	var stored map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions/"+itoa(vid), &stored)
	docJSON, _ := stored["design_doc_json"].(string)
	var reloaded designdoc.Doc
	if err := json.Unmarshal([]byte(docJSON), &reloaded); err != nil {
		t.Fatalf("stored design doc does not parse: %v", err)
	}
	if len(reloaded.Circuits) != 1 || reloaded.Circuits[0].ID != "c1" ||
		reloaded.Circuits[0].Name != "Script" {
		t.Fatalf("circuits did not survive the save: %+v", reloaded.Circuits)
	}
	for _, r := range reloaded.Runs {
		if r.CircuitID != "c1" {
			t.Fatalf("run %s lost its circuit_id: %+v", r.ID, r)
		}
		if len(r.Electrodes) != 2 {
			t.Fatalf("run %s lost electrodes — a circuit caps a derivation, it does not edit the doc", r.ID)
		}
	}

	// 4) The stored report agrees with the live one.
	reportJSON, _ := stored["validation_report_json"].(string)
	if strings.Contains(reportJSON, "raceway_transformer_fit") {
		t.Errorf("saved report still carries the fit warning: %s", reportJSON)
	}
}

// TestDanglingCircuitIDRejectedAtTheAPI is the negative control for the
// identity decision, and the failure Tier 3 #140 asked us not to repeat: the
// FK relationship has to be discoverable from the API, so the rejection names
// the run, the id and the rule instead of a bare "bad request".
func TestDanglingCircuitIDRejectedAtTheAPI(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	mux := http.NewServeMux()
	registerAPI(mux, db, dir)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := srv.Client()
	base := srv.URL

	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "dangling circuit",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	post := func(body string) (int, string) {
		resp, err := client.Post(
			base+"/api/projects/"+itoa(projectID)+"/design_versions",
			"application/json", bytes.NewReader([]byte(body)))
		if err != nil {
			t.Fatalf("POST design_versions: %v", err)
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		return resp.StatusCode, string(raw)
	}

	status, raw := post(`{"design_doc":{"version":1,"view_box_mm":[0,0,100,100],` +
		`"runs":[{"id":"r1","circuit_id":"c9","polyline":{"points":[[0,0],[10,0]],"closed":false}}]}}`)
	if status != http.StatusBadRequest {
		t.Fatalf("a run pointing at a missing circuit was accepted with status %d: %s", status, raw)
	}
	if !strings.Contains(raw, "names no circuit") || !strings.Contains(raw, "c9") {
		t.Errorf("rejection message does not explain itself: %s", raw)
	}

	// Negative control: the identical doc WITH the circuit declared saves.
	// Without this the check above could be passing because the endpoint
	// rejects everything.
	status, raw = post(`{"design_doc":{"version":1,"view_box_mm":[0,0,100,100],` +
		`"runs":[{"id":"r1","circuit_id":"c9","polyline":{"points":[[0,0],[10,0]],"closed":false}}],` +
		`"circuits":[{"id":"c9","name":"Main"}]}}`)
	if status != http.StatusOK && status != http.StatusCreated {
		t.Fatalf("a well-formed circuit doc was rejected with status %d: %s", status, raw)
	}
}
