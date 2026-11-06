package server

import (
	"bytes"
	"encoding/json"
	"errors"
	"flag"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/version"
)

// Tier 3 #140 — a rejected doc says why, and a running build says which
// schema it accepts.

var updateSchemaGolden = flag.Bool("update-schema", false,
	"rewrite testdata/design_doc_schema.golden from the current structs")

const schemaGoldenPath = "testdata/design_doc_schema.golden"

func newSchemaTestServer(t *testing.T) (*http.Client, string, int64) {
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
	client := srv.Client()

	var specs []map[string]any
	getJSON(t, client, srv.URL+"/api/tube_specs", &specs)
	if len(specs) == 0 {
		t.Fatal("expected seeded tube specs, got none")
	}
	var project map[string]any
	postJSON(t, client, srv.URL+"/api/projects", map[string]any{
		"name":         "schema discoverability",
		"tube_spec_id": int64(specs[0]["id"].(float64)),
	}, &project)
	return client, srv.URL, int64(project["id"].(float64))
}

// TestRejectedDocSaysWhy is both stumbles over the wire, on both endpoints
// that take a design doc. Before #140 every row below came back as
// "invalid JSON: …", including the ones whose JSON was perfectly valid.
func TestRejectedDocSaysWhy(t *testing.T) {
	client, base, pid := newSchemaTestServer(t)

	const okRuns = `"runs":[{"id":"r1","polyline":{"points":[[0,0],[10,0]],"closed":false}}]`
	doc := func(extra string) string {
		return `{"design_doc":{"version":1,"view_box_mm":[0,0,100,100],` + okRuns + extra + `}}`
	}
	unknownMsg := func(field string) string {
		return `unknown field "` + field + `": this build (` + version.Current() + `) does not accept it. ` +
			`If your client is newer than this server, the server binary predates the field — upgrade or rebuild it. ` +
			`Otherwise check the key's spelling and which object it sits in. ` +
			`GET /api/schema lists every design-doc field this build accepts`
	}
	const danglingRaceway = `rejected: raceway "rw9": no guideline with that id and kind "raceway" — ` +
		`a raceway box is the hardware for a raceway guideline, it has no identity of its own`

	cases := []struct {
		name   string
		body   string
		exact  string // whole message, when it is ours to pin
		prefix string // otherwise the part we own
	}{
		// Stumble (b): a field this build does not know. Top level of the
		// doc, nested inside a raceway, and in the request envelope.
		{name: "unknown doc field", body: doc(`,"widgets":[]`), exact: unknownMsg("widgets")},
		{
			name:  "unknown nested field",
			body:  doc(`,"guidelines":[{"id":"rw1","kind":"raceway","y_mm":0}],"raceways":[{"id":"rw1","x_mm":0,"length_mm":10,"colour":"red"}]`),
			exact: unknownMsg("colour"),
		},
		{
			name:  "wrong envelope key",
			body:  `{"doc":{"version":1,"view_box_mm":[0,0,100,100],"runs":[]}}`,
			exact: unknownMsg("doc"),
		},
		// Stumble (a): a raceway is not its own id space.
		{
			name:  "raceway naming no guideline",
			body:  doc(`,"raceways":[{"id":"rw9","x_mm":0,"length_mm":10}]`),
			exact: danglingRaceway,
		},
		{
			// Right id, wrong kind: a construction guide cannot carry a box.
			name:  "raceway naming a construction guideline",
			body:  doc(`,"guidelines":[{"id":"rw9","kind":"construction","y_mm":0}],"raceways":[{"id":"rw9","x_mm":0,"length_mm":10}]`),
			exact: danglingRaceway,
		},
		{
			name:   "run naming no circuit",
			body:   `{"design_doc":{"version":1,"view_box_mm":[0,0,100,100],"runs":[{"id":"r1","circuit_id":"c9","polyline":{"points":[[0,0],[10,0]],"closed":false}}]}}`,
			prefix: `rejected: run "r1": circuit_id "c9" names no circuit in doc.circuits`,
		},
		// The cases that really are the client's JSON, so the two above are
		// distinguishable from them.
		{name: "truncated body", body: `{"design_doc":{"version":1,`, exact: "malformed JSON: unexpected EOF"},
		{name: "bad syntax", body: `{"design_doc":{"version":1,}}`, prefix: "malformed JSON: invalid character"},
		{name: "empty body", body: ``, exact: "malformed JSON: empty request body"},
		{name: "wrong value type", body: `{"design_doc":{"version":"1"}}`, prefix: "wrong type: json: cannot unmarshal string"},
	}

	endpoints := map[string]string{
		"save":         base + "/api/projects/" + itoa(pid) + "/design_versions",
		"validate_doc": base + "/api/projects/" + itoa(pid) + "/validate_doc",
	}
	for epName, url := range endpoints {
		for _, tc := range cases {
			t.Run(epName+"/"+tc.name, func(t *testing.T) {
				status, msg := postRaw(t, client, url, tc.body)
				if status != http.StatusBadRequest {
					t.Fatalf("status %d, want 400; error %q", status, msg)
				}
				if strings.HasPrefix(msg, "invalid JSON") {
					t.Errorf("still the pre-#140 catch-all: %q", msg)
				}
				if tc.exact != "" && msg != tc.exact {
					t.Errorf("error\n got: %q\nwant: %q", msg, tc.exact)
				}
				if tc.prefix != "" && !strings.HasPrefix(msg, tc.prefix) {
					t.Errorf("error\n got: %q\nwant prefix: %q", msg, tc.prefix)
				}
			})
		}

		// Negative control: the raceway doc with its guideline present is
		// accepted, so the rejections above are about the rule and not about
		// the endpoint refusing raceways altogether.
		t.Run(epName+"/raceway with its guideline", func(t *testing.T) {
			status, msg := postRaw(t, client, url,
				doc(`,"guidelines":[{"id":"rw9","kind":"raceway","y_mm":0}],"raceways":[{"id":"rw9","x_mm":0,"length_mm":10}]`))
			if status/100 != 2 {
				t.Fatalf("well-formed raceway doc rejected with %d: %q", status, msg)
			}
		})
	}
}

