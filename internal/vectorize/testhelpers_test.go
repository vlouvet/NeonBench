package vectorize

import (
	"image"
	"image/color"
)

func newGrayLine(values []uint8) *image.Gray {
	gray := image.NewGray(image.Rect(0, 0, len(values), 1))
	for i, v := range values {
		gray.SetGray(i, 0, color.Gray{Y: v})
	}
	return gray
}
