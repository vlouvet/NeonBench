package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
)

// These live here rather than in integration_test.go deliberately: per
// AGENTS.md that file is the repo's most frequent merge conflict, because two
// agents appending test functions to it collide every time.

type estFixture struct {
	base      string
	client    *http.Client
	projectID int64
	versionID int64
	cardID    int64
}

func newEstFixture(t *testing.T) estFixture {
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

	f := estFixture{base: srv.URL, client: srv.Client()}

	var specs []map[string]any
	getJSON(t, f.client, f.base+"/api/tube_specs", &specs)
	var spec12 float64
	for _, s := range specs {
		if s["diameter_mm"].(float64) == 12 {
			spec12 = s["id"].(float64)
		}
	}
	if spec12 == 0 {
		spec12 = specs[0]["id"].(float64)
	}

	var project map[string]any
	postJSON(t, f.client, f.base+"/api/projects", map[string]any{
		"name": "estimate fixture", "tube_spec_id": int64(spec12),
		"customer": "Monolith Brewing", "job_number": "J-001",
	}, &project)
	f.projectID = int64(project["id"].(float64))

	// A two-colour design: one purple run, one green run, each with a pair
	// of electrodes, plus a blockout — enough to exercise grouping.
	doc := designdoc.Doc{
		Version:   designdoc.SchemaVersion,
		ViewBoxMM: [4]float64{0, 0, 914.4, 609.6},
		Runs: []designdoc.Run{
			{
				ID: "a", Color: "purple", TubeDiameterMM: 12,
				Polyline:   designdoc.Polyline{Points: [][2]float64{{0, 0}, {600, 0}, {1200, 0}}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 2}},
				Blockouts:  []designdoc.Blockout{{StartLiveIndex: 0, EndLiveIndex: 1}},
			},
			{
				ID: "b", Color: "green", TubeDiameterMM: 12,
				Polyline:   designdoc.Polyline{Points: [][2]float64{{0, 100}, {800, 100}}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
			},
		},
	}
	var version map[string]any
	postJSON(t, f.client, f.base+"/api/projects/"+itoa(f.projectID)+"/design_versions",
		map[string]any{"design_doc": doc, "label": "proof"}, &version)
	f.versionID = int64(version["id"].(float64))

	var cards []map[string]any
	getJSON(t, f.client, f.base+"/api/rate_cards", &cards)
	if len(cards) == 0 {
		t.Fatal("no seeded rate card")
	}
	f.cardID = int64(cards[0]["id"].(float64))
	return f
}

func (f estFixture) versionURL(suffix string) string {
	return f.base + "/api/projects/" + itoa(f.projectID) +
		"/design_versions/" + itoa(f.versionID) + suffix
}

func doReq(t *testing.T, c *http.Client, method, url string, body any) (int, []byte) {
	t.Helper()
	var rdr io.Reader
	if body != nil {
		buf, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		rdr = bytes.NewReader(buf)
	}
	req, err := http.NewRequest(method, url, rdr)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, out
}

// The takeoff endpoint must work with no rates configured at all — "how much
// glass do I order" is the question a shop asks before it has a rate card.
func TestTakeoffNeedsNoRates(t *testing.T) {
	f := newEstFixture(t)
	var got struct {
		Summary struct {
			NetTubeFt      float64 `json:"net_tube_ft"`
			GrossGlassFt   float64 `json:"gross_glass_ft"`
			ElectrodePairs int     `json:"electrode_pairs"`
			StickCount     int     `json:"stick_count"`
			BlockoutFt     float64 `json:"blockout_ft"`
		} `json:"summary"`
		Lines []map[string]any `json:"lines"`
	}
	getJSON(t, f.client, f.versionURL("/takeoff"), &got)

	if got.Summary.NetTubeFt <= 0 {
		t.Errorf("net tube = %v, want > 0", got.Summary.NetTubeFt)
	}
	if got.Summary.GrossGlassFt < got.Summary.NetTubeFt {
		t.Errorf("gross %v < net %v", got.Summary.GrossGlassFt, got.Summary.NetTubeFt)
	}
	if got.Summary.ElectrodePairs != 2 {
		t.Errorf("electrode pairs = %d, want 2", got.Summary.ElectrodePairs)
	}
	if got.Summary.BlockoutFt <= 0 {
		t.Error("blockout length not reported")
	}
	// Two colours must reach the wire as two separate tube lines.
	var tubes int
	for _, l := range got.Lines {
		if l["kind"] == "tube" {
			tubes++
		}
	}
	if tubes != 2 {
		t.Errorf("tube lines = %d, want 2 (one per colour)", tubes)
	}
}

