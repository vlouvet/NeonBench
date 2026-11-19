package validate_test

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/validate"
)

// Tier 3 #178 — the editor measures an arc by r*theta (runLengthMM), and the
// auto-split cuts a run until every piece is at most the limit by that
// measure. These tests are the validator's half of the claim "a run the
// auto-split calls short enough is not flagged overlong": the validator never
// measures an arc longer than r*theta (at the sizes a sign uses), and the
// pieces the editor actually produces pass the real rule.
//
// The piece coordinates and limits are shared, digit for digit, with
// web/src/lib/arcLengthSplit.test.ts, which asserts that autoSplitOverlongTubes
// produces exactly these pieces.

const (
	splitLimitMM      = 1043.0  // between the old 5° measure and the validator, for a 900mm arc
	splitLimitTightMM = 1043.21 // just above r*theta for a 900mm arc

	// Measured through the real pipeline (ToSVG → ExtractMMPolylines →
	// Length) and pinned below; the TS suite quotes the same numbers.
	validatorOpenArc100MM = 115.8964
	validatorOpenArc900MM = 1043.2042
)

// What the editor's auto-split makes of twoArcs() at splitLimitMM: both cuts
// land inside an arc, so each arc is straightened at its cut (row 177).
var splitAtLimitPieces = [][][2]float64{
	{{0, 0}, {621.1124405667608, 198.34212477490672}},
	{{621.1124405667608, 198.34212477490672}, {900, 0}, {1181.5144307849046, 199.1738888433693}},
	{{1181.5144307849046, 199.1738888433693}, {1800, 0}},
}

func arcRun(id string, p0, p1 [2]float64) designdoc.Run {
	return designdoc.Run{ID: id, Polyline: designdoc.Polyline{
		Points: [][2]float64{p0, p1}, SegmentTypes: []string{designdoc.SegmentArc},
	}}
}

func docOfRuns(runs ...designdoc.Run) *designdoc.Doc {
	return &designdoc.Doc{Version: 1, ViewBoxMM: [4]float64{-100, -500, 4000, 4000}, Runs: runs}
}

// validatorLengthMM is what the max-segment-length rule compares against the
// limit: the run as ToSVG emits it, flattened by the validator, summed.
func validatorLengthMM(t *testing.T, run designdoc.Run) float64 {
	t.Helper()
	pls, _, _, err := validate.ExtractMMPolylines(designdoc.ToSVG(docOfRuns(run)))
	if err != nil {
		t.Fatal(err)
	}
	total := 0.0
	for i := range pls {
		total += pls[i].Length()
	}
	return total
}

func overlongIssues(t *testing.T, doc *designdoc.Doc, limitMM float64) int {
	t.Helper()
	rep, err := validate.ValidateSVG(designdoc.ToSVG(doc), validate.Limits{MaxSegmentLengthMM: limitMM})
	if err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, is := range rep.Issues {
		if is.Rule == validate.RuleMaxSegmentLength {
			n++
		}
	}
	return n
}

// fiveDegreeLengthMM is the measure runLengthMM used before #178: the 5°
// flattening, summed. It is here only as the negative control.
func fiveDegreeLengthMM(run designdoc.Run) float64 {
	pts := run.Polyline.FlatPoints()
	total := 0.0
	for i := 1; i < len(pts); i++ {
		total += math.Hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1])
	}
	return total
}

func TestValidatorPinnedArcLengths(t *testing.T) {
	for _, tc := range []struct {
		chord, want float64
	}{{100, validatorOpenArc100MM}, {900, validatorOpenArc900MM}} {
		run := arcRun("r", [2]float64{0, 0}, [2]float64{tc.chord, 0})
		if got := validatorLengthMM(t, run); math.Abs(got-tc.want) > 1e-4 {
			t.Errorf("validator length of a %gmm-chord arc = %.6f, want %.4f", tc.chord, got, tc.want)
		}
	}
}

