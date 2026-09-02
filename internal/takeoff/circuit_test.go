package takeoff

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// letterRun is one bent letter: an L of the given leg length, with an
// electrode pair. Long enough that the lead-in allowance matters, short enough
// that one stick covers it.
func letterRun(id string, x, legMM float64) designdoc.Run {
	return designdoc.Run{
		ID:    id,
		Color: "red",
		Polyline: designdoc.Polyline{Points: [][2]float64{
			{x, 0}, {x + legMM, 0}, {x + legMM, legMM},
		}},
		Electrodes: []designdoc.Electrode{
			{PointIndex: 0, HousingType: "shell-15"},
			{PointIndex: 2, HousingType: "shell-15"},
		},
	}
}

// fourLetters is the fixture behind every assertion here: four separate bent
// letters, 350 mm of glass each, each carrying the electrode pair a designer
// naturally drops on a run.
func fourLetters() *designdoc.Doc {
	d := &designdoc.Doc{Version: designdoc.SchemaVersion, ViewBoxMM: [4]float64{0, 0, 1600, 400}}
	for i, id := range []string{"r1", "r2", "r3", "r4"} {
		d.Runs = append(d.Runs, letterRun(id, float64(i)*400, 175))
	}
	return d
}

// intoOneCircuit returns the same fixture with the only difference this row is
// about: the four runs are declared one circuit.
func intoOneCircuit() *designdoc.Doc {
	d := fourLetters()
	d.Circuits = []designdoc.Circuit{{ID: "c1", Name: "Main"}}
	for i := range d.Runs {
		d.Runs[i].CircuitID = "c1"
	}
	return d
}

func lineQty(t *testing.T, tk Takeoff, kind string) (float64, bool) {
	t.Helper()
	for _, l := range tk.Lines {
		if l.Kind == kind {
			return l.Qty, true
		}
	}
	return 0, false
}

// goldenNoCircuitsSHA256 pins the serialized takeoff of a circuit-free doc.
//
// This is the compatibility rule the whole design hangs off, and it is pinned
// as BYTES rather than as field assertions on purpose: every stored design,
// every stored validation_report and every downstream digest depends on the
// existing per-run derivation, and a field-by-field check cannot see a new
// JSON key appear. If this digest moves, a doc that models no circuits started
// serializing differently — which is a back-compat break, not a test to
// update. (The two additive fields, summary.circuit_count and takeoff
// .circuits, are omitempty precisely so this stays put.)
const goldenNoCircuitsSHA256 = "b877c58357293ef4d358adb6e1846c7550dff2dce3c57f737f95f934ddb64da8"

func TestTakeoffWithoutCircuitsIsByteIdentical(t *testing.T) {
	raw, err := json.Marshal(compute(fourLetters()))
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	sum := sha256.Sum256(raw)
	if got := hex.EncodeToString(sum[:]); got != goldenNoCircuitsSHA256 {
		t.Errorf("takeoff JSON for a circuit-free doc changed.\n got %s\nwant %s\njson: %s",
			got, goldenNoCircuitsSHA256, raw)
	}
	// Belt and braces: neither additive key may appear at all.
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if _, ok := m["circuits"]; ok {
		t.Error("circuit-free takeoff emitted a circuits key")
	}
	var s map[string]json.RawMessage
	if err := json.Unmarshal(m["summary"], &s); err != nil {
		t.Fatalf("unmarshal summary: %v", err)
	}
	if _, ok := s["circuit_count"]; ok {
		t.Error("circuit-free takeoff emitted a summary.circuit_count key")
	}
}

