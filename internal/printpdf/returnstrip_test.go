package printpdf

import (
	"bytes"
	"math"
	"strings"
	"testing"

	"github.com/phpdave11/gofpdf"
	"github.com/vlouvet/neonbench/internal/designdoc"
)

// TestPerimeter verifies the closed-polyline perimeter helper against
// two hand-computed cases. It's the foundation for the unfolded
// return-strip's total length, so every other return-strip number
// derives from this being right.
func TestPerimeter(t *testing.T) {
	// 100 × 50 closed rectangle: perimeter 300.
	rect := [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}}
	if got := polylinePerimeterMM(rect, true); !approx(got, 300) {
		t.Errorf("rect closed perimeter: got %v, want 300", got)
	}
	// Open same rectangle (no implicit closing edge): 100+50+100 = 250.
	if got := polylinePerimeterMM(rect, false); !approx(got, 250) {
		t.Errorf("rect open perimeter: got %v, want 250", got)
	}

	// 5-vertex zigzag with hand-summed segments.
	zig := [][2]float64{
		{0, 0}, {3, 4}, // hypot=5
		{6, 0},  // hypot(3,4)=5
		{10, 3}, // hypot(4,3)=5
		{14, 0}, // hypot(4,3)=5
	}
	if got := polylinePerimeterMM(zig, false); !approx(got, 20) {
		t.Errorf("zigzag open perimeter: got %v, want 20", got)
	}

	// Degenerate inputs: single point, empty.
	if got := polylinePerimeterMM([][2]float64{{1, 1}}, true); got != 0 {
		t.Errorf("single point: got %v, want 0", got)
	}
	if got := polylinePerimeterMM(nil, false); got != 0 {
		t.Errorf("nil slice: got %v, want 0", got)
	}
}

// TestInteriorAngles verifies the signed-turn-angle helper. A square's
// four corners must all be +90° (the canonical CCW square — left turns
// at every corner). A "checkmark" V-shape produces one positive and
// one negative angle, which is the test that catches sign-flip bugs.
func TestInteriorAngles(t *testing.T) {
	// Square wound CCW: each corner is a +90° left turn. (Note: in
	// screen coords with y-down a CCW math square is wound the other
	// way, but signedTurnDeg cares about cross-product sign in the
	// supplied basis — for the unit test we feed it points that are
	// CCW in *math* space, so the sign is unambiguously positive.)
	square := [][2]float64{{0, 0}, {1, 0}, {1, 1}, {0, 1}}
	marks := returnStripBendMarks(&designdoc.Polyline{Points: square, Closed: true}, true)
	if len(marks) != 4 {
		t.Fatalf("square closed marks: got %d, want 4", len(marks))
	}
	for i, m := range marks {
		if !approxAngle(m.AngleDeg, 90) {
			t.Errorf("square corner %d: got %v°, want +90°", i, m.AngleDeg)
		}
	}

	// Checkmark V: indices 0..2, vertex 1 is a sharp inward bend, then
	// open again at vertex 2. Open polyline: only vertex 1 is interior,
	// produces one angle entry.
	check := [][2]float64{{0, 5}, {3, 0}, {6, 5}}
	cm := returnStripBendMarks(&designdoc.Polyline{Points: check}, false)
	if len(cm) != 1 {
		t.Fatalf("check open marks: got %d, want 1", len(cm))
	}
	// Incoming (0,5)→(3,0) = (3,-5); outgoing (3,0)→(6,5) = (3,5).
	// Cross = 3*5 - (-5)*3 = 30 (positive → left turn).
	// Magnitude = acos((3*3 + -5*5)/(sqrt(34)*sqrt(34))) = acos(-16/34)
	// ≈ 118.07°. Sign positive so result ≈ +118°.
	if cm[0].AngleDeg < 100 || cm[0].AngleDeg > 130 {
		t.Errorf("check vertex 1 angle: got %v°, expected ~+118°", cm[0].AngleDeg)
	}

	// Mirror checkmark — flip vertex 1 to the other side; same shape,
	// opposite sign. This is the bug a unit test catches: if signedTurnDeg
	// drops the cross-product sign, both checkmarks read the same.
	mirrored := [][2]float64{{0, 0}, {3, 5}, {6, 0}}
	mm := returnStripBendMarks(&designdoc.Polyline{Points: mirrored}, false)
	if len(mm) != 1 {
		t.Fatalf("mirrored check marks: got %d, want 1", len(mm))
	}
	if mm[0].AngleDeg > -100 || mm[0].AngleDeg < -130 {
		t.Errorf("mirrored check vertex 1 angle: got %v°, expected ~-118°", mm[0].AngleDeg)
	}
	// Sanity: the magnitudes match.
	if !approxAngle(math.Abs(cm[0].AngleDeg), math.Abs(mm[0].AngleDeg)) {
		t.Errorf("magnitudes should match: |%v| vs |%v|", cm[0].AngleDeg, mm[0].AngleDeg)
	}
}

