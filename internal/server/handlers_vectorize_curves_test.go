package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
)

// TestVectorizeCurvesAreAdditiveAndNeverReachTheDoc pins Tier 2 #133 at the
// boundary where it could do real damage.
//
// handleVectorize feeds the vectorizer's SVG into generateDesignDoc, so that
// SVG *becomes the design doc the bender works from*. Emitting the smoothed
// centerline into it would change the bend geometry — the exact opposite of
// this row's contract. The curves therefore travel on their own response
// field and nothing persists them, and this test asserts that by running the
// same trace twice and comparing what got stored:
//
//   - the stored SVGData is byte-identical with and without `curves`
//   - the stored design doc JSON is byte-identical, and carries no cubic
//   - `curves_svg` is absent by default and all-cubic when asked for
func TestVectorizeCurvesAreAdditiveAndNeverReachTheDoc(t *testing.T) {
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
		"name":         "curve centerlines",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	projectID := int64(project["id"].(float64))

	raw, err := ringRasterPNG(400, 240, 40, 20)
	if err != nil {
		t.Fatalf("render raster: %v", err)
	}
	asset := uploadAsset(t, client, base, projectID, "ring.png", "image/png", raw)
	assetID := int64(asset["id"].(float64))

	trace := func(curves bool) vectorizeResp {
		t.Helper()
		body := map[string]any{
			"asset_id":        assetID,
			"target_width_mm": 660.0,
		}
		if curves {
			body["curves"] = true
		}
		var resp vectorizeResp
		postJSON(t, client, base+"/api/projects/"+itoa(projectID)+"/vectorize", body, &resp)
		return resp
	}

	plain := trace(false)
	curved := trace(true)

	// 1. The default response is what it always was: no curves_svg at all.
	if plain.CurvesSVG != "" {
		t.Error("a request that did not ask for curves got curves_svg back")
	}
	// Assert on the wire form too — omitempty is what keeps existing clients
	// byte-identical, and a struct-field check would not notice it going away.
	if wire, err := json.Marshal(plain); err != nil {
		t.Fatalf("marshal: %v", err)
	} else if strings.Contains(string(wire), "curves_svg") {
		t.Errorf("default response JSON carries a curves_svg key: %s", wire)
	}

	// 2. The stored fabrication geometry is untouched by asking for a picture.
	if plain.SVGData != curved.SVGData {
		t.Error("asking for curves changed the design version's stored SVG — " +
			"that SVG is what generateDesignDoc turns into the bend geometry")
	}
	if strings.Contains(plain.SVGData, "C") {
		t.Error("the stored fabrication SVG contains a cubic")
	}
	if plain.DesignDocJSON == nil || curved.DesignDocJSON == nil {
		t.Fatal("vectorize returned no design_doc_json")
	}
	if *plain.DesignDocJSON != *curved.DesignDocJSON {
		t.Error("asking for curves changed the stored design doc")
	}

	// 3. Nothing curve-shaped is in the doc: no cubic control points leaked in
	//    under a new key, and no segment became an arc.
	for _, needle := range []string{"curve", "cubic", "bezier", "c1", "c2"} {
		if strings.Contains(strings.ToLower(*curved.DesignDocJSON), `"`+needle) {
			t.Errorf("design doc JSON carries a %q key — no curve may enter a Doc", needle)
		}
	}
	var doc designdoc.Doc
	if err := json.Unmarshal([]byte(*curved.DesignDocJSON), &doc); err != nil {
		t.Fatalf("parse design doc: %v", err)
	}
	if len(doc.Runs) == 0 {
		t.Fatal("design doc has no runs")
	}
	for _, run := range doc.Runs {
		for i, st := range run.Polyline.SegmentTypes {
			if st != "" && st != "line" {
				t.Errorf("run %s segment %d is %q — this row is not an arc feature", run.ID, i, st)
			}
		}
	}

	// 4. The smoothed output is present, separate, and all cubics. `A` would
	//    be silently mis-validated (internal/validate approximates it as a
	//    straight line), so the picture has to be `C` too.
	if curved.CurvesSVG == "" {
		t.Fatal("curves:true returned no curves_svg")
	}
	nC := strings.Count(curved.CurvesSVG, "C")
	nL := strings.Count(plain.SVGData, "L")
	if nC == 0 || nL == 0 {
		t.Fatalf("expected a non-trivial trace, got %d C commands and %d L commands", nC, nL)
	}
	for _, d := range svgPathData(curved.CurvesSVG) {
		if strings.ContainsAny(d, "LlAa") {
			t.Errorf("curves_svg path data is not all-cubic: %q", d)
		}
	}
	t.Logf("same trace: fabrication SVG %d L commands, curves_svg %d C commands", nL, nC)
}

func svgPathData(svg string) []string {
	var out []string
	rest := svg
	for {
		i := strings.Index(rest, `d="`)
		if i < 0 {
			return out
		}
		rest = rest[i+3:]
		j := strings.Index(rest, `"`)
		if j < 0 {
			return out
		}
		out = append(out, rest[:j])
		rest = rest[j+1:]
	}
}
