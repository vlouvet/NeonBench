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
