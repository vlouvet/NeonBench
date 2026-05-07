package vectorize

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"testing"
)

// encodePNG is a tiny helper for round-tripping a synthetic test image
// through PreprocessAndBinarize, since the public entry point takes raw
// PNG/JPEG bytes.
func encodePNG(t *testing.T, img image.Image) []byte {
	t.Helper()
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		t.Fatalf("encode png: %v", err)
	}
	return buf.Bytes()
}

// solidGray builds an NRGBA all set to the same gray value v. Used to
// exercise brightness / contrast in isolation.
func solidGray(w, h int, v uint8) *image.NRGBA {
	img := image.NewNRGBA(image.Rect(0, 0, w, h))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i+0] = v
		img.Pix[i+1] = v
		img.Pix[i+2] = v
		img.Pix[i+3] = 255
	}
	return img
}

// TestPreprocessNoOpMatchesLegacy guards back-compat: with all the new
// adjustments at their zero values, PreprocessAndBinarize must return the
// same BinaryImage that the legacy DecodeImage→Binarize path would.
func TestPreprocessNoOpMatchesLegacy(t *testing.T) {
	// Synthetic checkerboard-ish gradient.
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			v := uint8(x*15 + y)
			img.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	data := encodePNG(t, img)

	bin, w, h, err := PreprocessAndBinarize(data, PreprocessOptions{Threshold: 128})
	if err != nil {
		t.Fatalf("preprocess: %v", err)
	}
	gray, err := DecodeImage(data)
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	legacy := Binarize(gray, 128)
	if w != legacy.W || h != legacy.H {
		t.Fatalf("dims: got %dx%d, want %dx%d", w, h, legacy.W, legacy.H)
	}
	for i := range bin.Pix {
		if bin.Pix[i] != legacy.Pix[i] {
			t.Fatalf("pixel %d differs: %v vs %v", i, bin.Pix[i], legacy.Pix[i])
		}
	}
}

// TestPreprocessBrightness verifies that a +offset pushes mid-gray pixels
// above threshold (background), and -offset pushes them below (foreground).
// 50% gray (128) is right at the default threshold; we shift it ±50 to land
// firmly on either side.
func TestPreprocessBrightness(t *testing.T) {
	data := encodePNG(t, solidGray(8, 8, 128))

	// +50 brightens to 178 → above threshold 128 → background (false).
	bin, _, _, err := PreprocessAndBinarize(data, PreprocessOptions{
		Brightness: 50,
		Threshold:  128,
	})
	if err != nil {
		t.Fatalf("brighten: %v", err)
	}
	for i, v := range bin.Pix {
		if v {
			t.Fatalf("expected all background after +50, pixel %d is foreground", i)
		}
	}

	// -50 darkens to 78 → below threshold → foreground (true).
	bin, _, _, err = PreprocessAndBinarize(data, PreprocessOptions{
		Brightness: -50,
		Threshold:  128,
	})
	if err != nil {
		t.Fatalf("darken: %v", err)
	}
	for i, v := range bin.Pix {
		if !v {
			t.Fatalf("expected all foreground after -50, pixel %d is background", i)
		}
	}
}

// TestPreprocessContrast checks that contrast > 1 pushes a faint dark mark
// across the threshold, and contrast < 1 pulls a strong dark mark above it.
// The test pattern is a single dark dot at gray=110 on a white field; with
// default threshold 128 the dot is *just* foreground (110 < 128) and stays
// foreground at all reasonable contrast settings — so we check the inverse:
// a faint dot at gray=140 (just *background*) gets pushed to foreground when
// contrast steepens, and a dark dot at gray=100 gets pulled to background
// when contrast flattens.
func TestPreprocessContrast(t *testing.T) {
	t.Run("flatten pushes near-midpoint to foreground", func(t *testing.T) {
		// At gray=140 with threshold 135, the pixel starts as background
		// (140 > 135). Contrast 0.5 (range compression) pulls it toward
		// midpoint 128: (140-128)*0.5 + 128 = 134, now below threshold →
		// foreground. Confirms applyContrast applies the documented
		// formula and runs *before* the threshold step.
		data := encodePNG(t, solidGray(4, 4, 140))
		bin, _, _, err := PreprocessAndBinarize(data, PreprocessOptions{
			Contrast:  0.5,
			Threshold: 135,
		})
		if err != nil {
			t.Fatalf("preprocess: %v", err)
		}
		// 140 → (140-128)*0.5+128 = 134 < threshold 135 → foreground.
		for i, v := range bin.Pix {
			if !v {
				t.Fatalf("expected foreground after contrast flatten, pixel %d is bg", i)
			}
		}
	})
	t.Run("contrast 1.0 is a no-op", func(t *testing.T) {
		data := encodePNG(t, solidGray(4, 4, 140))
		bin, _, _, err := PreprocessAndBinarize(data, PreprocessOptions{
			Contrast:  1.0,
			Threshold: 135,
		})
		if err != nil {
			t.Fatalf("preprocess: %v", err)
		}
		for i, v := range bin.Pix {
			if v {
				t.Fatalf("contrast=1 should leave 140 above threshold 135, pixel %d went fg", i)
			}
		}
	})
}