// The property the auto-split leans on, for single arcs up to 2m of chord
// (~2.3m of glass). It does not hold without bound; the next test pins where
// it ends.
func TestValidatorNeverMeasuresAnArcLongerThanRTheta(t *testing.T) {
	for chord := 1.0; chord <= 2000; chord *= 1.05 {
		for _, dir := range [][2]float64{{1, 0}, {0.6, 0.8}, {-0.28, 0.96}} {
			for _, kind := range []string{designdoc.SegmentArc, designdoc.SegmentArcR} {
				run := designdoc.Run{ID: "r", Polyline: designdoc.Polyline{
					Points:       [][2]float64{{10, 10}, {10 + chord*dir[0], 10 + chord*dir[1]}},
					SegmentTypes: []string{kind},
				}}
				v, rt := validatorLengthMM(t, run), run.Polyline.LengthMM()
				if v > rt+1e-9 {
					t.Fatalf("chord %.1fmm %s: validator %.6f > r*theta %.6f", chord, kind, v, rt)
				}
			}
		}
	}
}

// Known limit, pinned so it is visible rather than discovered. ToSVG emits an
// arc as two cubics (designdoc.ArcCubics), which run ~5 parts per million
// longer than the circle. The validator's 0.05mm flattening falls short of
// the curve by an amount that shrinks as the radius grows, so on an arc of
// roughly 2.2m of chord or more the cubics win and the validator measures a
// hair OVER r*theta. A piece cut to within that hair of the limit could then
// be flagged. If this test starts failing because the validator no longer
// exceeds r*theta, the 2m bound above can be lifted.
func TestValidatorExceedsRThetaOnlyByTheCubicErrorOnVeryLongArcs(t *testing.T) {
	run := arcRun("r", [2]float64{0, 0}, [2]float64{3000, 0})
	v, rt := validatorLengthMM(t, run), run.Polyline.LengthMM()
	if v <= rt {
		t.Fatalf("validator %.6f <= r*theta %.6f on a 3m chord; the documented limit has moved", v, rt)
	}
	if ppm := (v - rt) / rt * 1e6; ppm > 10 {
		t.Errorf("validator exceeds r*theta by %.2f ppm on a 3m chord, want under 10", ppm)
	}
}

func TestAutoSplitPiecesAreNotFlaggedOverlong(t *testing.T) {
	intactA := arcRun("a", [2]float64{0, 0}, [2]float64{900, 0})
	intactB := arcRun("b", [2]float64{900, 0}, [2]float64{1800, 0})

	// Negative control: what the pre-#178 walk did at splitLimitMM. It
	// measured each intact 900mm arc by the 5° flattening, under the limit,
	// so it cut twoArcs() at the middle vertex and called both halves fixed.
	// The real rule flags both.
	for _, r := range []designdoc.Run{intactA, intactB} {
		if old := fiveDegreeLengthMM(r); old > splitLimitMM {
			t.Fatalf("premise: old measure %.4f should be under %g", old, splitLimitMM)
		}
	}
	if n := overlongIssues(t, docOfRuns(intactA, intactB), splitLimitMM); n != 2 {
		t.Fatalf("pre-#178 pieces: %d max_segment_length issues, want 2 (negative control)", n)
	}
	// r*theta refuses those halves, which is why the new walk cuts again.
	if rt := intactA.Polyline.LengthMM(); rt <= splitLimitMM {
		t.Fatalf("r*theta %.4f should be over %g", rt, splitLimitMM)
	}

	// The pieces the editor makes now: nothing flagged.
	var runs []designdoc.Run
	for i, pts := range splitAtLimitPieces {
		r := designdoc.Run{ID: string(rune('p' + i)), Polyline: designdoc.Polyline{Points: pts}}
		if rt := r.Polyline.LengthMM(); rt > splitLimitMM {
			t.Fatalf("piece %d is %.4fmm by r*theta, over %g", i, rt, splitLimitMM)
		}
		runs = append(runs, r)
	}
	if n := overlongIssues(t, docOfRuns(runs...), splitLimitMM); n != 0 {
		t.Errorf("auto-split pieces: %d max_segment_length issues, want 0", n)
	}

	// At a limit just above r*theta the cut lands on the middle vertex and
	// both arcs survive intact, each within 0.003mm of the limit by r*theta.
	// The validator still passes them: it measures under r*theta.
	if n := overlongIssues(t, docOfRuns(intactA, intactB), splitLimitTightMM); n != 0 {
		t.Errorf("intact arcs at %g: %d max_segment_length issues, want 0", splitLimitTightMM, n)
	}
}
