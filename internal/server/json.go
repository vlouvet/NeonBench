package server

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/version"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("content-type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("encode response", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

func writeStorageError(w http.ResponseWriter, err error) {
	if errors.Is(err, storage.ErrNotFound) {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	slog.Error("storage error", "err", err)
	writeError(w, http.StatusInternalServerError, "internal error")
}

// decodeJSON decodes a request body STRICTLY: an unknown key is a 400, never
// silently dropped. That strictness is what keeps the Go and TS models honest
// (CLAUDE.md, recurring bug class 2) and it stays.
//
// What it costs is the error text. encoding/json reports an unknown key as
// `json: unknown field "raceways"`, which reads as "your JSON is malformed"
// when it almost always means "the client knows a field this binary does not"
// — a stale server, or a typo. Tier 3 #140 lost an afternoon to exactly that,
// so the unknown-field case comes back as *unknownFieldError, whose message
// says which of the two it probably is and where to look.
func decodeJSON(r *http.Request, v any) error {
	dec := json.NewDecoder(r.Body)
	dec.DisallowUnknownFields()
	return classifyDecodeError(dec.Decode(v))
}

// unknownFieldPrefix is encoding/json's wording for a key that matches no
// struct field under DisallowUnknownFields. It is a plain fmt error, not a
// typed one, so matching the text is the only way to recognise it. The tests
// assert on the rewritten message, so a stdlib rewording fails CI rather than
// quietly falling back to the bare text.
const unknownFieldPrefix = "json: unknown field "

// unknownFieldError is a request key this build's structs do not declare.
type unknownFieldError struct {
	Field string
}

func (e *unknownFieldError) Error() string {
	return fmt.Sprintf(
		"unknown field %q: this build (%s) does not accept it. If your client is newer than this server, "+
			"the server binary predates the field — upgrade or rebuild it. Otherwise check the key's spelling "+
			"and which object it sits in. GET /api/schema lists every design-doc field this build accepts",
		e.Field, version.Current())
}

// classifyDecodeError turns encoding/json's unknown-field error into an
// *unknownFieldError and passes everything else through untouched.
//
// The nested decoders in designdoc's UnmarshalJSON methods return the same
// text for a key inside the doc, so one rewrite here covers both the request
// envelope and every level of the design doc.
func classifyDecodeError(err error) error {
	if err == nil {
		return nil
	}
	if rest, ok := strings.CutPrefix(err.Error(), unknownFieldPrefix); ok {
		if field, uerr := strconv.Unquote(rest); uerr == nil {
			return &unknownFieldError{Field: field}
		}
	}
	return err
}

// writeDecodeError answers a failed decodeJSON with a 400 whose text says
// which of four things went wrong, so "malformed" is only ever said about JSON
// that genuinely does not parse:
//
//   - malformed JSON — the body does not parse at all;
//   - unknown field  — well-formed, but this build has no such key;
//   - wrong type     — well-formed, known key, value of the wrong JSON type;
//   - rejected       — well-formed and fully typed, but it breaks a rule the
//     schema enforces across fields (a raceway naming no guideline, a run
//     naming no circuit). Those come from designdoc's UnmarshalJSON methods,
//     which already name the object and the id; GET /api/schema lists the
//     relationships under "relations".
func writeDecodeError(w http.ResponseWriter, err error) {
	var unknown *unknownFieldError
	var syntax *json.SyntaxError
	var typ *json.UnmarshalTypeError
	switch {
	case errors.As(err, &unknown):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, io.EOF):
		writeError(w, http.StatusBadRequest, "malformed JSON: empty request body")
	case errors.As(err, &syntax), errors.Is(err, io.ErrUnexpectedEOF):
		writeError(w, http.StatusBadRequest, "malformed JSON: "+err.Error())
	case errors.As(err, &typ):
		writeError(w, http.StatusBadRequest, "wrong type: "+err.Error())
	default:
		writeError(w, http.StatusBadRequest, "rejected: "+err.Error())
	}
}
