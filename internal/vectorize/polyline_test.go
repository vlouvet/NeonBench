package vectorize

import (
	"math"
	"testing"

	"github.com/vlouvet/neonbench/internal/validate"
)

func TestRDPCollapsesCollinearLine(t *testing.T) {
	pl := MMPolyline{Points: []MMPoint{
		{0, 0}, {1, 0.05}, {2, -0.04}, {3, 0.02}, {4, -0.05}, {5, 0},
	}}
	out := RDPSimplify(pl, 0.5)
	if len(out.Points) != 2 {
		t.Errorf("noisy straight line at ε=0.5 should collapse to 2 vertices, got %d", len(out.Points))
	}
}

func TestRDPPreserves90DegCorner(t *testing.T) {
	pl := MMPolyline{Points: []MMPoint{
		{0, 0}, {1, 0}, {2, 0}, {3, 0}, {3, 1}, {3, 2}, {3, 3},
	}}
	out := RDPSimplify(pl, 0.3)
	// The corner at (3, 0) should survive.
	if len(out.Points) != 3 {
		t.Errorf("90° corner polyline should reduce to 3 vertices, got %d (%v)", len(out.Points), out.Points)
	}
	if out.Points[1].X != 3 || out.Points[1].Y != 0 {
		t.Errorf("corner vertex should be (3,0), got %v", out.Points[1])
	}
}

func TestEmitSVGRoundTripsThroughValidate(t *testing.T) {
	polys := []MMPolyline{
		{Points: []MMPoint{{10, 10}, {30, 10}, {30, 30}}, Closed: false},
		{Points: []MMPoint{{50, 50}, {70, 50}, {70, 70}, {50, 70}}, Closed: true},
	}
	svg := EmitSVG(polys, 100, 100)
	got, _, _, err := validate.ExtractMMPolylines(svg)
	if err != nil {
		t.Fatalf("ExtractMMPolylines: %v", err)
	}
	if len(got) != len(polys) {
		t.Fatalf("polyline count: want %d, got %d", len(polys), len(got))
	}
	for i, want := range polys {
		if got[i].Closed != want.Closed {
			t.Errorf("polyline %d closed: want %v, got %v", i, want.Closed, got[i].Closed)
		}
		// The validator's path parser appends the subpath-start point back
		// onto closed polylines to make the loop explicit, so closed
		// polylines round-trip with N+1 points instead of N. Compare just
		// the first len(want.Points) which are the non-duplicate vertices.
		gotPoints := got[i].Points
		if got[i].Closed && len(gotPoints) > len(want.Points) {
			gotPoints = gotPoints[:len(want.Points)]
		}
		if len(gotPoints) != len(want.Points) {
			t.Errorf("polyline %d point count: want %d, got %d", i, len(want.Points), len(gotPoints))
			continue
		}
		for j, p := range want.Points {
			gp := gotPoints[j]
			if math.Abs(gp.X-p.X) > 0.01 || math.Abs(gp.Y-p.Y) > 0.01 {
				t.Errorf("polyline %d point %d: want (%.3f,%.3f), got (%.3f,%.3f)", i, j, p.X, p.Y, gp.X, gp.Y)
			}
		}
	}
}
