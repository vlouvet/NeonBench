package vectorize

import "testing"

func filledBin(w, h int) *BinaryImage {
	b := NewBinaryImage(w, h)
	for i := range b.Pix {
		b.Pix[i] = true
	}
	return b
}

func TestThinFilledSquareCollapsesToOnePixel(t *testing.T) {
	// A 5×5 filled square. Zhang-Suen should reduce it to a single pixel
	// in the interior — the actual location can vary by a pixel depending
	// on which sub-pass deletes more, but the count must be 1.
	src := filledBin(5, 5)
	thin := Thin(src)
	count := 0
	for _, p := range thin.Pix {
		if p {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("5x5 filled square should thin to 1 pixel, got %d", count)
	}
}

func TestThinHorizontalBarBecomesLine(t *testing.T) {
	// 7 wide × 3 tall, all foreground. Should thin to a 1-pixel-tall
	// horizontal line on the middle row.
	src := NewBinaryImage(7, 3)
	for x := 0; x < 7; x++ {
		for y := 0; y < 3; y++ {
			src.Set(x, y, true)
		}
	}
	thin := Thin(src)
	// Count foreground per row.
	rowCounts := make([]int, 3)
	for y := 0; y < 3; y++ {
		for x := 0; x < 7; x++ {
			if thin.At(x, y) {
				rowCounts[y]++
			}
		}
	}
	// Bar centerline should land entirely on the middle row.
	if rowCounts[0] != 0 || rowCounts[2] != 0 {
		t.Errorf("middle-row collapse expected, got rowCounts=%v", rowCounts)
	}
	if rowCounts[1] < 3 {
		t.Errorf("middle row should have at least 3 pixels (the bar's centerline), got %d", rowCounts[1])
	}
}

func TestThinAnnulusHasNoEndpoints(t *testing.T) {
	// Filled annulus: 9×9 square with the center 3×3 removed. The skeleton
	// should be a topological closed loop — i.e. zero endpoints (degree-1
	// pixels). Small junction clusters at corners are an expected artifact
	// of Zhang-Suen on tight rings; the graph stage handles them.
	src := NewBinaryImage(9, 9)
	for y := 0; y < 9; y++ {
		for x := 0; x < 9; x++ {
			src.Set(x, y, true)
		}
	}
	for y := 3; y <= 5; y++ {
		for x := 3; x <= 5; x++ {
			src.Set(x, y, false)
		}
	}
	thin := Thin(src)
	count, endpoints := 0, 0
	for y := 0; y < thin.H; y++ {
		for x := 0; x < thin.W; x++ {
			if !thin.At(x, y) {
				continue
			}
			count++
			deg := 0
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					if dx == 0 && dy == 0 {
						continue
					}
					if thin.At(x+dx, y+dy) {
						deg++
					}
				}
			}
			if deg == 1 {
				endpoints++
			}
		}
	}
	if count == 0 {
		t.Fatal("annulus thinned to empty image")
	}
	if endpoints > 0 {
		t.Errorf("closed annulus skeleton should have 0 endpoints, got %d", endpoints)
	}
}

func TestBinarizeRespectsThreshold(t *testing.T) {
	// Build a 3×1 gray image with values [50, 128, 200] and threshold at 128.
	// Pixel 0 (50) is darker than 128 → foreground; pixels 1 and 2 are not.
	gray := newGrayLine([]uint8{50, 128, 200})
	bin := Binarize(gray, 128)
	if !bin.At(0, 0) {
		t.Error("pixel value 50 with threshold 128 should be foreground")
	}
	if bin.At(1, 0) {
		t.Error("pixel value 128 (== threshold) should NOT be foreground")
	}
	if bin.At(2, 0) {
		t.Error("pixel value 200 should NOT be foreground")
	}
}
