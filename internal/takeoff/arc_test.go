package takeoff

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// The takeoff's live length becomes glass footage and then the estimate, so an
// arc measured as its chord under-orders tube and under-bills the job by ~14%
// of every curved run.
func TestTakeoffMeasuresArcsNotChords(t *testing.T) {
	pts := [][2]float64{{0, 0}, {300, 0}}

	mk := func(arc bool) *designdoc.Doc {
		pl := designdoc.Polyline{Points: pts}
		if arc {
			pl.SegmentTypes = []string{designdoc.SegmentArc}
		}
		return &designdoc.Doc{
			Version:   1,
			ViewBoxMM: [4]float64{0, 0, 400, 400},
			Runs:      []designdoc.Run{{ID: "r1", Polyline: pl, TubeDiameterMM: 12}},
		}
	}

	straight := Compute(mk(false), spec12(), DefaultYield(), DefaultLabourModel(), Inputs{})
	curved := Compute(mk(true), spec12(), DefaultYield(), DefaultLabourModel(), Inputs{})

	ratio := curved.Summary.NetTubeFt / straight.Summary.NetTubeFt
	// The arc is 1.15911x the chord; both runs also carry the same electrode
	// tails, so the ratio lands between 1 and that, and must be clearly > 1.
	if ratio <= 1.0001 {
		t.Errorf("curved run measured %vmm vs straight %vmm — the arc was billed as its chord",
			curved.Summary.NetTubeFt, straight.Summary.NetTubeFt)
	}
	wantDeltaFt := 300 * (0.625*4*math.Atan(0.5) - 1) / MMPerFoot
	gotDeltaFt := curved.Summary.NetTubeFt - straight.Summary.NetTubeFt
	if math.Abs(gotDeltaFt-wantDeltaFt) > 0.001 {
		t.Errorf("arc added %v ft of glass, want %v ft", gotDeltaFt, wantDeltaFt)
	}
}

// An all-line segment_types array must not move a single number.
func TestTakeoffUnchangedWithoutArcs(t *testing.T) {
	pts := [][2]float64{{0, 0}, {100, 0}, {100, 100}}
	mk := func(withField bool) *designdoc.Doc {
		pl := designdoc.Polyline{Points: pts}
		if withField {
			pl.SegmentTypes = []string{designdoc.SegmentLine, designdoc.SegmentLine}
		}
		return &designdoc.Doc{
			Version:   1,
			ViewBoxMM: [4]float64{0, 0, 200, 200},
			Runs:      []designdoc.Run{{ID: "r1", Polyline: pl, TubeDiameterMM: 12}},
		}
	}
	a := Compute(mk(false), spec12(), DefaultYield(), DefaultLabourModel(), Inputs{})
	b := Compute(mk(true), spec12(), DefaultYield(), DefaultLabourModel(), Inputs{})
	if a.Summary != b.Summary {
		t.Errorf("an inert segment_types array changed the takeoff:\n  %+v\n  %+v", a.Summary, b.Summary)
	}
}
