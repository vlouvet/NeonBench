package vectorize

import "image"

// BinaryImage is a row-major boolean bitmap. true = foreground (the
// region that will become tube centerlines).
type BinaryImage struct {
	W, H int
	Pix  []bool
}

func NewBinaryImage(w, h int) *BinaryImage {
	return &BinaryImage{W: w, H: h, Pix: make([]bool, w*h)}
}

func (b *BinaryImage) idx(x, y int) int { return y*b.W + x }

// At returns the pixel at (x, y); out-of-bounds reads as background.
func (b *BinaryImage) At(x, y int) bool {
	if x < 0 || y < 0 || x >= b.W || y >= b.H {
		return false
	}
	return b.Pix[b.idx(x, y)]
}

func (b *BinaryImage) Set(x, y int, v bool) {
	if x < 0 || y < 0 || x >= b.W || y >= b.H {
		return
	}
	b.Pix[b.idx(x, y)] = v
}

// Binarize thresholds a Gray image into a BinaryImage. Pixels with
// luminance < threshold become foreground (true). Mirrors the EncodePBM
// convention so the threshold parameter behaves identically.
func Binarize(gray *image.Gray, threshold uint8) *BinaryImage {
	bounds := gray.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	bin := NewBinaryImage(w, h)
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			if gray.GrayAt(bounds.Min.X+x, bounds.Min.Y+y).Y < threshold {
				bin.Pix[bin.idx(x, y)] = true
			}
		}
	}
	return bin
}

// Thin runs Zhang-Suen iterative thinning until the skeleton is stable.
// Returns a new BinaryImage; the input is not modified. Pixels in the
// 1-pixel border are treated as if their out-of-bounds neighbors were
// always background, which is correct for our use (signs don't extend
// into the border in practice).
func Thin(src *BinaryImage) *BinaryImage {
	dst := &BinaryImage{W: src.W, H: src.H, Pix: make([]bool, len(src.Pix))}
	copy(dst.Pix, src.Pix)
	w, h := dst.W, dst.H
	if w == 0 || h == 0 {
		return dst
	}
	marks := make([]bool, len(dst.Pix))

	// passOne / passTwo differ only in the last two conjunction tests.
	// Returns true if any pixel was marked for deletion in this sub-pass.
	subPass := func(passOne bool) bool {
		for i := range marks {
			marks[i] = false
		}
		any := false
		// Process every pixel — At() returns false for out-of-bounds reads,
		// which is the correct "background outside the canvas" semantics for
		// thinning and lets the algorithm work on images whose foreground
		// touches the border (test fixtures, tightly-cropped uploads).
		for y := 0; y < h; y++ {
			for x := 0; x < w; x++ {
				if !dst.Pix[dst.idx(x, y)] {
					continue
				}
				p2 := dst.At(x, y-1)
				p3 := dst.At(x+1, y-1)
				p4 := dst.At(x+1, y)
				p5 := dst.At(x+1, y+1)
				p6 := dst.At(x, y+1)
				p7 := dst.At(x-1, y+1)
				p8 := dst.At(x-1, y)
				p9 := dst.At(x-1, y-1)

				b := boolToInt(p2) + boolToInt(p3) + boolToInt(p4) + boolToInt(p5) +
					boolToInt(p6) + boolToInt(p7) + boolToInt(p8) + boolToInt(p9)
				if b < 2 || b > 6 {
					continue
				}

				// A(p1): count 0→1 transitions in the cyclic sequence p2..p9,p2.
				seq := [9]bool{p2, p3, p4, p5, p6, p7, p8, p9, p2}
				a := 0
				for k := 0; k < 8; k++ {
					if !seq[k] && seq[k+1] {
						a++
					}
				}
				if a != 1 {
					continue
				}

				if passOne {
					if (p2 && p4 && p6) || (p4 && p6 && p8) {
						continue
					}
				} else {
					if (p2 && p4 && p8) || (p2 && p6 && p8) {
						continue
					}
				}
				marks[dst.idx(x, y)] = true
				any = true
			}
		}
		if any {
			for i, m := range marks {
				if m {
					dst.Pix[i] = false
				}
			}
		}
		return any
	}

	for {
		c1 := subPass(true)
		c2 := subPass(false)
		if !c1 && !c2 {
			break
		}
	}
	return dst
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
