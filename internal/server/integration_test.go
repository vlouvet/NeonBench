package server

import (
	"archive/zip"
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pressly/goose/v3"
	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
)

// TestEditorPipelineFromOpenNeon exercises the full sequence a user runs
// when they open an OPEN-style sign image: create project, upload PNG,
// vectorize, mutate the resulting design doc through every editor tool,
// save as a new version, hit the live-validate endpoint, and download
// the print PDF. Each step asserts the response shape the editor relies
// on. If a tool stops working the breakage shows up here without anyone
// having to click around in a browser.
func TestEditorPipelineFromOpenNeon(t *testing.T) {
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

	// 1) Pick the first seeded tube spec.
	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	if len(specs) == 0 {
		t.Fatal("expected seeded tube specs, got none")
	}
	tubeSpecID := int64(specs[0]["id"].(float64))

	// 2) Create a project.
	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "OPEN sign integration test",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// 3) Upload the test PNG as an asset.
	imgBytes, err := os.ReadFile(filepath.Join("testdata", "open_neon.png"))
	if err != nil {
		t.Fatalf("read test image: %v", err)
	}
	asset := uploadAsset(t, client, base, projectID, "open_neon.png", "image/png", imgBytes)
	assetID := int64(asset["id"].(float64))

	// 4) Vectorize. The handler returns a freshly-created design version.
	var designVersion map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/vectorize", map[string]any{
		"asset_id":        assetID,
		"target_width_mm": 300.0,
	}, &designVersion)
	versionID := int64(designVersion["id"].(float64))
	docJSON, _ := designVersion["design_doc_json"].(string)
	if docJSON == "" {
		t.Fatal("vectorize returned no design_doc_json — editor won't load this version")
	}

	var doc designdoc.Doc
	if err := json.Unmarshal([]byte(docJSON), &doc); err != nil {
		t.Fatalf("unmarshal doc: %v", err)
	}
	if len(doc.Runs) == 0 {
		t.Fatal("vectorize produced no runs")
	}
	t.Logf("vectorize: %d runs, viewBox=%v", len(doc.Runs), doc.ViewBoxMM)

	// 5) Drive every editor tool against the doc.
	openRun := pickOpenRun(doc.Runs)
	closedRun := pickClosedRun(doc.Runs)
	if openRun == nil && closedRun == nil {
		t.Fatal("vectorize produced no usable runs")
	}

	if openRun != nil {
		applyOpenRunEdits(t, &doc, openRun.ID)
	}
	if closedRun != nil {
		applyClosedRunEdits(t, &doc, closedRun.ID)
	}

	// Doc-level annotations (labels + dimensions).
	doc.Labels = append(doc.Labels, designdoc.Label{X: 5, Y: 5, Text: "transformer"})
	doc.Dimensions = append(doc.Dimensions, designdoc.Dimension{X1: 0, Y1: 0, X2: 100, Y2: 0, Note: "min spacing"})

	// 6) Live-validate the in-flight doc.
	var liveReport map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc", map[string]any{
		"design_doc": doc,
	}, &liveReport)
	if liveReport["tube_runs"] == nil {
		t.Fatal("validate_doc returned malformed report")
	}
	t.Logf("live validate: %v issue(s), %v runs",
		len(liveReport["issues"].([]any)), liveReport["tube_runs"])

	// 7) Save as a new design version.
	var newVersion map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"based_on_vid": versionID,
		"label":        "edits via integration test",
		"design_doc":   doc,
	}, &newVersion)
	newVersionID := int64(newVersion["id"].(float64))

	// 8) Reload the saved version: doc must round-trip with our edits intact.
	var reloaded map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions/"+itoa(newVersionID), &reloaded)
	reloadedJSON, _ := reloaded["design_doc_json"].(string)
	var reDoc designdoc.Doc
	if err := json.Unmarshal([]byte(reloadedJSON), &reDoc); err != nil {
		t.Fatalf("reload unmarshal: %v", err)
	}
	if len(reDoc.Labels) != 1 || reDoc.Labels[0].Text != "transformer" {
		t.Errorf("doc label did not survive round-trip: got %v", reDoc.Labels)
	}
	if len(reDoc.Dimensions) != 1 || reDoc.Dimensions[0].Note != "min spacing" {
		t.Errorf("doc dimension did not survive round-trip: got %v", reDoc.Dimensions)
	}
	if openRun != nil {
		got := findRun(reDoc.Runs, openRun.ID)
		if got == nil {
			t.Fatalf("open run %s missing after reload", openRun.ID)
		}
		if len(got.Electrodes) != 2 {
			t.Errorf("open run electrodes: want 2, got %d", len(got.Electrodes))
		}
		if len(got.Blockouts) != 1 {
			t.Errorf("open run blockouts: want 1, got %d", len(got.Blockouts))
		}
		if len(got.Annotations) != 3 {
			t.Errorf("open run annotations (jump/support/doubleback): want 3, got %d", len(got.Annotations))
		}
		if got.Color != "classic-red" {
			t.Errorf("open run color: want classic-red, got %q", got.Color)
		}
		if got.TubeDiameterMM != 12 {
			t.Errorf("open run diameter override: want 12, got %v", got.TubeDiameterMM)
		}
		if got.Notes == "" {
			t.Errorf("open run notes did not survive")
		}
	}
	if closedRun != nil {
		got := findRun(reDoc.Runs, closedRun.ID)
		if got == nil {
			t.Fatalf("closed run %s missing after reload", closedRun.ID)
		}
		if len(got.Electrodes) != 2 {
			t.Errorf("closed run electrodes: want 2, got %d", len(got.Electrodes))
		}
		if got.Direction == "" {
			t.Errorf("closed run with 2 electrodes should have a direction")
		}
	}

	// 9a) Export bundle must produce a valid zip with manifest + history.
	bundleResp, err := client.Get(base + "/api/projects/" + itoa(projectID) + "/export.neonbench")
	if err != nil {
		t.Fatalf("export.neonbench: %v", err)
	}
	bundleBytes, _ := io.ReadAll(bundleResp.Body)
	bundleResp.Body.Close()
	if bundleResp.StatusCode != 200 {
		t.Fatalf("export.neonbench status %d: %s", bundleResp.StatusCode, bundleBytes)
	}
	if !bytes.HasPrefix(bundleBytes, []byte("PK")) {
		t.Errorf("export.neonbench did not return a zip (first 2 bytes: %q)", bundleBytes[:min(2, len(bundleBytes))])
	}
	if len(bundleBytes) < 200 {
		t.Errorf("export.neonbench unreasonably small: %d bytes", len(bundleBytes))
	}

	// 9b) Print PDF must render without error and start with %PDF-.
	pdfResp, err := client.Get(base + "/api/projects/" + itoa(projectID) + "/design_versions/" + itoa(newVersionID) + "/print.pdf")
	if err != nil {
		t.Fatalf("print.pdf: %v", err)
	}
	defer pdfResp.Body.Close()
	if pdfResp.StatusCode != 200 {
		body, _ := io.ReadAll(pdfResp.Body)
		t.Fatalf("print.pdf status %d: %s", pdfResp.StatusCode, body)
	}
	pdfBytes, _ := io.ReadAll(pdfResp.Body)
	if !bytes.HasPrefix(pdfBytes, []byte("%PDF-")) {
		t.Errorf("print.pdf did not return a PDF document (first 8 bytes: %q)", pdfBytes[:min(8, len(pdfBytes))])
	}
	t.Logf("print.pdf: %d bytes", len(pdfBytes))
}

