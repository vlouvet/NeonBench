package validate

import (
	"strings"
	"testing"
)

// fittedRaceway is a box that exactly spans its runs and comfortably holds
// its transformers — i.e. the state both rules must stay silent about.
func fittedRaceway() RacewayInput {
	return RacewayInput{
		ID:                  "rw1",
		XMM:                 0,
		LengthMM:            2000,
		YMM:                 50,
		MemberMinXMM:        0,
		MemberMaxXMM:        2000,
		HasMembers:          true,
		TransformerCount:    2,
		TransformerLengthMM: RacewayTransformerLengthMM,
	}
}

func issuesFor(rule string, issues []Issue) []Issue {
	var out []Issue
	for _, i := range issues {
		if i.Rule == rule {
			out = append(out, i)
		}
	}
	return out
}

// TestCheckRacewaysCleanWhenFitted is the negative control the two tests
// below need in order to mean anything: on a well-formed raceway,
// CheckRaceways says nothing at all.
func TestCheckRacewaysCleanWhenFitted(t *testing.T) {
	if got := CheckRaceways([]RacewayInput{fittedRaceway()}); len(got) != 0 {
		t.Errorf("a fitted raceway produced %d issue(s): %+v", len(got), got)
	}
	if got := CheckRaceways(nil); got != nil {
		t.Errorf("no raceways should produce no issues, got %+v", got)
	}
}

// TestRacewaySpanRuleBoundary walks the span rule across its threshold in
// both directions. The failure it exists to catch is an auto-fit that was
// never re-run after the letters moved.
func TestRacewaySpanRuleBoundary(t *testing.T) {
	cases := []struct {
		name      string
		mutate    func(*RacewayInput)
		wantFire  bool
		wantWords string
	}{
		{
			name:     "exactly flush",
			mutate:   func(rw *RacewayInput) {},
			wantFire: false,
		},
		{
			name:     "inside tolerance",
			mutate:   func(rw *RacewayInput) { rw.MemberMaxXMM = 2000 + racewaySpanToleranceMM/2 },
			wantFire: false,
		},
		{
			name:      "glass past the right end",
			mutate:    func(rw *RacewayInput) { rw.MemberMaxXMM = 2400 },
			wantFire:  true,
			wantWords: "past the right end",
		},
		{
			name:      "glass past the left end",
			mutate:    func(rw *RacewayInput) { rw.MemberMinXMM = -120 },
			wantFire:  true,
			wantWords: "past the left end",
		},
		{
			name: "short at both ends",
			mutate: func(rw *RacewayInput) {
				rw.XMM = 500
				rw.LengthMM = 300
			},
			wantFire:  true,
			wantWords: "and",
		},
		{
			name:     "no member runs at all",
			mutate:   func(rw *RacewayInput) { rw.HasMembers = false },
			wantFire: false,
		},
		{
			name:     "unsized box",
			mutate:   func(rw *RacewayInput) { rw.LengthMM = 0 },
			wantFire: false,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rw := fittedRaceway()
			rw.TransformerCount = 0 // isolate the span rule
			tc.mutate(&rw)
			got := issuesFor(RuleRacewaySpan, CheckRaceways([]RacewayInput{rw}))
			if tc.wantFire && len(got) == 0 {
				t.Fatalf("expected %s to fire", RuleRacewaySpan)
			}
			if !tc.wantFire {
				if len(got) != 0 {
					t.Fatalf("expected silence, got %+v", got)
				}
				return
			}
			if got[0].Severity != SeverityWarning {
				t.Errorf("severity = %q, want %q — raceway numbers come from a weaker source class than the rest of docs/neon-rules/",
					got[0].Severity, SeverityWarning)
			}
			if tc.wantWords != "" && !strings.Contains(got[0].Message, tc.wantWords) {
				t.Errorf("message %q does not mention %q", got[0].Message, tc.wantWords)
			}
			if got[0].YMM != rw.YMM {
				t.Errorf("marker Y = %v, want the guideline's %v", got[0].YMM, rw.YMM)
			}
		})
	}
}

