package designdoc

import (
	"encoding/json"
	"math"
	"strings"
	"testing"
)

// A bulge of 0.5 fixes every other number about the arc. These are the values
// the SVG writer, the PDF, the DXF emitter and the bend list all inherit, so
// they are pinned here rather than recomputed in each.
func TestArcForGeometry(t *testing.T) {
	p0 := [2]float64{0, 0}
	p1 := [2]float64{100, 0}
	a, ok := ArcFor(p0, p1)
	if !ok {
		t.Fatal("ArcFor returned !ok for a 100mm chord")
	}
	if got, want := a.RadiusMM, 62.5; math.Abs(got-want) > 1e-9 {
		t.Errorf("radius = %v, want %v (0.625 x chord)", got, want)
	}
	// Included angle 4*atan(0.5); arc length = r*theta.
	wantLen := 62.5 * 4 * math.Atan(0.5)
	if math.Abs(a.IncludedMM-wantLen) > 1e-9 {
		t.Errorf("arc length = %v, want %v", a.IncludedMM, wantLen)
	}
	// ~15.9% longer than the chord it replaces.
	if ratio := a.IncludedMM / 100; math.Abs(ratio-1.15911) > 1e-4 {
		t.Errorf("arc/chord ratio = %v, want ~1.15911", ratio)
	}
	// Both endpoints must sit exactly on the circle.
	for _, p := range [][2]float64{p0, p1} {
		d := math.Hypot(p[0]-a.CX, p[1]-a.CY)
		if math.Abs(d-a.RadiusMM) > 1e-9 {
			t.Errorf("endpoint %v is %v from the centre, want radius %v", p, d, a.RadiusMM)
		}
	}
}

// The apex must bow out by exactly a quarter of the chord, on the side the
// convention promises — that IS the definition of bulge 0.5.
func TestArcSagittaAndSide(t *testing.T) {
	p0 := [2]float64{0, 0}
	p1 := [2]float64{100, 0}
	pts := FlattenSegment(p0, p1, true)
	var apex [2]float64
	best := 0.0
	for _, p := range pts {
		if d := math.Abs(p[1]); d > best {
			best, apex = d, p
		}
	}
	if math.Abs(best-25) > 0.05 {
		t.Errorf("sagitta = %v, want 25 (chord/4)", best)
	}
	// Chord runs +x, so the normal (-dy, dx) is +y: the arc bows to +y.
	if apex[1] <= 0 {
		t.Errorf("arc bowed to %v, want the +y side per the convention", apex[1])
	}
	// Sampling must land exactly on the declared endpoint.
	last := pts[len(pts)-1]
	if last != p1 {
		t.Errorf("flattened arc ends at %v, want exactly %v", last, p1)
	}
}

// Flattening is only useful if it actually approximates the circle.
func TestFlattenSegmentStaysOnTheCircle(t *testing.T) {
	p0 := [2]float64{10, 20}
	p1 := [2]float64{90, 75}
	a, _ := ArcFor(p0, p1)
	pts := FlattenSegment(p0, p1, true)
	for _, p := range pts {
		d := math.Hypot(p[0]-a.CX, p[1]-a.CY)
		if math.Abs(d-a.RadiusMM) > 1e-6 {
			t.Fatalf("sample %v is %v from the centre, want %v", p, d, a.RadiusMM)
		}
	}
	// The flattened chain must be within a hair of the true arc length.
	sum := 0.0
	prev := p0
	for _, p := range pts {
		sum += math.Hypot(p[0]-prev[0], p[1]-prev[1])
		prev = p
	}
	if rel := math.Abs(sum-a.IncludedMM) / a.IncludedMM; rel > 1e-3 {
		t.Errorf("flattened length %v vs true %v (%.4f%% off)", sum, a.IncludedMM, rel*100)
	}
}

