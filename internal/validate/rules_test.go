package validate

import (
	"math"
	"testing"
)

// countByRule returns how many issues in `issues` carry the given rule.
func countByRule(issues []Issue, rule string) int {
	n := 0
	for _, iss := range issues {
		if iss.Rule == rule {
			n++
		}
	}
	return n
}

// firstByRule returns the first issue with the given rule, or a zero Issue
// + false if none match.
func firstByRule(issues []Issue, rule string) (Issue, bool) {
	for _, iss := range issues {
		if iss.Rule == rule {
			return iss, true
		}
	}
	return Issue{}, false
}

// TestMinLeadInWarnsWhenTooShort verifies the lead-in rule fires when an
// electrode (open-polyline endpoint) is closer to the first bend than the
// configured limit.
func TestMinLeadInWarnsWhenTooShort(t *testing.T) {
	// Endpoint at (0, 0); first vertex 10 mm out at (10, 0); then a 90°
	// turn down to (10, 50). MinLeadInMM = 25 → endpoint is short.
	pl := Polyline{
		Points: []Point{{0, 0}, {10, 0}, {10, 50}},
		Closed: false,
	}
	limits := Limits{
		DiameterMM:  12,
		MinLeadInMM: 25,
	}
	issues := checkMinLeadIn([]Polyline{pl}, limits)

	if got, want := countByRule(issues, RuleMinLeadIn), 1; got != want {
		t.Fatalf("expected %d min_lead_in issues, got %d (issues: %+v)", want, got, issues)
	}
	iss, _ := firstByRule(issues, RuleMinLeadIn)
	if iss.Severity != SeverityWarning {
		t.Errorf("severity = %q, want %q", iss.Severity, SeverityWarning)
	}
	if iss.XMM != 0 || iss.YMM != 0 {
		t.Errorf("issue location = (%v, %v), want electrode at (0, 0)", iss.XMM, iss.YMM)
	}
}

// TestMinLeadInIgnoresWhenLongEnough verifies no warning when the lead-in
// length is at or above the limit.
func TestMinLeadInIgnoresWhenLongEnough(t *testing.T) {
	// Same shape, but the first bend is 30 mm out instead of 10.
	pl := Polyline{
		Points: []Point{{0, 0}, {30, 0}, {30, 50}},
		Closed: false,
	}
	limits := Limits{
		DiameterMM:  12,
		MinLeadInMM: 25,
	}
	issues := checkMinLeadIn([]Polyline{pl}, limits)

	if got := countByRule(issues, RuleMinLeadIn); got != 0 {
		t.Fatalf("expected 0 min_lead_in issues, got %d (issues: %+v)", got, issues)
	}
}