// applyOpenRunEdits exercises every editor tool that needs an open run:
// place 2 electrodes, add a blockout, jump/support/doubleback annotations,
// per-run color/diameter/notes overrides, and a manual bend.
func applyOpenRunEdits(t *testing.T, doc *designdoc.Doc, runID string) {
	t.Helper()
	idx := runIndex(doc.Runs, runID)
	if idx < 0 {
		t.Fatalf("open run %s not found", runID)
	}
	run := &doc.Runs[idx]
	n := len(run.Polyline.Points)
	if n < 10 {
		t.Fatalf("open run %s has only %d points; need >=10 for edit fixtures", runID, n)
	}
	mid := n / 2
	run.Electrodes = []designdoc.Electrode{{PointIndex: 0}, {PointIndex: n - 1}}
	run.Blockouts = []designdoc.Blockout{{StartLiveIndex: mid - 2, EndLiveIndex: mid + 2}}
	run.Annotations = []designdoc.Annotation{
		{Kind: "jump", LiveIndex: 1},
		{Kind: "support", LiveIndex: 2},
		{Kind: "doubleback", LiveIndex: 3},
	}
	run.Color = "classic-red"
	run.TubeDiameterMM = 12
	run.Notes = "15kV @ 60mA, GTO HV cable"
	// Snapshot auto-detect + 1 manual bend so the bends list stays in
	// authored ("manual") mode after round-trip.
	auto := designdoc.ComputeBends(*run, 12)
	bends := make([]designdoc.Bend, 0, len(auto)+1)
	for _, b := range auto {
		bends = append(bends, designdoc.Bend{LiveIndex: b.LiveIndex})
	}
	bends = append(bends, designdoc.Bend{LiveIndex: mid})
	run.Bends = bends
}

// applyClosedRunEdits places 2 electrodes on a closed run and lets the
// auto-direction logic pick which arc is live.
func applyClosedRunEdits(t *testing.T, doc *designdoc.Doc, runID string) {
	t.Helper()
	idx := runIndex(doc.Runs, runID)
	if idx < 0 {
		t.Fatalf("closed run %s not found", runID)
	}
	run := &doc.Runs[idx]
	n := len(run.Polyline.Points)
	if n < 4 {
		t.Skipf("closed run %s has only %d points; skipping closed-run electrode test", runID, n)
		return
	}
	a := 0
	b := n / 2
	run.Electrodes = []designdoc.Electrode{{PointIndex: a}, {PointIndex: b}}
	// direction normally set by the editor; pick the longer arc here.
	run.Direction = "forward"
}

func pickOpenRun(runs []designdoc.Run) *designdoc.Run {
	for i := range runs {
		if !runs[i].Polyline.Closed && len(runs[i].Polyline.Points) >= 10 {
			return &runs[i]
		}
	}
	return nil
}

func pickClosedRun(runs []designdoc.Run) *designdoc.Run {
	for i := range runs {
		if runs[i].Polyline.Closed && len(runs[i].Polyline.Points) >= 4 {
			return &runs[i]
		}
	}
	return nil
}

func runIndex(runs []designdoc.Run, id string) int {
	for i := range runs {
		if runs[i].ID == id {
			return i
		}
	}
	return -1
}

func findRun(runs []designdoc.Run, id string) *designdoc.Run {
	if i := runIndex(runs, id); i >= 0 {
		return &runs[i]
	}
	return nil
}

func itoa(n int64) string {
	buf := make([]byte, 0, 20)
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		buf = append([]byte{byte('0' + n%10)}, buf...)
		n /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}

func getJSON(t *testing.T, c *http.Client, url string, dst any) {
	t.Helper()
	resp, err := c.Get(url)
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("GET %s status %d: %s", url, resp.StatusCode, body)
	}
	if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
		t.Fatalf("GET %s decode: %v", url, err)
	}
}

func postJSON(t *testing.T, c *http.Client, url string, body any, dst any) {
	t.Helper()
	buf, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("marshal POST body: %v", err)
	}
	resp, err := c.Post(url, "application/json", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		respBody, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST %s status %d: %s", url, resp.StatusCode, respBody)
	}
	if dst != nil {
		if err := json.NewDecoder(resp.Body).Decode(dst); err != nil {
			t.Fatalf("POST %s decode: %v", url, err)
		}
	}
}