func TestArcForDegenerateChord(t *testing.T) {
	if _, ok := ArcFor([2]float64{5, 5}, [2]float64{5, 5}); ok {
		t.Error("a zero-length chord defines no circle; want ok=false")
	}
	// The safe fallback is to treat it as a line, not to panic or emit NaN.
	if got := ArcSegmentLengthMM([2]float64{5, 5}, [2]float64{5, 5}, true); got != 0 {
		t.Errorf("degenerate arc length = %v, want 0", got)
	}
	if got := FlattenSegment([2]float64{5, 5}, [2]float64{5, 5}, true); len(got) != 1 {
		t.Errorf("degenerate arc flattened to %d points, want 1", len(got))
	}
}

func TestPolylineLengthWithArcs(t *testing.T) {
	// Two 100mm segments: one straight, one arc.
	pl := Polyline{
		Points:       [][2]float64{{0, 0}, {100, 0}, {200, 0}},
		SegmentTypes: []string{SegmentLine, SegmentArc},
	}
	want := 100 + 62.5*4*math.Atan(0.5)
	if got := pl.LengthMM(); math.Abs(got-want) > 1e-9 {
		t.Errorf("length = %v, want %v", got, want)
	}
	// Same points, no arcs: the plain chord sum. Proves the field is what
	// makes the difference, not the point list.
	plain := Polyline{Points: pl.Points}
	if got := plain.LengthMM(); math.Abs(got-200) > 1e-9 {
		t.Errorf("all-line length = %v, want 200", got)
	}
}

func TestSegmentTypeDefaultsToLine(t *testing.T) {
	pl := Polyline{Points: [][2]float64{{0, 0}, {1, 0}, {2, 0}}}
	for _, i := range []int{-1, 0, 1, 2, 99} {
		if got := pl.SegmentType(i); got != SegmentLine {
			t.Errorf("SegmentType(%d) = %q on a nil array, want %q", i, got, SegmentLine)
		}
	}
	if pl.HasArcs() {
		t.Error("a nil SegmentTypes must not report arcs")
	}
	// FlatPoints must hand back the very same slice when there is nothing to
	// expand — the no-arc path has to stay free.
	if &pl.FlatPoints()[0] != &pl.Points[0] {
		t.Error("FlatPoints copied an all-line polyline")
	}
}

func TestSegmentCount(t *testing.T) {
	cases := []struct {
		n      int
		closed bool
		want   int
	}{{0, false, 0}, {1, false, 0}, {2, false, 1}, {5, false, 4}, {5, true, 5}, {1, true, 0}}
	for _, c := range cases {
		pts := make([][2]float64, c.n)
		pl := Polyline{Points: pts, Closed: c.closed}
		if got := pl.SegmentCount(); got != c.want {
			t.Errorf("SegmentCount(%d points, closed=%v) = %d, want %d", c.n, c.closed, got, c.want)
		}
	}
}

// The invariant has to hold at the door. A SegmentTypes array that disagrees
// with the point count would leave every consumer with a different idea of
// which segment is curved.
func TestPolylineUnmarshalValidation(t *testing.T) {
	cases := []struct {
		name    string
		json    string
		wantErr string
	}{
		{
			name: "valid open",
			json: `{"points":[[0,0],[1,0],[2,0]],"closed":false,"segment_types":["line","arc"]}`,
		},
		{
			name: "valid closed counts the closing segment",
			json: `{"points":[[0,0],[1,0],[2,0]],"closed":true,"segment_types":["line","arc","line"]}`,
		},
		{
			name: "nil array is always fine",
			json: `{"points":[[0,0],[1,0]],"closed":false}`,
		},
		{
			name:    "too few entries",
			json:    `{"points":[[0,0],[1,0],[2,0]],"closed":false,"segment_types":["line"]}`,
			wantErr: "want 2",
		},
		{
			name:    "too many entries",
			json:    `{"points":[[0,0],[1,0]],"closed":false,"segment_types":["line","arc"]}`,
			wantErr: "want 1",
		},
		{
			name:    "open array on a closed polyline",
			json:    `{"points":[[0,0],[1,0],[2,0]],"closed":true,"segment_types":["line","arc"]}`,
			wantErr: "want 3",
		},
		{
			name:    "unknown value",
			json:    `{"points":[[0,0],[1,0]],"closed":false,"segment_types":["spline"]}`,
			wantErr: `want "line" or "arc"`,
		},
		{
			name:    "unknown key is still rejected",
			json:    `{"points":[[0,0],[1,0]],"closed":false,"segment_typos":["line"]}`,
			wantErr: "unknown field",
		},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			var pl Polyline
			err := json.Unmarshal([]byte(c.json), &pl)
			if c.wantErr == "" {
				if err != nil {
					t.Fatalf("unexpected error: %v", err)
				}
				return
			}
			if err == nil {
				t.Fatalf("expected an error containing %q, got none", c.wantErr)
			}
			if !strings.Contains(err.Error(), c.wantErr) {
				t.Errorf("error %q does not mention %q", err, c.wantErr)
			}
		})
	}
}

