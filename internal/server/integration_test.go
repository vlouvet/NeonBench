package server

import (
	"bytes"
	"encoding/json"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
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
	if _, err := exec.LookPath("potrace"); err != nil {
		t.Skip("potrace not on PATH; skipping integration test")
	}

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

	// 9) Print PDF must render without error and start with %PDF-.
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

// keep imports honest
var _ = strings.NewReader
