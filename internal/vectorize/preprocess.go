package vectorize

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
	"math"
)

// DecodeImage decodes a raster image (PNG or JPEG) and returns it composited
// onto a white background as a Gray image, ready for thresholding.
func DecodeImage(data []byte) (*image.Gray, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, fmt.Errorf("decode image: %w", err)
	}
	bounds := src.Bounds()
	gray := image.NewGray(bounds)
	// Fill with white, then composite source over it so transparent pixels
	// don't show up as black.
	draw.Draw(gray, bounds, image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(gray, bounds, src, bounds.Min, draw.Over)
	return gray, nil
}

// Crop is a source-pixel rectangle. X/Y are top-left, W/H are dimensions.
type Crop struct {
	X, Y, W, H int
}

// PreprocessOptions bundles the user-controlled bitmap adjustments applied
// before binarize. The pipeline is:
//
//	rotate → crop → brightness → contrast → luminance → threshold
//
// Each stage is a no-op when the corresponding option is at its default,
// preserving back-compat with the original DecodeImage → Binarize flow.
type PreprocessOptions struct {
	// RotationDeg in degrees, range -45..+45 (most photo skew). Positive =
	// counter-clockwise. Output canvas grows to fit so no content is lost
	// at the rotation step itself.
	RotationDeg float64
	// Crop in source-pixel coordinates AFTER rotation. nil = full image.
	Crop *Crop
	// Brightness offset added to each RGB channel, range -100..+100,
	// clamped to [0,255].
	Brightness int
	// Contrast multiplicative factor around channel midpoint 128, range
	// 0.5..2.0. The zero value (0.0) is treated as 1.0 for back-compat
	// with callers that leave the field unset.
	Contrast float64
	// Threshold for the final binarize step. 0 → 128.
	Threshold uint8
}

// PreprocessOptionRanges defines the accepted ranges; reused by handler
// validation so the limits live in one place.
const (
	MinRotationDeg = -45.0
	MaxRotationDeg = 45.0
	MinBrightness  = -100
	MaxBrightness  = 100
	MinContrast    = 0.5
	MaxContrast    = 2.0
)

// PreprocessAndBinarize runs the full preprocessing pipeline on raw image
// bytes and returns the resulting BinaryImage plus the post-adjustment
// pixel dimensions (so callers can compute mm/px against the cropped/rotated
// extent rather than the original).
func PreprocessAndBinarize(data []byte, opts PreprocessOptions) (*BinaryImage, int, int, error) {
	src, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, 0, 0, fmt.Errorf("decode image: %w", err)
	}
	rgba := compositeOnWhite(src)

	if opts.RotationDeg != 0 {
		rgba = rotateBilinear(rgba, opts.RotationDeg)
	}
	if opts.Crop != nil {
		rgba, err = cropNRGBA(rgba, *opts.Crop)
		if err != nil {
			return nil, 0, 0, err
		}
	}
	if opts.Brightness != 0 {
		applyBrightness(rgba, opts.Brightness)
	}
	if opts.Contrast != 0 && opts.Contrast != 1 {
		applyContrast(rgba, opts.Contrast)
	}

	gray := toGray(rgba)
	threshold := opts.Threshold
	if threshold == 0 {
		threshold = 128
	}
	bin := Binarize(gray, threshold)
	w, h := gray.Bounds().Dx(), gray.Bounds().Dy()
	return bin, w, h, nil
}