// Old blobs must round-trip byte-identically: no segment_types key in, none out.
func TestSegmentTypesBackwardsCompat(t *testing.T) {
	const legacy = `{"points":[[0,0],[100,0]],"closed":false}`
	var pl Polyline
	if err := json.Unmarshal([]byte(legacy), &pl); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if pl.SegmentTypes != nil {
		t.Errorf("legacy polyline gained segment types: %v", pl.SegmentTypes)
	}
	raw, err := json.Marshal(&pl)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), "segment_types") {
		t.Errorf("omitempty failed: %s", raw)
	}
}

// An arc leaves and rejoins its chord at half the included angle. A bend list
// built from raw chords misreports every vertex where an arc meets a line, and
// that number is what the bender sets the jig to.
func TestSegmentTangents(t *testing.T) {
	p0 := [2]float64{0, 0}
	p1 := [2]float64{100, 0}

	lv, ar := SegmentTangents(p0, p1, false)
	if math.Abs(lv[0]-1) > 1e-12 || math.Abs(lv[1]) > 1e-12 || lv != ar {
		t.Errorf("a line's tangents must both be the chord direction, got %v / %v", lv, ar)
	}

	lv, ar = SegmentTangents(p0, p1, true)
	half := 2 * math.Atan(ArcBulge) // θ/2
	// Leaving rotated +θ/2, arriving rotated −θ/2, about the chord.
	if got := math.Atan2(lv[1], lv[0]); math.Abs(got-half) > 1e-12 {
		t.Errorf("leaving tangent at %v rad, want %v", got, half)
	}
	if got := math.Atan2(ar[1], ar[0]); math.Abs(got+half) > 1e-12 {
		t.Errorf("arriving tangent at %v rad, want %v", got, -half)
	}
	// Both must be unit length, or every downstream angle is scaled wrong.
	for _, v := range [][2]float64{lv, ar} {
		if l := math.Hypot(v[0], v[1]); math.Abs(l-1) > 1e-12 {
			t.Errorf("tangent %v has length %v, want 1", v, l)
		}
	}
}

