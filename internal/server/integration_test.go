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
	"time"

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

// TestProjectChannelLetterDepth covers create + GET + PATCH + validation
// for the optional channel_letter_depth_mm setting added in Tier 2 #10
// (NW #106). Same three-state PATCH semantics as tube_end_gap_mm:
// nil/omitted leaves it alone, explicit null clears the override,
// in-range numbers write through.
func TestProjectChannelLetterDepth(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var created map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":                    "channel letter depth roundtrip",
		"tube_spec_id":            tubeSpecID,
		"channel_letter_depth_mm": 75.0,
	}, &created)
	if got := created["channel_letter_depth_mm"]; got != 75.0 {
		t.Errorf("create echo: got %v, want 75", got)
	}
	pid := int64(created["id"].(float64))

	var fetched map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(pid), &fetched)
	if got := fetched["channel_letter_depth_mm"]; got != 75.0 {
		t.Errorf("GET: got %v, want 75", got)
	}

	patchURL := base + "/api/projects/" + itoa(pid)
	patch := func(body string) (int, map[string]any) {
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

	if code, body := patch(`{"channel_letter_depth_mm": 150}`); code/100 != 2 {
		t.Fatalf("PATCH set: status %d", code)
	} else if body["channel_letter_depth_mm"] != 150.0 {
		t.Errorf("PATCH set: got %v, want 150", body["channel_letter_depth_mm"])
	}

	if code, body := patch(`{"channel_letter_depth_mm": null}`); code/100 != 2 {
		t.Fatalf("PATCH null: status %d", code)
	} else if _, present := body["channel_letter_depth_mm"]; present {
		t.Errorf("PATCH null should clear: still present %v", body["channel_letter_depth_mm"])
	}

	for _, bad := range []string{
		`{"channel_letter_depth_mm": 5}`,    // below 10 mm minimum
		`{"channel_letter_depth_mm": 1000}`, // above 500 mm max
		`{"channel_letter_depth_mm": "ten"}`,
	} {
		if code, _ := patch(bad); code != http.StatusBadRequest {
			t.Errorf("PATCH %s: want 400, got %d", bad, code)
		}
	}

	// Same range check applies on CREATE.
	resp, err := client.Post(base+"/api/projects", "application/json",
		strings.NewReader(`{"name":"x","tube_spec_id":`+itoa(tubeSpecID)+`,"channel_letter_depth_mm":2000}`))
	if err != nil {
		t.Fatalf("create out-of-range: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("create out-of-range: want 400, got %d", resp.StatusCode)
	}

	// Project with no override gets the field omitted from the response.
	var minimal map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "no depth override",
		"tube_spec_id": tubeSpecID,
	}, &minimal)
	if _, present := minimal["channel_letter_depth_mm"]; present {
		t.Errorf("minimal create: should omit channel_letter_depth_mm, got %v", minimal["channel_letter_depth_mm"])
	}
}

// TestProjectStripOverlap covers create + GET + PATCH + validation for
// the optional strip_overlap_mm setting added in Tier 3 #26. Same
// three-state PATCH semantics as tube_end_gap_mm and
// channel_letter_depth_mm: nil/omitted leaves it alone, explicit null
// clears the override, in-range numbers write through.
func TestProjectStripOverlap(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var created map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":             "strip overlap roundtrip",
		"tube_spec_id":     tubeSpecID,
		"strip_overlap_mm": 18.0,
	}, &created)
	if got := created["strip_overlap_mm"]; got != 18.0 {
		t.Errorf("create echo: got %v, want 18", got)
	}
	pid := int64(created["id"].(float64))

	var fetched map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(pid), &fetched)
	if got := fetched["strip_overlap_mm"]; got != 18.0 {
		t.Errorf("GET: got %v, want 18", got)
	}

	patchURL := base + "/api/projects/" + itoa(pid)
	patch := func(body string) (int, map[string]any) {
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

	if code, body := patch(`{"strip_overlap_mm": 25}`); code/100 != 2 {
		t.Fatalf("PATCH set: status %d", code)
	} else if body["strip_overlap_mm"] != 25.0 {
		t.Errorf("PATCH set: got %v, want 25", body["strip_overlap_mm"])
	}

	if code, body := patch(`{"strip_overlap_mm": null}`); code/100 != 2 {
		t.Fatalf("PATCH null: status %d", code)
	} else if _, present := body["strip_overlap_mm"]; present {
		t.Errorf("PATCH null should clear: still present %v", body["strip_overlap_mm"])
	}

	for _, bad := range []string{
		`{"strip_overlap_mm": -1}`,    // below 0 mm minimum
		`{"strip_overlap_mm": 101}`,   // above 100 mm max
		`{"strip_overlap_mm": "tip"}`, // non-numeric
	} {
		if code, _ := patch(bad); code != http.StatusBadRequest {
			t.Errorf("PATCH %s: want 400, got %d", bad, code)
		}
	}

	// Project with no override gets the field omitted from the response.
	var minimal map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "no overlap override",
		"tube_spec_id": tubeSpecID,
	}, &minimal)
	if _, present := minimal["strip_overlap_mm"]; present {
		t.Errorf("minimal create: should omit strip_overlap_mm, got %v", minimal["strip_overlap_mm"])
	}
}

// TestChannelLetterReturnPattern is the end-to-end regression guard
// for NW #106 / Tier 2 #10. It creates a project with an explicit
// channel-letter depth, posts a design version where one run is
// flagged as a face and another is not, fetches the print PDF, and
// asserts:
//
//   - the response is a well-formed PDF (starts with "%PDF-")
//   - the PDF is meaningfully larger than the same design rendered
//     with no face flag, because the face-marked run added a
//     return-strip page
//
// The spec calls for `bytes.Contains` against literal "Return strip"
// text, but gofpdf compresses content streams by default — text never
// appears as plain bytes in production output. Size-delta and
// PDF-prefix together cover the same regression: a future refactor
// that silently drops the return-strip emission will shrink the PDF
// back toward baseline and this test will catch it.
func TestChannelLetterReturnPattern(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":                    "channel letter print",
		"tube_spec_id":            tubeSpecID,
		"channel_letter_depth_mm": 75.0,
	}, &project)
	projectID := int64(project["id"].(float64))

	// Two runs: a 100×50 closed rectangle face (will trigger a
	// return-strip page) and a small open polyline (won't).
	faceRun := designdoc.Run{
		ID: "face-rect",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
			Closed: true,
		},
		IsChannelLetterFace: true,
	}
	plainRun := designdoc.Run{
		ID: "plain-line",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 80}, {100, 80}, {100, 90}},
			Closed: false,
		},
	}

	docWithFace := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs:      []designdoc.Run{faceRun, plainRun},
	}
	var withFaceVersion map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":       "with face",
		"design_doc":  docWithFace,
	}, &withFaceVersion)
	withFaceVID := int64(withFaceVersion["id"].(float64))

	// Baseline: same geometry, face flag cleared, so no return-strip page.
	plain := faceRun
	plain.IsChannelLetterFace = false
	docBaseline := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs:      []designdoc.Run{plain, plainRun},
	}
	var baselineVersion map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":       "no face",
		"design_doc":  docBaseline,
	}, &baselineVersion)
	baselineVID := int64(baselineVersion["id"].(float64))

	getPDF := func(vid int64) []byte {
		resp, err := client.Get(base + "/api/projects/" + itoa(projectID) + "/design_versions/" + itoa(vid) + "/print.pdf")
		if err != nil {
			t.Fatalf("print.pdf: %v", err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("print.pdf v%d status %d: %s", vid, resp.StatusCode, body)
		}
		if !bytes.HasPrefix(body, []byte("%PDF-")) {
			t.Fatalf("print.pdf v%d: not a PDF (first 8 bytes %q)", vid, body[:min(8, len(body))])
		}
		return body
	}

	withFacePDF := getPDF(withFaceVID)
	baselinePDF := getPDF(baselineVID)

	t.Logf("with-face PDF: %d bytes; baseline PDF: %d bytes", len(withFacePDF), len(baselinePDF))

	// The face flag adds a whole extra page (header + strip + ticks +
	// footer). 1 KB is a conservative floor — in practice the delta is
	// many KB, but compression makes exact byte counts unstable across
	// gofpdf updates.
	if len(withFacePDF) <= len(baselinePDF)+512 {
		t.Errorf("expected with-face PDF significantly larger than baseline (extra return-strip page); with=%d baseline=%d",
			len(withFacePDF), len(baselinePDF))
	}
}

// countPDFPages returns the number of page objects in a gofpdf-emitted
// PDF. gofpdf emits page object dictionaries uncompressed (only content
// streams are compressed), so a substring count of "/Type /Page" hits
// every page plus the single "/Type /Pages" parent — subtract the
// parent count to get the page count. Used by the strips-only tests
// below to assert page-count deltas precisely instead of relying on
// fragile byte-size heuristics.
func countPDFPages(pdfBytes []byte) int {
	s := string(pdfBytes)
	all := strings.Count(s, "/Type /Page")
	parents := strings.Count(s, "/Type /Pages")
	return all - parents
}