// postRaw POSTs body verbatim and returns the status and, for an error
// response, the "error" string.
func postRaw(t *testing.T, c *http.Client, url, body string) (int, string) {
	t.Helper()
	resp, err := c.Post(url, "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatalf("POST %s: %v", url, err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode/100 == 2 {
		return resp.StatusCode, ""
	}
	var e struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		t.Fatalf("error response is not {\"error\":…}: %s", raw)
	}
	return resp.StatusCode, e.Error
}

func TestSchemaEndpoint(t *testing.T) {
	client, base, _ := newSchemaTestServer(t)
	var got schemaResponse
	getJSON(t, client, base+"/api/schema", &got)

	if got.BuildVersion != version.Current() {
		t.Errorf("build_version = %q, want %q", got.BuildVersion, version.Current())
	}
	if !regexp.MustCompile(`^[0-9a-f]{12}$`).MatchString(got.Fingerprint) {
		t.Errorf("fingerprint = %q, want 12 hex digits", got.Fingerprint)
	}
	if got.DesignDoc.Root != "Doc" {
		t.Errorf("root = %q, want Doc", got.DesignDoc.Root)
	}
	field := func(typ, name string) (schemaField, bool) {
		for _, f := range got.DesignDoc.Types[typ] {
			if f.Name == name {
				return f, true
			}
		}
		return schemaField{}, false
	}
	// The two fields from the stumbles, as a client would look for them.
	for _, want := range []schemaField{
		{Name: "raceways", Type: "Raceway[]", OmitEmpty: true},
		{Name: "circuits", Type: "Circuit[]", OmitEmpty: true},
		{Name: "version", Type: "integer"},
		{Name: "view_box_mm", Type: "number[4]"},
	} {
		if f, ok := field("Doc", want.Name); !ok || f != want {
			t.Errorf("Doc.%s = %+v (present %v), want %+v", want.Name, f, ok, want)
		}
	}
	if f, ok := field("Polyline", "points"); !ok || f.Type != "number[2][]" {
		t.Errorf("Polyline.points = %+v, want type number[2][]", f)
	}
	// A pointer is described as its element.
	if f, ok := field("Run", "channel_letter_depth_mm"); !ok || f.Type != "number" || !f.OmitEmpty {
		t.Errorf("Run.channel_letter_depth_mm = %+v, want omitempty number", f)
	}
	// Negative control: the field the unknown-field test posts is absent.
	for typ, fields := range got.DesignDoc.Types {
		for _, f := range fields {
			if f.Name == "widgets" {
				t.Errorf("%s lists %q, which the server rejects", typ, f.Name)
			}
		}
	}
	idx := slices.IndexFunc(got.Relations, func(r schemaRelation) bool { return r.Field == "raceways[].id" })
	if idx < 0 || !got.Relations[idx].Enforced || !strings.Contains(got.Relations[idx].References, `kind = "raceway"`) {
		t.Errorf("raceways[].id relation missing or wrong: %+v", got.Relations)
	}
}

