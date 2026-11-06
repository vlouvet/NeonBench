package server

import (
	"crypto/sha256"
	"encoding"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"reflect"
	"strings"
	"sync"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/version"
)

// GET /api/schema — which design-doc schema this build accepts (Tier 3 #140).
//
// WHY A FIELD LIST AND NOT A VERSION INTEGER. designdoc.SchemaVersion already
// exists and has read 1 through every additive schema change since it was
// written — segment_types, guidelines, raceways, circuits and more all landed
// without a bump, because nothing forced one. A version number is exactly the
// hand-maintained artifact the spec warns drifts, and it drifted silently. It
// also answers the wrong question: the caller holding `unknown field
// "circuits"` wants to know whether THIS build knows `circuits`, and only a
// field list says that.
//
// WHY IT CANNOT DRIFT. Nothing below is hand-maintained except Relations. The
// field list is reflected, at startup, from the very structs decodeJSON
// decodes into (designdoc.Doc and everything it reaches), using the same
// struct-tag rules encoding/json uses. Adding a field to a struct adds it here
// with no further edit. Three tests keep that honest:
//
//   - schema_discovery_test.go checks, for every listed type, that the keys
//     encoding/json actually emits for a fully populated value are EXACTLY the
//     listed fields, and that the strict decoder accepts each one — so the
//     list is pinned to the encoder/decoder, not just to the reflector;
//   - a golden file (testdata/design_doc_schema.golden) fails CI on any
//     schema change until it is regenerated, so the change is visible in the
//     PR diff and the TS side gets a reminder to move with it;
//   - every Relation carries a test case proving the decoder enforces it (or,
//     for enforced=false, proving it does not).
//
// Fingerprint is a short hash of the field list. Two builds with the same
// fingerprint accept the same document shape; it is an equality check, not an
// ordering — it cannot say which build is newer, and does not pretend to.

type schemaField struct {
	Name string `json:"name"`
	Type string `json:"type"`
	// OmitEmpty marks a field the server leaves out when it is empty. Every
	// field added after the first release is omitempty (the byte-identical
	// back-compat invariant in CLAUDE.md), so this is also the list of keys a
	// client may leave out.
	OmitEmpty bool `json:"omitempty"`
}

// schemaRelation is a cross-field identity rule: a field whose value must name
// something elsewhere in the doc. These are the rules a field list alone
// cannot express, and the ones Tier 3 #140 stumble (a) was about.
type schemaRelation struct {
	Field      string `json:"field"`
	References string `json:"references"`
	// Enforced: the server rejects a doc that breaks the rule. false means
	// the relationship is real but a dangling value is tolerated.
	Enforced bool   `json:"enforced"`
	Rule     string `json:"rule"`
}

type docSchema struct {
	Root  string                   `json:"root"`
	Types map[string][]schemaField `json:"types"`
}

type schemaResponse struct {
	BuildVersion string           `json:"build_version"`
	Fingerprint  string           `json:"fingerprint"`
	DesignDoc    docSchema        `json:"design_doc"`
	Relations    []schemaRelation `json:"relations"`
}

// designDocRelations is the one hand-maintained part of the endpoint. Each
// entry MUST have a case in TestSchemaRelationsMatchTheDecoder, which fails
// for an entry without one; add a rule to designdoc's UnmarshalJSON and it
// belongs here too.
var designDocRelations = []schemaRelation{
	{
		Field:      "raceways[].id",
		References: `guidelines[].id where kind = "raceway"`,
		Enforced:   true,
		Rule: `A raceway is the box for a raceway guideline and has no id space of its own: its id must equal ` +
			`the id of a guideline whose kind is "raceway", and one guideline carries at most one raceway.`,
	},
	{
		Field:      "runs[].circuit_id",
		References: "circuits[].id",
		Enforced:   true,
		Rule:       "A non-empty circuit_id must name a circuit in circuits. Circuit ids are their own id space, non-empty and unique.",
	},
	{
		Field:      "runs[].raceway_id",
		References: `guidelines[].id where kind = "raceway"`,
		Enforced:   false,
		Rule: "Stamped on every piece of a tube split at a raceway guideline; the same id a raceways[] box " +
			"carries. A value naming no guideline is accepted.",
	},
	{
		Field:      "runs[].group_id",
		References: "groups[].id",
		Enforced:   false,
		Rule:       "Editor-only grouping. A value naming no group is accepted.",
	},
}

var designDocSchema = sync.OnceValues(func() (schemaResponse, error) {
	types, err := describeTypes(reflect.TypeFor[designdoc.Doc]())
	if err != nil {
		return schemaResponse{}, err
	}
	ds := docSchema{Root: "Doc", Types: types}
	fp, err := schemaFingerprint(ds)
	if err != nil {
		return schemaResponse{}, err
	}
	return schemaResponse{
		BuildVersion: version.Current(),
		Fingerprint:  fp,
		DesignDoc:    ds,
		Relations:    designDocRelations,
	}, nil
})

