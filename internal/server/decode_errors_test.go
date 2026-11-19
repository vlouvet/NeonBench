package server

import (
	"encoding/json"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vlouvet/neonbench/internal/version"
)

// Tier 3 #185 — every endpoint that decodes a JSON body says WHY it rejected
// one. #140 taught the two design-doc handlers to tell malformed JSON, an
// unknown field and a wrong type apart; the nine below still answered all of
// them with "invalid JSON: …" (six sites) or "invalid body: …" (the three
// estimate/rate-card sites), so a perfectly well-formed PATCH carrying a key
// this build does not know was reported as broken JSON.

// sendRaw sends body verbatim with the given method and returns the status
// and, for an error response, the "error" string.
func sendRaw(t *testing.T, c *http.Client, method, url, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set("content-type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	defer resp.Body.Close()
	var e struct {
		Error string `json:"error"`
	}
	if resp.StatusCode/100 != 2 {
		raw, err := io.ReadAll(resp.Body)
		if err != nil {
			t.Fatalf("read body: %v", err)
		}
		if err := json.Unmarshal(raw, &e); err != nil {
			t.Fatalf("error response is not {\"error\":…}: %s", raw)
		}
	}
	return resp.StatusCode, e.Error
}

func TestEveryEndpointSaysWhyItRejectedTheBody(t *testing.T) {
	client, base, pid := newSchemaTestServer(t)

	var specs []map[string]any
	getJSON(t, client, base+"/api/tube_specs", &specs)
	specID := int64(specs[0]["id"].(float64))

	var dv map[string]any
	postJSON(t, client, base+"/api/projects/"+itoa(pid)+"/design_versions", map[string]any{
		"design_doc": map[string]any{
			"version":     1,
			"view_box_mm": []float64{0, 0, 100, 100},
			"runs": []any{map[string]any{
				"id":       "r1",
				"polyline": map[string]any{"points": [][2]float64{{0, 0}, {10, 0}}, "closed": false},
			}},
		},
	}, &dv)
	vid := int64(dv["id"].(float64))

	var cards []map[string]any
	getJSON(t, client, base+"/api/rate_cards", &cards)
	if len(cards) == 0 {
		t.Fatal("no seeded rate card")
	}
	cardID := int64(cards[0]["id"].(float64))
	var card struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	getJSON(t, client, base+"/api/rate_cards/"+itoa(cardID), &card)
	if len(card.Items) == 0 {
		t.Fatal("seeded rate card has no items")
	}
	itemID := card.Items[0].ID

	project := base + "/api/projects/" + itoa(pid)
	version_ := project + "/design_versions/" + itoa(vid)
	// wrongType names a field the endpoint really declares, given a value of
	// the wrong JSON type, so it is distinguishable from the unknown case.
	endpoints := []struct {
		name, method, url, wrongType string
	}{
		{"create project", http.MethodPost, base + "/api/projects", `{"name":1}`},
		{"update project", http.MethodPatch, project, `{"name":1}`},
		{"create tube spec", http.MethodPost, base + "/api/tube_specs", `{"name":1}`},
		{"update tube spec", http.MethodPatch, base + "/api/tube_specs/" + itoa(specID), `{"name":1}`},
		{"vectorize", http.MethodPost, project + "/vectorize", `{"asset_id":"one"}`},
		{"rename design version", http.MethodPatch, version_, `{"label":1}`},
		{"estimate inputs", http.MethodPut, version_ + "/estimate_inputs", `{"transformer_count":"two"}`},
		{"patch rate card", http.MethodPatch, base + "/api/rate_cards/" + itoa(cardID), `{"name":1}`},
		{"patch rate card item", http.MethodPatch,
			base + "/api/rate_cards/" + itoa(cardID) + "/items/" + itoa(itemID), `{"label":1}`},
	}

	unknownMsg := `unknown field "no_such_field": this build (` + version.Current() + `) does not accept it. ` +
		`If your client is newer than this server, the server binary predates the field — upgrade or rebuild it. ` +
		`Otherwise check the key's spelling and which object it sits in. ` +
		`GET /api/schema lists every design-doc field this build accepts`

	for _, ep := range endpoints {
		cases := []struct {
			name, body, exact, prefix string
		}{
			{name: "unknown field", body: `{"no_such_field":1}`, exact: unknownMsg},
			{name: "truncated body", body: `{"name":`, exact: "malformed JSON: unexpected EOF"},
			{name: "bad syntax", body: `{"name":1,}`, prefix: "malformed JSON: invalid character"},
			{name: "empty body", body: ``, exact: "malformed JSON: empty request body"},
			{name: "wrong value type", body: ep.wrongType, prefix: "wrong type: json: cannot unmarshal"},
		}
		for _, tc := range cases {
			t.Run(ep.name+"/"+tc.name, func(t *testing.T) {
				status, msg := sendRaw(t, client, ep.method, ep.url, tc.body)
				if status != http.StatusBadRequest {
					t.Fatalf("status %d, want 400; error %q", status, msg)
				}
				if strings.HasPrefix(msg, "invalid JSON") || strings.HasPrefix(msg, "invalid body") {
					t.Errorf("still the pre-#185 catch-all: %q", msg)
				}
				if tc.exact != "" && msg != tc.exact {
					t.Errorf("error\n got: %q\nwant: %q", msg, tc.exact)
				}
				if tc.prefix != "" && !strings.HasPrefix(msg, tc.prefix) {
					t.Errorf("error\n got: %q\nwant prefix: %q", msg, tc.prefix)
				}
			})
		}
	}
}

// TestEveryDecodeJSONCallerUsesWriteDecodeError keeps #185 from regrowing: a
// new handler that copies an old `"invalid JSON: "+err.Error()` line fails
// here even though its own tests, if any, would pass.
//
// It walks every non-test file in this package for `if err := decodeJSON(…);
// err != nil { … }` and requires the branch's first statement to be a call to
// writeDecodeError. Every decodeJSON call must sit in that shape, so one
// written any other way is reported rather than skipped.
func TestEveryDecodeJSONCallerUsesWriteDecodeError(t *testing.T) {
	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	var calls, checked int
	for _, path := range files {
		if strings.HasSuffix(path, "_test.go") {
			continue
		}
		src, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		f, err := parser.ParseFile(fset, path, src, 0)
		if err != nil {
			t.Fatal(err)
		}
		ast.Inspect(f, func(n ast.Node) bool {
			if c, ok := n.(*ast.CallExpr); ok && isIdentCall(c, "decodeJSON") {
				calls++
			}
			ifs, ok := n.(*ast.IfStmt)
			if !ok {
				return true
			}
			as, ok := ifs.Init.(*ast.AssignStmt)
			if !ok || len(as.Rhs) != 1 {
				return true
			}
			c, ok := as.Rhs[0].(*ast.CallExpr)
			if !ok || !isIdentCall(c, "decodeJSON") {
				return true
			}
			checked++
			pos := fset.Position(ifs.Pos())
			if len(ifs.Body.List) == 0 {
				t.Errorf("%s: empty error branch after decodeJSON", pos)
				return true
			}
			var first *ast.CallExpr
			if es, ok := ifs.Body.List[0].(*ast.ExprStmt); ok {
				first, _ = es.X.(*ast.CallExpr)
			}
			if first == nil || !isIdentCall(first, "writeDecodeError") {
				t.Errorf("%s: decodeJSON failure is not answered by writeDecodeError", pos)
			}
			return true
		})
	}
	if calls != checked {
		t.Errorf("%d decodeJSON calls, but only %d sit in `if err := decodeJSON(…); err != nil` — "+
			"rewrite the others in that shape so this test can check them", calls, checked)
	}
	// The two design-doc handlers (#140) plus the nine converted in #185.
	// A drop means the walk stopped finding them, not that they went away.
	if checked < 11 {
		t.Errorf("found %d decodeJSON call sites, want at least 11; the AST walk has gone blind", checked)
	}
}

func isIdentCall(c *ast.CallExpr, name string) bool {
	id, ok := c.Fun.(*ast.Ident)
	return ok && id.Name == name
}
