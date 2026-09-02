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

// Bug #17 — segment_types over the wire.
//
// The frontend's insertVertex spliced a point into a polyline and left
// segment_types exactly as it found it, so the array came out one entry short
// of segmentCount. Nothing in the editor noticed: the canvas drew, the tools
// worked, and the doc was unsaveable. (*Polyline).UnmarshalJSON rejects the
// length at the door, so the NEXT save — and every save after it — was a 400
// the operator had no way to connect to the vertex they inserted three edits
// ago.
//
// A unit test on the TypeScript side can assert the array's length; only this
// level can assert that the length is the thing standing between the operator
// and a lost edit. Both bodies below are the literal bytes the op emits, taken
// from `docOps.test.ts` → "emits the polyline the API round-trip test posts",
// which pins them from the other side so the two cannot drift apart silently.
const (
	// What insertVertex(doc, 'r1', 0, 0.5) produces today: the cut segment's
	// two halves are lines, three entries for four points.
	insertVertexPolylineJSON = `{"points":[[0,0],[150,0],[300,0],[600,0]],"closed":false,` +
		`"segment_types":["line","line","line"]}`
	// What it produced before the fix: the array untouched, two entries for
	// four points. Kept as the negative control — without it, "the good body
	// saves" is a claim about an endpoint that has never been seen to refuse.
	preFixPolylineJSON = `{"points":[[0,0],[150,0],[300,0],[600,0]],"closed":false,` +
		`"segment_types":["arc","line"]}`
)

func TestInsertVertexDocRoundTripsThroughSave(t *testing.T) {
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
		"name":         "insertVertex round trip",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))
	versionsURL := base + "/api/projects/" + itoa(projectID) + "/design_versions"

	docBody := func(polyline string) string {
		return `{"design_doc":{"version":1,"view_box_mm":[0,0,800,800],"runs":[` +
			`{"id":"r1","polyline":` + polyline + `,"tube_diameter_mm":12}]}}`
	}

	// 1) The pre-fix shape must be refused, and say why. Run FIRST so that the
	//    success below is a result rather than the default a permissive
	//    endpoint would produce for anything.
	resp, err := client.Post(versionsURL, "application/json",
		bytes.NewReader([]byte(docBody(preFixPolylineJSON))))
	if err != nil {
		t.Fatalf("POST design_versions: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a short segment_types array was accepted with status %d: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "segment_types has 2 entries, want 3") {
		t.Errorf("rejection message does not explain itself: %s", raw)
	}

	// 2) The doc insertVertex actually emits now saves, reloads, and comes
	//    back with the same segment types on the same segments.
	var saved map[string]any
	postJSON(t, client, versionsURL, json.RawMessage(docBody(insertVertexPolylineJSON)), &saved)
	versionID := int64(saved["id"].(float64))

	var reloaded map[string]any
	getJSON(t, client, versionsURL+"/"+itoa(versionID), &reloaded)
	reloadedJSON, _ := reloaded["design_doc_json"].(string)
	var reDoc designdoc.Doc
	if err := json.Unmarshal([]byte(reloadedJSON), &reDoc); err != nil {
		t.Fatalf("reload unmarshal: %v", err)
	}
	if len(reDoc.Runs) != 1 {
		t.Fatalf("expected 1 run back, got %d", len(reDoc.Runs))
	}
	pl := reDoc.Runs[0].Polyline
	if got, want := len(pl.Points), 4; got != want {
		t.Fatalf("reloaded %d points, want %d", got, want)
	}
	if got, want := len(pl.SegmentTypes), pl.SegmentCount(); got != want {
		t.Fatalf("reloaded segment_types has %d entries, want %d", got, want)
	}
	for i := range pl.SegmentTypes {
		if pl.SegmentType(i) != designdoc.SegmentLine {
			t.Errorf("segment %d came back %q, want %q", i, pl.SegmentType(i), designdoc.SegmentLine)
		}
	}
}