// TestCircuitCollapsesElectrodeDerivedQuantities is the headline: four runs in
// one circuit yield ONE electrode pair and therefore one transformer, one gas
// fill and two boots — not four, four and eight.
func TestCircuitCollapsesElectrodeDerivedQuantities(t *testing.T) {
	before := compute(fourLetters())
	after := compute(intoOneCircuit())

	if before.Summary.ElectrodePairs != 4 || before.Summary.PumpedSections != 4 {
		t.Fatalf("fixture is not the case under test: pairs=%d sections=%d",
			before.Summary.ElectrodePairs, before.Summary.PumpedSections)
	}
	if after.Summary.ElectrodeCount != 2 {
		t.Errorf("electrodes = %d, want 2", after.Summary.ElectrodeCount)
	}
	if after.Summary.ElectrodePairs != 1 {
		t.Errorf("pairs = %d, want 1", after.Summary.ElectrodePairs)
	}
	if after.Summary.PumpedSections != 1 {
		t.Errorf("pumped sections = %d, want 1", after.Summary.PumpedSections)
	}
	if after.Summary.HousingCount != 2 {
		t.Errorf("housings = %d, want 2", after.Summary.HousingCount)
	}
	if after.Summary.CircuitCount != 1 {
		t.Errorf("circuit count = %d, want 1", after.Summary.CircuitCount)
	}

	gasBefore, _ := lineQty(t, before, KindGasFill)
	gasAfter, _ := lineQty(t, after, KindGasFill)
	if gasBefore != 4 || gasAfter != 1 {
		t.Errorf("gas fills %v → %v, want 4 → 1", gasBefore, gasAfter)
	}
	bootsBefore, _ := lineQty(t, before, KindBootEndcap)
	bootsAfter, _ := lineQty(t, after, KindBootEndcap)
	if bootsBefore != 8 || bootsAfter != 2 {
		t.Errorf("boots %v → %v, want 8 → 2", bootsBefore, bootsAfter)
	}
	elecBefore, _ := lineQty(t, before, KindElectrode)
	elecAfter, _ := lineQty(t, after, KindElectrode)
	if elecBefore != 4 || elecAfter != 1 {
		t.Errorf("electrode pairs line %v → %v, want 4 → 1", elecBefore, elecAfter)
	}

	// Negative control: the runs still exist, still measure the same glass,
	// and still carry every electrode the designer placed. A circuit caps a
	// derivation; it does not edit the document.
	if before.Summary.RunCount != after.Summary.RunCount {
		t.Errorf("run count moved: %d → %d", before.Summary.RunCount, after.Summary.RunCount)
	}
	if before.Summary.NetTubeFt != after.Summary.NetTubeFt {
		t.Errorf("net footage moved: %v → %v", before.Summary.NetTubeFt, after.Summary.NetTubeFt)
	}
}

// TestCircuitDoesNotChangeStickYield is the decision this row deliberately did
// NOT make. Sticks are counted per run, and grouping runs into a circuit is a
// wiring statement, not a licence to nest offcuts: four 350 mm letters are four
// physical pieces of bent glass and need four sticks, while ceiling the
// circuit's 1400 mm against a 1219 mm usable stick would order two. The only
// glass that moves is the lead-in allowance, which follows the electrodes.
func TestCircuitDoesNotChangeStickYield(t *testing.T) {
	before := compute(fourLetters())
	after := compute(intoOneCircuit())

	if before.Summary.StickCount != 4 {
		t.Fatalf("fixture sticks = %d, want 4", before.Summary.StickCount)
	}
	if after.Summary.StickCount != 4 {
		t.Errorf("sticks after grouping = %d, want 4 — a circuit must not be read as a cut plan",
			after.Summary.StickCount)
	}
	if after.Summary.GrossGlassFt != before.Summary.GrossGlassFt {
		t.Errorf("gross glass moved on stick count: %v → %v",
			before.Summary.GrossGlassFt, after.Summary.GrossGlassFt)
	}
}

// TestCircuitLeadInIsPaidOnce — the interior ends of a circuit are splices,
// and a splice has no lead-in. Four runs each claiming two tails is 8 × 50 mm
// of glass ordered for electrodes the circuit does not have.
func TestCircuitLeadInIsPaidOnce(t *testing.T) {
	// A fixture whose glass sits just under a stick boundary so the tails
	// are visible in the stick count rather than being absorbed.
	mk := func(circuited bool) *designdoc.Doc {
		d := &designdoc.Doc{Version: designdoc.SchemaVersion}
		for i, id := range []string{"a", "b"} {
			r := designdoc.Run{
				ID:    id,
				Color: "red",
				Polyline: designdoc.Polyline{Points: [][2]float64{
					{0, float64(i) * 10}, {1200, float64(i) * 10},
				}},
				Electrodes: []designdoc.Electrode{{PointIndex: 0}, {PointIndex: 1}},
			}
			if circuited {
				r.CircuitID = "c1"
			}
			d.Runs = append(d.Runs, r)
		}
		if circuited {
			d.Circuits = []designdoc.Circuit{{ID: "c1"}}
		}
		return d
	}
	// 1200 mm of live glass + 2 × 50 mm lead-in = 1300 mm > 1219 usable, so
	// each free run needs two sticks.
	before := compute(mk(false))
	if before.Summary.StickCount != 4 {
		t.Fatalf("free runs: sticks = %d, want 4", before.Summary.StickCount)
	}
	// In one circuit the pair is spent on run "a": it still needs two
	// sticks, but "b" is interior glass at 1200 mm and fits one.
	after := compute(mk(true))
	if after.Summary.StickCount != 3 {
		t.Errorf("circuit: sticks = %d, want 3 (the second run's phantom tails are gone)",
			after.Summary.StickCount)
	}
}