func uploadAsset(t *testing.T, c *http.Client, base string, projectID int64, filename, mime string, data []byte) map[string]any {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := make(map[string][]string)
	hdr["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	hdr["Content-Type"] = []string{mime}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("multipart create: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("multipart write: %v", err)
	}
	mw.Close()
	req, err := http.NewRequest("POST", base+"/api/projects/"+itoa(projectID)+"/assets", &buf)
	if err != nil {
		t.Fatalf("upload req: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("upload: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(resp.Body)
		t.Fatalf("upload status %d: %s", resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("upload decode: %v", err)
	}
	return out
}

// TestDeleteDesignVersion covers the DELETE /api/projects/{id}/design_versions/{vid}
// route added for Tier 1 #1: a botched vectorize must be removable from the
// shop's history. The flow is create-project, create-version directly via
// storage, hit DELETE, then expect 404 on a follow-up GET.
func TestDeleteDesignVersion(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "delete-version test",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// Insert two design versions directly so we can delete one and see the
	// other still on the list.
	dv1, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: projectID,
		Label:     "first",
		SVGData:   `<svg xmlns="http://www.w3.org/2000/svg"/>`,
	})
	if err != nil {
		t.Fatalf("create v1: %v", err)
	}
	dv2, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: projectID,
		Label:     "second",
		SVGData:   `<svg xmlns="http://www.w3.org/2000/svg"/>`,
	})
	if err != nil {
		t.Fatalf("create v2: %v", err)
	}

	// Delete v1.
	delURL := base + "/api/projects/" + itoa(projectID) + "/design_versions/" + itoa(dv1.ID)
	req, err := http.NewRequest("DELETE", delURL, nil)
	if err != nil {
		t.Fatalf("build DELETE: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE %s: %v", delURL, err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE expected 204, got %d", resp.StatusCode)
	}

	// Subsequent GET on the deleted version → 404.
	getResp, err := client.Get(delURL)
	if err != nil {
		t.Fatalf("GET deleted: %v", err)
	}
	getResp.Body.Close()
	if getResp.StatusCode != http.StatusNotFound {
		t.Fatalf("GET deleted: want 404, got %d", getResp.StatusCode)
	}

	// A second DELETE on the same id → 404 (idempotency-of-status guard).
	dupReq, _ := http.NewRequest("DELETE", delURL, nil)
	dupResp, err := client.Do(dupReq)
	if err != nil {
		t.Fatalf("DELETE again: %v", err)
	}
	dupResp.Body.Close()
	if dupResp.StatusCode != http.StatusNotFound {
		t.Fatalf("DELETE missing: want 404, got %d", dupResp.StatusCode)
	}

	// v2 still there.
	var remaining []map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", &remaining)
	if len(remaining) != 1 || int64(remaining[0]["id"].(float64)) != dv2.ID {
		t.Fatalf("after delete, want only v2 remaining, got %v", remaining)
	}

	// Cross-project guard: a version that belongs to a different project
	// must not be deletable via this project's URL.
	otherProj := storage.CreateProjectParams{Name: "other", TubeSpecID: tubeSpecID, Units: "mm"}
	op, err := storage.CreateProject(t.Context(), db, otherProj)
	if err != nil {
		t.Fatalf("create other project: %v", err)
	}
	otherDV, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: op.ID,
		SVGData:   `<svg xmlns="http://www.w3.org/2000/svg"/>`,
	})
	if err != nil {
		t.Fatalf("create other dv: %v", err)
	}
	wrongURL := base + "/api/projects/" + itoa(projectID) + "/design_versions/" + itoa(otherDV.ID)
	wrongReq, _ := http.NewRequest("DELETE", wrongURL, nil)
	wrongResp, err := client.Do(wrongReq)
	if err != nil {
		t.Fatalf("DELETE wrong project: %v", err)
	}
	wrongResp.Body.Close()
	if wrongResp.StatusCode != http.StatusNotFound {
		t.Fatalf("DELETE wrong project: want 404, got %d", wrongResp.StatusCode)
	}
}

