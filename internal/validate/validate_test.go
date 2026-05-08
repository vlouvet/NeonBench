package validate

import (
	"bytes"
	"encoding/json"
	"testing"
)

// Pins the JSON-shape contract with the frontend: an empty issues
// list must marshal as `[]`, not `null`. A nil slice would marshal
// to JSON null, and the editor reads `report.issues.length` /
// `.filter(...)` unconditionally — Tier 1 #64 was the editor crash
// caused by this exact regression.
func TestValidateSVGEmptyIssuesMarshalAsArray(t *testing.T) {
	blankSVG := []byte(`<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="500" viewBox="0 0 1000 500"></svg>`)
	report, err := ValidateSVG(blankSVG, Limits{DiameterMM: 12, MinBendRadiusMM: 27})
	if err != nil {
		t.Fatalf("ValidateSVG on blank doc: %v", err)
	}
	if report.Issues == nil {
		t.Fatal("Report.Issues must be non-nil for an empty result; got nil")
	}
	data, err := json.Marshal(report)
	if err != nil {
		t.Fatalf("json.Marshal(report): %v", err)
	}
	if !bytes.Contains(data, []byte(`"issues":[]`)) {
		t.Fatalf(`empty report must marshal "issues":[]; got %s`, data)
	}
	if bytes.Contains(data, []byte(`"issues":null`)) {
		t.Fatalf(`empty report must not marshal "issues":null; got %s`, data)
	}
}