// TestCircuitBreakdown pins the per-circuit report, including a circuit an
// operator created and left empty and a run left out of every circuit.
func TestCircuitBreakdown(t *testing.T) {
	d := fourLetters()
	d.Circuits = []designdoc.Circuit{{ID: "c1", Name: "Main"}, {ID: "c2"}}
	d.Runs[0].CircuitID = "c1"
	d.Runs[1].CircuitID = "c1"
	d.Runs[2].CircuitID = "c1"
	// r4 stays free.

	got := compute(d)
	if len(got.Circuits) != 2 {
		t.Fatalf("circuits reported = %d, want 2", len(got.Circuits))
	}
	c1 := got.Circuits[0]
	if c1.ID != "c1" || c1.Name != "Main" {
		t.Errorf("first circuit = %+v", c1)
	}
	if c1.RunCount != 3 {
		t.Errorf("c1 runs = %d, want 3", c1.RunCount)
	}
	if c1.ElectrodePairs != 1 {
		t.Errorf("c1 pairs = %d, want 1", c1.ElectrodePairs)
	}
	if c1.StickCount != 3 {
		t.Errorf("c1 sticks = %d, want 3 (one per member run)", c1.StickCount)
	}
	near(t, c1.NetTubeFt, 3*350/MMPerFoot, "c1 net")
	near(t, c1.GrossGlassFt, 3*1524/MMPerFoot, "c1 gross")

	c2 := got.Circuits[1]
	if c2.ID != "c2" || c2.RunCount != 0 || c2.StickCount != 0 || c2.ElectrodePairs != 0 {
		t.Errorf("empty circuit should report zeros: %+v", c2)
	}

	// The free run keeps its own pair on top of the circuit's.
	if got.Summary.ElectrodePairs != 2 {
		t.Errorf("pairs = %d, want 2 (one circuit + one free run)", got.Summary.ElectrodePairs)
	}
	if got.Summary.PumpedSections != 2 {
		t.Errorf("pumped sections = %d, want 2", got.Summary.PumpedSections)
	}
}

// TestCircuitWithNoElectrodesBuysNothing — grouping runs that carry no
// electrodes must not invent a pair out of the grouping itself.
func TestCircuitWithNoElectrodesBuysNothing(t *testing.T) {
	d := docOf(openRun([2]float64{0, 0}, [2]float64{500, 0}))
	d.Runs[0].CircuitID = "c1"
	d.Circuits = []designdoc.Circuit{{ID: "c1"}}
	got := compute(d)
	if got.Summary.ElectrodePairs != 0 || got.Summary.PumpedSections != 0 {
		t.Errorf("electrode-free circuit derived pairs=%d sections=%d, want 0/0",
			got.Summary.ElectrodePairs, got.Summary.PumpedSections)
	}
	if len(got.Circuits) != 1 || got.Circuits[0].RunCount != 1 {
		t.Errorf("breakdown = %+v", got.Circuits)
	}
}

// TestUndeclaredCircuitIDFallsBackToPerRun — a circuit_id naming nothing in
// Doc.Circuits must derive exactly what it derived before this field existed.
// designdoc's decoder rejects that shape so it cannot arrive over the wire,
// but an in-memory doc must not silently lose its pairs to a typo'd id.
// designdoc.RacewayTransformerCount makes the same choice.
func TestUndeclaredCircuitIDFallsBackToPerRun(t *testing.T) {
	d := fourLetters()
	for i := range d.Runs {
		d.Runs[i].CircuitID = "ghost" // never declared
	}
	got := compute(d)
	if got.Summary.ElectrodePairs != 4 || got.Summary.PumpedSections != 4 {
		t.Errorf("pairs=%d sections=%d, want 4/4 — an undeclared id must cap nothing",
			got.Summary.ElectrodePairs, got.Summary.PumpedSections)
	}
	if got.Summary.CircuitCount != 0 || got.Circuits != nil {
		t.Errorf("undeclared id invented a circuit: count=%d %+v",
			got.Summary.CircuitCount, got.Circuits)
	}
	// Negative control: declaring it collapses to one pair.
	d.Circuits = []designdoc.Circuit{{ID: "ghost"}}
	if got := compute(d); got.Summary.ElectrodePairs != 1 {
		t.Errorf("pairs = %d, want 1 once the circuit is declared", got.Summary.ElectrodePairs)
	}
}
