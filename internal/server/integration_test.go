package server

import (
	"bytes"
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

// keep imports honest
var _ = strings.NewReader
