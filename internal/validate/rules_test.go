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

// TestDerivedMinBendRadius verifies the K * D² / t derivation matches
// the wall-thinning bound from docs/neon-rules/bend-radius.md across the
// three named techniques. Tier 3 #31.
func TestDerivedMinBendRadius(t *testing.T) {
	cases := []struct {
		name      string
		D, t      float64
		technique string
		want      float64
		tol       float64
	}{
		// 12 mm clear, 1.07 mm wall, ribbon → 26.9 mm. Matches the
		// existing 27 mm folklore seed within 0.1 mm.
		{"12mm-ribbon", 12, 1.07, "ribbon", 26.92, 0.5},
		// Crossfire is the doc's first-principles 2.25·D bound when
		// calibrated against typical 1.07 mm wall: 0.225 * 144 / 1.07
		// = 30.3 mm. Slightly looser than ribbon, as expected.
		{"12mm-crossfire", 12, 1.07, "crossfire", 30.28, 0.5},
		// Hand torch is the loosest: 0.275 * 144 / 1.07 = 37.0 mm.
		{"12mm-hand_torch", 12, 1.07, "hand_torch", 37.01, 0.5},
		// 15 mm clear, 1.32 mm wall, ribbon → 34.1 mm. Matches the
		// existing 34 mm folklore seed.
		{"15mm-ribbon", 15, 1.32, "ribbon", 34.09, 0.5},
		// Spec test: derivedMinBendRadius(12, 1.0, "ribbon") ≈ 25 mm
		// per the spec's success criterion (within ±2 mm of the
		// published table). 0.20 * 144 / 1.0 = 28.8 — close but the
		// looser tolerance from the spec accommodates K-rounding.
		{"12mm-1.0wall-ribbon", 12, 1.0, "ribbon", 28.8, 2.0},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := derivedMinBendRadius(c.D, c.t, c.technique)
			if math.Abs(got-c.want) > c.tol {
				t.Errorf("derivedMinBendRadius(%v, %v, %q) = %.3f, want %.3f ±%.2f",
					c.D, c.t, c.technique, got, c.want, c.tol)
			}
		})
	}
}

// TestDerivedMinBendRadiusFallsBackToDiameterBound verifies the helper
// gracefully degrades to the 2.25·D bound when the wall thickness or
// technique is missing/unknown. Tier 3 #31.
func TestDerivedMinBendRadiusFallsBackToDiameterBound(t *testing.T) {
	cases := []struct {
		name      string
		D, t      float64
		technique string
		want      float64
	}{
		{"missing-wall", 12, 0, "ribbon", 27.0},
		{"missing-technique", 12, 1.0, "", 27.0},
		{"unknown-technique", 12, 1.0, "magic", 27.0},
		{"both-missing", 15, 0, "", 33.75},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := derivedMinBendRadius(c.D, c.t, c.technique)
			if math.Abs(got-c.want) > 0.01 {
				t.Errorf("derivedMinBendRadius(%v, %v, %q) = %.3f, want %.3f (2.25·D fallback)",
					c.D, c.t, c.technique, got, c.want)
			}
		})
	}
	// Zero diameter → zero (no curve to bend).
	if got := derivedMinBendRadius(0, 1.0, "ribbon"); got != 0 {
		t.Errorf("derivedMinBendRadius(0, ...) = %v, want 0", got)
	}
}

// TestRunBendLimitFallsBackToDerivedWhenSpecMissing verifies that when
// the project's stored MinBendRadiusMM is zero AND wall thickness +
// technique are present, runBendLimitMM returns the derived value.
// Tier 3 #31.
func TestRunBendLimitFallsBackToDerivedWhenSpecMissing(t *testing.T) {
	limits := Limits{
		DiameterMM:      12,
		MinBendRadiusMM: 0,
		WallThicknessMM: 1.2,
		BendTechnique:   "crossfire",
	}
	pl := Polyline{Points: []Point{{0, 0}, {1, 0}}, Closed: false}
	got := runBendLimitMM(pl, limits)
	want := 0.225 * 12 * 12 / 1.2 // 27.0
	if math.Abs(got-want) > 0.01 {
		t.Errorf("runBendLimitMM(crossfire derived) = %v, want %v", got, want)
	}
}

// TestRunBendLimitPrefersExplicitOverride verifies that when the spec
// has an explicit MinBendRadiusMM value, the derivation does NOT run —
// the user's override wins. Tier 3 #31.
func TestRunBendLimitPrefersExplicitOverride(t *testing.T) {
	limits := Limits{
		DiameterMM:      12,
		MinBendRadiusMM: 30, // explicit override
		WallThicknessMM: 1.2,
		BendTechnique:   "ribbon", // would give 0.20*144/1.2 = 24 mm
	}
	pl := Polyline{Points: []Point{{0, 0}, {1, 0}}, Closed: false}
	got := runBendLimitMM(pl, limits)
	if math.Abs(got-30) > 0.01 {
		t.Errorf("runBendLimitMM(explicit=30, derived=24) = %v, want 30", got)
	}
}

// TestRunBendLimitFallsBackToHeuristicWhenAllNull verifies backward
// compatibility: a Limits with no wall thickness, no technique, and no
// explicit min_bend_radius_mm falls back to the diameter-only 2.25·D
// bound — which numerically matches today's seeded folklore values
// within ±0.5 mm. Tier 3 #31.
func TestRunBendLimitFallsBackToHeuristicWhenAllNull(t *testing.T) {
	cases := []struct {
		D, want float64
	}{
		{8, 18.0},   // 2.25·8 = 18.0 (matches seed 18)
		{10, 22.5},  // matches seed 22 within 0.5
		{12, 27.0},  // matches seed 27 exactly
		{15, 33.75}, // matches seed 34 within 0.25
	}
	for _, c := range cases {
		limits := Limits{DiameterMM: c.D}
		pl := Polyline{Points: []Point{{0, 0}, {1, 0}}, Closed: false}
		got := runBendLimitMM(pl, limits)
		if math.Abs(got-c.want) > 0.01 {
			t.Errorf("runBendLimitMM(D=%v, all-null) = %v, want %v", c.D, got, c.want)
		}
	}
}