// TestEmitReturnStripBendCount exercises the closed-vs-open
// expectations for the number of bend ticks, which is the
// load-bearing detail when the operator scans the printed strip.
func TestEmitReturnStripBendCount(t *testing.T) {
	closedFive := [][2]float64{{0, 0}, {10, 0}, {10, 5}, {5, 8}, {0, 5}}
	got := returnStripBendMarks(&designdoc.Polyline{Points: closedFive, Closed: true}, true)
	if len(got) != 5 {
		t.Errorf("closed 5-pt: got %d marks, want 5", len(got))
	}
	openFive := [][2]float64{{0, 0}, {10, 0}, {10, 5}, {5, 8}, {0, 5}}
	got = returnStripBendMarks(&designdoc.Polyline{Points: openFive}, false)
	if len(got) != 3 {
		t.Errorf("open 5-pt: got %d marks (interior only), want 3", len(got))
	}

	// Open 2-point polyline: no interior vertices, no marks.
	if got := returnStripBendMarks(&designdoc.Polyline{Points: [][2]float64{{0, 0}, {1, 0}}}, false); len(got) != 0 {
		t.Errorf("open 2-pt: got %d marks, want 0", len(got))
	}
}

// TestEmitReturnStripDimensions emits a return-strip page for a
// 100×50 closed face at 100 mm depth and asserts the rendered PDF
// is non-empty, well-formed, and contains the strip's dimensional
// landmarks (perimeter 300 mm, depth 100 mm) in the header / footer
// text. We can't easily parse back gofpdf output, so we look for
// the literal numeric strings the renderer is required to emit —
// if a refactor drops them silently this test catches it.
func TestEmitReturnStripDimensions(t *testing.T) {
	pdf := gofpdf.NewCustom(&gofpdf.InitType{
		OrientationStr: "P",
		UnitStr:        "mm",
		Size:           gofpdf.SizeType{Wd: 215.9, Ht: 279.4}, // US Letter
	})
	pdf.SetMargins(10, 10, 10)
	pdf.SetAutoPageBreak(false, 0)
	// Disable stream compression so we can grep the raw bytes for the
	// header / footer landmarks. Production PDFs keep compression on.
	pdf.SetCompression(false)

	opts := DefaultOptions()
	opts.ProjectName = "test"
	opts.DesignVersionLabel = "v1"

	run := designdoc.Run{
		ID: "run-1",
		Polyline: designdoc.Polyline{
			Points: [][2]float64{{0, 0}, {100, 0}, {100, 50}, {0, 50}},
			Closed: true,
		},
		IsChannelLetterFace: true,
	}
	emitReturnStrip(pdf, opts, run, 100)

	var buf bytes.Buffer
	if err := pdf.Output(&buf); err != nil {
		t.Fatalf("output: %v", err)
	}
	data := buf.Bytes()
	if len(data) < 200 {
		t.Fatalf("PDF unreasonably small: %d bytes", len(data))
	}
	// gofpdf encodes text strings literally inside the content stream,
	// so the header text is searchable in the raw bytes.
	asStr := string(data)
	for _, want := range []string{
		"Return strip", "Run run-1",
		"Perimeter 300.0 mm",
		"Depth 100.0 mm",
		"Total length: 300.0 mm",
	} {
		if !strings.Contains(asStr, want) {
			t.Errorf("PDF missing landmark %q", want)
		}
	}
}

// approx returns true if a and b are within 1e-9.
func approx(a, b float64) bool {
	return math.Abs(a-b) < 1e-9
}

// approxAngle is a looser tolerance for angles (degrees, ~0.01°).
func approxAngle(a, b float64) bool {
	return math.Abs(a-b) < 0.01
}