// TestRevalidateAfterTubeSpecSwap is the regression guard for the
// "silently stale validation report" failure mode that the editor's
// tube-spec switcher (Tier 1 #5) is built to prevent. The flow:
//
//  1. Create a project pointing at a small-diameter tube spec (loose
//     bend-radius limit) with a design version whose only path is a
//     gentle 25mm-radius arc that the loose spec accepts.
//  2. Confirm the saved report has zero bend-radius issues, and that the
//     report's bend-radius messages (if any) cite the loose spec's
//     limit.
//  3. PATCH the project to a larger-diameter tube spec whose tighter
//     bend-radius limit the same 25mm arc cannot satisfy.
//  4. POST /validate to re-run validation. The new report MUST cite the
//     stricter spec's limit and MUST flag the arc.
//
// Without auto-revalidate after the switch, step 4's report would still
// match step 2's — the regression we're protecting against.
func TestRevalidateAfterTubeSpecSwap(t *testing.T) {
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

	// Locate the loose ("8mm clear", limit 18mm) and tight ("12mm clear",
	// limit 27mm) seeded specs by name. Hard-coded IDs would be fragile
	// to seed re-orderings.
	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	var looseID, tightID int64
	var looseLimit, tightLimit float64
	for _, s := range specs {
		switch s["name"].(string) {
		case "8mm clear":
			looseID = int64(s["id"].(float64))
			looseLimit = s["min_bend_radius_mm"].(float64)
		case "12mm clear":
			tightID = int64(s["id"].(float64))
			tightLimit = s["min_bend_radius_mm"].(float64)
		}
	}
	if looseID == 0 || tightID == 0 {
		t.Fatalf("expected seeded 8mm/12mm specs; got %v", specs)
	}
	if !(looseLimit < 25 && tightLimit > 25) {
		t.Fatalf("seeded specs no longer bracket 25mm radius (loose=%v, tight=%v)", looseLimit, tightLimit)
	}

	// Project + design version. The test SVG is a closed polyline that
	// samples a 25mm-radius circle at 1° intervals, encoded as M+L+Z
	// path commands. SVG `A` (elliptical-arc) commands are approximated
	// as straight lines by the validator's path parser, so we cannot
	// rely on `A 25,25 …` here; explicit polyline samples make the
	// curvature deterministic.
	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "tube-spec swap regression",
		"tube_spec_id": looseID,
	}, &project)
	projectID := int64(project["id"].(float64))

	const radius = 25.0
	circleSVG := buildCirclePolylineSVG(radius, 50, 50, 100, 1)
	dv, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: projectID,
		Label:     "circle r=25",
		SVGData:   circleSVG,
	})
	if err != nil {
		t.Fatalf("create design version: %v", err)
	}

	revalURL := base + "/api/projects/" + itoa(projectID) + "/design_versions/" + itoa(dv.ID) + "/validate"

	// Step 1: validate against the LOOSE spec. radius=25mm > 18mm limit
	// → no bend-radius errors expected.
	var looseDV map[string]any
	postJSON(t, client, revalURL, nil, &looseDV)
	looseReportJSON, _ := looseDV["validation_report_json"].(string)
	if looseReportJSON == "" {
		t.Fatal("loose-spec revalidate produced no report")
	}
	if got := countBendRadiusIssues(t, looseReportJSON); got != 0 {
		t.Errorf("loose spec (limit %vmm) on r=25mm arc: want 0 bend errors, got %d (report=%s)",
			looseLimit, got, looseReportJSON)
	}
	// Whatever issues the loose-spec report does mention, none of them
	// should reference the TIGHT spec's limit value — that's the marker
	// of a stale report leaking through after a swap.
	if strings.Contains(looseReportJSON, formatLimit(tightLimit)) {
		t.Errorf("loose-spec report unexpectedly references tight limit %vmm: %s", tightLimit, looseReportJSON)
	}

	// Step 2: PATCH the project to the tight spec.
	patchURL := base + "/api/projects/" + itoa(projectID)
	patchBody, _ := json.Marshal(map[string]any{"tube_spec_id": tightID})
	patchReq, _ := http.NewRequest("PATCH", patchURL, bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := client.Do(patchReq)
	if err != nil {
		t.Fatalf("PATCH project: %v", err)
	}
	if patchResp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(patchResp.Body)
		patchResp.Body.Close()
		t.Fatalf("PATCH project status %d: %s", patchResp.StatusCode, body)
	}
	patchResp.Body.Close()

	// Critical: read back the version BEFORE revalidate. The stored
	// report should still be the loose-spec one — we have not yet asked
	// the server to refresh it. If a future change starts auto-
	// revalidating in the PATCH handler this assertion will catch it
	// and prompt a reviewer to verify the editor's flow still makes
	// sense.
	var preReval map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions/"+itoa(dv.ID), &preReval)
	preRevalReport, _ := preReval["validation_report_json"].(string)
	if countBendRadiusIssues(t, preRevalReport) != 0 {
		t.Errorf("pre-revalidate report should still match loose spec (no bend errors); got %s", preRevalReport)
	}

	// Step 3: revalidate. r=25mm < 27mm limit → at least one bend error
	// expected, and the message must cite the tight spec's limit.
	var tightDV map[string]any
	postJSON(t, client, revalURL, nil, &tightDV)
	tightReportJSON, _ := tightDV["validation_report_json"].(string)
	if tightReportJSON == "" {
		t.Fatal("tight-spec revalidate produced no report")
	}
	if got := countBendRadiusIssues(t, tightReportJSON); got == 0 {
		t.Errorf("tight spec (limit %vmm) on r=%vmm arc: want >=1 bend error, got 0 (report=%s)",
			tightLimit, radius, tightReportJSON)
	}
	if !strings.Contains(tightReportJSON, formatLimit(tightLimit)) {
		t.Errorf("tight-spec report should reference limit %vmm; got %s", tightLimit, tightReportJSON)
	}
	if strings.Contains(tightReportJSON, formatLimit(looseLimit)) {
		t.Errorf("tight-spec report still references loose limit %vmm — stale report: %s", looseLimit, tightReportJSON)
	}
}

// countBendRadiusIssues counts validation issues with rule "min_bend_radius"
// in a marshaled validation_report_json blob.
func countBendRadiusIssues(t *testing.T, reportJSON string) int {
	t.Helper()
	if reportJSON == "" {
		return 0
	}
	var rep struct {
		Issues []struct {
			Rule string `json:"rule"`
		} `json:"issues"`
	}
	if err := json.Unmarshal([]byte(reportJSON), &rep); err != nil {
		t.Fatalf("unmarshal report: %v", err)
	}
	n := 0
	for _, iss := range rep.Issues {
		if iss.Rule == "min_bend_radius" {
			n++
		}
	}
	return n
}

// formatLimit renders a tube-spec bend-radius limit the way the
// validator embeds it in issue messages ("below tube minimum 27.0mm")
// so substring-matching against the report is deterministic.
func formatLimit(mm float64) string {
	return fmt.Sprintf("%.1fmm", mm)
}

// buildCirclePolylineSVG returns an SVG document whose only path is a
// closed polyline sampling a circle of given radius around (cx, cy).
// stepDeg controls sample density. The doc has a 1:1 mm viewBox so the
// validator's coordinate transform is the identity — path coordinates
// are interpreted directly as millimeters. Used by the tube-spec swap
// regression test, which needs a curve of known constant radius.
func buildCirclePolylineSVG(radius, cx, cy, sideMM, stepDeg float64) string {
	var b strings.Builder
	fmt.Fprintf(&b, `<svg xmlns="http://www.w3.org/2000/svg" width="%vmm" height="%vmm" viewBox="0 0 %v %v">`,
		sideMM, sideMM, sideMM, sideMM)
	b.WriteString(`<path d="`)
	first := true
	for ang := 0.0; ang < 360.0; ang += stepDeg {
		rad := ang * math.Pi / 180
		x := cx + radius*math.Cos(rad)
		y := cy + radius*math.Sin(rad)
		if first {
			fmt.Fprintf(&b, "M %.4f,%.4f", x, y)
			first = false
		} else {
			fmt.Fprintf(&b, " L %.4f,%.4f", x, y)
		}
	}
	b.WriteString(` Z" fill="none" stroke="black"/>`)
	b.WriteString(`</svg>`)
	return b.String()
}

