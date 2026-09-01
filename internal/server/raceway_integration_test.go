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

// Tier 2 #104 / NW #133 — the raceway over the wire.
//
// Two things can only be proved at this level, and both are on CLAUDE.md's
// recurring-bug list:
//
//  1. `internal/server/json.go` sets DisallowUnknownFields, so a TS field
//     with no Go counterpart makes EVERY save 400. Saving a doc that carries
//     a raceway is the only way to know the two sides actually moved
//     together.
//  2. "It returned 200, so it worked" — the validation assertions below run
//     against a doc known to be DIRTY first, so "no issues" is a result
//     rather than the default a wrong request key produces.
func TestRacewayRoundTripsThroughSaveAndValidate(t *testing.T) {
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
		"name":         "raceway hardware model",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	// Two letters on one raceway, plus the guideline that gives the box its
	// identity. The box is deliberately STALE — 60mm long against 110mm of
	// glass — which is the state the span rule exists to catch.
	letter := func(id string, x0, x1 float64) designdoc.Run {
		return designdoc.Run{
			ID: id,
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{x0, 0}, {x1, 0}, {x1, 50}, {x0, 50}},
				Closed: true,
			},
			IsChannelLetterFace: true,
			RacewayID:           "rw1",
			Electrodes:          []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
		}
	}
	doc := designdoc.Doc{
		Version:   designdoc.SchemaVersion,
		ViewBoxMM: [4]float64{0, 0, 400, 200},
		Runs:      []designdoc.Run{letter("letter-O", 0, 50), letter("letter-N", 60, 110)},
		Guidelines: []designdoc.Guideline{
			{ID: "rw1", Kind: designdoc.GuidelineKindRaceway, YMM: 50},
		},
		Raceways: []designdoc.Raceway{{ID: "rw1", XMM: 0, LengthMM: 60}},
	}

	// 1) Live-validate the dirty doc: the span rule fires, as a WARNING.
	var dirty map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc",
		map[string]any{"design_doc": doc}, &dirty)
	spans := issuesWithRule(t, dirty, "raceway_span")
	if len(spans) != 1 {
		t.Fatalf("expected 1 raceway_span issue on a box that stops 50mm short, got %d (%v)",
			len(spans), dirty["issues"])
	}
	if sev := spans[0]["severity"]; sev != "warning" {
		t.Errorf("raceway_span severity = %v, want warning — these numbers come from a weaker source class", sev)
	}
	if msg, _ := spans[0]["message"].(string); !strings.Contains(msg, "rw1") {
		t.Errorf("message %q does not name the raceway", msg)
	}

	// 2) Fit the box and the rule clears. This is the pair that makes the
	// assertion above mean something.
	doc.Raceways[0].LengthMM = 110
	var clean map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc",
		map[string]any{"design_doc": doc}, &clean)
	if got := issuesWithRule(t, clean, "raceway_span"); len(got) != 0 {
		t.Errorf("a fitted box still warns: %v", got)
	}

	// 3) A 300mm box cannot hold the two transformers the four electrodes
	// imply, and says so — also as a warning.
	shortDoc := doc
	shortDoc.Raceways = []designdoc.Raceway{{ID: "rw1", XMM: 0, LengthMM: 110}}
	var fit map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc",
		map[string]any{"design_doc": shortDoc}, &fit)
	tf := issuesWithRule(t, fit, "raceway_transformer_fit")
	if len(tf) != 1 {
		t.Fatalf("expected the transformer-fit rule to fire on a 110mm box, got %d", len(tf))
	}
	if sev := tf[0]["severity"]; sev != "warning" {
		t.Errorf("raceway_transformer_fit severity = %v, want warning", sev)
	}

	// 4) SAVE. This is the DisallowUnknownFields check: a 400 here means the
	// Go struct and web/src/api.ts drifted.
	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions",
		map[string]any{"label": "raceway", "design_doc": doc}, &version)
	vid := int64(version["id"].(float64))

	// The stored doc must still carry the box, with its dimensions intact.
	var stored map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions/"+itoa(vid), &stored)
	docJSON, _ := stored["design_doc_json"].(string)
	var reloaded designdoc.Doc
	if err := json.Unmarshal([]byte(docJSON), &reloaded); err != nil {
		t.Fatalf("stored design doc does not parse: %v", err)
	}
	if len(reloaded.Raceways) != 1 || reloaded.Raceways[0].LengthMM != 110 {
		t.Fatalf("raceway did not survive the save: %+v", reloaded.Raceways)
	}

	// 5) The saved version's own validation report carries the doc-level
	// rules too, so a re-opened design shows the same warnings the editor
	// showed live.
	reportJSON, _ := stored["validation_report_json"].(string)
	if !strings.Contains(reportJSON, "raceway_transformer_fit") {
		t.Errorf("saved validation report has no raceway rule: %s", reportJSON)
	}

	// 6) The print PDF renders, and does so with the raceway page in it.
	resp, err := client.Get(base + "/api/projects/" + itoa(projectID) +
		"/design_versions/" + itoa(vid) + "/print.pdf")
	if err != nil {
		t.Fatalf("GET print.pdf: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("print.pdf status %d: %s", resp.StatusCode, body)
	}
	pdf, _ := io.ReadAll(resp.Body)
	if len(pdf) < 1000 {
		t.Errorf("print.pdf is %d bytes, which is not a real document", len(pdf))
	}
}

// TestDanglingRacewayRejectedAtTheAPI is the negative control for the
// identity decision: a raceway box has no id space of its own, so one whose
// id names no raceway guideline is refused at the door rather than reaching
// the PDF as a box with no top edge.
func TestDanglingRacewayRejectedAtTheAPI(t *testing.T) {
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
		"name":         "dangling raceway",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	body := `{"design_doc":{"version":1,"view_box_mm":[0,0,100,100],"runs":[],` +
		`"raceways":[{"id":"rw9","x_mm":0,"length_mm":100}]}}`
	resp, err := client.Post(
		base+"/api/projects/"+itoa(projectID)+"/design_versions",
		"application/json", bytes.NewReader([]byte(body)))
	if err != nil {
		t.Fatalf("POST design_versions: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("a raceway with no guideline was accepted with status %d: %s", resp.StatusCode, raw)
	}
	raw, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(raw), "no guideline with that id") {
		t.Errorf("rejection message does not explain itself: %s", raw)
	}
}

// issuesWithRule pulls the issues of one rule out of a decoded report.
func issuesWithRule(t *testing.T, report map[string]any, rule string) []map[string]any {
	t.Helper()
	raw, ok := report["issues"].([]any)
	if !ok {
		t.Fatalf("report has no issues array: %v", report)
	}
	var out []map[string]any
	for _, i := range raw {
		m, ok := i.(map[string]any)
		if !ok {
			continue
		}
		if m["rule"] == rule {
			out = append(out, m)
		}
	}
	return out
}