func (s *apiServer) handleSchema(w http.ResponseWriter, r *http.Request) {
	resp, err := designDocSchema()
	if err != nil {
		// Unreachable unless a struct grows a field kind describeTypes
		// refuses; TestDesignDocSchemaGolden fails first.
		writeError(w, http.StatusInternalServerError, "schema: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, resp)
}

// schemaFingerprint hashes the canonical JSON of the field list. Map keys
// marshal sorted and fields keep declaration order, so this is stable.
func schemaFingerprint(ds docSchema) (string, error) {
	b, err := json.Marshal(ds)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:6]), nil
}

// describeTypes walks every struct reachable from root and lists its JSON
// fields. It refuses, rather than guesses at, anything whose JSON shape it
// does not model exactly — an embedded struct (encoding/json promotes its
// fields), a map, an interface, a []byte (base64) — so a struct change that
// would make this list lie fails loudly instead.
func describeTypes(root reflect.Type) (map[string][]schemaField, error) {
	out := map[string][]schemaField{}
	owner := map[string]reflect.Type{}
	var visit func(t reflect.Type) error
	visit = func(t reflect.Type) error {
		if prev, ok := owner[t.Name()]; ok {
			if prev != t {
				return fmt.Errorf("two types named %q (%s, %s)", t.Name(), prev.PkgPath(), t.PkgPath())
			}
			return nil
		}
		owner[t.Name()] = t
		fields := []schemaField{}
		for i := range t.NumField() {
			f := t.Field(i)
			if f.Anonymous {
				return fmt.Errorf("%s.%s: embedded fields are not modelled", t.Name(), f.Name)
			}
			if !f.IsExported() {
				continue
			}
			tag := f.Tag.Get("json")
			if tag == "-" {
				continue
			}
			name, opts, _ := strings.Cut(tag, ",")
			if name == "" {
				name = f.Name
			}
			typ, nested, err := jsonTypeName(f.Type)
			if err != nil {
				return fmt.Errorf("%s.%s: %w", t.Name(), f.Name, err)
			}
			fields = append(fields, schemaField{
				Name:      name,
				Type:      typ,
				OmitEmpty: hasTagOption(opts, "omitempty") || hasTagOption(opts, "omitzero"),
			})
			for _, n := range nested {
				if err := visit(n); err != nil {
					return err
				}
			}
		}
		out[t.Name()] = fields
		return nil
	}
	if root.Kind() != reflect.Struct {
		return nil, fmt.Errorf("root %s is not a struct", root)
	}
	if err := visit(root); err != nil {
		return nil, err
	}
	return out, nil
}

var (
	marshalerType     = reflect.TypeFor[json.Marshaler]()
	textMarshalerType = reflect.TypeFor[encoding.TextMarshaler]()
)

func hasTagOption(opts, want string) bool {
	for opts != "" {
		var o string
		o, opts, _ = strings.Cut(opts, ",")
		if o == want {
			return true
		}
	}
	return false
}

// jsonTypeName names a Go type by its JSON shape — "number", "Run[]",
// "number[2][]" — and returns any struct types it reaches so the walk can
// describe them too. A pointer is described as its element: in JSON it is the
// same value, or null.
func jsonTypeName(t reflect.Type) (string, []reflect.Type, error) {
	if t.Implements(marshalerType) || reflect.PointerTo(t).Implements(marshalerType) ||
		t.Implements(textMarshalerType) || reflect.PointerTo(t).Implements(textMarshalerType) {
		// A custom marshaller decides its own JSON shape; the struct fields
		// would describe something the wire never carries.
		return "", nil, fmt.Errorf("%s has a custom marshaller, whose shape is not modelled", t)
	}
	switch t.Kind() {
	case reflect.String:
		return "string", nil, nil
	case reflect.Bool:
		return "boolean", nil, nil
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64,
		reflect.Uint16, reflect.Uint32, reflect.Uint64:
		return "integer", nil, nil
	case reflect.Float32, reflect.Float64:
		return "number", nil, nil
	case reflect.Pointer:
		return jsonTypeName(t.Elem())
	case reflect.Slice:
		if t.Elem().Kind() == reflect.Uint8 {
			return "", nil, fmt.Errorf("[]byte marshals as base64 and is not modelled")
		}
		name, nested, err := jsonTypeName(t.Elem())
		return name + "[]", nested, err
	case reflect.Array:
		name, nested, err := jsonTypeName(t.Elem())
		return fmt.Sprintf("%s[%d]", name, t.Len()), nested, err
	case reflect.Struct:
		if t.Name() == "" {
			return "", nil, fmt.Errorf("anonymous struct types are not modelled")
		}
		return t.Name(), []reflect.Type{t}, nil
	default:
		return "", nil, fmt.Errorf("kind %s is not modelled", t.Kind())
	}
}