// Three collinear vertices turn 0° when straight — but an arc in the middle
// makes the glass turn at both of its ends.
func TestVertexTurnDegAccountsForArcs(t *testing.T) {
	pl := Polyline{Points: [][2]float64{{0, 0}, {100, 0}, {200, 0}}}
	if got := pl.VertexTurnDeg(0, 1, 2); math.Abs(got) > 1e-9 {
		t.Errorf("collinear straight vertices turn %v°, want 0", got)
	}

	// Arc on the FIRST segment: arriving at vertex 1 rotated −θ/2, leaving
	// along the chord, so the turn is +θ/2.
	pl.SegmentTypes = []string{SegmentArc, SegmentLine}
	halfDeg := 2 * math.Atan(ArcBulge) * 180 / math.Pi
	if got := pl.VertexTurnDeg(0, 1, 2); math.Abs(got-halfDeg) > 1e-9 {
		t.Errorf("turn after an arc = %v°, want %v°", got, halfDeg)
	}

	// Arc on the SECOND segment: arrive straight, leave rotated +θ/2.
	pl.SegmentTypes = []string{SegmentLine, SegmentArc}
	if got := pl.VertexTurnDeg(0, 1, 2); math.Abs(got-halfDeg) > 1e-9 {
		t.Errorf("turn into an arc = %v°, want %v°", got, halfDeg)
	}

	// Arcs both sides: the two half-angles add.
	pl.SegmentTypes = []string{SegmentArc, SegmentArc}
	if got := pl.VertexTurnDeg(0, 1, 2); math.Abs(got-2*halfDeg) > 1e-9 {
		t.Errorf("turn between two arcs = %v°, want %v°", got, 2*halfDeg)
	}
}

// Walking a closed run backwards through an arc must give the mirrored turn,
// not a garbled one.
func TestVertexTurnDegReversedWalk(t *testing.T) {
	pl := Polyline{
		Points:       [][2]float64{{0, 0}, {100, 0}, {200, 0}},
		SegmentTypes: []string{SegmentLine, SegmentArc},
	}
	fwd := pl.VertexTurnDeg(0, 1, 2)
	bwd := pl.VertexTurnDeg(2, 1, 0)
	if math.Abs(fwd+bwd) > 1e-9 {
		t.Errorf("forward turn %v° and reverse turn %v° should be equal and opposite", fwd, bwd)
	}
}

func TestWalkSegmentLengthMM(t *testing.T) {
	pl := Polyline{
		Points:       [][2]float64{{0, 0}, {100, 0}, {200, 0}},
		SegmentTypes: []string{SegmentLine, SegmentArc},
	}
	if got := pl.WalkSegmentLengthMM(0, 1); math.Abs(got-100) > 1e-9 {
		t.Errorf("line step = %v, want 100", got)
	}
	wantArc := 62.5 * 4 * math.Atan(0.5)
	if got := pl.WalkSegmentLengthMM(1, 2); math.Abs(got-wantArc) > 1e-9 {
		t.Errorf("arc step = %v, want %v", got, wantArc)
	}
	// Crossing the same arc backwards is the same glass.
	if got := pl.WalkSegmentLengthMM(2, 1); math.Abs(got-wantArc) > 1e-9 {
		t.Errorf("reverse arc step = %v, want %v", got, wantArc)
	}
	// A non-adjacent pair is a jump, not a segment: straight distance.
	if got := pl.WalkSegmentLengthMM(0, 2); math.Abs(got-200) > 1e-9 {
		t.Errorf("non-adjacent step = %v, want the straight 200", got)
	}
	if got := pl.WalkSegmentLengthMM(0, 99); got != 0 {
		t.Errorf("out-of-range step = %v, want 0", got)
	}
}

// A right-hand bend must be detected exactly like a left-hand one. This was a
// real gap: the bend detector compares a MAGNITUDE against a threshold, so
// feeding it a signed turn silently dropped every clockwise bend from the
// list. Nothing in the suite noticed until it was written down.
func TestComputeBendsDetectsBothTurnDirections(t *testing.T) {
	mk := func(sign float64) Run {
		// A 90° corner, turning one way or the other.
		return Run{
			ID: "r",
			Polyline: Polyline{Points: [][2]float64{
				{0, 0}, {50, 0}, {50, sign * 50},
			}},
			TubeDiameterMM: 12,
		}
	}
	left := ComputeBends(mk(1), 12)
	right := ComputeBends(mk(-1), 12)
	if len(left) == 0 {
		t.Fatal("no bend detected on a left-hand 90° corner")
	}
	if len(right) != len(left) {
		t.Fatalf("right-hand corner produced %d bends, left-hand produced %d — direction must not matter",
			len(right), len(left))
	}
	if math.Abs(left[0].AngleDeg-right[0].AngleDeg) > 1e-6 {
		t.Errorf("mirrored corners reported %v° and %v°; magnitudes must match",
			left[0].AngleDeg, right[0].AngleDeg)
	}
	if left[0].AngleDeg <= 0 {
		t.Errorf("bend angle %v° should be reported as a magnitude", left[0].AngleDeg)
	}
}