// TestPrintStripsOnlyOmitsMainPages — Tier 3 #50 strips-only filter.
// Builds a doc with one face-flagged run + one plain run, fetches the
// default PDF, then fetches the same URL with strips_only=1, and
// asserts (a) the strips-only response is a valid PDF, (b) the page
// count drops by the expected amount (main tile pages + bend-list
// page disappear; the strip page survives), and (c) the strips-only
// PDF is strictly smaller than the default.
func TestPrintStripsOnlyOmitsMainPages(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "strips only",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// Closed rectangle face + plain open polyline. The face run produces
	// the strip page; the plain run keeps the bend-list path off the
	// happy path (no auto-bends below 20°).
	faceRun := designdoc.Run{
		ID: "face-rect",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
			Closed: true,
		},
		IsChannelLetterFace: true,
	}
	plainRun := designdoc.Run{
		ID: "plain-line",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 80}, {100, 80}, {100, 90}},
			Closed: false,
		},
	}
	doc := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs:      []designdoc.Run{faceRun, plainRun},
	}
	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":      "with face",
		"design_doc": doc,
	}, &version)
	vid := int64(version["id"].(float64))

	getPDF := func(suffix string) []byte {
		resp, err := client.Get(base + "/api/projects/" + itoa(projectID) +
			"/design_versions/" + itoa(vid) + "/print.pdf" + suffix)
		if err != nil {
			t.Fatalf("print.pdf%s: %v", suffix, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("print.pdf%s status %d: %s", suffix, resp.StatusCode, body)
		}
		if !bytes.HasPrefix(body, []byte("%PDF-")) {
			t.Fatalf("print.pdf%s: not a PDF (first 8 bytes %q)",
				suffix, body[:min(8, len(body))])
		}
		return body
	}

	defaultPDF := getPDF("")
	stripsOnlyPDF := getPDF("?strips_only=1")

	defaultPages := countPDFPages(defaultPDF)
	stripsOnlyPages := countPDFPages(stripsOnlyPDF)

	t.Logf("default PDF: %d bytes / %d pages; strips-only: %d bytes / %d pages",
		len(defaultPDF), defaultPages, len(stripsOnlyPDF), stripsOnlyPages)

	// Strips-only must produce strictly fewer pages — at minimum, the
	// main tile page is gone (1 strip page total).
	if stripsOnlyPages >= defaultPages {
		t.Errorf("strips-only PDF page count %d should be < default %d",
			stripsOnlyPages, defaultPages)
	}
	// Exactly 1 face run = exactly 1 strip page expected.
	if stripsOnlyPages != 1 {
		t.Errorf("strips-only with one face run: expected 1 page, got %d",
			stripsOnlyPages)
	}
	// Strips-only response must still be a strictly smaller PDF byte-
	// wise (main tile + bend-list pages add real bytes).
	if len(stripsOnlyPDF) >= len(defaultPDF) {
		t.Errorf("strips-only PDF (%d B) should be smaller than default (%d B)",
			len(stripsOnlyPDF), len(defaultPDF))
	}
}

// TestPrintStripsOnlyZeroFacesEmpty — when strips_only=1 is requested
// against a doc with no face-flagged runs, the server returns 422 with
// a clear message rather than emitting a zero-page (technically
// invalid) PDF. Failing loud lets the toolbar's hidden iframe surface
// the error to the operator instead of silently spooling nothing.
func TestPrintStripsOnlyZeroFacesEmpty(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "strips only zero",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// One plain run, zero face flags. strips_only=1 must 422.
	doc := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{
			{
				ID: "plain",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}},
					Closed: false,
				},
			},
		},
	}
	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":      "no faces",
		"design_doc": doc,
	}, &version)
	vid := int64(version["id"].(float64))

	url := base + "/api/projects/" + itoa(projectID) +
		"/design_versions/" + itoa(vid) + "/print.pdf?strips_only=1"
	resp, err := client.Get(url)
	if err != nil {
		t.Fatalf("print.pdf?strips_only=1: %v", err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422, got %d: %s", resp.StatusCode, body)
	}
	if !bytes.Contains(body, []byte("no return strips")) {
		t.Errorf("expected error mentioning 'no return strips', got: %s", body)
	}

	// Sanity: same version without strips_only=1 still works.
	resp2, err := client.Get(base + "/api/projects/" + itoa(projectID) +
		"/design_versions/" + itoa(vid) + "/print.pdf")
	if err != nil {
		t.Fatalf("baseline print.pdf: %v", err)
	}
	defer resp2.Body.Close()
	body2, _ := io.ReadAll(resp2.Body)
	if resp2.StatusCode != 200 {
		t.Fatalf("baseline print.pdf status %d: %s", resp2.StatusCode, body2)
	}
	if !bytes.HasPrefix(body2, []byte("%PDF-")) {
		t.Fatalf("baseline print.pdf: not a PDF")
	}
}

// TestPrintBackwardsCompat — a request without strips_only=1 must
// produce identical output to a request with strips_only=0 (the
// param's no-op value). Pins the no-regression guarantee for any
// caller hitting /print.pdf without the new flag. We compare two
// fresh responses from the same in-process server in the same test
// run, so the embedded /CreationDate is the same.
func TestPrintBackwardsCompat(t *testing.T) {
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
	tubeSpecID := int64(specs[0]["id"].(float64))

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "backcompat",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	doc := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 200, 100},
		Runs: []designdoc.Run{
			{
				ID: "face",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
					Closed: true,
				},
				IsChannelLetterFace: true,
			},
		},
	}
	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":      "v1",
		"design_doc": doc,
	}, &version)
	vid := int64(version["id"].(float64))

	get := func(suffix string) []byte {
		resp, err := client.Get(base + "/api/projects/" + itoa(projectID) +
			"/design_versions/" + itoa(vid) + "/print.pdf" + suffix)
		if err != nil {
			t.Fatalf("print.pdf%s: %v", suffix, err)
		}
		defer resp.Body.Close()
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			t.Fatalf("print.pdf%s status %d: %s", suffix, resp.StatusCode, body)
		}
		return body
	}

	plain := get("")
	withZeroFlag := get("?strips_only=0")

	// strips_only=0 should produce a PDF with the same gross size and
	// page count as omitting the param entirely. We can't byte-equal-
	// compare: gofpdf interleaves font dictionaries non-deterministically
	// across two render runs, and the embedded /CreationDate is a
	// wall-clock timestamp that can straddle a second boundary. The
	// length-and-page-count check is enough to pin "the strips-only=0
	// branch is identical to the no-param branch end-to-end" — which is
	// the no-regression guarantee Tier 3 #50 promises callers.
	if len(plain) != len(withZeroFlag) {
		t.Errorf("strips_only=0 PDF length should match no-param length: plain=%d zeroFlag=%d",
			len(plain), len(withZeroFlag))
	}
	if a, b := countPDFPages(plain), countPDFPages(withZeroFlag); a != b {
		t.Errorf("strips_only=0 PDF page count should match no-param: plain=%d zeroFlag=%d", a, b)
	}

	// Sanity: the page count exceeds 1 (proves the main pages survived).
	if pages := countPDFPages(plain); pages < 2 {
		t.Errorf("baseline PDF should have >= 2 pages (main tile + strip), got %d", pages)
	}
}

// TestMigration0007Reversible exercises the goose Down step for the
// 0007_channel_letter_depth migration so we catch any future
// SQLite/driver breakage that would brick a user mid-rollback.
// Mirrors the 0005 / 0006 reversibility test pattern.
func TestMigration0007Reversible(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := db.Exec("SELECT channel_letter_depth_mm FROM projects"); err != nil {
		t.Fatalf("post-up SELECT failed: %v", err)
	}
	// Roll back every migration newer than 0007, then 0007 itself, so this
	// test doesn't break each time a later migration lands.
	if err := goose.DownTo(db, "migrations", 6); err != nil {
		t.Fatalf("down to 6: %v", err)
	}
	if _, err := db.Exec("SELECT channel_letter_depth_mm FROM projects"); err == nil {
		t.Errorf("column channel_letter_depth_mm still present after down migration")
	}
}

// TestMigration0009Reversible exercises the goose Down step for the
// 0009_tube_spec_lead_in migration so we catch any future SQLite/driver
// breakage that would brick a user mid-rollback. Mirrors the 0005 / 0006
// / 0007 reversibility test pattern.
func TestMigration0009Reversible(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := db.Exec("SELECT min_lead_in_mm, sharp_bend_angle_deg FROM tube_specs"); err != nil {
		t.Fatalf("post-up SELECT failed: %v", err)
	}
	// Roll back every migration newer than 0009, then 0009 itself, so this
	// test doesn't break each time a later migration lands.
	if err := goose.DownTo(db, "migrations", 8); err != nil {
		t.Fatalf("down to 8: %v", err)
	}
	for _, col := range []string{"min_lead_in_mm", "sharp_bend_angle_deg"} {
		if _, err := db.Exec("SELECT " + col + " FROM tube_specs"); err == nil {
			t.Errorf("column %q still present after down migration", col)
		}
	}
}

