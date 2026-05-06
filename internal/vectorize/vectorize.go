package vectorize

import (
	"context"
	"fmt"
)

// Request bundles all inputs to a vectorize call.
type Request struct {
	SourceBytes   []byte // PNG or JPEG bytes
	TargetWidthMM float64
	Threshold     uint8 // 0..255, pixels darker than this are traced as black
	Potrace       PotraceParams
}

// Result holds the output of a successful vectorize call.
type Result struct {
	SVG       []byte
	WidthPx   int
	HeightPx  int
	WidthMM   float64
	ThresholdUsed uint8
}

// VectorizeRaster runs the full pipeline: decode raster → threshold → PBM →
// potrace → SVG. The caller is responsible for handling SVG inputs separately
// (no vectorization needed).
func VectorizeRaster(ctx context.Context, req Request) (*Result, error) {
	if req.TargetWidthMM <= 0 {
		return nil, fmt.Errorf("target_width_mm must be > 0")
	}
	if req.Threshold == 0 {
		req.Threshold = 128
	}

	gray, err := DecodeImage(req.SourceBytes)
	if err != nil {
		return nil, err
	}
	pbm := EncodePBM(gray, req.Threshold)

	p := req.Potrace
	p.WidthMM = req.TargetWidthMM
	if p.TurnPolicy == "" {
		p = DefaultPotraceParams(req.TargetWidthMM)
	}

	svg, err := RunPotrace(ctx, pbm, p)
	if err != nil {
		return nil, err
	}
	bounds := gray.Bounds()
	return &Result{
		SVG:           svg,
		WidthPx:       bounds.Dx(),
		HeightPx:      bounds.Dy(),
		WidthMM:       req.TargetWidthMM,
		ThresholdUsed: req.Threshold,
	}, nil
}