// TestProjectJobManagerFields covers the create/get/update round-trip for
// the Job Manager metadata added in Tier 2 #13 (NW #112). Every field is
// optional; we exercise the happy path (all four set on create), the
// "clear via empty string" path on PATCH, and the validation rejections
// (too-long fields and a malformed due_date).
func TestProjectJobManagerFields(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	// Create a project with all four optional fields populated.
	var created map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "Job Manager round-trip",
		"tube_spec_id": tubeSpecID,
		"customer":     "  ACME Diner LLC  ",
		"designer":     "Pat Welder",
		"due_date":     "2026-09-01",
		"job_number":   "INV-1042",
	}, &created)
	if got, want := created["customer"], "ACME Diner LLC"; got != want {
		t.Errorf("customer trim: got %q want %q", got, want)
	}
	if got, want := created["designer"], "Pat Welder"; got != want {
		t.Errorf("designer: got %q want %q", got, want)
	}
	if got, want := created["due_date"], "2026-09-01"; got != want {
		t.Errorf("due_date: got %q want %q", got, want)
	}
	if got, want := created["job_number"], "INV-1042"; got != want {
		t.Errorf("job_number: got %q want %q", got, want)
	}
	projectID := int64(created["id"].(float64))

	// GET should return the same values.
	var fetched map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID), &fetched)
	for _, k := range []string{"customer", "designer", "due_date", "job_number"} {
		if fetched[k] != created[k] {
			t.Errorf("GET field %s: got %v want %v", k, fetched[k], created[k])
		}
	}

	// LIST should return them too (the "row" used to subtitle by customer).
	var list []map[string]any
	getJSON(t, client, base+"/api/projects", &list)
	if len(list) == 0 || list[0]["customer"] != "ACME Diner LLC" {
		t.Errorf("LIST did not surface customer field: %v", list)
	}

	// PATCH: clear customer (empty string), update designer, leave others.
	patchURL := base + "/api/projects/" + itoa(projectID)
	patchBody, _ := json.Marshal(map[string]any{
		"customer": "",
		"designer": "Sam Bender",
	})
	patchReq, _ := http.NewRequest("PATCH", patchURL, bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := client.Do(patchReq)
	if err != nil {
		t.Fatalf("PATCH: %v", err)
	}
	if patchResp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(patchResp.Body)
		patchResp.Body.Close()
		t.Fatalf("PATCH status %d: %s", patchResp.StatusCode, body)
	}
	var patched map[string]any
	json.NewDecoder(patchResp.Body).Decode(&patched)
	patchResp.Body.Close()
	if patched["customer"] != "" {
		t.Errorf("PATCH clear customer: got %q want empty", patched["customer"])
	}
	if patched["designer"] != "Sam Bender" {
		t.Errorf("PATCH designer: got %q want Sam Bender", patched["designer"])
	}
	if patched["due_date"] != "2026-09-01" {
		t.Errorf("PATCH preserved due_date: got %v", patched["due_date"])
	}
	if patched["job_number"] != "INV-1042" {
		t.Errorf("PATCH preserved job_number: got %v", patched["job_number"])
	}

	// Validation rejections — each should produce 400 without mutating
	// the project.
	for _, bad := range []struct {
		name string
		body map[string]any
	}{
		{"malformed due_date", map[string]any{"due_date": "next thursday"}},
		{"impossible date", map[string]any{"due_date": "2026-13-40"}},
		{"too-long customer", map[string]any{"customer": strings.Repeat("x", 201)}},
		{"too-long designer", map[string]any{"designer": strings.Repeat("y", 101)}},
		{"too-long job_number", map[string]any{"job_number": strings.Repeat("z", 51)}},
	} {
		body, _ := json.Marshal(bad.body)
		req, _ := http.NewRequest("PATCH", patchURL, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s: %v", bad.name, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", bad.name, resp.StatusCode)
		}
	}

	// Same rejections must apply to CREATE.
	for _, bad := range []struct {
		name string
		body map[string]any
	}{
		{"create malformed due_date", map[string]any{
			"name": "x", "tube_spec_id": tubeSpecID, "due_date": "tomorrow",
		}},
		{"create too-long customer", map[string]any{
			"name": "x", "tube_spec_id": tubeSpecID, "customer": strings.Repeat("a", 201),
		}},
	} {
		body, _ := json.Marshal(bad.body)
		resp, err := client.Post(base+"/api/projects", "application/json", bytes.NewReader(body))
		if err != nil {
			t.Fatalf("%s: %v", bad.name, err)
		}
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: want 400, got %d", bad.name, resp.StatusCode)
		}
	}

	// Sanity: a fresh project that omits all four fields gets empty strings
	// in the response (NULL columns are exposed as "" by the storage layer).
	var minimal map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "minimal job",
		"tube_spec_id": tubeSpecID,
	}, &minimal)
	for _, k := range []string{"customer", "designer", "due_date", "job_number"} {
		if minimal[k] != "" {
			t.Errorf("minimal create: %s should default to \"\", got %v", k, minimal[k])
		}
	}
}