// With the seeded card every material rate is NULL, so the estimate must come
// back provisional rather than confidently cheap.
func TestEstimateWithSeededCardIsProvisional(t *testing.T) {
	f := newEstFixture(t)
	var got struct {
		Estimate struct {
			MaterialCost  float64  `json:"material_cost"`
			LabourCost    float64  `json:"labour_cost"`
			Price         float64  `json:"price"`
			UnpricedCount int      `json:"unpriced_count"`
			IsProvisional bool     `json:"is_provisional"`
			UnpricedKinds []string `json:"unpriced_kinds"`
			RateCardID    int64    `json:"rate_card_id"`
		} `json:"estimate"`
	}
	getJSON(t, f.client, f.versionURL("/estimate"), &got)

	if !got.Estimate.IsProvisional || got.Estimate.UnpricedCount == 0 {
		t.Fatalf("seeded card should price nothing: %+v", got.Estimate)
	}
	if got.Estimate.MaterialCost != 0 {
		t.Errorf("material cost = %v with no rates set", got.Estimate.MaterialCost)
	}
	// Labour still prices: the card carries an hourly rate even when no
	// material does.
	if got.Estimate.LabourCost <= 0 {
		t.Errorf("labour cost = %v, want > 0", got.Estimate.LabourCost)
	}
	if got.Estimate.RateCardID != f.cardID {
		t.Errorf("rate card id = %d, want %d", got.Estimate.RateCardID, f.cardID)
	}
}

// Setting one rate must move the total, and clearing it must move it back.
func TestRateEditRoundTripChangesEstimate(t *testing.T) {
	f := newEstFixture(t)
	var card struct {
		Items []struct {
			ID   int64  `json:"id"`
			Kind string `json:"kind"`
		} `json:"items"`
	}
	getJSON(t, f.client, f.base+"/api/rate_cards/"+itoa(f.cardID), &card)
	var tubeItem int64
	for _, it := range card.Items {
		if it.Kind == "tube" {
			tubeItem = it.ID
		}
	}
	if tubeItem == 0 {
		t.Fatal("no seeded tube rate")
	}
	itemURL := f.base + "/api/rate_cards/" + itoa(f.cardID) + "/items/" + itoa(tubeItem)

	readMaterial := func() float64 {
		var got struct {
			Estimate struct {
				MaterialCost float64 `json:"material_cost"`
			} `json:"estimate"`
		}
		getJSON(t, f.client, f.versionURL("/estimate"), &got)
		return got.Estimate.MaterialCost
	}

	if code, body := doReq(t, f.client, http.MethodPatch, itemURL,
		map[string]any{"unit_cost": 0.5962, "min_qty": 5}); code != http.StatusOK {
		t.Fatalf("patch rate: %d %s", code, body)
	}
	priced := readMaterial()
	if priced <= 0 {
		t.Fatalf("material cost still %v after setting a rate", priced)
	}

	// Explicit null clears it. Without this a wrong price could never be
	// removed, only overwritten.
	if code, body := doReq(t, f.client, http.MethodPatch, itemURL,
		map[string]any{"unit_cost": nil}); code != http.StatusOK {
		t.Fatalf("clear rate: %d %s", code, body)
	}
	if got := readMaterial(); got != 0 {
		t.Errorf("material cost = %v after clearing the rate, want 0", got)
	}
}

// A deliberate zero is a price and must not be reported unpriced.
func TestZeroRateIsPricedOverTheWire(t *testing.T) {
	f := newEstFixture(t)
	var card struct {
		Items []struct {
			ID   int64  `json:"id"`
			Kind string `json:"kind"`
		} `json:"items"`
	}
	getJSON(t, f.client, f.base+"/api/rate_cards/"+itoa(f.cardID), &card)
	for _, it := range card.Items {
		url := f.base + "/api/rate_cards/" + itoa(f.cardID) + "/items/" + itoa(it.ID)
		if code, body := doReq(t, f.client, http.MethodPatch, url,
			map[string]any{"unit_cost": 0}); code != http.StatusOK {
			t.Fatalf("patch %s: %d %s", it.Kind, code, body)
		}
	}
	var got struct {
		Estimate struct {
			IsProvisional bool `json:"is_provisional"`
			UnpricedCount int  `json:"unpriced_count"`
		} `json:"estimate"`
	}
	getJSON(t, f.client, f.versionURL("/estimate"), &got)
	if got.Estimate.IsProvisional || got.Estimate.UnpricedCount != 0 {
		t.Errorf("all-zero rates reported provisional: %+v", got.Estimate)
	}
}