// TestMigration0011Reversible exercises the goose Down step for the
// 0011_project_strip_overlap migration (Tier 3 #26). Mirrors the
// 0005 / 0006 / 0007 / 0009 / 0010 reversibility tests so a future
// SQLite/driver regression that breaks DROP COLUMN gets caught
// before users hit it mid-rollback.
func TestMigration0011Reversible(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("up: %v", err)
	}
	if _, err := db.Exec("SELECT strip_overlap_mm FROM projects"); err != nil {
		t.Fatalf("post-up SELECT failed: %v", err)
	}
	if err := goose.DownTo(db, "migrations", 10); err != nil {
		t.Fatalf("down to 10: %v", err)
	}
	if _, err := db.Exec("SELECT strip_overlap_mm FROM projects"); err == nil {
		t.Errorf("column strip_overlap_mm still present after down migration")
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
	// Roll back every migration newer than 0006, then 0006 itself,
	// so this test doesn't break each time a later migration lands.
	if err := goose.DownTo(db, "migrations", 5); err != nil {
		t.Fatalf("down to 5: %v", err)
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

// TestImportBundleRejectsFutureSchema verifies the dispatcher's
// upgrade branch: a bundle whose schema is newer than this server
// understands must come back as 422 with a message that mentions
// both "schema" and "upgrade", and must not leave any rows behind.
// Pins the contract so when we eventually ship a v2 bundle, an
// older NeonBench install fails loudly instead of silently
// importing whatever the v1 importer happens to make of it.
func TestImportBundleRejectsFutureSchema(t *testing.T) {
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

	// Build a bundle that would be a perfectly valid v1 import...
	bundle := buildSyntheticBundle(t, "future bundle", storage.TubeSpec{
		Name:               "12mm clear",
		DiameterMM:         12,
		MinBendRadiusMM:    27,
		MaxSegmentLengthMM: 2500,
		MinSpacingMM:       14,
	}, []syntheticVersion{
		{VersionNo: 1, SVG: `<svg xmlns="http://www.w3.org/2000/svg" data-marker="future-v1"/>`},
	})
	// ...then rewrite the manifest's schema to a future value. We
	// crack open the zip we just produced rather than adding a flag
	// to the helper — keeps the helper honest about producing
	// "valid v1" bundles, and the rewrite is small.
	bundle = rewriteBundleSchema(t, bundle, 2)

	projsBefore := mustListProjects(t, db)

	resp := postBundleRaw(t, client, base+"/api/projects/import", "future.neonbench", bundle)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnprocessableEntity {
		t.Fatalf("want 422, got %d: %s", resp.StatusCode, body)
	}
	bodyStr := string(body)
	if !strings.Contains(bodyStr, "schema") {
		t.Errorf("error body should mention 'schema': %q", bodyStr)
	}
	if !strings.Contains(bodyStr, "upgrade") {
		t.Errorf("error body should mention 'upgrade': %q", bodyStr)
	}

	if got := mustListProjects(t, db); len(got) != len(projsBefore) {
		t.Errorf("future-schema bundle left rows behind (%d → %d)", len(projsBefore), len(got))
	}
}

// TestImportBundleAcceptsLegacyMissingSchema pins the missing-field
// tolerance baked into the dispatcher: a manifest with no `schema`
// key (zero value after JSON unmarshal) must still import as v1.
// Bundles in the wild always set schema=1, but we don't want a
// hand-crafted manifest to fail on a technicality the moment we
// add schema branching.
func TestImportBundleAcceptsLegacyMissingSchema(t *testing.T) {
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

	bundle := buildSyntheticBundle(t, "legacy missing schema", storage.TubeSpec{
		Name:               "12mm clear",
		DiameterMM:         12,
		MinBendRadiusMM:    27,
		MaxSegmentLengthMM: 2500,
		MinSpacingMM:       14,
	}, []syntheticVersion{
		{VersionNo: 1, SVG: `<svg xmlns="http://www.w3.org/2000/svg" data-marker="legacy-v1"/>`, Label: "only"},
	})
	// Drop the schema key entirely from the manifest. This is the
	// shape a hand-crafted manifest takes — the export endpoint
	// always emits schema=1, but we want the importer to still
	// accept zero-value-on-unmarshal as legacy v1.
	bundle = rewriteBundleSchema(t, bundle, -2 /* sentinel: drop the key */)

	resp := postBundleRaw(t, client, base+"/api/projects/import", "legacy.neonbench", bundle)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("want 201, got %d: %s", resp.StatusCode, body)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode response: %v (body=%s)", err, body)
	}
	if name, _ := got["name"].(string); name != "legacy missing schema" {
		t.Errorf("imported project name: want %q, got %q", "legacy missing schema", name)
	}
}

// TestImportBundleRejectsNegativeSchema covers the "weird" leg of
// the dispatcher: a negative schema is nonsense input and should
// fail with 400, not 422 (negative is malformed, not "from the
// future"). Keeps the dispatcher's edge-case guard from quietly
// rotting if someone reorders the switch later.
func TestImportBundleRejectsNegativeSchema(t *testing.T) {
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

	bundle := buildSyntheticBundle(t, "negative schema", storage.TubeSpec{
		Name:               "12mm clear",
		DiameterMM:         12,
		MinBendRadiusMM:    27,
		MaxSegmentLengthMM: 2500,
		MinSpacingMM:       14,
	}, []syntheticVersion{
		{VersionNo: 1, SVG: `<svg xmlns="http://www.w3.org/2000/svg" data-marker="negative"/>`},
	})
	bundle = rewriteBundleSchema(t, bundle, -1)

	resp := postBundleRaw(t, client, base+"/api/projects/import", "negative.neonbench", bundle)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("want 400, got %d: %s", resp.StatusCode, body)
	}
}