// TestProjectTubeEndGap covers create + GET + PATCH + validation for
// the optional tube_end_gap_mm setting added in Tier 2 #15 (NW #135).
// The column is nullable on purpose: nil means "no per-project
// override; renderers fall back to the shop default of 6.35 mm". The
// test verifies that round-trip + clear-with-explicit-null + range
// rejection all work end-to-end.
func TestProjectTubeEndGap(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	// Create with an explicit value.
	var created map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":            "end-gap roundtrip",
		"tube_spec_id":    tubeSpecID,
		"tube_end_gap_mm": 8.0,
	}, &created)
	if got := created["tube_end_gap_mm"]; got != 8.0 {
		t.Errorf("create echo: got %v, want 8", got)
	}
	pid := int64(created["id"].(float64))

	// GET should round-trip the same value.
	var fetched map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(pid), &fetched)
	if got := fetched["tube_end_gap_mm"]; got != 8.0 {
		t.Errorf("GET: got %v, want 8", got)
	}

	patchURL := base + "/api/projects/" + itoa(pid)
	patch := func(t *testing.T, body string) (int, map[string]any) {
		t.Helper()
		req, _ := http.NewRequest("PATCH", patchURL, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("PATCH: %v", err)
		}
		defer resp.Body.Close()
		var out map[string]any
		if resp.StatusCode/100 == 2 {
			_ = json.NewDecoder(resp.Body).Decode(&out)
		}
		return resp.StatusCode, out
	}

	// PATCH with a new in-range value writes through.
	if code, body := patch(t, `{"tube_end_gap_mm": 12.5}`); code/100 != 2 {
		t.Fatalf("PATCH set: status %d", code)
	} else if body["tube_end_gap_mm"] != 12.5 {
		t.Errorf("PATCH set: got %v, want 12.5", body["tube_end_gap_mm"])
	}

	// PATCH with an unrelated field leaves tube_end_gap_mm untouched.
	if code, body := patch(t, `{"name": "renamed"}`); code/100 != 2 {
		t.Fatalf("PATCH unrelated: status %d", code)
	} else if body["tube_end_gap_mm"] != 12.5 {
		t.Errorf("PATCH unrelated should preserve gap: got %v", body["tube_end_gap_mm"])
	}

	// PATCH with explicit null clears the override; the response should
	// then omit the field (the storage column goes back to NULL and the
	// JSON tag is omitempty on the pointer).
	if code, body := patch(t, `{"tube_end_gap_mm": null}`); code/100 != 2 {
		t.Fatalf("PATCH null: status %d", code)
	} else if _, present := body["tube_end_gap_mm"]; present {
		t.Errorf("PATCH null should clear field, but response still has it: %v", body["tube_end_gap_mm"])
	}

	// Validation: out-of-range rejected.
	for _, bad := range []string{
		`{"tube_end_gap_mm": -1}`,
		`{"tube_end_gap_mm": 101}`,
		`{"tube_end_gap_mm": "six"}`,
	} {
		if code, _ := patch(t, bad); code != http.StatusBadRequest {
			t.Errorf("PATCH %s: want 400, got %d", bad, code)
		}
	}

	// Same range check on CREATE.
	resp, err := client.Post(base+"/api/projects", "application/json",
		strings.NewReader(`{"name":"x","tube_spec_id":`+itoa(tubeSpecID)+`,"tube_end_gap_mm":250}`))
	if err != nil {
		t.Fatalf("create out-of-range: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("create out-of-range: want 400, got %d", resp.StatusCode)
	}

	// A fresh project that omits the field stays unset (response omits
	// the key entirely; matches the migration's "leave existing rows
	// NULL" intent).
	var minimal map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "no end-gap",
		"tube_spec_id": tubeSpecID,
	}, &minimal)
	if _, present := minimal["tube_end_gap_mm"]; present {
		t.Errorf("minimal create: tube_end_gap_mm should be omitted, got %v", minimal["tube_end_gap_mm"])
	}
}

// TestMigration0006Reversible exercises the goose Down step for the
// 0006_tube_end_gap migration so we catch any future SQLite/driver
// breakage that would brick a user mid-rollback. Mirrors the
// 0005 reversibility test pattern.
func TestMigration0006Reversible(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := db.Exec("SELECT tube_end_gap_mm FROM projects"); err != nil {
		t.Fatalf("post-up SELECT failed: %v", err)
	}
	if err := goose.Down(db, "migrations"); err != nil {
		t.Fatalf("down 1: %v", err)
	}
	if _, err := db.Exec("SELECT tube_end_gap_mm FROM projects"); err == nil {
		t.Errorf("column tube_end_gap_mm still present after down migration")
	}
}

// TestMigration0005Reversible exercises the goose Down step for the
// 0005_project_metadata migration. SQLite supports DROP COLUMN since
// 3.35.0 so the four ALTER TABLE statements should round-trip cleanly;
// if a future SQLite/driver pairing breaks the simple Down path we
// catch it here instead of bricking a user mid-rollback.
func TestMigration0005Reversible(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("up: %v", err)
	}
	// After Up the four columns must exist.
	if _, err := db.Exec("SELECT customer, designer, due_date, job_number FROM projects"); err != nil {
		t.Fatalf("post-up SELECT failed: %v", err)
	}
	// Roll back every migration newer than 0005, then 0005 itself, so
	// this test doesn't break each time a later migration lands.
	if err := goose.DownTo(db, "migrations", 4); err != nil {
		t.Fatalf("down to 4: %v", err)
	}
	// After Down the columns must be gone — a SELECT referencing
	// any of them is required to fail.
	for _, col := range []string{"customer", "designer", "due_date", "job_number"} {
		if _, err := db.Exec("SELECT " + col + " FROM projects"); err == nil {
			t.Errorf("column %q still present after down migration", col)
		}
	}
}