// TestSchemaFieldsMatchEncodingJSON is the drift guard that matters: it holds
// the endpoint to what encoding/json DOES, not to what the reflector thinks.
// For every listed type, the keys json.Marshal emits for a fully populated
// value must be exactly the listed fields, and the strict decoder must accept
// every one of them.
func TestSchemaFieldsMatchEncodingJSON(t *testing.T) {
	resp, err := designDocSchema()
	if err != nil {
		t.Fatal(err)
	}
	structs := map[string]reflect.Type{}
	collectStructs(reflect.TypeFor[designdoc.Doc](), structs)
	if got, want := sortedKeys(resp.DesignDoc.Types), sortedKeys(structs); !slices.Equal(got, want) {
		t.Fatalf("schema lists types %v, Doc reaches %v", got, want)
	}

	for name, typ := range structs {
		v := reflect.New(typ).Elem()
		fillNonZero(v)
		raw, err := json.Marshal(v.Interface())
		if err != nil {
			t.Fatalf("%s: marshal: %v", name, err)
		}
		var emitted map[string]json.RawMessage
		if err := json.Unmarshal(raw, &emitted); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var listed []string
		for _, f := range resp.DesignDoc.Types[name] {
			listed = append(listed, f.Name)
		}
		sort.Strings(listed)
		if got := sortedKeys(emitted); !slices.Equal(got, listed) {
			t.Errorf("%s: encoding/json emits %v, schema lists %v", name, got, listed)
		}

		for _, key := range listed {
			body, _ := json.Marshal(map[string]json.RawMessage{key: emitted[key]})
			if err := strictDecode(body, typ); isUnknownField(err) {
				t.Errorf("%s: schema lists %q but the strict decoder refuses it: %v", name, key, err)
			}
		}
		// Negative control: the strict decoder really does refuse a key the
		// schema does not list, so the loop above could have failed.
		if err := strictDecode([]byte(`{"__no_such_field__":0}`), typ); !isUnknownField(err) {
			t.Errorf("%s: an unlisted key was not refused as unknown: %v", name, err)
		}
	}
}

func strictDecode(body []byte, typ reflect.Type) error {
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	return classifyDecodeError(dec.Decode(reflect.New(typ).Interface()))
}

func isUnknownField(err error) bool {
	var u *unknownFieldError
	return errors.As(err, &u)
}

// collectStructs is an independent walk (not describeTypes) of every named
// struct reachable from t.
func collectStructs(t reflect.Type, out map[string]reflect.Type) {
	switch t.Kind() {
	case reflect.Pointer, reflect.Slice, reflect.Array:
		collectStructs(t.Elem(), out)
	case reflect.Struct:
		if _, seen := out[t.Name()]; seen {
			return
		}
		out[t.Name()] = t
		for i := range t.NumField() {
			if t.Field(i).IsExported() {
				collectStructs(t.Field(i).Type, out)
			}
		}
	}
}