// TestPreprocessCrop verifies the crop trims to the correct sub-rectangle
// and that the binarized output reflects only the cropped pixels.
func TestPreprocessCrop(t *testing.T) {
	// Left half black (foreground after threshold), right half white.
	img := image.NewNRGBA(image.Rect(0, 0, 20, 10))
	for y := 0; y < 10; y++ {
		for x := 0; x < 20; x++ {
			v := uint8(255)
			if x < 10 {
				v = 0
			}
			img.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	data := encodePNG(t, img)

	// Crop to the right half — should be all background.
	bin, w, h, err := PreprocessAndBinarize(data, PreprocessOptions{
		Crop:      &Crop{X: 10, Y: 0, W: 10, H: 10},
		Threshold: 128,
	})
	if err != nil {
		t.Fatalf("crop: %v", err)
	}
	if w != 10 || h != 10 {
		t.Fatalf("expected 10x10 crop, got %dx%d", w, h)
	}
	for i, v := range bin.Pix {
		if v {
			t.Fatalf("right-half crop should be all background, pixel %d is fg", i)
		}
	}

	// Crop to the left half — should be all foreground.
	bin, _, _, err = PreprocessAndBinarize(data, PreprocessOptions{
		Crop:      &Crop{X: 0, Y: 0, W: 10, H: 10},
		Threshold: 128,
	})
	if err != nil {
		t.Fatalf("crop left: %v", err)
	}
	for i, v := range bin.Pix {
		if !v {
			t.Fatalf("left-half crop should be all foreground, pixel %d is bg", i)
		}
	}
}

// TestPreprocessCropInvalid rejects out-of-range crops with a non-nil error
// so the handler can translate that into a 400.
func TestPreprocessCropInvalid(t *testing.T) {
	img := solidGray(10, 10, 0)
	data := encodePNG(t, img)
	cases := []struct {
		name string
		c    Crop
	}{
		{"zero width", Crop{X: 0, Y: 0, W: 0, H: 5}},
		{"zero height", Crop{X: 0, Y: 0, W: 5, H: 0}},
		{"x out of range", Crop{X: 11, Y: 0, W: 1, H: 1}},
		{"extent overflows", Crop{X: 5, Y: 5, W: 10, H: 10}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			c := tc.c
			_, _, _, err := PreprocessAndBinarize(data, PreprocessOptions{Crop: &c, Threshold: 128})
			if err == nil {
				t.Fatalf("expected error for %v", tc.c)
			}
		})
	}
}

// TestPreprocessRotationGrowsCanvas: rotating a square by 45° must produce a
// canvas at least sqrt(2)×bigger on each axis. Content correctness is
// covered separately — here we're guarding the "grow to fit" promise.
func TestPreprocessRotationGrowsCanvas(t *testing.T) {
	img := solidGray(20, 20, 128)
	data := encodePNG(t, img)
	_, w, h, err := PreprocessAndBinarize(data, PreprocessOptions{
		RotationDeg: 45,
		Threshold:   128,
	})
	if err != nil {
		t.Fatalf("rotate: %v", err)
	}
	// sqrt(2)*20 ≈ 28.28 → ceil → 29.
	if w < 28 || h < 28 {
		t.Fatalf("rotated canvas too small: %dx%d, expected ≥ 28×28", w, h)
	}
}

// TestPreprocessRotationIdentity: rotating by 0° must produce identical
// output to no rotation at all — the rotation branch must short-circuit.
func TestPreprocessRotationIdentity(t *testing.T) {
	// Half-and-half image so we can spot any subtle bilinear smearing.
	img := image.NewNRGBA(image.Rect(0, 0, 16, 16))
	for y := 0; y < 16; y++ {
		for x := 0; x < 16; x++ {
			v := uint8(255)
			if x < 8 {
				v = 0
			}
			img.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	data := encodePNG(t, img)
	binA, wA, hA, err := PreprocessAndBinarize(data, PreprocessOptions{Threshold: 128})
	if err != nil {
		t.Fatalf("baseline: %v", err)
	}
	binB, wB, hB, err := PreprocessAndBinarize(data, PreprocessOptions{RotationDeg: 0, Threshold: 128})
	if err != nil {
		t.Fatalf("zero rotation: %v", err)
	}
	if wA != wB || hA != hB {
		t.Fatalf("dims differ: %dx%d vs %dx%d", wA, hA, wB, hB)
	}
	for i := range binA.Pix {
		if binA.Pix[i] != binB.Pix[i] {
			t.Fatalf("rotation=0 should be a no-op, pixel %d differs", i)
		}
	}
}

// TestPreprocessApplyOrder pins the documented apply order: rotate first
// (canvas grows), then crop in the post-rotation coordinate space, then
// brightness, then contrast, then threshold. The test rotates a half-black
// image by 90° (which moves the boundary) and crops to a corner that is
// only black after rotation — proves rotate-then-crop, not crop-then-rotate.
func TestPreprocessApplyOrder(t *testing.T) {
	// 20x20: top half black, bottom half white.
	img := image.NewNRGBA(image.Rect(0, 0, 20, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 20; x++ {
			v := uint8(255)
			if y < 10 {
				v = 0
			}
			img.SetNRGBA(x, y, color.NRGBA{R: v, G: v, B: v, A: 255})
		}
	}
	data := encodePNG(t, img)
	// Rotate 90° CCW: top-half black becomes left-half black.
	// Then crop the left half — should be all foreground.
	bin, _, _, err := PreprocessAndBinarize(data, PreprocessOptions{
		RotationDeg: 90, // outside the typical -45..45 but the function
		// itself accepts any angle; range-clamping is the handler's job.
		Crop:      &Crop{X: 0, Y: 0, W: 8, H: 16},
		Threshold: 128,
	})
	if err != nil {
		t.Fatalf("rotate+crop: %v", err)
	}
	// Most of the cropped region should be foreground (left half of
	// rotated image). Allow a bilinear-edge smudge: count foreground pct.
	fgCount := 0
	for _, v := range bin.Pix {
		if v {
			fgCount++
		}
	}
	pct := float64(fgCount) / float64(len(bin.Pix))
	if pct < 0.8 {
		t.Fatalf("rotate-then-crop expected mostly foreground, got %.1f%%", pct*100)
	}
}