// The half of Bug #17 that never produced an error at all: splitRun dropped
// segment_types entirely, so both pieces of a cut curve saved cleanly and
// measured short. The source is the bug report's geometry — 2400mm of chord
// from (200,700) to (2600,700), drawn as two arcs, 2781mm of glass — cut at
// its middle vertex, and the assertion is on the number the VALIDATOR reports
// for the saved doc, which is what the takeoff, the pattern and the DXF are
// all derived from. `docOps.test.ts` → "emits the two polylines the API
// takeoff test posts" pins that these are the runs splitRun actually returns.
func TestSplitPiecesKeepTheirGlassThroughSave(t *testing.T) {
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
		"name":         "split keeps its glass",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	// The two pieces splitRun now returns for a cut at the middle vertex of
	// [[200,700],[1400,700],[2600,700]] typed ["arc","arc"], each keeping the
	// arc it was drawn with.
	doc := &designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 3000, 1400},
		Runs: []designdoc.Run{
			{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points:       [][2]float64{{200, 700}, {1400, 700}},
					SegmentTypes: []string{designdoc.SegmentArc},
				},
				TubeDiameterMM: 12,
			},
			{
				ID: "r2",
				Polyline: designdoc.Polyline{
					Points:       [][2]float64{{1400, 700}, {2600, 700}},
					SegmentTypes: []string{designdoc.SegmentArc},
				},
				TubeDiameterMM: 12,
			},
		},
	}
	var report map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc", map[string]any{
		"design_doc": doc,
	}, &report)
	total, ok := report["total_length_mm"].(float64)
	if !ok {
		t.Fatalf("validate_doc returned no total_length_mm: %v", report)
	}
	// 2400mm of chord bowed at ARC_BULGE 0.5 is ~2781mm of glass. The pre-fix
	// pieces carried no segment_types at all and this came back 2400.00 — the
	// 381mm the bug report measured, missing from the number the shop quotes
	// and cuts to.
	if total < 2700 || total > 2800 {
		t.Fatalf("validator measured %.2fmm for two arc pieces; want ~2781mm "+
			"(2400mm is the chord, i.e. the arcs were lost)", total)
	}
}

// Tier 3 #119 — the same failure with the opposite sign.
//
// deleteVertex filtered a point out of the polyline and left segment_types
// exactly as it found it, so the array came out one entry LONG. Same decoder,
// same door, same 400 on the next save — and, like insertVertex, nothing in
// the editor noticed at the time the vertex was deleted.
//
// Both bodies below are the literal bytes the op emits; `docOps.test.ts` →
// "emits the polyline the API round-trip test posts" (in the Tier 3 #119
// block) pins them from the other side so the two cannot drift apart.
const (
	// What deleteVertex(doc, 'r1', 1) produces today, on a 4-point run typed
	// ["arc","line","arc_r"]: the two segments either side of the dropped
	// vertex merge into one line, two entries for three points. The surviving
	// arc_r keeps its side.
	deleteVertexPolylineJSON = `{"points":[[0,0],[600,0],[900,0]],"closed":false,` +
		`"segment_types":["line","arc_r"]}`
	// What it produced before the fix: the array untouched, three entries for
	// three points. The negative control, run first, so the success after it
	// is a result rather than the default.
	preFixDeletePolylineJSON = `{"points":[[0,0],[600,0],[900,0]],"closed":false,` +
		`"segment_types":["arc","line","arc_r"]}`
)

func TestDeleteVertexDocRoundTripsThroughSave(t *testing.T) {
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
		"name":         "deleteVertex round trip",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))
	versionsURL := base + "/api/projects/" + itoa(projectID) + "/design_versions"

	docBody := func(polyline string) string {
		return `{"design_doc":{"version":1,"view_box_mm":[0,0,1000,1000],"runs":[` +
			`{"id":"r1","polyline":` + polyline + `,"tube_diameter_mm":12}]}}`
	}

	// 1) The pre-fix shape must be refused, and say why.
	resp, err := client.Post(versionsURL, "application/json",
		bytes.NewReader([]byte(docBody(preFixDeletePolylineJSON))))
	if err != nil {
		t.Fatalf("POST design_versions: %v", err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("a long segment_types array was accepted with status %d: %s", resp.StatusCode, raw)
	}
	if !strings.Contains(string(raw), "segment_types has 3 entries, want 2") {
		t.Errorf("rejection message does not explain itself: %s", raw)
	}

	// 2) The doc deleteVertex actually emits now saves, reloads, and comes
	//    back with the surviving arc still on the segment it was drawn on —
	//    an off-by-one rotation would put it on the merged straight instead,
	//    which is a shape change no length check would report.
	var saved map[string]any
	postJSON(t, client, versionsURL, json.RawMessage(docBody(deleteVertexPolylineJSON)), &saved)
	versionID := int64(saved["id"].(float64))

	var reloaded map[string]any
	getJSON(t, client, versionsURL+"/"+itoa(versionID), &reloaded)
	reloadedJSON, _ := reloaded["design_doc_json"].(string)
	var reDoc designdoc.Doc
	if err := json.Unmarshal([]byte(reloadedJSON), &reDoc); err != nil {
		t.Fatalf("reload unmarshal: %v", err)
	}
	if len(reDoc.Runs) != 1 {
		t.Fatalf("expected 1 run back, got %d", len(reDoc.Runs))
	}
	pl := reDoc.Runs[0].Polyline
	if got, want := len(pl.SegmentTypes), pl.SegmentCount(); got != want {
		t.Fatalf("reloaded segment_types has %d entries, want %d", got, want)
	}
	want := []string{designdoc.SegmentLine, designdoc.SegmentArcR}
	for i, w := range want {
		if got := pl.SegmentType(i); got != w {
			t.Errorf("segment %d came back %q, want %q", i, got, w)
		}
	}
}