// fillNonZero sets every exported field to a non-zero value, so omitempty
// cannot hide a key from json.Marshal.
func fillNonZero(v reflect.Value) {
	switch v.Kind() {
	case reflect.String:
		v.SetString("x")
	case reflect.Bool:
		v.SetBool(true)
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		v.SetInt(1)
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		v.SetUint(1)
	case reflect.Float32, reflect.Float64:
		v.SetFloat(1.5)
	case reflect.Pointer:
		v.Set(reflect.New(v.Type().Elem()))
		fillNonZero(v.Elem())
	case reflect.Slice:
		v.Set(reflect.MakeSlice(v.Type(), 1, 1))
		fillNonZero(v.Index(0))
	case reflect.Array:
		for i := range v.Len() {
			fillNonZero(v.Index(i))
		}
	case reflect.Struct:
		for i := range v.NumField() {
			if v.Type().Field(i).IsExported() {
				fillNonZero(v.Field(i))
			}
		}
	}
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// TestDescribeTypesSeesANewField is the negative control for the reflector:
// adding a field changes the listing and the fingerprint, and a field shape
// it cannot describe exactly is refused instead of guessed at.
func TestDescribeTypesSeesANewField(t *testing.T) {
	type Probe struct {
		A string `json:"a"`
	}
	type ProbeGrown struct {
		A string  `json:"a"`
		B float64 `json:"b,omitempty"`
	}
	before, err := describeTypes(reflect.TypeFor[Probe]())
	if err != nil {
		t.Fatal(err)
	}
	after, err := describeTypes(reflect.TypeFor[ProbeGrown]())
	if err != nil {
		t.Fatal(err)
	}
	want := []schemaField{{Name: "a", Type: "string"}, {Name: "b", Type: "number", OmitEmpty: true}}
	if !reflect.DeepEqual(after["ProbeGrown"], want) {
		t.Errorf("grown probe = %+v, want %+v", after["ProbeGrown"], want)
	}
	fpBefore, _ := schemaFingerprint(docSchema{Root: "Probe", Types: map[string][]schemaField{"Probe": before["Probe"]}})
	fpAfter, _ := schemaFingerprint(docSchema{Root: "Probe", Types: map[string][]schemaField{"Probe": after["ProbeGrown"]}})
	if fpBefore == fpAfter {
		t.Error("adding a field did not change the fingerprint")
	}

	type Inner struct {
		X int `json:"x"`
	}
	type Embeds struct {
		Inner
	}
	type HasMap struct {
		M map[string]int `json:"m"`
	}
	type HasBytes struct {
		B []byte `json:"b"`
	}
	type HasRaw struct {
		R json.RawMessage `json:"r"`
	}
	for name, typ := range map[string]reflect.Type{
		"embedded struct":   reflect.TypeFor[Embeds](),
		"map":               reflect.TypeFor[HasMap](),
		"[]byte":            reflect.TypeFor[HasBytes](),
		"custom marshaller": reflect.TypeFor[HasRaw](),
	} {
		if _, err := describeTypes(typ); err == nil {
			t.Errorf("%s: describeTypes accepted a shape it does not model", name)
		}
	}
}

// TestDesignDocSchemaGolden makes every schema change visible in review. It
// fails on ANY change to the design-doc structs until the golden is
// regenerated, which is the moment to check that web/src moved too.
func TestDesignDocSchemaGolden(t *testing.T) {
	resp, err := designDocSchema()
	if err != nil {
		t.Fatalf("describe the design doc: %v", err)
	}
	// One line per field, so a schema change is a one-line diff and two PRs
	// adding fields to different types do not conflict.
	var buf bytes.Buffer
	buf.WriteString("# GET /api/schema design_doc fields — generated by TestDesignDocSchemaGolden, do not edit.\n")
	buf.WriteString("# Regenerate: go test ./internal/server -run TestDesignDocSchemaGolden -update-schema\n")
	for _, typ := range sortedKeys(resp.DesignDoc.Types) {
		for _, f := range resp.DesignDoc.Types[typ] {
			line := typ + "." + f.Name + " " + f.Type
			if f.OmitEmpty {
				line += " omitempty"
			}
			buf.WriteString(line + "\n")
		}
	}
	got := buf.Bytes()
	if *updateSchemaGolden {
		if err := os.MkdirAll(filepath.Dir(schemaGoldenPath), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(schemaGoldenPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	want, err := os.ReadFile(schemaGoldenPath)
	if err != nil {
		t.Fatalf("read golden: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Errorf("the design-doc schema changed (GET /api/schema now reports something else).\n"+
			"If that is intended: make sure web/src moved with it (DisallowUnknownFields makes every save 400 otherwise),\n"+
			"then regenerate with\n\n    go test ./internal/server -run TestDesignDocSchemaGolden -update-schema\n\n"+
			"got:\n%s", got)
	}
}

// TestSchemaRelationsMatchTheDecoder keeps the one hand-maintained list
// honest: every listed relation has a case, an enforced one is rejected by
// the decoder (and the error names the bad id), an unenforced one is
// accepted, and in every case the same doc with the reference satisfied
// decodes.
func TestSchemaRelationsMatchTheDecoder(t *testing.T) {
	const run = `{"id":"r1","polyline":{"points":[[0,0],[10,0]],"closed":false}%s}`
	doc := func(runExtra, docExtra string) string {
		return `{"version":1,"view_box_mm":[0,0,100,100],"runs":[` +
			strings.Replace(run, "%s", runExtra, 1) + `]` + docExtra + `}`
	}
	cases := map[string]struct{ broken, fixed, badID string }{
		"raceways[].id": {
			broken: doc("", `,"raceways":[{"id":"rw9","x_mm":0,"length_mm":10}]`),
			fixed:  doc("", `,"guidelines":[{"id":"rw9","kind":"raceway","y_mm":0}],"raceways":[{"id":"rw9","x_mm":0,"length_mm":10}]`),
			badID:  "rw9",
		},
		"runs[].circuit_id": {
			broken: doc(`,"circuit_id":"c9"`, ""),
			fixed:  doc(`,"circuit_id":"c9"`, `,"circuits":[{"id":"c9"}]`),
			badID:  "c9",
		},
		"runs[].raceway_id": {
			broken: doc(`,"raceway_id":"rw9"`, ""),
			fixed:  doc(`,"raceway_id":"rw9"`, `,"guidelines":[{"id":"rw9","kind":"raceway","y_mm":0}]`),
		},
		"runs[].group_id": {
			broken: doc(`,"group_id":"g9"`, ""),
			fixed:  doc(`,"group_id":"g9"`, `,"groups":[{"id":"g9","name":"G"}]`),
		},
	}
	for _, rel := range designDocRelations {
		tc, ok := cases[rel.Field]
		if !ok {
			t.Errorf("relation %q has no case here — add one proving the decoder does what the endpoint says", rel.Field)
			continue
		}
		var d designdoc.Doc
		err := json.Unmarshal([]byte(tc.broken), &d)
		switch {
		case rel.Enforced && err == nil:
			t.Errorf("%s: listed as enforced, but a doc breaking it decodes", rel.Field)
		case rel.Enforced && !strings.Contains(err.Error(), `"`+tc.badID+`"`):
			t.Errorf("%s: rejection %q does not name the bad id %q", rel.Field, err, tc.badID)
		case !rel.Enforced && err != nil:
			t.Errorf("%s: listed as unenforced, but the decoder rejects it: %v", rel.Field, err)
		}
		if err := json.Unmarshal([]byte(tc.fixed), &d); err != nil {
			t.Errorf("%s: the satisfied doc does not decode either, so the case proves nothing: %v", rel.Field, err)
		}
	}
	for field := range cases {
		if !slices.ContainsFunc(designDocRelations, func(r schemaRelation) bool { return r.Field == field }) {
			t.Errorf("case %q has no relation in designDocRelations", field)
		}
	}
}