// TestRunBendLimitDiameterRatioStillScalesDerivedBase verifies the
// per-run diameter override still applies linearly even when the base
// limit comes from the derivation (not an explicit override). Preserves
// the existing wall-thinning ratio scaling. Tier 3 #31.
func TestRunBendLimitDiameterRatioStillScalesDerivedBase(t *testing.T) {
	limits := Limits{
		DiameterMM:      12,
		MinBendRadiusMM: 0, // derived path
		WallThicknessMM: 1.07,
		BendTechnique:   "ribbon",
	}
	// Per-run override at 15 mm — the limit should scale by 15/12.
	pl := Polyline{Points: []Point{{0, 0}, {1, 0}}, Closed: false, DiameterMM: 15}
	got := runBendLimitMM(pl, limits)
	base := 0.20 * 12 * 12 / 1.07 // ≈ 26.92
	want := base * 15 / 12        // ≈ 33.65
	if math.Abs(got-want) > 0.01 {
		t.Errorf("runBendLimitMM(derived base, run override) = %v, want %v", got, want)
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

// TestFacePerimeterExceedsBlank verifies the perimeter validator fires
// only on face-flagged polylines whose total perimeter exceeds the
// 1168 mm blank length, and lands a single warning at the run centroid.
// Tier 3 #26.
func TestFacePerimeterExceedsBlank(t *testing.T) {
	// Closed rectangle with perimeter 1500 mm: 600×150 → 2*(600+150) = 1500.
	tooBig := Polyline{
		Points: []Point{{0, 0}, {600, 0}, {600, 150}, {0, 150}},
		Closed: true,
	}
	tooBig.IsChannelLetterFace = true
	short := Polyline{
		Points: []Point{{0, 0}, {200, 0}, {200, 100}, {0, 100}},
		Closed: true, // perimeter 600 — below threshold
	}
	short.IsChannelLetterFace = true
	notFace := Polyline{
		Points: []Point{{0, 0}, {600, 0}, {600, 150}, {0, 150}},
		Closed: true, // perimeter 1500 but NOT a face → ignored
	}

	issues := checkFacePerimeter([]Polyline{tooBig, short, notFace})
	if got, want := countByRule(issues, RuleFacePerimeterExceedsBlank), 1; got != want {
		t.Fatalf("expected exactly %d face_perimeter_exceeds_blank issue, got %d (%+v)", want, got, issues)
	}
	iss, _ := firstByRule(issues, RuleFacePerimeterExceedsBlank)
	if iss.Severity != SeverityWarning {
		t.Errorf("severity: got %q, want %q (warning, not error — see rule doc)", iss.Severity, SeverityWarning)
	}
	// Centroid of (0,0)+(600,0)+(600,150)+(0,150) is (300, 75).
	if math.Abs(iss.XMM-300) > 0.01 || math.Abs(iss.YMM-75) > 0.01 {
		t.Errorf("marker landed at (%.1f, %.1f); expected centroid (300, 75)", iss.XMM, iss.YMM)
	}
	if !contains(iss.Message, "1500") || !contains(iss.Message, "1168") {
		t.Errorf("message missing perimeter / blank values: %q", iss.Message)
	}
}

// TestValidateSVGEmitsFacePerimeter wires the rule into the public
// ValidateSVG entry point and asserts the data-channel-letter-face SVG
// attribute is parsed end-to-end.
func TestValidateSVGEmitsFacePerimeter(t *testing.T) {
	// 600×150 closed rect, perimeter 1500 mm > 1168 mm blank.
	svg := []byte(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800mm" height="300mm" viewBox="0 0 800 300">
  <path data-channel-letter-face="1" d="M 0 0 L 600 0 L 600 150 L 0 150 Z" stroke="black" fill="none"/>
</svg>`)
	report, err := ValidateSVG(svg, Limits{DiameterMM: 12})
	if err != nil {
		t.Fatalf("ValidateSVG: %v", err)
	}
	if got := countByRule(report.Issues, RuleFacePerimeterExceedsBlank); got != 1 {
		t.Errorf("expected 1 face_perimeter_exceeds_blank, got %d (%+v)", got, report.Issues)
	}

	// Same polyline without the data attribute: rule is silent.
	svgPlain := []byte(`<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="800mm" height="300mm" viewBox="0 0 800 300">
  <path d="M 0 0 L 600 0 L 600 150 L 0 150 Z" stroke="black" fill="none"/>
</svg>`)
	rep2, err := ValidateSVG(svgPlain, Limits{DiameterMM: 12})
	if err != nil {
		t.Fatalf("ValidateSVG plain: %v", err)
	}
	if got := countByRule(rep2.Issues, RuleFacePerimeterExceedsBlank); got != 0 {
		t.Errorf("non-face polyline: expected 0 perimeter issues, got %d", got)
	}
}

// contains is a tiny strings.Contains shim so tests stay free of an
// extra import (rules_test.go already pulls in only "math" and
// "testing").
func contains(haystack, needle string) bool {
	for i := 0; i+len(needle) <= len(haystack); i++ {
		if haystack[i:i+len(needle)] == needle {
			return true
		}
	}
	return false
}