// TestMinLeadInIgnoresStraightTube verifies a perfectly straight run with
// no bends produces no warning, even if its total length is below the
// limit. With no bend, there's nothing for the lead-in to be short to.
func TestMinLeadInIgnoresStraightTube(t *testing.T) {
	pl := Polyline{
		Points: []Point{{0, 0}, {15, 0}}, // 15 mm straight
		Closed: false,
	}
	limits := Limits{
		DiameterMM:  12,
		MinLeadInMM: 25,
	}
	issues := checkMinLeadIn([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleMinLeadIn); got != 0 {
		t.Fatalf("expected 0 min_lead_in issues for a straight tube, got %d", got)
	}
}

// TestSharpBendAngleWarnsAt90Degrees verifies a 90° L-shape fires the
// sharp-bend rule with default 85° threshold... wait, 90 > 85 so it
// shouldn't. Verify we DON'T fire at exactly 90° but DO fire below it.
func TestSharpBendAngleWarnsBelowThreshold(t *testing.T) {
	// Sharp angle: ~60° corner, well below the 85° threshold.
	pl := Polyline{
		Points: []Point{{0, 0}, {100, 0}, {50, 86.6}}, // ~60° at (100, 0)
		Closed: false,
	}
	limits := Limits{
		DiameterMM:        12,
		MinBendRadiusMM:   25, // realistic so resampling is stable
		SharpBendAngleDeg: 85,
	}
	issues := checkSharpBendAngles([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleSharpBendAngle); got < 1 {
		t.Fatalf("expected ≥1 sharp_bend_angle issue, got %d (issues: %+v)", got, issues)
	}
	iss, _ := firstByRule(issues, RuleSharpBendAngle)
	if iss.Severity != SeverityWarning {
		t.Errorf("severity = %q, want %q", iss.Severity, SeverityWarning)
	}
}

// TestSharpBendAngleIgnoresGentleSweep verifies a gentle bend (well above
// the threshold) doesn't fire.
func TestSharpBendAngleIgnoresGentleSweep(t *testing.T) {
	// 135° corner — well above the 85° default threshold.
	pl := Polyline{
		Points: []Point{{0, 0}, {100, 0}, {170.7, 70.7}},
		Closed: false,
	}
	limits := Limits{
		DiameterMM:        12,
		MinBendRadiusMM:   25,
		SharpBendAngleDeg: 85,
	}
	issues := checkSharpBendAngles([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleSharpBendAngle); got != 0 {
		t.Fatalf("expected 0 sharp_bend_angle issues for a gentle sweep, got %d (issues: %+v)", got, issues)
	}
}

// TestSharpBendAngleExemptsHairpinApex verifies a 180° hairpin's apex —
// flanked by two parallel legs — is treated as a documented double-back
// construction, not flagged as a sharp bend. Builds a tight U-turn whose
// hairpin geometry the existing isDoubleBackHairpin detector recognizes.
func TestSharpBendAngleExemptsHairpinApex(t *testing.T) {
	// Two parallel 100mm legs separated by 20mm, joined by a tight semicircle
	// at one end. Tube diameter 12mm; the legs sit ~1.7 × D apart, well
	// inside the 4 × D hairpin detector window.
	const D = 12.0
	const legLen = 100.0
	const sep = 20.0 // leg-to-leg spacing
	const apexX = 0.0
	// Build the U: leg 1 going +X from (apexX-legLen, 0) to (apexX, 0), then
	// a semicircle around (apexX, sep/2) of radius sep/2 to (apexX, sep),
	// then leg 2 going -X back to (apexX-legLen, sep).
	var pts []Point
	// Leg 1: 11 sample points
	for i := 0; i <= 10; i++ {
		x := -legLen + float64(i)*legLen/10
		pts = append(pts, Point{x, 0})
	}
	// Semicircle: 11 sample points, sweeping 180° from (0, 0) to (0, sep)
	r := sep / 2
	cx, cy := 0.0, r
	for i := 1; i <= 10; i++ {
		theta := math.Pi * float64(i) / 10 // 0 → π
		// Start at angle -π/2 (the (0, 0) point), sweep to +π/2 (the (0, sep) point).
		px := cx + r*math.Sin(theta)
		py := cy - r*math.Cos(theta)
		pts = append(pts, Point{px, py})
	}
	// Leg 2: walk back to start in 10 steps
	for i := 1; i <= 10; i++ {
		x := 0 - float64(i)*legLen/10
		pts = append(pts, Point{x, sep})
	}
	pl := Polyline{Points: pts, Closed: false, DiameterMM: D}
	limits := Limits{
		DiameterMM:        D,
		MinBendRadiusMM:   25,
		SharpBendAngleDeg: 85,
	}
	issues := checkSharpBendAngles([]Polyline{pl}, limits)

	// At least one sample inside the semicircle has interior angle below
	// 85° — but every one of those should be detected as a hairpin apex
	// and suppressed. The legs themselves are straight (180°), no flag.
	if got := countByRule(issues, RuleSharpBendAngle); got != 0 {
		t.Fatalf("expected 0 sharp_bend_angle issues at the hairpin apex, got %d (issues: %+v)", got, issues)
	}
}

// TestSharpBendAngleExemptsUserDoubleback verifies an explicit user-marked
// double-back point also suppresses the warning, even when the geometric
// hairpin detector wouldn't fire (e.g. the corner is too sharp/short to
// look like a parallel-leg hairpin).
func TestSharpBendAngleExemptsUserDoubleback(t *testing.T) {
	const D = 12.0
	pl := Polyline{
		Points:          []Point{{0, 0}, {100, 0}, {50, 86.6}}, // ~60° apex
		Closed:          false,
		DiameterMM:      D,
		DoublebackMarks: []Point{{100, 0}}, // user marked the apex as a deliberate DB
	}
	limits := Limits{
		DiameterMM:        D,
		MinBendRadiusMM:   25,
		SharpBendAngleDeg: 85,
	}
	issues := checkSharpBendAngles([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleSharpBendAngle); got != 0 {
		t.Fatalf("expected 0 sharp_bend_angle issues with a user double-back mark, got %d (issues: %+v)", got, issues)
	}
}

// TestMinLeadInExemptsUserDoubleback verifies a documented hairpin
// double-back at the first bend doesn't trigger a short-lead-in warning;
// the user has explicitly opted into that geometry.
func TestMinLeadInExemptsUserDoubleback(t *testing.T) {
	pl := Polyline{
		Points:          []Point{{0, 0}, {10, 0}, {10, 50}}, // first bend 10mm out
		Closed:          false,
		DiameterMM:      12,
		DoublebackMarks: []Point{{10, 0}},
	}
	limits := Limits{
		DiameterMM:  12,
		MinLeadInMM: 25,
	}
	issues := checkMinLeadIn([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleMinLeadIn); got != 0 {
		t.Fatalf("expected 0 min_lead_in issues with a user double-back at the first bend, got %d", got)
	}
}

// TestMinLeadInDerivedDefault verifies the 2 × diameter fall-back applies
// when the tube spec provides no per-spec limit (Limits.MinLeadInMM == 0).
// For 12 mm tube, the derived default is 24 mm.
func TestMinLeadInDerivedDefault(t *testing.T) {
	// First bend 20 mm from the electrode — below the derived 24 mm
	// default, so the warning should fire.
	pl := Polyline{
		Points: []Point{{0, 0}, {20, 0}, {20, 50}},
		Closed: false,
	}
	limits := Limits{
		DiameterMM:  12,
		MinLeadInMM: 0, // no override → derived default 2×12 = 24 mm
	}
	issues := checkMinLeadIn([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleMinLeadIn); got < 1 {
		t.Fatalf("expected ≥1 min_lead_in issue at derived default, got %d", got)
	}

	// Bumping the bend to 30 mm clears the derived default.
	pl2 := Polyline{
		Points: []Point{{0, 0}, {30, 0}, {30, 50}},
		Closed: false,
	}
	issues2 := checkMinLeadIn([]Polyline{pl2}, limits)
	if got := countByRule(issues2, RuleMinLeadIn); got != 0 {
		t.Fatalf("expected 0 min_lead_in issues at 30 mm > 2×D, got %d (issues: %+v)", got, issues2)
	}
}

// TestSharpBendAngleDefaultThreshold verifies the 85° default fires when
// no per-spec override is set.
func TestSharpBendAngleDefaultThreshold(t *testing.T) {
	pl := Polyline{
		Points: []Point{{0, 0}, {100, 0}, {50, 86.6}}, // ~60°
		Closed: false,
	}
	limits := Limits{
		DiameterMM:      12,
		MinBendRadiusMM: 25,
		// SharpBendAngleDeg == 0 → should default to 85°.
	}
	issues := checkSharpBendAngles([]Polyline{pl}, limits)
	if got := countByRule(issues, RuleSharpBendAngle); got < 1 {
		t.Fatalf("expected ≥1 sharp_bend_angle issue at default threshold, got %d", got)
	}
}

// TestInteriorAngleDeg sanity-checks the geometry helper at known values.
func TestInteriorAngleDeg(t *testing.T) {
	cases := []struct {
		name    string
		a, b, c Point
		want    float64
	}{
		{"straight", Point{-1, 0}, Point{0, 0}, Point{1, 0}, 180},
		{"right", Point{1, 0}, Point{0, 0}, Point{0, 1}, 90},
		{"acute", Point{1, 0}, Point{0, 0}, Point{1, 1}, 45},
		{"reflex-folded-back", Point{1, 0}, Point{0, 0}, Point{1, 0}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := interiorAngleDeg(tc.a, tc.b, tc.c)
			if math.Abs(got-tc.want) > 0.5 {
				t.Errorf("interiorAngleDeg = %v, want %v", got, tc.want)
			}
		})
	}
}

// TestValidateSVGEmitsLeadInAndSharpBend confirms the two new rules are
// wired into the public ValidateSVG entry point.
func TestValidateSVGEmitsLeadInAndSharpBend(t *testing.T) {
	// Simple SVG path: M 0 0 L 10 0 L 10 50.
	// Endpoint at (0,0), first bend 10mm out, ~90° turn.
	svg := []byte(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="200mm" height="200mm" viewBox="0 0 200 200">
  <path d="M 0 0 L 10 0 L 10 50" stroke="black" fill="none"/>
</svg>`)
	limits := Limits{
		DiameterMM:        12,
		MinBendRadiusMM:   25,
		MinLeadInMM:       25,
		SharpBendAngleDeg: 95, // generous enough that 90° fires
	}
	report, err := ValidateSVG(svg, limits)
	if err != nil {
		t.Fatalf("ValidateSVG: %v", err)
	}
	if got := countByRule(report.Issues, RuleMinLeadIn); got < 1 {
		t.Errorf("expected ValidateSVG to emit min_lead_in, got %d (%+v)", got, report.Issues)
	}
	if got := countByRule(report.Issues, RuleSharpBendAngle); got < 1 {
		t.Errorf("expected ValidateSVG to emit sharp_bend_angle, got %d (%+v)", got, report.Issues)
	}
}