// TestRacewayTransformerFitBoundary walks the fit rule across its exact
// threshold. Four transformers at 159mm + 25.4mm clearance need 737.6mm; a
// box one millimetre shorter must fire and one millimetre longer must not.
func TestRacewayTransformerFitBoundary(t *testing.T) {
	const perUnit = RacewayTransformerLengthMM + RacewayTransformerClearanceMM
	needed := 4 * perUnit

	fires := func(lengthMM float64) []Issue {
		rw := fittedRaceway()
		rw.TransformerCount = 4
		rw.LengthMM = lengthMM
		// Keep the span rule quiet so the assertion is about fit alone.
		rw.MemberMinXMM = rw.XMM
		rw.MemberMaxXMM = rw.XMM + lengthMM
		return issuesFor(RuleRacewayTransformerFit, CheckRaceways([]RacewayInput{rw}))
	}

	if got := fires(needed + 1); len(got) != 0 {
		t.Errorf("a box with room to spare fired: %+v", got)
	}
	if got := fires(needed); len(got) != 0 {
		t.Errorf("a box exactly long enough fired: %+v", got)
	}
	short := fires(needed - 1)
	if len(short) != 1 {
		t.Fatalf("a box one mm too short produced %d issues, want 1", len(short))
	}
	if short[0].Severity != SeverityWarning {
		t.Errorf("severity = %q, want %q — a shop with a different transformer must not be blocked",
			short[0].Severity, SeverityWarning)
	}
	if !strings.Contains(short[0].Message, "laid along it") {
		t.Errorf("message %q does not say the transformers lie ALONG the box, which is the whole constraint", short[0].Message)
	}

	// The spec's illustration is "four transformers in a 900mm raceway does
	// not go together". At the 1 in clearance this rule uses, four units
	// need 737.6mm and 900mm CLEARS — so that example is a near miss, not a
	// fire, and the rule says so rather than being tuned to make an
	// illustration true. 700mm is the version that genuinely does not go
	// together, and it is what the threshold is pinned on.
	if got := fires(900); len(got) != 0 {
		t.Errorf("four transformers need %.1fmm; 900mm fits, so the rule must stay silent: %+v", needed, got)
	}
	if got := fires(700); len(got) != 1 {
		t.Errorf("four transformers in a 700mm raceway produced %d issues, want 1", len(got))
	}

	// A design with no electrodes implies no transformers, and nothing to say.
	none := fittedRaceway()
	none.TransformerCount = 0
	none.LengthMM = 10
	none.MemberMaxXMM = 10
	if got := issuesFor(RuleRacewayTransformerFit, CheckRaceways([]RacewayInput{none})); len(got) != 0 {
		t.Errorf("a design with no transformers fired the fit rule: %+v", got)
	}

	// An absent per-input length falls back to the shop figure rather than
	// dividing by nothing.
	fallback := fittedRaceway()
	fallback.TransformerCount = 4
	fallback.TransformerLengthMM = 0
	fallback.LengthMM = 700
	fallback.MemberMaxXMM = 700
	if got := issuesFor(RuleRacewayTransformerFit, CheckRaceways([]RacewayInput{fallback})); len(got) != 1 {
		t.Errorf("zero TransformerLengthMM should fall back to %vmm, got %d issues", RacewayTransformerLengthMM, len(got))
	}
}

// TestCheckRacewaysNeverErrors is the severity invariant stated once, over
// every way either rule can fire. Errors block; these two must not.
func TestCheckRacewaysNeverErrors(t *testing.T) {
	rw := fittedRaceway()
	rw.LengthMM = 100
	rw.MemberMaxXMM = 4000
	rw.TransformerCount = 6
	got := CheckRaceways([]RacewayInput{rw})
	if len(got) != 2 {
		t.Fatalf("expected both rules to fire, got %+v", got)
	}
	for _, i := range got {
		if i.Severity != SeverityWarning {
			t.Errorf("rule %s has severity %q, want %q", i.Rule, i.Severity, SeverityWarning)
		}
	}
	report := Report{Issues: got}
	if report.HasErrors() {
		t.Error("raceway issues made a report error-bearing — they must never block a save")
	}
}