func TestExportImportRoundtrip(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "roundtrip source",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// Two versions with distinguishable SVG bodies + a label so the
	// label round-trip is exercised too.
	svg1 := `<svg xmlns="http://www.w3.org/2000/svg" data-marker="v1"/>`
	svg2 := `<svg xmlns="http://www.w3.org/2000/svg" data-marker="v2"/>`
	if _, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: projectID,
		Label:     "first cut",
		SVGData:   svg1,
	}); err != nil {
		t.Fatalf("create v1: %v", err)
	}
	if _, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: projectID,
		Label:     "second cut",
		SVGData:   svg2,
	}); err != nil {
		t.Fatalf("create v2: %v", err)
	}

	// 1) Export.
	bundleResp, err := client.Get(base + "/api/projects/" + itoa(projectID) + "/export.neonbench")
	if err != nil {
		t.Fatalf("export.neonbench: %v", err)
	}
	bundleBytes, _ := io.ReadAll(bundleResp.Body)
	bundleResp.Body.Close()
	if bundleResp.StatusCode != 200 {
		t.Fatalf("export.neonbench status %d: %s", bundleResp.StatusCode, bundleBytes)
	}
	if !bytes.HasPrefix(bundleBytes, []byte("PK")) {
		t.Fatalf("export did not return a zip")
	}

	// 2) Import the same bytes back. Project name will collide with the
	// source, so the importer should suffix "(imported)".
	imported := postBundle(t, client, base+"/api/projects/import", "first.neonbench", bundleBytes)
	importedID := int64(imported["id"].(float64))
	if name := imported["name"].(string); name != "roundtrip source (imported)" {
		t.Errorf("imported project name: want %q, got %q", "roundtrip source (imported)", name)
	}
	if tsID := int64(imported["tube_spec_id"].(float64)); tsID != tubeSpecID {
		t.Errorf("imported tube_spec_id: want %d (matched seed), got %d", tubeSpecID, tsID)
	}

	// 3) Walk both projects' version lists; SVG bytes must match
	// version-for-version, and labels must round-trip.
	var srcVersions, impVersions []map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", &srcVersions)
	getJSON(t, client, base+"/api/projects/"+itoa(importedID)+"/design_versions", &impVersions)
	if len(srcVersions) != len(impVersions) {
		t.Fatalf("version count: source %d, imported %d", len(srcVersions), len(impVersions))
	}
	if len(impVersions) != 2 {
		t.Fatalf("expected 2 versions imported, got %d", len(impVersions))
	}
	// design_versions list endpoint returns newest-first; sort by
	// version_no for a deterministic comparison.
	sortByVersionNo := func(arr []map[string]any) {
		// stable insertion sort — small slice, no need for sort import
		for i := 1; i < len(arr); i++ {
			for j := i; j > 0 && arr[j]["version_no"].(float64) < arr[j-1]["version_no"].(float64); j-- {
				arr[j], arr[j-1] = arr[j-1], arr[j]
			}
		}
	}
	sortByVersionNo(srcVersions)
	sortByVersionNo(impVersions)

	for i := range srcVersions {
		srcID := int64(srcVersions[i]["id"].(float64))
		impID := int64(impVersions[i]["id"].(float64))
		var srcFull, impFull map[string]any
		getJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions/"+itoa(srcID), &srcFull)
		getJSON(t, client, base+"/api/projects/"+itoa(importedID)+"/design_versions/"+itoa(impID), &impFull)
		if srcFull["svg_data"].(string) != impFull["svg_data"].(string) {
			t.Errorf("v%d svg_data did not survive round-trip", i+1)
		}
		if fmt.Sprint(srcFull["label"]) != fmt.Sprint(impFull["label"]) {
			t.Errorf("v%d label: source %v, imported %v", i+1, srcFull["label"], impFull["label"])
		}
		if int64(srcFull["version_no"].(float64)) != int64(impFull["version_no"].(float64)) {
			t.Errorf("v%d version_no: source %v, imported %v", i+1, srcFull["version_no"], impFull["version_no"])
		}
	}

	// 4) Re-importing the same bundle a second time must succeed and
	// yield a third project with a deeper "(imported 2)" suffix —
	// proves the name-collision fallback iterates rather than crashing.
	imported2 := postBundle(t, client, base+"/api/projects/import", "second.neonbench", bundleBytes)
	if name := imported2["name"].(string); name != "roundtrip source (imported 2)" {
		t.Errorf("second import name: want %q, got %q", "roundtrip source (imported 2)", name)
	}
}

// TestImportBundleCreatesNewTubeSpec covers the dedup branch: when a
// bundle's tube-spec snapshot doesn't dimensionally match anything on
// the target install, the importer must mint a new tube_specs row
// (rather than silently retargeting the project at a default spec).
func TestImportBundleCreatesNewTubeSpec(t *testing.T) {
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

	specsBefore, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list specs: %v", err)
	}

	// Hand-roll a bundle whose tube_spec dimensions don't match any
	// seeded spec (24mm diameter — none of the seeds use it).
	bundle := buildSyntheticBundle(t, "exotic project", storage.TubeSpec{
		Name:               "24mm exotic",
		DiameterMM:         24,
		MinBendRadiusMM:    55,
		MaxSegmentLengthMM: 4000,
		MinSpacingMM:       28,
	}, []syntheticVersion{
		{VersionNo: 1, SVG: `<svg xmlns="http://www.w3.org/2000/svg" data-marker="exotic-v1"/>`, Label: "only"},
	})

	imported := postBundle(t, client, base+"/api/projects/import", "exotic.neonbench", bundle)
	importedID := int64(imported["id"].(float64))
	tsID := int64(imported["tube_spec_id"].(float64))

	specsAfter, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list specs after: %v", err)
	}
	if len(specsAfter) != len(specsBefore)+1 {
		t.Fatalf("expected one new tube_spec row; before=%d after=%d", len(specsBefore), len(specsAfter))
	}

	created, err := storage.GetTubeSpec(t.Context(), db, tsID)
	if err != nil {
		t.Fatalf("get new spec: %v", err)
	}
	if created.DiameterMM != 24 || created.MinBendRadiusMM != 55 ||
		created.MaxSegmentLengthMM != 4000 || created.MinSpacingMM != 28 {
		t.Errorf("new spec dimensions did not match snapshot: %+v", created)
	}
	if created.IsDefault {
		t.Error("imported spec should not be marked is_default — would override seeded default")
	}

	// Sanity: the imported project should reference exactly that new
	// spec, and the version row should exist with the expected SVG.
	var versions []map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(importedID)+"/design_versions", &versions)
	if len(versions) != 1 {
		t.Fatalf("expected 1 version, got %d", len(versions))
	}
	var full map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(importedID)+"/design_versions/"+itoa(int64(versions[0]["id"].(float64))), &full)
	if !strings.Contains(full["svg_data"].(string), "exotic-v1") {
		t.Errorf("imported SVG body lost: %q", full["svg_data"])
	}

	// Re-importing the same exotic bundle MUST reuse the now-present
	// tube spec rather than creating yet another row — confirms the
	// dimension-based dedup actually kicks in across imports.
	postBundle(t, client, base+"/api/projects/import", "exotic2.neonbench", bundle)
	specsAgain, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list specs again: %v", err)
	}
	if len(specsAgain) != len(specsAfter) {
		t.Errorf("second import created an additional tube_spec — dedup failed (had %d, now %d)",
			len(specsAfter), len(specsAgain))
	}
}