// rewriteBundleSchema cracks open a .neonbench zip we just produced,
// patches the manifest's schema field, and re-zips. Only used by the
// dispatcher tests. `schema == -2` is a sentinel meaning "delete the
// schema key entirely" so we can test the missing-field path.
func rewriteBundleSchema(t *testing.T, src []byte, schema int) []byte {
	t.Helper()
	zr, err := zip.NewReader(bytes.NewReader(src), int64(len(src)))
	if err != nil {
		t.Fatalf("re-open bundle: %v", err)
	}
	var out bytes.Buffer
	zw := zip.NewWriter(&out)
	for _, f := range zr.File {
		rc, err := f.Open()
		if err != nil {
			t.Fatalf("open zip entry %q: %v", f.Name, err)
		}
		data, err := io.ReadAll(rc)
		rc.Close()
		if err != nil {
			t.Fatalf("read zip entry %q: %v", f.Name, err)
		}
		if f.Name == "manifest.json" {
			var m map[string]any
			if err := json.Unmarshal(data, &m); err != nil {
				t.Fatalf("decode manifest for rewrite: %v", err)
			}
			if schema == -2 {
				delete(m, "schema")
			} else {
				m["schema"] = schema
			}
			data, err = json.MarshalIndent(m, "", "  ")
			if err != nil {
				t.Fatalf("re-encode manifest: %v", err)
			}
		}
		mustZip(t, zw, f.Name, data)
	}
	if err := zw.Close(); err != nil {
		t.Fatalf("zip close: %v", err)
	}
	return out.Bytes()
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

// TestUpdateTubeSpecFansOutRevalidation is the regression guard for Tier
// 3 #18: editing the dimensional fields of a tube spec must
// re-validate every design version in every project that references
// that spec, not just whichever version happens to be loaded in the
// editor.
//
// Setup: two projects (P1, P2) both reference the same loose 8mm spec.
// Each project gets two design versions — a 25mm-radius circle, which
// the loose spec accepts. We tighten the spec's min_bend_radius_mm
// past 25mm and assert:
//
//  1. The PATCH response carries `revalidated.project_count == 2` and
//     `revalidated.version_count == 4` (every version touched).
//  2. Each version's stored validation_report_json was regenerated:
//     the new report's generated_at is strictly newer, and the new
//     report flags the bend-radius rule that the old one did not.
//
// The "stale report on history versions" failure mode is the whole
// reason for the fan-out — without this test, a fan-out regression
// silently skipping older versions would not be caught by the
// existing single-version revalidate tests.
func TestUpdateTubeSpecFansOutRevalidation(t *testing.T) {
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

	// Pick the loose 8mm spec (limit 18mm) so the seeded value comfortably
	// accepts a 25mm-radius circle. We will tighten this same row later.
	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	var looseID int64
	var looseLimit float64
	for _, s := range specs {
		if s["name"].(string) == "8mm clear" {
			looseID = int64(s["id"].(float64))
			looseLimit = s["min_bend_radius_mm"].(float64)
		}
	}
	if looseID == 0 {
		t.Fatalf("expected seeded 8mm spec; got %v", specs)
	}
	if looseLimit >= 25 {
		t.Fatalf("seeded 8mm limit unexpectedly tight: %v", looseLimit)
	}

	// Two projects share the same spec. The fan-out must touch both.
	var p1, p2 map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "fan-out p1",
		"tube_spec_id": looseID,
	}, &p1)
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "fan-out p2",
		"tube_spec_id": looseID,
	}, &p2)
	p1ID := int64(p1["id"].(float64))
	p2ID := int64(p2["id"].(float64))

	// Two design versions each. The 25mm-radius circle is well within
	// the 18mm loose-spec budget, so the seeded report should have zero
	// bend-radius issues.
	circleSVG := buildCirclePolylineSVG(25.0, 50, 50, 100, 1)
	versions := []struct {
		projectID int64
		dvID      int64
	}{}
	for _, pid := range []int64{p1ID, p2ID} {
		for v := 0; v < 2; v++ {
			dv, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
				ProjectID: pid,
				Label:     fmt.Sprintf("v%d", v+1),
				SVGData:   circleSVG,
			})
			if err != nil {
				t.Fatalf("create design version: %v", err)
			}
			// Seed a baseline report by hitting the per-version
			// revalidate endpoint — same path the editor uses.
			revalURL := base + "/api/projects/" + itoa(pid) + "/design_versions/" + itoa(dv.ID) + "/validate"
			postJSON(t, client, revalURL, nil, nil)
			versions = append(versions, struct {
				projectID int64
				dvID      int64
			}{pid, dv.ID})
		}
	}

	// Capture each version's generated_at so we can assert "strictly
	// newer" after the fan-out runs. SQLite's strftime resolution is
	// milliseconds — fine for a test that only needs strict inequality
	// across two server roundtrips.
	preGenAt := make(map[int64]string, len(versions))
	for _, v := range versions {
		var dv map[string]any
		getJSON(t, client, base+"/api/projects/"+itoa(v.projectID)+"/design_versions/"+itoa(v.dvID), &dv)
		reportJSON, _ := dv["validation_report_json"].(string)
		if reportJSON == "" {
			t.Fatalf("version %d: missing baseline report", v.dvID)
		}
		var rep struct {
			GeneratedAt string `json:"generated_at"`
		}
		if err := json.Unmarshal([]byte(reportJSON), &rep); err != nil {
			t.Fatalf("unmarshal baseline report: %v", err)
		}
		if got := countBendRadiusIssues(t, reportJSON); got != 0 {
			t.Fatalf("baseline (loose) version %d: want 0 bend errors, got %d", v.dvID, got)
		}
		preGenAt[v.dvID] = rep.GeneratedAt
	}

	// Sleep one millisecond so SQLite's strftime tick is guaranteed to
	// advance between baseline and fan-out reports. The validate
	// pipeline runs fast enough on this machine that consecutive calls
	// can otherwise share a millisecond.
	waitForClockTick()

	// PATCH the spec: tighten min_bend_radius_mm to 35mm so the 25mm
	// circle becomes a violation. Also bump max_segment_length so we
	// exercise the multi-field path.
	patchURL := base + "/api/tube_specs/" + itoa(looseID)
	patchBody, _ := json.Marshal(map[string]any{
		"min_bend_radius_mm":    35.0,
		"max_segment_length_mm": 2400.0,
	})
	patchReq, _ := http.NewRequest("PATCH", patchURL, bytes.NewReader(patchBody))
	patchReq.Header.Set("Content-Type", "application/json")
	patchResp, err := client.Do(patchReq)
	if err != nil {
		t.Fatalf("PATCH tube_spec: %v", err)
	}
	if patchResp.StatusCode/100 != 2 {
		body, _ := io.ReadAll(patchResp.Body)
		patchResp.Body.Close()
		t.Fatalf("PATCH tube_spec status %d: %s", patchResp.StatusCode, body)
	}
	var patchOut struct {
		TubeSpec    storage.TubeSpec   `json:"tube_spec"`
		Revalidated revalidatedSummary `json:"revalidated"`
	}
	if err := json.NewDecoder(patchResp.Body).Decode(&patchOut); err != nil {
		t.Fatalf("decode PATCH response: %v", err)
	}
	patchResp.Body.Close()

	if patchOut.Revalidated.ProjectCount != 2 {
		t.Errorf("project_count = %d, want 2", patchOut.Revalidated.ProjectCount)
	}
	if patchOut.Revalidated.VersionCount != 4 {
		t.Errorf("version_count = %d, want 4", patchOut.Revalidated.VersionCount)
	}
	if patchOut.Revalidated.FailedCount != 0 {
		t.Errorf("failed_count = %d, want 0", patchOut.Revalidated.FailedCount)
	}
	if patchOut.TubeSpec.MinBendRadiusMM != 35 {
		t.Errorf("returned min_bend_radius_mm = %v, want 35", patchOut.TubeSpec.MinBendRadiusMM)
	}
	if patchOut.TubeSpec.MaxSegmentLengthMM != 2400 {
		t.Errorf("returned max_segment_length_mm = %v, want 2400", patchOut.TubeSpec.MaxSegmentLengthMM)
	}

	// Every version's report must be strictly newer AND must now flag
	// the bend radius the old report missed. The loose-spec baseline
	// had zero bend errors; the tight-spec fan-out report should have
	// > 0.
	for _, v := range versions {
		var dv map[string]any
		getJSON(t, client, base+"/api/projects/"+itoa(v.projectID)+"/design_versions/"+itoa(v.dvID), &dv)
		reportJSON, _ := dv["validation_report_json"].(string)
		if reportJSON == "" {
			t.Fatalf("version %d: report missing after fan-out", v.dvID)
		}
		var rep struct {
			GeneratedAt string `json:"generated_at"`
		}
		if err := json.Unmarshal([]byte(reportJSON), &rep); err != nil {
			t.Fatalf("unmarshal post-fan-out report v%d: %v", v.dvID, err)
		}
		if rep.GeneratedAt <= preGenAt[v.dvID] {
			t.Errorf("version %d: generated_at not strictly newer (was %q, now %q)",
				v.dvID, preGenAt[v.dvID], rep.GeneratedAt)
		}
		if got := countBendRadiusIssues(t, reportJSON); got == 0 {
			t.Errorf("version %d: post-fan-out report still missing bend errors (limit 35mm vs r=25mm circle); report=%s",
				v.dvID, reportJSON)
		}
	}
}

// TestUpdateTubeSpecPartialFailureContinues guarantees that a single
// unparseable design_version doesn't abort the fan-out for siblings.
// We seed three versions in the same project: two valid circles plus
// one with corrupt SVG bytes. After the PATCH, the response must
// report version_count == 2 and failed_count == 1, and the spec row
// itself must be persisted (the user's primary action commits even
// when the secondary fan-out partially fails).
func TestUpdateTubeSpecPartialFailureContinues(t *testing.T) {
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
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "8mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 8mm spec")
	}

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "partial-failure project",
		"tube_spec_id": specID,
	}, &project)
	pid := int64(project["id"].(float64))

	circleSVG := buildCirclePolylineSVG(25.0, 50, 50, 100, 1)
	for i := 0; i < 2; i++ {
		if _, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
			ProjectID: pid,
			Label:     fmt.Sprintf("good v%d", i+1),
			SVGData:   circleSVG,
		}); err != nil {
			t.Fatalf("create good version: %v", err)
		}
	}
	// Corrupt SVG: a stray "<svg" with no closing element. The
	// validator's xml decoder rejects it, runValidation returns the
	// empty-string sentinel, and the fan-out logs + counts it as a
	// failure without aborting the loop.
	if _, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
		ProjectID: pid,
		Label:     "broken",
		SVGData:   `<svg xmlns="http://www.w3.org/2000/svg"><path d="`,
	}); err != nil {
		t.Fatalf("create broken version: %v", err)
	}

	patchURL := base + "/api/tube_specs/" + itoa(specID)
	patchBody, _ := json.Marshal(map[string]any{"min_bend_radius_mm": 35.0})
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
	var out struct {
		TubeSpec    storage.TubeSpec   `json:"tube_spec"`
		Revalidated revalidatedSummary `json:"revalidated"`
	}
	if err := json.NewDecoder(patchResp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	patchResp.Body.Close()

	if out.Revalidated.ProjectCount != 1 {
		t.Errorf("project_count = %d, want 1", out.Revalidated.ProjectCount)
	}
	if out.Revalidated.VersionCount != 2 {
		t.Errorf("version_count = %d, want 2 (one corrupt SVG should be skipped, two good versions revalidated)", out.Revalidated.VersionCount)
	}
	if out.Revalidated.FailedCount != 1 {
		t.Errorf("failed_count = %d, want 1", out.Revalidated.FailedCount)
	}
	// Confirm the spec UPDATE persisted even though one version
	// re-validation failed.
	if out.TubeSpec.MinBendRadiusMM != 35 {
		t.Errorf("spec edit lost: min_bend_radius_mm = %v, want 35", out.TubeSpec.MinBendRadiusMM)
	}
}

