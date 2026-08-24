package takeoff

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

const eps = 1e-6

func spec12() Spec { return Spec{DiameterMM: 12} }

// openRun builds a run with no electrodes, so glass length equals live length
// and the stick arithmetic can be asserted without a lead-in allowance.
func openRun(pts ...[2]float64) designdoc.Run {
	return designdoc.Run{ID: "r", Polyline: designdoc.Polyline{Points: pts}}
}

func docOf(runs ...designdoc.Run) *designdoc.Doc {
	return &designdoc.Doc{Runs: runs}
}

func compute(d *designdoc.Doc) Takeoff {
	return Compute(d, spec12(), DefaultYield(), DefaultLabourModel(), Inputs{})
}

func near(t *testing.T, got, want float64, what string) {
	t.Helper()
	if math.Abs(got-want) > 1e-3 {
		t.Errorf("%s = %v, want %v", what, got, want)
	}
}

func TestNetLength(t *testing.T) {
	tests := []struct {
		name   string
		run    designdoc.Run
		wantMM float64
	}{
		{"straight 3-point", openRun([2]float64{0, 0}, [2]float64{100, 0}, [2]float64{300, 0}), 300},
		{"3-4-5 open", openRun([2]float64{0, 0}, [2]float64{300, 0}, [2]float64{300, 400}), 700},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := compute(docOf(tc.run))
			near(t, got.Summary.NetTubeFt, tc.wantMM/MMPerFoot, "NetTubeFt")
		})
	}
}

// A closed polyline closes the loop; the 3-4-5 triangle is the check that the
// hypotenuse is counted exactly once.
func TestNetLengthClosedAddsClosingSegment(t *testing.T) {
	r := openRun([2]float64{0, 0}, [2]float64{300, 0}, [2]float64{300, 400})
	r.Polyline.Closed = true
	got := compute(docOf(r))
	near(t, got.Summary.NetTubeFt, 1200/MMPerFoot, "NetTubeFt")
}

// The two arcs around a loop differ, and picking the wrong one silently halves
// the glass order. Electrodes sit on adjacent corners so the arcs are unequal.
func TestClosedRunDirectionSelectsArc(t *testing.T) {
	base := designdoc.Run{
		ID: "r",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {1000, 0}, {1000, 400}, {0, 400}},
			Closed: true,
		},
		Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
	}
	for _, tc := range []struct {
		dir    string
		wantMM float64
	}{
		{"forward", 1000},
		{"backward", 1800},
		{"", 1800}, // default picks the longer arc as the live tube
	} {
		t.Run("dir="+tc.dir, func(t *testing.T) {
			r := base
			r.Direction = tc.dir
			got := compute(docOf(r))
			near(t, got.Summary.NetTubeFt, tc.wantMM/MMPerFoot, "NetTubeFt")
		})
	}
}

// Sticks are the unit glass is actually bought in. These boundaries are the
// difference between ordering one stick and two.
func TestStickYieldBoundaries(t *testing.T) {
	for _, tc := range []struct {
		glassMM     float64
		wantSticks  int
		wantSplices int
	}{
		{1219, 1, 0}, // exactly one usable stick at the 1524/305 default
		{1220, 2, 1},
		{2438, 2, 1},
		{2439, 3, 2},
	} {
		got := compute(docOf(openRun([2]float64{0, 0}, [2]float64{tc.glassMM, 0})))
		if got.Summary.StickCount != tc.wantSticks {
			t.Errorf("%.0fmm: sticks = %d, want %d", tc.glassMM, got.Summary.StickCount, tc.wantSticks)
		}
		if got.Summary.SpliceCount != tc.wantSplices {
			t.Errorf("%.0fmm: splices = %d, want %d", tc.glassMM, got.Summary.SpliceCount, tc.wantSplices)
		}
	}
}

// The stick length is data, not a constant. Re-running the same boundaries
// against Miller's 46in blank must move them — if this fails, someone inlined
// a number that belongs on the rate card.
func TestStickLengthIsData(t *testing.T) {
	miller := Yield{StickLengthMM: 1168, StickWasteMM: 304, SheetAreaSqFt: 32}
	for _, tc := range []struct {
		glassMM    float64
		wantSticks int
	}{
		{864, 1}, // Miller's 34in usable
		{865, 2},
	} {
		got := Compute(docOf(openRun([2]float64{0, 0}, [2]float64{tc.glassMM, 0})),
			spec12(), miller, DefaultLabourModel(), Inputs{})
		if got.Summary.StickCount != tc.wantSticks {
			t.Errorf("%.0fmm on Miller blank: sticks = %d, want %d",
				tc.glassMM, got.Summary.StickCount, tc.wantSticks)
		}
	}
	// And the same length yields differently under the two regimes.
	run := docOf(openRun([2]float64{0, 0}, [2]float64{1000, 0}))
	if a, b := compute(run).Summary.GrossGlassFt,
		Compute(run, spec12(), miller, DefaultLabourModel(), Inputs{}).Summary.GrossGlassFt; a == b {
		t.Errorf("gross glass identical (%v) across stick regimes; lengths are not data", a)
	}
}

