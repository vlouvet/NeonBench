package vectorize

import (
	"bytes"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	_ "image/jpeg"
	_ "image/png"
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

// EncodePBM converts a Gray image to a PBM P4 (binary) bitmap, with pixels
// darker than `threshold` (0..255) marked as black (the bit value potrace traces).
func EncodePBM(gray *image.Gray, threshold uint8) []byte {
	bounds := gray.Bounds()
	w, h := bounds.Dx(), bounds.Dy()
	rowBytes := (w + 7) / 8

	var buf bytes.Buffer
	fmt.Fprintf(&buf, "P4\n%d %d\n", w, h)

	row := make([]byte, rowBytes)
	for y := 0; y < h; y++ {
		for i := range row {
			row[i] = 0
		}
		for x := 0; x < w; x++ {
			lum := gray.GrayAt(bounds.Min.X+x, bounds.Min.Y+y).Y
			if lum < threshold {
				row[x/8] |= 1 << (7 - uint(x%8))
			}
		}
		buf.Write(row)
	}
	return buf.Bytes()
}