// TestUpdateTubeSpecValidationRejects ensures the PATCH input checks
// reject obvious garbage (out-of-range values, empty name, bend radius
// smaller than diameter) and that no design versions are touched on a
// rejected request.
func TestUpdateTubeSpecValidationRejects(t *testing.T) {
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
	specID := int64(specs[0]["id"].(float64))
	originalLimit := specs[0]["min_bend_radius_mm"].(float64)

	patchURL := base + "/api/tube_specs/" + itoa(specID)
	cases := []struct {
		name string
		body string
	}{
		{"diameter too small", `{"diameter_mm":0.5}`},
		{"diameter too large", `{"diameter_mm":99}`},
		{"bend radius too small", `{"min_bend_radius_mm":0.5}`},
		{"empty name", `{"name":"   "}`},
		{"bend radius < diameter", `{"diameter_mm":12,"min_bend_radius_mm":6}`},
	}
	for _, tc := range cases {
		req, _ := http.NewRequest("PATCH", patchURL, strings.NewReader(tc.body))
		req.Header.Set("Content-Type", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatalf("%s: PATCH: %v", tc.name, err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400 (body=%s)", tc.name, resp.StatusCode, body)
		}
	}

	// Confirm the spec wasn't mutated by any of the rejected attempts.
	getJSON(t, client, base+"/api/tube_specs", &specs)
	if got := specs[0]["min_bend_radius_mm"].(float64); got != originalLimit {
		t.Errorf("rejected PATCHes leaked through: limit = %v, want %v", got, originalLimit)
	}
}

// waitForClockTick blocks long enough for the validator's
// generated_at timestamp (RFC3339Nano) to advance between two
// consecutive validate runs. The validator stamps reports via
// time.Now().UTC() at sub-millisecond precision, but two calls
// inside the same goroutine on a fast machine can land in the same
// nanosecond and fail a strict-inequality assertion. 2ms is overkill
// even on the slowest CI worker.
func waitForClockTick() {
	time.Sleep(2 * time.Millisecond)
}

// TestValidationConsultsAllTubeSpecFields is the wiring guard for Tier 3
// #44: the four pointer-typed validate.Limits fields added by Tier 3 #29
// (min_lead_in_mm, sharp_bend_angle_deg) and Tier 3 #31 (wall_thickness_mm,
// bend_technique) must flow from storage.TubeSpec through the request-
// scoped validate.Limits at every site that constructs one. Before this
// PR the validator silently fell back to diameter-derived defaults
// because handlers_vectorize.go and handlers_designdoc.go each hand-built
// a four-field Limits — the optional rules' values from the spec were
// dropped on the floor.
//
// The lead-in field is the cleanest end-to-end probe: a 12 mm leg passes
// the diameter-derived default for a 5 mm tube (2 × 5 = 10 mm) but fails
// an explicit 20 mm spec override. With the wiring fix, the validator
// emits a min_lead_in issue. Without the fix, the issue is absent — the
// regression this test is built to catch.
//
// The sharp-bend-angle field is exercised similarly: a 90° corner passes
// the default 85° threshold but fails an explicit 95° spec override, and
// only fires when the wiring forwards the spec value.
//
// The wall-thickness + bend-technique fields are wired through to
// validate.Limits at the handler, but the bend-radius rule's checkBendRadius
// has an early-return at limits.MinBendRadiusMM <= 0 — see
// internal/validate/rules.go — so a tube spec with min_bend_radius_mm = 0
// + populated wall + technique cannot, today, surface a derived-radius
// issue end-to-end. That's a validate-package gating bug logged as a
// Tier 3 follow-up; the wiring itself is verified by the lead-in and
// sharp-bend assertions in this test plus the parallel rules unit tests
// in internal/validate (TestRunBendLimitFallsBackToDerivedWhenSpecMissing).
func TestValidationConsultsAllTubeSpecFields(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Insert a custom tube spec with the four new optional fields populated.
	// The handler PATCH surface only exposes the four primary dimensional
	// columns (see handlers_tube_specs.go updateTubeSpecRow doc-comment),
	// so we go through the DB directly to set min_lead_in_mm /
	// sharp_bend_angle_deg / wall_thickness_mm / bend_technique. The
	// diameter is at the bottom of the validated range so the diameter-
	// derived lead-in default (2 × 5 = 10 mm) falls below our test
	// geometry's 12 mm first leg — only the explicit 20 mm override flags
	// it.
	res, err := db.Exec(`
		INSERT INTO tube_specs (
			name, diameter_mm, min_bend_radius_mm,
			max_segment_length_mm, min_spacing_mm,
			min_lead_in_mm, sharp_bend_angle_deg,
			wall_thickness_mm, bend_technique,
			is_default
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
		"tier3-44-fixture", 5.0, 12.0, 1000.0, 5.0,
		20.0, 95.0, 1.0, "ribbon")
	if err != nil {
		t.Fatalf("insert tube spec: %v", err)
	}
	tubeSpecID, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}

	mux := http.NewServeMux()
	registerAPI(mux, db, dir)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)

	client := srv.Client()
	base := srv.URL

	// Sanity: the spec we just inserted should round-trip with the new
	// fields populated. If the storage layer ever drops the columns we'd
	// get bogus test results downstream.
	all, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list tube specs: %v", err)
	}
	var fixture storage.TubeSpec
	for _, s := range all {
		if s.ID == tubeSpecID {
			fixture = s
		}
	}
	if fixture.MinLeadInMM == nil || *fixture.MinLeadInMM != 20.0 {
		t.Fatalf("fixture missing MinLeadInMM=20: %+v", fixture)
	}
	if fixture.SharpBendAngleDeg == nil || *fixture.SharpBendAngleDeg != 95.0 {
		t.Fatalf("fixture missing SharpBendAngleDeg=95: %+v", fixture)
	}
	if fixture.WallThicknessMM == nil || *fixture.WallThicknessMM != 1.0 {
		t.Fatalf("fixture missing WallThicknessMM=1: %+v", fixture)
	}
	if fixture.BendTechnique == nil || *fixture.BendTechnique != "ribbon" {
		t.Fatalf("fixture missing BendTechnique=ribbon: %+v", fixture)
	}

	// Project that uses the fixture spec.
	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "tier3-44 wiring guard",
		"tube_spec_id": tubeSpecID,
	}, &project)
	projectID := int64(project["id"].(float64))

	// Geometry: open polyline with a 12 mm first leg, a 90° corner, and a
	// 40 mm second leg. Lead-in length from electrode (0,0) to first bend
	// at (12,0) is exactly 12 mm — passes the diameter-derived default
	// (10 mm) but fails the spec's 20 mm explicit override. The 90° corner
	// at (12,0) probes the sharp-bend-angle wiring: 90° passes the default
	// 85° threshold but fails the spec's 95° threshold.
	doc := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 100, 100},
		Runs: []designdoc.Run{{
			ID: "lead-in-fixture",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {12, 0}, {12, 40}},
				Closed: false,
			},
			Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
		}},
	}

	// Drive both validation entry points: the live /validate_doc path
	// (handlers_designdoc.go) and the persisted-version path
	// (handlers_vectorize.go runValidation, reached by creating a design
	// version and reading the stored report). Both must surface the
	// wired-through fields.
	var liveReport map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/validate_doc", map[string]any{
		"design_doc": doc,
	}, &liveReport)
	assertReportFlagsLeadInAndSharpBend(t, liveReport, "validate_doc")

	var version map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/design_versions", map[string]any{
		"label":      "wiring-guard",
		"design_doc": doc,
	}, &version)
	storedReport, _ := version["validation_report_json"].(string)
	if storedReport == "" {
		t.Fatal("design_versions create returned empty validation_report_json")
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(storedReport), &parsed); err != nil {
		t.Fatalf("unmarshal stored report: %v", err)
	}
	assertReportFlagsLeadInAndSharpBend(t, parsed, "design_versions create")
}

// assertReportFlagsLeadInAndSharpBend confirms a validation report contains
// at least one min_lead_in and one sharp_bend_angle issue, naming the
// caller's report source for diagnostic output. Used by the Tier 3 #44
// wiring guard to assert both the live and persisted paths forward the
// spec's optional fields through to the validator.
func assertReportFlagsLeadInAndSharpBend(t *testing.T, report map[string]any, source string) {
	t.Helper()
	issues, _ := report["issues"].([]any)
	var leadIn, sharp int
	for _, raw := range issues {
		iss, _ := raw.(map[string]any)
		switch iss["rule"] {
		case "min_lead_in":
			leadIn++
		case "sharp_bend_angle":
			sharp++
		}
	}
	if leadIn == 0 {
		t.Errorf("[%s] expected >=1 min_lead_in issue (12mm leg vs spec 20mm); got 0. issues=%v",
			source, issues)
	}
	if sharp == 0 {
		t.Errorf("[%s] expected >=1 sharp_bend_angle issue (90° corner vs spec 95° threshold); got 0. issues=%v",
			source, issues)
	}
}

// fetchTubeSpecRow looks up a tube spec by ID via the storage layer
// (rather than the JSON API) so tests can directly assert that
// nullable columns are NULL rather than the zero-value of their JSON
// type. Returns the wall-thickness pointer, the technique pointer, and
// the row's primary fields. Used by the Tier 3 #43 PATCH tests.
func fetchTubeSpecRow(t *testing.T, db *sql.DB, id int64) storage.TubeSpec {
	t.Helper()
	specs, err := storage.ListTubeSpecs(t.Context(), db)
	if err != nil {
		t.Fatalf("list tube specs: %v", err)
	}
	for _, s := range specs {
		if s.ID == id {
			return s
		}
	}
	t.Fatalf("tube spec %d not found", id)
	return storage.TubeSpec{}
}

// patchTubeSpecRaw issues a PATCH /api/tube_specs/{id} with the given
// raw JSON body. Returns the response status and decoded body so the
// caller can assert exact JSON payloads without having Go's encoder
// rewrite "null" → omitted via the omitempty tag on a *float64.
func patchTubeSpecRaw(t *testing.T, client *http.Client, base string, id int64, body string) (int, []byte) {
	t.Helper()
	req, err := http.NewRequest("PATCH",
		base+"/api/tube_specs/"+itoa(id), strings.NewReader(body))
	if err != nil {
		t.Fatalf("build PATCH: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("PATCH: %v", err)
	}
	defer resp.Body.Close()
	out, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read PATCH body: %v", err)
	}
	return resp.StatusCode, out
}

// TestPatchTubeSpecWallThicknessOmitted pins the three-state PATCH
// preserve semantics: a body that mentions only `name` must leave the
// optional wall_thickness_mm + bend_technique columns untouched. Without
// this guard a future refactor that always overwrites those columns
// (e.g. zero-value-merging from a non-pointer struct) would silently
// blank seeded data. Tier 3 #43.
func TestPatchTubeSpecWallThicknessOmitted(t *testing.T) {
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

	// 12mm clear is seeded with wall=1.07 mm, technique=ribbon by
	// migration 0010. PATCH with only name set; nothing else should
	// move.
	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}
	pre := fetchTubeSpecRow(t, db, specID)
	if pre.WallThicknessMM == nil || *pre.WallThicknessMM != 1.07 {
		t.Fatalf("baseline wall_thickness_mm: want 1.07, got %v", pre.WallThicknessMM)
	}
	if pre.BendTechnique == nil || *pre.BendTechnique != "ribbon" {
		t.Fatalf("baseline bend_technique: want ribbon, got %v", pre.BendTechnique)
	}

	status, body := patchTubeSpecRaw(t, client, srv.URL, specID, `{"name":"12mm clear renamed"}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.WallThicknessMM == nil || *post.WallThicknessMM != 1.07 {
		t.Errorf("wall_thickness_mm dirtied by name-only PATCH: want 1.07, got %v", post.WallThicknessMM)
	}
	if post.BendTechnique == nil || *post.BendTechnique != "ribbon" {
		t.Errorf("bend_technique dirtied by name-only PATCH: want ribbon, got %v", post.BendTechnique)
	}
	if post.Name != "12mm clear renamed" {
		t.Errorf("name not applied: got %q", post.Name)
	}
}

// TestPatchTubeSpecWallThicknessClears proves explicit `null` in the
// PATCH body clears the column to SQL NULL — the third state in the
// three-state semantics that distinguishes "leave alone" (omit) from
// "wipe this" (null). Tier 3 #43.
func TestPatchTubeSpecWallThicknessClears(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}

	// Confirm the seed (defensive — if migration 0010 ever moves this
	// number we'd otherwise pass without exercising the clear path).
	pre := fetchTubeSpecRow(t, db, specID)
	if pre.WallThicknessMM == nil {
		t.Fatal("baseline wall_thickness_mm is already NULL; can't exercise clear path")
	}

	status, body := patchTubeSpecRaw(t, client, srv.URL, specID,
		`{"wall_thickness_mm":null,"bend_technique":null}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.WallThicknessMM != nil {
		t.Errorf("wall_thickness_mm not cleared: got %v", *post.WallThicknessMM)
	}
	if post.BendTechnique != nil {
		t.Errorf("bend_technique not cleared: got %v", *post.BendTechnique)
	}
}

// TestPatchTubeSpecBendTechniqueValidates rejects a bend_technique
// value outside the whitelist with a 422. The unknown string would
// otherwise silently fall back to the diameter-only 2.25·D bound in
// the validator's derivedMinBendRadius helper — operators would never
// see why their derived radius stopped tightening, hence the strict
// gate. The row must remain unchanged after the rejection. Tier 3 #43.
func TestPatchTubeSpecBendTechniqueValidates(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}
	pre := fetchTubeSpecRow(t, db, specID)

	// "torch" is a plausible typo for "hand_torch" — exactly the kind
	// of input we want to surface as a 422 rather than coerce.
	status, body := patchTubeSpecRaw(t, client, srv.URL, specID,
		`{"bend_technique":"torch"}`)
	if status != http.StatusUnprocessableEntity {
		t.Errorf("status = %d, want 422 (body=%s)", status, body)
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.BendTechnique == nil || pre.BendTechnique == nil ||
		*post.BendTechnique != *pre.BendTechnique {
		t.Errorf("rejected PATCH leaked: bend_technique pre=%v post=%v",
			pre.BendTechnique, post.BendTechnique)
	}
	if post.WallThicknessMM == nil || pre.WallThicknessMM == nil ||
		*post.WallThicknessMM != *pre.WallThicknessMM {
		t.Errorf("rejected PATCH dirtied wall_thickness_mm: pre=%v post=%v",
			pre.WallThicknessMM, post.WallThicknessMM)
	}

	// Out-of-range wall thickness also rejects with 422.
	status2, body2 := patchTubeSpecRaw(t, client, srv.URL, specID,
		`{"wall_thickness_mm":50}`)
	if status2 != http.StatusUnprocessableEntity {
		t.Errorf("oversized wall thickness status = %d, want 422 (body=%s)", status2, body2)
	}
	status3, body3 := patchTubeSpecRaw(t, client, srv.URL, specID,
		`{"wall_thickness_mm":0.05}`)
	if status3 != http.StatusUnprocessableEntity {
		t.Errorf("undersized wall thickness status = %d, want 422 (body=%s)", status3, body3)
	}
}

// TestPatchTubeSpecFanoutRevalidatesAfterWallChange asserts the PR #18
// fan-out path runs on wall-thickness edits too: every design version
// referencing the spec must get a fresh report after the column moves.
// We don't assert that the issue list changes (whether the new wall
// trips a bend-radius rule depends on the validator's gating, which is
// the subject of the Tier 3 #44 work), only that revalidated.version_count
// > 0 — i.e. the fan-out actually ran. Tier 3 #43.
func TestPatchTubeSpecFanoutRevalidatesAfterWallChange(t *testing.T) {
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
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "wall-fanout project",
		"tube_spec_id": specID,
	}, &project)
	pid := int64(project["id"].(float64))

	circleSVG := buildCirclePolylineSVG(50.0, 100, 100, 200, 1)
	for v := 0; v < 2; v++ {
		dv, err := storage.CreateDesignVersion(t.Context(), db, storage.CreateDesignVersionParams{
			ProjectID: pid,
			Label:     fmt.Sprintf("v%d", v+1),
			SVGData:   circleSVG,
		})
		if err != nil {
			t.Fatalf("create design version: %v", err)
		}
		// Seed a baseline report so the fan-out has something to refresh.
		revalURL := base + "/api/projects/" + itoa(pid) + "/design_versions/" + itoa(dv.ID) + "/validate"
		postJSON(t, client, revalURL, nil, nil)
	}
	waitForClockTick()

	status, body := patchTubeSpecRaw(t, client, base, specID,
		`{"wall_thickness_mm":1.50}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	var out struct {
		TubeSpec    storage.TubeSpec   `json:"tube_spec"`
		Revalidated revalidatedSummary `json:"revalidated"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode PATCH response: %v", err)
	}
	if out.Revalidated.VersionCount == 0 {
		t.Errorf("fan-out skipped: version_count = 0; want > 0 (%+v)", out.Revalidated)
	}
	if out.TubeSpec.WallThicknessMM == nil || *out.TubeSpec.WallThicknessMM != 1.50 {
		t.Errorf("response wall_thickness_mm = %v, want 1.50", out.TubeSpec.WallThicknessMM)
	}
}

// TestPatchTubeSpecAcceptsAllValidTechniques is the parametric pin
// across the three whitelist values plus the explicit empty-string
// clear sentinel. Each must round-trip with status 200 and the column
// must end up at the patched value (or NULL for the clear). Tier 3 #43.
func TestPatchTubeSpecAcceptsAllValidTechniques(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}

	cases := []struct {
		name      string
		body      string
		wantValue string // "" means expect NULL
	}{
		{"ribbon", `{"bend_technique":"ribbon"}`, "ribbon"},
		{"crossfire", `{"bend_technique":"crossfire"}`, "crossfire"},
		{"hand_torch", `{"bend_technique":"hand_torch"}`, "hand_torch"},
		{"empty-string clears", `{"bend_technique":""}`, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := patchTubeSpecRaw(t, client, srv.URL, specID, tc.body)
			if status/100 != 2 {
				t.Fatalf("status %d: %s", status, body)
			}
			row := fetchTubeSpecRow(t, db, specID)
			if tc.wantValue == "" {
				if row.BendTechnique != nil {
					t.Errorf("technique not cleared: got %v", *row.BendTechnique)
				}
			} else {
				if row.BendTechnique == nil || *row.BendTechnique != tc.wantValue {
					t.Errorf("technique = %v, want %q", row.BendTechnique, tc.wantValue)
				}
			}
		})
	}
}

// TestPatchTubeSpecLeadInOmitted pins the three-state PATCH preserve
// semantics for the lead-in / sharp-bend columns added in Tier 3 #41.
// A body that mentions only an unrelated field must leave both
// optional columns untouched. The columns are NULL on every seeded
// spec, so we pre-seed them via direct SQL to exercise the
// preserve-from-set-value path (rather than preserve-from-NULL, which
// is degenerate). Without this guard a future refactor that always
// overwrites the columns would silently blank operator-set overrides.
func TestPatchTubeSpecLeadInOmitted(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}
	// Seed both columns directly — the seed migrations leave them
	// NULL by design, so we have to write them in order to exercise
	// the preserve-from-set-value path.
	if _, err := db.Exec(
		`UPDATE tube_specs SET min_lead_in_mm = ?, sharp_bend_angle_deg = ? WHERE id = ?`,
		18.0, 80.0, specID); err != nil {
		t.Fatalf("seed lead-in / sharp-bend: %v", err)
	}
	pre := fetchTubeSpecRow(t, db, specID)
	if pre.MinLeadInMM == nil || *pre.MinLeadInMM != 18.0 {
		t.Fatalf("baseline min_lead_in_mm: want 18.0, got %v", pre.MinLeadInMM)
	}
	if pre.SharpBendAngleDeg == nil || *pre.SharpBendAngleDeg != 80.0 {
		t.Fatalf("baseline sharp_bend_angle_deg: want 80.0, got %v", pre.SharpBendAngleDeg)
	}

	status, body := patchTubeSpecRaw(t, client, srv.URL, specID, `{"name":"12mm clear renamed"}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.MinLeadInMM == nil || *post.MinLeadInMM != 18.0 {
		t.Errorf("min_lead_in_mm dirtied by name-only PATCH: want 18.0, got %v", post.MinLeadInMM)
	}
	if post.SharpBendAngleDeg == nil || *post.SharpBendAngleDeg != 80.0 {
		t.Errorf("sharp_bend_angle_deg dirtied by name-only PATCH: want 80.0, got %v", post.SharpBendAngleDeg)
	}
}

// TestPatchTubeSpecLeadInClears proves explicit `null` in the PATCH
// body clears the lead-in / sharp-bend columns to SQL NULL — the
// third state in the three-state semantics that distinguishes "leave
// alone" (omit) from "wipe this" (null). Tier 3 #41.
func TestPatchTubeSpecLeadInClears(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}

	// Pre-seed lead-in=10 directly so the clear path has something to
	// observe (the seed leaves both columns NULL).
	if _, err := db.Exec(
		`UPDATE tube_specs SET min_lead_in_mm = ?, sharp_bend_angle_deg = ? WHERE id = ?`,
		10.0, 75.0, specID); err != nil {
		t.Fatalf("seed lead-in / sharp-bend: %v", err)
	}
	pre := fetchTubeSpecRow(t, db, specID)
	if pre.MinLeadInMM == nil {
		t.Fatal("baseline min_lead_in_mm is already NULL; can't exercise clear path")
	}

	status, body := patchTubeSpecRaw(t, client, srv.URL, specID,
		`{"min_lead_in_mm":null,"sharp_bend_angle_deg":null}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.MinLeadInMM != nil {
		t.Errorf("min_lead_in_mm not cleared: got %v", *post.MinLeadInMM)
	}
	if post.SharpBendAngleDeg != nil {
		t.Errorf("sharp_bend_angle_deg not cleared: got %v", *post.SharpBendAngleDeg)
	}
}

// TestPatchTubeSpecSharpBendBoundsValidate rejects out-of-range
// values on both new fields with a 422 and proves the row is left
// untouched. Mirrors the wall-thickness bounds-validation pattern;
// covers both the negative bound (-5) and the over-90° bound (95)
// for sharp_bend_angle_deg, plus the over-50 mm and negative bounds
// for min_lead_in_mm. Tier 3 #41.
func TestPatchTubeSpecSharpBendBoundsValidate(t *testing.T) {
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

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	var specID int64
	for _, s := range specs {
		if s["name"].(string) == "12mm clear" {
			specID = int64(s["id"].(float64))
		}
	}
	if specID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}
	// Seed an in-range value on both columns so we can detect leaks
	// after each rejected PATCH.
	if _, err := db.Exec(
		`UPDATE tube_specs SET min_lead_in_mm = ?, sharp_bend_angle_deg = ? WHERE id = ?`,
		15.0, 85.0, specID); err != nil {
		t.Fatalf("seed lead-in / sharp-bend: %v", err)
	}
	pre := fetchTubeSpecRow(t, db, specID)

	cases := []struct {
		name string
		body string
	}{
		{"sharp_bend negative", `{"sharp_bend_angle_deg":-5}`},
		{"sharp_bend over 90", `{"sharp_bend_angle_deg":95}`},
		{"min_lead_in negative", `{"min_lead_in_mm":-1}`},
		{"min_lead_in over 50", `{"min_lead_in_mm":75}`},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, body := patchTubeSpecRaw(t, client, srv.URL, specID, tc.body)
			if status != http.StatusUnprocessableEntity {
				t.Errorf("status = %d, want 422 (body=%s)", status, body)
			}
		})
	}
	post := fetchTubeSpecRow(t, db, specID)
	if post.MinLeadInMM == nil || pre.MinLeadInMM == nil ||
		*post.MinLeadInMM != *pre.MinLeadInMM {
		t.Errorf("rejected PATCH leaked: min_lead_in_mm pre=%v post=%v",
			pre.MinLeadInMM, post.MinLeadInMM)
	}
	if post.SharpBendAngleDeg == nil || pre.SharpBendAngleDeg == nil ||
		*post.SharpBendAngleDeg != *pre.SharpBendAngleDeg {
		t.Errorf("rejected PATCH leaked: sharp_bend_angle_deg pre=%v post=%v",
			pre.SharpBendAngleDeg, post.SharpBendAngleDeg)
	}
}

// TestPatchTubeSpecLeadInFanoutRevalidates asserts the PR #18 fan-out
// path runs on lead-in edits: every design version referencing the
// spec must get a fresh report after the column moves, and the report
// must reflect the new override. We seed a spec at 5 mm diameter so
// the diameter-derived lead-in default (2 × 5 = 10 mm) does NOT flag a
// 12 mm leg, then PATCH min_lead_in_mm=20 and assert at least one
// version's report flags a previously-clean run as min_lead_in. Tier
// 3 #41.
func TestPatchTubeSpecLeadInFanoutRevalidates(t *testing.T) {
	dir := t.TempDir()
	db, err := storage.Open(dir)
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if err := storage.Migrate(db); err != nil {
		t.Fatalf("migrate: %v", err)
	}

	// Insert a custom 5 mm spec so the diameter-derived lead-in
	// default is 10 mm — well below our test geometry's 12 mm leg —
	// so the baseline run is clean and the override surfaces a fresh
	// issue.
	res, err := db.Exec(`
		INSERT INTO tube_specs (
			name, diameter_mm, min_bend_radius_mm,
			max_segment_length_mm, min_spacing_mm,
			is_default
		) VALUES (?, ?, ?, ?, ?, 0)`,
		"tier3-41-fanout-fixture", 5.0, 12.0, 1000.0, 5.0)
	if err != nil {
		t.Fatalf("insert tube spec: %v", err)
	}
	tubeSpecID, err := res.LastInsertId()
	if err != nil {
		t.Fatalf("last insert id: %v", err)
	}

	mux := http.NewServeMux()
	registerAPI(mux, db, dir)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	client := srv.Client()
	base := srv.URL

	var project map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "lead-in fanout project",
		"tube_spec_id": tubeSpecID,
	}, &project)
	pid := int64(project["id"].(float64))

	// Open polyline with a 12 mm first leg + 90° corner. The 12 mm
	// lead-in passes the diameter-derived default (10 mm) but fails
	// the post-PATCH 20 mm override. Two versions so the fan-out has
	// more than one row to refresh.
	doc := designdoc.Doc{
		Version:   1,
		ViewBoxMM: [4]float64{0, 0, 100, 100},
		Runs: []designdoc.Run{{
			ID: "lead-in-fanout",
			Polyline: designdoc.Polyline{
				Points: [][2]float64{{0, 0}, {12, 0}, {12, 40}},
				Closed: false,
			},
			Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
		}},
	}
	for v := 0; v < 2; v++ {
		var version map[string]any
		postJSON(t, client, base+"/api/projects/"+itoa(pid)+"/design_versions",
			map[string]any{
				"label":      fmt.Sprintf("v%d", v+1),
				"design_doc": doc,
			}, &version)
		// Sanity: baseline run is clean — no min_lead_in issue at the
		// 10 mm diameter-derived default.
		report, _ := version["validation_report_json"].(string)
		var parsed map[string]any
		if err := json.Unmarshal([]byte(report), &parsed); err != nil {
			t.Fatalf("decode baseline report: %v", err)
		}
		issues, _ := parsed["issues"].([]any)
		for _, raw := range issues {
			iss, _ := raw.(map[string]any)
			if iss["rule"] == "min_lead_in" {
				t.Fatalf("baseline already flags min_lead_in; fixture is wrong")
			}
		}
	}
	waitForClockTick()

	// PATCH lead-in to 20 mm: now the 12 mm leg fails. Fan-out should
	// re-run validation across both versions and the response must
	// report version_count > 0.
	status, body := patchTubeSpecRaw(t, client, base, tubeSpecID,
		`{"min_lead_in_mm":20}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}
	var out struct {
		TubeSpec    storage.TubeSpec   `json:"tube_spec"`
		Revalidated revalidatedSummary `json:"revalidated"`
	}
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("decode PATCH response: %v", err)
	}
	if out.Revalidated.VersionCount == 0 {
		t.Errorf("fan-out skipped: version_count = 0; want > 0 (%+v)", out.Revalidated)
	}
	if out.TubeSpec.MinLeadInMM == nil || *out.TubeSpec.MinLeadInMM != 20.0 {
		t.Errorf("response min_lead_in_mm = %v, want 20.0", out.TubeSpec.MinLeadInMM)
	}

	// Now read back the stored report on at least one version and
	// confirm it flags the previously-clean run.
	var versions []map[string]any
	getJSON(t, client, base+"/api/projects/"+itoa(pid)+"/design_versions", &versions)
	if len(versions) == 0 {
		t.Fatal("no design versions returned")
	}
	var flagged int
	for _, v := range versions {
		report, _ := v["validation_report_json"].(string)
		if report == "" {
			continue
		}
		var parsed map[string]any
		if err := json.Unmarshal([]byte(report), &parsed); err != nil {
			t.Fatalf("unmarshal post-fanout report: %v", err)
		}
		issues, _ := parsed["issues"].([]any)
		for _, raw := range issues {
			iss, _ := raw.(map[string]any)
			if iss["rule"] == "min_lead_in" {
				flagged++
				break
			}
		}
	}
	if flagged == 0 {
		t.Errorf("expected >=1 version's report to flag min_lead_in after fan-out; got 0")
	}
}

// newTubeSpecCRUDServer is the boilerplate-killer for the Tier 3 #51
// CRUD tests: open a temp DB, run migrations, register the API, and
// return the http.Server URL plus a teardown-registered client. Mirrors
// the pattern the existing fan-out tests use without forcing a
// helpers.go split.
func newTubeSpecCRUDServer(t *testing.T) (*sql.DB, string, *http.Client) {
	t.Helper()
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
	return db, srv.URL, srv.Client()
}

// TestCreateTubeSpec exercises the happy path of POST /api/tube_specs.
// Tier 3 #51: shops with custom diameters / unusual glass shouldn't
// have to hand-write SQL or fork the binary to add a spec.
func TestCreateTubeSpec(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	body := map[string]any{
		"name":                  "9mm test",
		"diameter_mm":           9.0,
		"min_bend_radius_mm":    20.0,
		"max_segment_length_mm": 2500.0,
		"min_spacing_mm":        11.0,
	}
	buf, _ := json.Marshal(body)
	resp, err := client.Post(base+"/api/tube_specs", "application/json", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusCreated {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST status %d: %s", resp.StatusCode, out)
	}
	var created storage.TubeSpec
	if err := json.NewDecoder(resp.Body).Decode(&created); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if created.ID == 0 {
		t.Errorf("expected server-assigned id, got 0")
	}
	if created.Name != "9mm test" {
		t.Errorf("name: got %q want %q", created.Name, "9mm test")
	}
	if created.DiameterMM != 9.0 {
		t.Errorf("diameter: got %g want 9", created.DiameterMM)
	}

	// The list endpoint should now contain it.
	var specs []storage.TubeSpec
	getJSON(t, client, base+"/api/tube_specs", &specs)
	var found bool
	for _, s := range specs {
		if s.ID == created.ID {
			found = true
			break
		}
	}
	if !found {
		t.Errorf("created spec not present in list response")
	}
}

// TestCreateTubeSpecRejectsDuplicateName proves the case-insensitive
// uniqueness gate: "12mm clear" is seeded; "12MM Clear" must collide.
// Without the case-folding pre-flight the SQLite UNIQUE constraint
// would only catch the exact-case match (modernc.org/sqlite default
// collation is BINARY) and two visually-indistinguishable specs would
// land in the dropdown.
func TestCreateTubeSpecRejectsDuplicateName(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	body := map[string]any{
		"name":                  "12MM Clear",
		"diameter_mm":           12.0,
		"min_bend_radius_mm":    27.0,
		"max_segment_length_mm": 2500.0,
		"min_spacing_mm":        14.0,
	}
	buf, _ := json.Marshal(body)
	resp, err := client.Post(base+"/api/tube_specs", "application/json", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST status: got %d, want 409 (%s)", resp.StatusCode, out)
	}
	out, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(out, []byte("12mm clear")) {
		t.Errorf("conflict message should reference the existing seeded name, got %s", out)
	}
}

// TestCreateTubeSpecRejectsBadDiameter pins the dimensional bounds:
// a 0.5 mm tube isn't a real product (capillary at best) and would
// blow through every downstream sanity check; reject at the door.
func TestCreateTubeSpecRejectsBadDiameter(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	body := map[string]any{
		"name":                  "tiny",
		"diameter_mm":           0.5,
		"min_bend_radius_mm":    20.0,
		"max_segment_length_mm": 2500.0,
		"min_spacing_mm":        11.0,
	}
	buf, _ := json.Marshal(body)
	resp, err := client.Post(base+"/api/tube_specs", "application/json", bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("POST status: got %d, want 400 (%s)", resp.StatusCode, out)
	}
}

// TestDeleteTubeSpecUnused is the happy path: a freshly-created spec
// with no project references can be deleted; subsequent GET returns
// 404.
func TestDeleteTubeSpecUnused(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	// Create a fresh spec so we don't have to worry about the seeded
	// rows being referenced by anything implicit.
	var created storage.TubeSpec
	postJSON(t, client, base+"/api/tube_specs", map[string]any{
		"name":                  "delete-me",
		"diameter_mm":           14.0,
		"min_bend_radius_mm":    30.0,
		"max_segment_length_mm": 3000.0,
		"min_spacing_mm":        16.0,
	}, &created)

	req, err := http.NewRequest("DELETE", base+"/api/tube_specs/"+itoa(created.ID), nil)
	if err != nil {
		t.Fatalf("build DELETE: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("DELETE status: got %d, want 204 (%s)", resp.StatusCode, out)
	}

	// The list endpoint should no longer contain it.
	var specs []storage.TubeSpec
	getJSON(t, client, base+"/api/tube_specs", &specs)
	for _, s := range specs {
		if s.ID == created.ID {
			t.Errorf("deleted spec still present in list")
		}
	}
}

// TestDeleteTubeSpecReferencedReturns409 is the safety guard: if any
// project still references the spec, the delete must refuse with 409
// and the response body must list the project names so the UI can
// tell the user which ones to migrate first.
func TestDeleteTubeSpecReferencedReturns409(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	// Use a seeded spec so the project's tube_spec_id resolves.
	var specs []storage.TubeSpec
	getJSON(t, client, base+"/api/tube_specs", &specs)
	var seededID int64
	var seededName string
	for _, s := range specs {
		if s.Name == "12mm clear" {
			seededID = s.ID
			seededName = s.Name
		}
	}
	if seededID == 0 {
		t.Fatal("expected seeded 12mm clear spec")
	}

	var p map[string]any
	postJSON(t, client, base+"/api/projects", map[string]any{
		"name":         "anchored-to-spec",
		"tube_spec_id": seededID,
	}, &p)

	req, err := http.NewRequest("DELETE", base+"/api/tube_specs/"+itoa(seededID), nil)
	if err != nil {
		t.Fatalf("build DELETE: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusConflict {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("DELETE status: got %d, want 409 (%s)", resp.StatusCode, out)
	}
	out, _ := io.ReadAll(resp.Body)
	if !bytes.Contains(out, []byte("anchored-to-spec")) {
		t.Errorf("conflict body should mention the referencing project name, got %s", out)
	}
	var conflict map[string]any
	if err := json.Unmarshal(out, &conflict); err != nil {
		t.Fatalf("unmarshal conflict: %v", err)
	}
	if pc, _ := conflict["project_count"].(float64); int(pc) != 1 {
		t.Errorf("project_count: got %v, want 1", conflict["project_count"])
	}

	// And the spec must still be in the list — refusal didn't half-delete.
	var post []storage.TubeSpec
	getJSON(t, client, base+"/api/tube_specs", &post)
	var found bool
	for _, s := range post {
		if s.ID == seededID && s.Name == seededName {
			found = true
		}
	}
	if !found {
		t.Errorf("seeded %q vanished after refused DELETE", seededName)
	}
}

// TestTubeSpecCRUDRoundTrip exercises every verb in sequence: create →
// patch → delete → re-create with the same name. The re-create only
// works if the prior delete actually removed the row (otherwise the
// uniqueness gate fires). Catches the "delete reports 204 but row
// stays" failure mode in a way the unit-level test can't.
func TestTubeSpecCRUDRoundTrip(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	// Create.
	var created storage.TubeSpec
	postJSON(t, client, base+"/api/tube_specs", map[string]any{
		"name":                  "round-trip",
		"diameter_mm":           10.0,
		"min_bend_radius_mm":    22.0,
		"max_segment_length_mm": 2500.0,
		"min_spacing_mm":        12.0,
	}, &created)
	if created.ID == 0 {
		t.Fatal("create returned zero id")
	}

	// Patch via existing PATCH plumbing — proves the storage extraction
	// didn't break the previously-inlined UPDATE path.
	status, body := patchTubeSpecRaw(t, client, base, created.ID,
		`{"max_segment_length_mm": 3000}`)
	if status/100 != 2 {
		t.Fatalf("PATCH status %d: %s", status, body)
	}

	// Delete.
	req, err := http.NewRequest("DELETE", base+"/api/tube_specs/"+itoa(created.ID), nil)
	if err != nil {
		t.Fatalf("build DELETE: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("DELETE status: got %d, want 204", resp.StatusCode)
	}

	// Re-create with the same name. If the prior delete left the row
	// in place this would 409.
	var recreated storage.TubeSpec
	postJSON(t, client, base+"/api/tube_specs", map[string]any{
		"name":                  "round-trip",
		"diameter_mm":           10.0,
		"min_bend_radius_mm":    22.0,
		"max_segment_length_mm": 2500.0,
		"min_spacing_mm":        12.0,
	}, &recreated)
	if recreated.ID == 0 {
		t.Errorf("re-create after delete returned zero id")
	}
	if recreated.ID == created.ID {
		t.Errorf("re-created spec reused the deleted id (%d) — autoincrement should advance",
			created.ID)
	}
}

// TestDeleteTubeSpec404 covers the not-found path: deleting a non-
// existent id should surface as 404, not as a misleading 204.
func TestDeleteTubeSpec404(t *testing.T) {
	_, base, client := newTubeSpecCRUDServer(t)

	req, err := http.NewRequest("DELETE", base+"/api/tube_specs/9999", nil)
	if err != nil {
		t.Fatalf("build DELETE: %v", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("DELETE: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		out, _ := io.ReadAll(resp.Body)
		t.Fatalf("DELETE status: got %d, want 404 (%s)", resp.StatusCode, out)
	}
}