func TestLeadInClamp(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	for _, tc := range []struct {
		name string
		spec Spec
		want float64
	}{
		{"derived 2xD below floor", Spec{DiameterMM: 12}, MinLeadInFloorMM},
		{"derived 2xD in band", Spec{DiameterMM: 40}, 80},
		{"override above ceiling", Spec{DiameterMM: 12, MinLeadInMM: f(500)}, MinLeadInCeilMM},
		{"override below floor", Spec{DiameterMM: 12, MinLeadInMM: f(10)}, MinLeadInFloorMM},
		{"override in band", Spec{DiameterMM: 12, MinLeadInMM: f(100)}, 100},
	} {
		if got := EffectiveLeadInMM(tc.spec); math.Abs(got-tc.want) > eps {
			t.Errorf("%s: lead-in = %v, want %v", tc.name, got, tc.want)
		}
	}
}

// The lead-in is real glass: a run with electrodes orders more than it lights.
func TestElectrodeTailsAddGlass(t *testing.T) {
	r := openRun([2]float64{0, 0}, [2]float64{1000, 0})
	r.Electrodes = []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}}
	got := compute(docOf(r))
	// 1000 live + 2x50 lead-in = 1100mm glass, still inside one 1219mm stick.
	near(t, got.Summary.NetTubeFt, 1000/MMPerFoot, "NetTubeFt")
	if got.Summary.StickCount != 1 {
		t.Errorf("sticks = %d, want 1", got.Summary.StickCount)
	}
	// Push live length so that only the tails tip it over a stick boundary.
	r2 := openRun([2]float64{0, 0}, [2]float64{1150, 0})
	r2.Electrodes = r.Electrodes
	if s := compute(docOf(r2)).Summary.StickCount; s != 2 {
		t.Errorf("1150mm + tails: sticks = %d, want 2 (tails must count)", s)
	}
}

func TestJumpersExcludedFromNetAndCounts(t *testing.T) {
	primary := openRun([2]float64{0, 0}, [2]float64{1000, 0})
	primary.Electrodes = []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}}
	jumper := openRun([2]float64{0, 0}, [2]float64{200, 0})
	jumper.ID = "j"
	jumper.Kind = "jumper"
	jumper.Electrodes = []designdoc.Electrode{{PointIndex: 0}}

	got := compute(docOf(primary, jumper))
	near(t, got.Summary.NetTubeFt, 1000/MMPerFoot, "NetTubeFt")
	near(t, got.Summary.JumperFt, 200/MMPerFoot, "JumperFt")
	if got.Summary.RunCount != 1 || got.Summary.JumperCount != 1 {
		t.Errorf("runs=%d jumpers=%d, want 1/1", got.Summary.RunCount, got.Summary.JumperCount)
	}
	if got.Summary.ElectrodeCount != 2 {
		t.Errorf("electrodes = %d, want 2 (jumper's must not count)", got.Summary.ElectrodeCount)
	}
}

// Glass is ordered per colour. Two colours must not collapse into one line,
// and the split must not lose length.
func TestTubeGroupingByColour(t *testing.T) {
	purple := openRun([2]float64{0, 0}, [2]float64{1000, 0})
	purple.Color = "purple"
	green := openRun([2]float64{0, 0}, [2]float64{600, 0})
	green.ID = "g"
	green.Color = "green"

	got := compute(docOf(purple, green))

	var tubes []Line
	var grossFt float64
	for _, l := range got.Lines {
		if l.Kind == KindTube {
			tubes = append(tubes, l)
			grossFt += l.Qty
		}
	}
	if len(tubes) != 2 {
		t.Fatalf("tube lines = %d, want 2", len(tubes))
	}
	seen := map[string]bool{}
	for _, l := range tubes {
		seen[l.Qualifier] = true
	}
	for _, q := range []string{"12mm/purple", "12mm/green"} {
		if !seen[q] {
			t.Errorf("missing tube qualifier %q (got %v)", q, seen)
		}
	}
	near(t, grossFt, got.Summary.GrossGlassFt, "sum of tube lines vs GrossGlassFt")
	near(t, got.Summary.NetTubeFt, 1600/MMPerFoot, "NetTubeFt")
}

func TestBlockoutLength(t *testing.T) {
	r := openRun([2]float64{0, 0}, [2]float64{300, 0}, [2]float64{600, 0}, [2]float64{900, 0})
	r.Blockouts = []designdoc.Blockout{{StartLiveIndex: 1, EndLiveIndex: 3}}
	got := compute(docOf(r))
	near(t, got.Summary.BlockoutFt, 600/MMPerFoot, "BlockoutFt")

	// Out-of-range indices clamp rather than panic or over-count.
	r.Blockouts = []designdoc.Blockout{{StartLiveIndex: -5, EndLiveIndex: 99}}
	near(t, compute(docOf(r)).Summary.BlockoutFt, 900/MMPerFoot, "clamped BlockoutFt")
}