func TestEstimateInputsRoundTripAndValidate(t *testing.T) {
	f := newEstFixture(t)
	url := f.versionURL("/estimate_inputs")

	code, body := doReq(t, f.client, http.MethodPut, url, map[string]any{
		"transformer_count": 1, "transformer_qualifier": "12kv-30ma", "install_hours": 4,
	})
	if code != http.StatusOK {
		t.Fatalf("put inputs: %d %s", code, body)
	}
	// The saved inputs must reach the next estimate.
	var got struct {
		Takeoff struct {
			Lines []map[string]any `json:"lines"`
		} `json:"takeoff"`
	}
	getJSON(t, f.client, f.versionURL("/estimate"), &got)
	var sawTransformer, sawInstall bool
	for _, l := range got.Takeoff.Lines {
		switch l["kind"] {
		case "transformer":
			sawTransformer = true
			if l["qualifier"] != "12kv-30ma" {
				t.Errorf("transformer qualifier = %v", l["qualifier"])
			}
		case "labour_install":
			sawInstall = true
		}
	}
	if !sawTransformer || !sawInstall {
		t.Error("saved inputs did not reach the takeoff")
	}

	// A negative quantity is a typo, and it would subtract from a quote.
	if code, _ := doReq(t, f.client, http.MethodPut, url,
		map[string]any{"install_hours": -3}); code != http.StatusUnprocessableEntity {
		t.Errorf("negative install_hours: status %d, want 422", code)
	}
	// An unknown field is rejected rather than silently dropped.
	if code, _ := doReq(t, f.client, http.MethodPut, url,
		map[string]any{"instal_hours": 3}); code != http.StatusBadRequest {
		t.Errorf("typo'd field: status %d, want 400", code)
	}
}

func TestRateCardPatchValidation(t *testing.T) {
	f := newEstFixture(t)
	url := f.base + "/api/rate_cards/" + itoa(f.cardID)
	for _, tc := range []struct {
		name string
		body map[string]any
		want int
	}{
		{"markup zero inverts the price", map[string]any{"markup_multiplier": 0}, http.StatusUnprocessableEntity},
		{"waste exceeds stick", map[string]any{"stick_length_mm": 1000, "stick_waste_mm": 1000}, http.StatusUnprocessableEntity},
		{"zero sheet area divides by zero", map[string]any{"sheet_area_sq_ft": 0}, http.StatusUnprocessableEntity},
		{"valid stock geometry", map[string]any{"stick_length_mm": 1168, "stick_waste_mm": 304}, http.StatusOK},
	} {
		if code, body := doReq(t, f.client, http.MethodPatch, url, tc.body); code != tc.want {
			t.Errorf("%s: status %d want %d (%s)", tc.name, code, tc.want, body)
		}
	}
	// The accepted stock change must actually reach the geometry.
	var got struct {
		Summary struct {
			StickCount int `json:"stick_count"`
		} `json:"summary"`
	}
	getJSON(t, f.client, f.versionURL("/takeoff"), &got)
	if got.Summary.StickCount == 0 {
		t.Error("stick count zero after switching stock geometry")
	}
}

func TestEstimatePDFRenders(t *testing.T) {
	f := newEstFixture(t)
	resp, err := f.client.Get(f.versionURL("/estimate.pdf"))
	if err != nil {
		t.Fatalf("get pdf: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("content-type"); ct != "application/pdf" {
		t.Errorf("content-type = %q", ct)
	}
	body, _ := io.ReadAll(resp.Body)
	if !bytes.HasPrefix(body, []byte("%PDF-")) {
		t.Errorf("not a PDF: %q", body[:min(16, len(body))])
	}
	if len(body) < 1000 {
		t.Errorf("PDF suspiciously small: %d bytes", len(body))
	}
}

// A version with no design doc takes off to zero rather than 404ing — the
// route must not look broken on a freshly created project.
func TestEstimateOnEmptyVersion(t *testing.T) {
	f := newEstFixture(t)
	var version map[string]any
	// A blank doc (zero runs) is the legal bootstrap version for the
	// "design from a blank file" workflow.
	postJSON(t, f.client, f.base+"/api/projects/"+itoa(f.projectID)+"/design_versions",
		map[string]any{"design_doc": designdoc.Doc{Version: designdoc.SchemaVersion}}, &version)
	vid := int64(version["id"].(float64))

	url := f.base + "/api/projects/" + itoa(f.projectID) + "/design_versions/" + itoa(vid) + "/estimate"
	code, body := doReq(t, f.client, http.MethodGet, url, nil)
	if code != http.StatusOK {
		t.Fatalf("status %d: %s", code, body)
	}
	var got struct {
		Estimate struct {
			Price float64 `json:"price"`
		} `json:"estimate"`
	}
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Estimate.Price != 0 {
		t.Errorf("price = %v on an empty version", got.Estimate.Price)
	}
}

// A version belonging to another project must not be reachable through this
// project's path.
func TestEstimateRejectsCrossProjectVersion(t *testing.T) {
	f := newEstFixture(t)
	var other map[string]any
	postJSON(t, f.client, f.base+"/api/projects", map[string]any{
		"name": "other", "tube_spec_id": 1,
	}, &other)
	otherID := int64(other["id"].(float64))

	url := f.base + "/api/projects/" + itoa(otherID) + "/design_versions/" + itoa(f.versionID) + "/estimate"
	if code, _ := doReq(t, f.client, http.MethodGet, url, nil); code != http.StatusNotFound {
		t.Errorf("cross-project estimate: status %d, want 404", code)
	}
}
