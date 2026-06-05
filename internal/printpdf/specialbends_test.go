package printpdf

import (
	"reflect"
	"testing"

	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestSpecialBendsForRun covers the Tier 3 #77 bend-list helper that
// produces "JUMP" and "DROP" entries for the per-run special-bends
// subsection. Asserts:
//   - jumps and drops are both extracted (other kinds skipped);
//   - per-kind numbering is monotonic in declaration order;
//   - the returned slice is sorted by arc length so the bender walks
//     the tube in physical order;
//   - empty / no-jump-no-drop annotations short-circuit to nil so the
//     caller can elide the whole subsection.
func TestSpecialBendsForRun(t *testing.T) {
	// 6-point colinear run at 10 mm spacing; electrodes at 0 and 5
	// mean the live arc is the whole polyline, so liveIndex N maps
	// to polyline index N and arc length at live index N is N*10.
	run := designdoc.Run{
		ID: "r1",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{
				{0, 0}, {10, 0}, {20, 0}, {30, 0}, {40, 0}, {50, 0},
			},
		},
		Electrodes: []designdoc.Electrode{
			{PointIndex: 0}, {PointIndex: 5},
		},
		Annotations: []designdoc.Annotation{
			// Out-of-order declaration: the helper must sort.
			{Kind: "drop_bend", LiveIndex: 4},
			{Kind: "jump", LiveIndex: 1},
			{Kind: "support", LiveIndex: 3}, // ignored
			{Kind: "drop_bend", LiveIndex: 2},
			{Kind: "jump", LiveIndex: 3},
		},
	}
	got := specialBendsForRun(run)
	// Numbering is by declaration order (J1 = first jump declared,
	// D1 = first drop declared) then sorted by arc-length. With the
	// declarations above:
	//   J1 = jump@1   → arc 10
	//   J2 = jump@3   → arc 30
	//   D1 = drop@4   → arc 40
	//   D2 = drop@2   → arc 20
	// Sorted by arc: J1(10), D2(20), J2(30), D1(40).
	want := []specialBend{
		{tag: "J1", label: "JUMP", arcMM: 10},
		{tag: "D2", label: "DROP", arcMM: 20},
		{tag: "J2", label: "JUMP", arcMM: 30},
		{tag: "D1", label: "DROP", arcMM: 40},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("specialBendsForRun mismatch.\ngot:  %+v\nwant: %+v", got, want)
	}
}

// TestSpecialBendsForRunEmpty checks the short-circuit paths: runs with
// no annotations at all, runs with only non-special annotations
// (support, doubleback), and runs whose live arc is too short return nil
// so the caller can elide the "Special bends:" subsection cleanly.
func TestSpecialBendsForRunEmpty(t *testing.T) {
	cases := []struct {
		name string
		run  designdoc.Run
	}{
		{
			name: "no annotations",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}},
				},
			},
		},
		{
			name: "no jump or drop annotations",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}},
				},
				Annotations: []designdoc.Annotation{
					{Kind: "support", LiveIndex: 1},
					{Kind: "doubleback", LiveIndex: 1},
				},
			},
		},
		{
			name: "single-point live arc",
			run: designdoc.Run{
				ID: "r1",
				Polyline: designdoc.Polyline{
					Points: [][2]float64{{0, 0}},
				},
				Annotations: []designdoc.Annotation{
					{Kind: "jump", LiveIndex: 0},
				},
			},
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := specialBendsForRun(tc.run); got != nil {
				t.Errorf("expected nil, got %+v", got)
			}
		})
	}
}

// TestSpecialBendsForRunOutOfRange guards the defensive index check:
// annotations pointing outside the live arc are silently dropped, not
// emitted with garbage arc lengths.
func TestSpecialBendsForRunOutOfRange(t *testing.T) {
	run := designdoc.Run{
		ID: "r1",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {10, 0}, {20, 0}},
		},
		Annotations: []designdoc.Annotation{
			{Kind: "jump", LiveIndex: -1},
			{Kind: "drop_bend", LiveIndex: 999},
			// One in-range jump survives so we can confirm the slice
			// isn't accidentally empty for the wrong reason.
			{Kind: "jump", LiveIndex: 1},
		},
	}
	got := specialBendsForRun(run)
	if len(got) != 1 {
		t.Fatalf("want 1 entry (the in-range jump), got %d: %+v", len(got), got)
	}
	if got[0].label != "JUMP" {
		t.Errorf("survivor label: want JUMP, got %q", got[0].label)
	}
	if got[0].arcMM != 10 {
		t.Errorf("survivor arc: want 10, got %v", got[0].arcMM)
	}
}