func TestElectrodePairsAndPumpedSections(t *testing.T) {
	mk := func(id string, n int) designdoc.Run {
		r := openRun([2]float64{0, 0}, [2]float64{500, 0})
		r.ID = id
		for i := 0; i < n; i++ {
			r.Electrodes = append(r.Electrodes, designdoc.Electrode{PointIndex: i % 2})
		}
		return r
	}
	got := compute(docOf(mk("a", 2), mk("b", 2), mk("c", 1)))
	if got.Summary.ElectrodeCount != 5 {
		t.Errorf("electrodes = %d, want 5", got.Summary.ElectrodeCount)
	}
	if got.Summary.ElectrodePairs != 3 { // ceil(5/2) — EGL sells in pairs
		t.Errorf("pairs = %d, want 3", got.Summary.ElectrodePairs)
	}
	if got.Summary.PumpedSections != 2 {
		t.Errorf("pumped sections = %d, want 2", got.Summary.PumpedSections)
	}
}

// The bounding box overestimates a shaped panel, and the sheet count
// overestimates again. Both numbers must survive to the caller.
func TestBackingBBoxAndSheetYield(t *testing.T) {
	d := docOf(openRun([2]float64{0, 0}, [2]float64{500, 0}))
	d.ViewBoxMM = [4]float64{0, 0, 914.4, 609.6} // 36in x 24in = 6 sq ft
	got := compute(d)
	near(t, got.Summary.BackingBBoxSqFt, 6, "BackingBBoxSqFt")
	if !got.Summary.BackingIsBBox {
		t.Error("BackingIsBBox = false, want true when derived from the view box")
	}
	if got.Summary.BackingSheets != 1 {
		t.Errorf("sheets = %d, want 1 (6 sq ft out of a 32 sq ft sheet)", got.Summary.BackingSheets)
	}

	override := 40.0
	got2 := Compute(d, spec12(), DefaultYield(), DefaultLabourModel(), Inputs{BackingSqFt: &override})
	if got2.Summary.BackingIsBBox {
		t.Error("BackingIsBBox = true after an explicit override")
	}
	if got2.Summary.BackingSheets != 2 {
		t.Errorf("sheets = %d, want 2 for 40 sq ft", got2.Summary.BackingSheets)
	}
}

func TestFabricationHoursTracksNetFootage(t *testing.T) {
	// 10 ft of net tube at the calibrated 30 + 30/ft => 330 min => 5.5 h.
	tenFt := 10 * MMPerFoot
	got := compute(docOf(openRun([2]float64{0, 0}, [2]float64{tenFt, 0})))
	near(t, got.Summary.FabricationHours, 5.5, "FabricationHours")
}

func TestUnitConversions(t *testing.T) {
	got := compute(docOf(openRun([2]float64{0, 0}, [2]float64{MMPerFoot, 0})))
	near(t, got.Summary.NetTubeFt, 1, "one foot")

	d := docOf(openRun([2]float64{0, 0}, [2]float64{100, 0}))
	d.ViewBoxMM = [4]float64{0, 0, math.Sqrt(MM2PerSqFt), math.Sqrt(MM2PerSqFt)}
	near(t, compute(d).Summary.BackingBBoxSqFt, 1, "one square foot")
}

func TestEmptyAndNilDocsAreSafe(t *testing.T) {
	for _, tc := range []struct {
		name string
		doc  *designdoc.Doc
	}{
		{"nil", nil},
		{"empty", &designdoc.Doc{}},
		{"degenerate run", docOf(openRun([2]float64{0, 0}))},
	} {
		got := compute(tc.doc)
		if len(got.Lines) != 0 {
			t.Errorf("%s: lines = %d, want 0", tc.name, len(got.Lines))
		}
		if got.Summary.FabricationHours != 0 {
			t.Errorf("%s: fabrication hours = %v, want 0", tc.name, got.Summary.FabricationHours)
		}
	}
}

// A zero or negative yield is a misconfiguration; it must not divide by zero
// and report infinite glass.
func TestDegenerateYieldFallsBack(t *testing.T) {
	got := Compute(docOf(openRun([2]float64{0, 0}, [2]float64{1000, 0})),
		spec12(), Yield{}, DefaultLabourModel(), Inputs{})
	if got.Summary.StickCount != 1 {
		t.Errorf("sticks = %d, want 1 under a zero yield fallback", got.Summary.StickCount)
	}
	if math.IsInf(got.Summary.GrossGlassFt, 0) || math.IsNaN(got.Summary.GrossGlassFt) {
		t.Errorf("gross glass = %v", got.Summary.GrossGlassFt)
	}
	waste := Yield{StickLengthMM: 1000, StickWasteMM: 1000, SheetAreaSqFt: 32}
	got2 := Compute(docOf(openRun([2]float64{0, 0}, [2]float64{500, 0})),
		spec12(), waste, DefaultLabourModel(), Inputs{})
	if got2.Summary.StickCount != 1 {
		t.Errorf("all-waste stick: sticks = %d, want 1", got2.Summary.StickCount)
	}
}