// TestImportBundleRejectsMalformed is the negative-path guard for the
// import handler. Each case must come back as 400 with a human message
// (the importer is the user's first interaction with a foreign file —
// vague "internal error" responses are unhelpful here).
func TestImportBundleRejectsMalformed(t *testing.T) {
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

	cases := []struct {
		name string
		body []byte
	}{
		{name: "not a zip", body: []byte("this is not a zip file at all")},
		{name: "zip without manifest", body: zipOf(t, map[string][]byte{"random.txt": []byte("hi")})},
		{name: "manifest missing bundle marker", body: zipOf(t, map[string][]byte{
			"manifest.json": []byte(`{"schema":1,"project":{"name":"x"},"versions":[]}`),
		})},
		{name: "manifest missing project name", body: zipOf(t, map[string][]byte{
			"manifest.json": []byte(`{"bundle":"neonbench","schema":1,"project":{"name":""},"versions":[{"version_no":1}]}`),
		})},
		{name: "manifest with no versions", body: zipOf(t, map[string][]byte{
			"manifest.json": []byte(`{"bundle":"neonbench","schema":1,"project":{"name":"x"},"versions":[]}`),
		})},
		{name: "manifest references missing svg", body: zipOf(t, map[string][]byte{
			"manifest.json": []byte(`{"bundle":"neonbench","schema":1,"project":{"name":"x"},"tube_spec":{"name":"t","diameter_mm":12,"min_bend_radius_mm":27,"max_segment_length_mm":2500,"min_spacing_mm":14},"versions":[{"version_no":1}]}`),
		})},
	}

	specsBefore := mustListSpecs(t, db)
	projsBefore := mustListProjects(t, db)
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := postBundleRaw(t, client, base+"/api/projects/import", "bad.neonbench", tc.body)
			if resp.StatusCode != http.StatusBadRequest {
				body, _ := io.ReadAll(resp.Body)
				resp.Body.Close()
				t.Fatalf("want 400, got %d: %s", resp.StatusCode, body)
			}
			resp.Body.Close()
		})
	}
	// None of the failure paths should have left rows behind.
	if got := mustListSpecs(t, db); len(got) != len(specsBefore) {
		t.Errorf("malformed imports created tube_specs (%d → %d)", len(specsBefore), len(got))
	}
	if got := mustListProjects(t, db); len(got) != len(projsBefore) {
		t.Errorf("malformed imports left orphan projects (%d → %d)", len(projsBefore), len(got))
	}
}

// --- helpers shared by the import tests ---------------------------------

type syntheticVersion struct {
	VersionNo int64
	Label     string
	SVG       string
	Doc       string
	Report    string
}

// buildSyntheticBundle hand-rolls a .neonbench zip exactly the way
// handleExportBundle does, so import tests can exercise edge cases
// (exotic tube specs, custom version contents) without going through
// the export endpoint.
func buildSyntheticBundle(t *testing.T, projectName string, spec storage.TubeSpec, versions []syntheticVersion) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	manifest := bundleManifest{
		Bundle:     "neonbench",
		Schema:     1,
		ExportedAt: "2026-05-07T00:00:00.000Z",
		Project: bundleProject{
			Name:      projectName,
			Units:     "mm",
			CreatedAt: "2026-05-07T00:00:00.000Z",
			UpdatedAt: "2026-05-07T00:00:00.000Z",
		},
		TubeSpec: spec,
		Versions: make([]bundleVersionRef, 0, len(versions)),
	}
	for _, v := range versions {
		ref := bundleVersionRef{
			VersionNo: v.VersionNo,
			Label:     v.Label,
			CreatedAt: "2026-05-07T00:00:00.000Z",
			HasDoc:    v.Doc != "",
			HasReport: v.Report != "",
		}
		manifest.Versions = append(manifest.Versions, ref)
		base := fmt.Sprintf("history/v%03d", v.VersionNo)
		mustZip(t, zw, base+".svg", []byte(v.SVG))
		if v.Doc != "" {
			mustZip(t, zw, base+".design.json", []byte(v.Doc))
		}
		if v.Report != "" {
			mustZip(t, zw, base+".report.json", []byte(v.Report))
		}
	}
	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		t.Fatalf("marshal manifest: %v", err)
	}
	mustZip(t, zw, "manifest.json", manifestJSON)
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func mustZip(t *testing.T, zw *zip.Writer, name string, data []byte) {
	t.Helper()
	w, err := zw.Create(name)
	if err != nil {
		t.Fatalf("zip create %q: %v", name, err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatalf("zip write %q: %v", name, err)
	}
}

func zipOf(t *testing.T, files map[string][]byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, data := range files {
		mustZip(t, zw, name, data)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return buf.Bytes()
}

func postBundle(t *testing.T, c *http.Client, url, filename string, data []byte) map[string]any {
	t.Helper()
	resp := postBundleRaw(t, c, url, filename, data)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 != 2 {
		t.Fatalf("POST %s status %d: %s", url, resp.StatusCode, body)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode import response: %v (body=%s)", err, body)
	}
	return out
}

func postBundleRaw(t *testing.T, c *http.Client, url, filename string, data []byte) *http.Response {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	hdr := make(map[string][]string)
	hdr["Content-Disposition"] = []string{`form-data; name="file"; filename="` + filename + `"`}
	hdr["Content-Type"] = []string{"application/zip"}
	part, err := mw.CreatePart(hdr)
	if err != nil {
		t.Fatalf("multipart: %v", err)
	}
	if _, err := part.Write(data); err != nil {
		t.Fatalf("multipart write: %v", err)
	}
	mw.Close()
	req, err := http.NewRequest("POST", url, &buf)
	if err != nil {
		t.Fatalf("import req: %v", err)
	}
	req.Header.Set("Content-Type", mw.FormDataContentType())
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("import POST: %v", err)
	}
	return resp
}

func mustListSpecs(t *testing.T, db *sql.DB) []storage.TubeSpec {
	t.Helper()
	specs, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list tube specs: %v", err)
	}
	return specs
}

func mustListProjects(t *testing.T, db *sql.DB) []storage.Project {
	t.Helper()
	projs, err := storage.ListProjects(t.Context(), db)
	if err != nil {
		t.Fatalf("list projects: %v", err)
	}
	return projs
}

// keep imports honest
var _ = strings.NewReader