// compositeOnWhite turns any image.Image into an NRGBA flattened against a
// white background — same convention as DecodeImage, but kept as RGBA so
// brightness/contrast see real channel values rather than pre-luminance gray.
func compositeOnWhite(src image.Image) *image.NRGBA {
	b := src.Bounds()
	out := image.NewNRGBA(image.Rect(0, 0, b.Dx(), b.Dy()))
	draw.Draw(out, out.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	draw.Draw(out, out.Bounds(), src, b.Min, draw.Over)
	return out
}

// rotateBilinear rotates by angleDeg degrees counter-clockwise about the
// source-image center. The output canvas grows to fit the rotated content.
// Bilinear sampling; out-of-bounds source pixels read as white so the
// background continues seamlessly past the original frame.
func rotateBilinear(src *image.NRGBA, angleDeg float64) *image.NRGBA {
	if angleDeg == 0 {
		return src
	}
	theta := angleDeg * math.Pi / 180
	cosT := math.Cos(theta)
	sinT := math.Sin(theta)
	sw := src.Rect.Dx()
	sh := src.Rect.Dy()
	// Output bbox: project the four corners through the rotation and take
	// the axis-aligned bounding rectangle.
	corners := [4][2]float64{
		{0, 0},
		{float64(sw), 0},
		{0, float64(sh)},
		{float64(sw), float64(sh)},
	}
	// Rotate around the source center.
	cx := float64(sw) / 2
	cy := float64(sh) / 2
	minX, minY := math.Inf(1), math.Inf(1)
	maxX, maxY := math.Inf(-1), math.Inf(-1)
	for _, c := range corners {
		xr := (c[0]-cx)*cosT + (c[1]-cy)*sinT
		yr := -(c[0]-cx)*sinT + (c[1]-cy)*cosT
		if xr < minX {
			minX = xr
		}
		if xr > maxX {
			maxX = xr
		}
		if yr < minY {
			minY = yr
		}
		if yr > maxY {
			maxY = yr
		}
	}
	dw := int(math.Ceil(maxX - minX))
	dh := int(math.Ceil(maxY - minY))
	if dw < 1 {
		dw = 1
	}
	if dh < 1 {
		dh = 1
	}
	dst := image.NewNRGBA(image.Rect(0, 0, dw, dh))
	// Inverse map every destination pixel back to source space and
	// bilinearly sample. Out-of-source samples → white.
	for y := 0; y < dh; y++ {
		for x := 0; x < dw; x++ {
			// Destination → centered → undo rotation → re-add center.
			xc := float64(x) + minX
			yc := float64(y) + minY
			sx := xc*cosT - yc*sinT + cx
			sy := xc*sinT + yc*cosT + cy
			r, g, b, a := sampleBilinearNRGBA(src, sx, sy)
			i := dst.PixOffset(x, y)
			dst.Pix[i+0] = r
			dst.Pix[i+1] = g
			dst.Pix[i+2] = b
			dst.Pix[i+3] = a
		}
	}
	return dst
}

func sampleBilinearNRGBA(src *image.NRGBA, x, y float64) (uint8, uint8, uint8, uint8) {
	w := src.Rect.Dx()
	h := src.Rect.Dy()
	if x < -1 || y < -1 || x > float64(w) || y > float64(h) {
		// Outside: white background.
		return 255, 255, 255, 255
	}
	x0 := int(math.Floor(x))
	y0 := int(math.Floor(y))
	x1 := x0 + 1
	y1 := y0 + 1
	dx := x - float64(x0)
	dy := y - float64(y0)
	p00 := getNRGBA(src, x0, y0, w, h)
	p10 := getNRGBA(src, x1, y0, w, h)
	p01 := getNRGBA(src, x0, y1, w, h)
	p11 := getNRGBA(src, x1, y1, w, h)
	r := bilerp(float64(p00[0]), float64(p10[0]), float64(p01[0]), float64(p11[0]), dx, dy)
	g := bilerp(float64(p00[1]), float64(p10[1]), float64(p01[1]), float64(p11[1]), dx, dy)
	b := bilerp(float64(p00[2]), float64(p10[2]), float64(p01[2]), float64(p11[2]), dx, dy)
	a := bilerp(float64(p00[3]), float64(p10[3]), float64(p01[3]), float64(p11[3]), dx, dy)
	return clampU8(r), clampU8(g), clampU8(b), clampU8(a)
}

func getNRGBA(src *image.NRGBA, x, y, w, h int) [4]uint8 {
	if x < 0 || y < 0 || x >= w || y >= h {
		return [4]uint8{255, 255, 255, 255}
	}
	i := src.PixOffset(x, y)
	return [4]uint8{src.Pix[i], src.Pix[i+1], src.Pix[i+2], src.Pix[i+3]}
}

func bilerp(a, b, c, d, dx, dy float64) float64 {
	ab := a + (b-a)*dx
	cd := c + (d-c)*dx
	return ab + (cd-ab)*dy
}

func clampU8(v float64) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v + 0.5)
}

// cropNRGBA returns the sub-rectangle of src as a fresh NRGBA. The crop is
// validated against the source bounds; an empty or out-of-range crop is an
// error.
func cropNRGBA(src *image.NRGBA, c Crop) (*image.NRGBA, error) {
	if c.W <= 0 || c.H <= 0 {
		return nil, fmt.Errorf("crop: w and h must be > 0")
	}
	w := src.Rect.Dx()
	h := src.Rect.Dy()
	if c.X < 0 || c.Y < 0 || c.X >= w || c.Y >= h {
		return nil, fmt.Errorf("crop: origin out of range (image %dx%d)", w, h)
	}
	if c.X+c.W > w || c.Y+c.H > h {
		return nil, fmt.Errorf("crop: extent %d,%d %dx%d exceeds image %dx%d", c.X, c.Y, c.W, c.H, w, h)
	}
	out := image.NewNRGBA(image.Rect(0, 0, c.W, c.H))
	for y := 0; y < c.H; y++ {
		si := src.PixOffset(c.X, c.Y+y)
		di := out.PixOffset(0, y)
		copy(out.Pix[di:di+c.W*4], src.Pix[si:si+c.W*4])
	}
	return out, nil
}

// applyBrightness adds a constant offset to R,G,B (alpha untouched), clamped
// to [0,255]. In-place.
func applyBrightness(img *image.NRGBA, offset int) {
	if offset == 0 {
		return
	}
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i+0] = clampInt(int(img.Pix[i+0]) + offset)
		img.Pix[i+1] = clampInt(int(img.Pix[i+1]) + offset)
		img.Pix[i+2] = clampInt(int(img.Pix[i+2]) + offset)
	}
}

func clampInt(v int) uint8 {
	if v < 0 {
		return 0
	}
	if v > 255 {
		return 255
	}
	return uint8(v)
}

// applyContrast scales each RGB channel around the midpoint 128:
//
//	out = clamp((in - 128) * factor + 128, 0, 255)
//
// In-place.
func applyContrast(img *image.NRGBA, factor float64) {
	if factor == 1 {
		return
	}
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i+0] = contrastChannel(img.Pix[i+0], factor)
		img.Pix[i+1] = contrastChannel(img.Pix[i+1], factor)
		img.Pix[i+2] = contrastChannel(img.Pix[i+2], factor)
	}
}

func contrastChannel(v uint8, factor float64) uint8 {
	out := (float64(v)-128)*factor + 128
	return clampU8(out)
}

// toGray converts an NRGBA to image.Gray using Rec. 601 luma — same formula
// the frontend preview uses, so the live preview and backend agree.
func toGray(src *image.NRGBA) *image.Gray {
	w := src.Rect.Dx()
	h := src.Rect.Dy()
	out := image.NewGray(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			i := src.PixOffset(x, y)
			r := float64(src.Pix[i+0])
			g := float64(src.Pix[i+1])
			b := float64(src.Pix[i+2])
			lum := 0.299*r + 0.587*g + 0.114*b
			out.SetGray(x, y, color.Gray{Y: clampU8(lum)})
		}
	}
	return out
}