// The bend list positions every callout by distance along the glass. An arc is
// ~15.9% longer than its chord, so chord-summing slides every downstream mark
// up the tube.
func TestBendArcLengthsFollowTheCurve(t *testing.T) {
	pts := [][2]float64{{0, 0}, {100, 0}, {100, 100}, {200, 100}}
	straight := Run{ID: "r", Polyline: Polyline{Points: pts}, TubeDiameterMM: 12}
	curved := Run{
		ID: "r",
		Polyline: Polyline{
			Points:       pts,
			SegmentTypes: []string{SegmentArc, SegmentLine, SegmentLine},
		},
		TubeDiameterMM: 12,
	}
	sb := ComputeBends(straight, 12)
	cb := ComputeBends(curved, 12)
	if len(sb) == 0 || len(cb) == 0 {
		t.Fatalf("expected bends on both runs, got %d and %d", len(sb), len(cb))
	}
	// The first corner sits at the end of segment 0. Straight: 100mm along.
	// Arc: 100 * 1.15911.
	wantArc := 100 * (0.625 * 4 * math.Atan(0.5))
	if math.Abs(sb[0].ArcLengthMM-100) > 1e-6 {
		t.Errorf("straight first bend at %vmm, want 100", sb[0].ArcLengthMM)
	}
	if math.Abs(cb[0].ArcLengthMM-wantArc) > 1e-6 {
		t.Errorf("curved first bend at %vmm, want %v", cb[0].ArcLengthMM, wantArc)
	}
}

// At a vertex an arc meets, the radius the bender sets the jig to is the
// arc's, not the circumradius of the chords either side of it.
func TestBendRadiusReportsTheArc(t *testing.T) {
	run := Run{
		ID: "r",
		Polyline: Polyline{
			Points:       [][2]float64{{0, 0}, {100, 0}, {100, 100}},
			SegmentTypes: []string{SegmentArc, SegmentLine},
		},
		TubeDiameterMM: 12,
		Bends:          []Bend{{LiveIndex: 1}},
	}
	got := EffectiveBends(run, 12)
	if len(got) != 1 {
		t.Fatalf("expected 1 manual bend, got %d", len(got))
	}
	if want := 62.5; math.Abs(got[0].RadiusMM-want) > 1e-9 {
		t.Errorf("radius = %v, want the arc's %v", got[0].RadiusMM, want)
	}
}

// An all-line run must produce byte-identical bend output to before the
// feature — the arc plumbing has to be inert when nothing is curved.
func TestBendsUnchangedWithoutArcs(t *testing.T) {
	pts := [][2]float64{{0, 0}, {100, 0}, {100, 100}, {200, 100}, {200, 0}}
	bare := Run{ID: "r", Polyline: Polyline{Points: pts}, TubeDiameterMM: 12}
	withField := Run{
		ID: "r",
		Polyline: Polyline{
			Points:       pts,
			SegmentTypes: []string{SegmentLine, SegmentLine, SegmentLine, SegmentLine},
		},
		TubeDiameterMM: 12,
	}
	a := ComputeBends(bare, 12)
	b := ComputeBends(withField, 12)
	if len(a) != len(b) {
		t.Fatalf("bend counts differ: %d vs %d", len(a), len(b))
	}
	for i := range a {
		if a[i] != b[i] {
			t.Errorf("bend %d differs:\n  %+v\n  %+v", i, a[i], b[i])
		}
	}
}
