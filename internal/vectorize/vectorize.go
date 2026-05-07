package vectorize

import (
	"context"
	"fmt"
	"math"
)

// Request bundles all inputs to a vectorize call.
type Request struct {
	SourceBytes       []byte  // PNG or JPEG bytes
	TargetWidthMM     float64 // physical width of the design in mm
	Threshold         uint8   // 0..255, pixels darker than this become foreground
	SmoothingMM       float64 // RDP epsilon (mm). 0 → derive from DefaultDiameterMM
	MinSpurMM         float64 // spur prune threshold (mm). 0 → derive from DefaultDiameterMM
	DefaultDiameterMM float64 // project tube diameter; drives spur+smoothing defaults. 0 → 12mm

	// Optional pre-binarize bitmap adjustments. Each is a no-op at its zero
	// value, preserving the original Decode→Binarize behaviour for callers
	// that don't set them. Apply order: rotate → crop → brightness →
	// contrast → luminance → threshold.
	RotationDeg float64 // -45..+45, 0 = no rotation
	Crop        *Crop   // nil = full image (post-rotation coordinates)
	Brightness  int     // -100..+100, 0 = no change
	Contrast    float64 // 0.5..2.0, 0 or 1 = no change
}

// Result holds the output of a successful vectorize call.
type Result struct {
	SVG           []byte
	WidthPx       int
	HeightPx      int
	WidthMM       float64
	HeightMM      float64
	ThresholdUsed uint8
	Polylines     []MMPolyline // optional fast-path for callers skipping SVG round-trip
}

const (
	defaultDiameterMM = 12.0
	maxPruneIters     = 3
)

// VectorizeRaster runs the centerline-extraction pipeline:
//   decode raster → binarize → Zhang-Suen thin → classify pixels →
//   merge thick junction clusters → walk graph into polylines → prune
//   spurs (iterate until stable) → convert to mm → RDP simplify → emit SVG.
//
// The output SVG has paths in mm coordinates with a viewBox in mm so the
// downstream validator and design-doc parsers see identity-mapped paths.
func VectorizeRaster(ctx context.Context, req Request) (*Result, error) {
	_ = ctx // reserved for cancellation if needed; current pipeline is fast enough not to bother
	if req.TargetWidthMM <= 0 {
		return nil, fmt.Errorf("target_width_mm must be > 0")
	}
	if req.Threshold == 0 {
		req.Threshold = 128
	}
	D := req.DefaultDiameterMM
	if D <= 0 {
		D = defaultDiameterMM
	}

	bin, widthPx, heightPx, err := PreprocessAndBinarize(req.SourceBytes, PreprocessOptions{
		RotationDeg: req.RotationDeg,
		Crop:        req.Crop,
		Brightness:  req.Brightness,
		Contrast:    req.Contrast,
		Threshold:   req.Threshold,
	})
	if err != nil {
		return nil, err
	}
	if widthPx == 0 || heightPx == 0 {
		return nil, fmt.Errorf("decoded image has zero size")
	}

	skel := Thin(bin)

	mmPerPx := req.TargetWidthMM / float64(widthPx)
	heightMM := float64(heightPx) * mmPerPx

	// Spur prune in pixels — derive from diameter unless overridden.
	minSpurMM := req.MinSpurMM
	if minSpurMM <= 0 {
		minSpurMM = math.Max(2*D, 4) // at least 4mm so 0.1mm/px doesn't make this absurdly aggressive
	}
	minSpurPx := int(math.Ceil(minSpurMM / mmPerPx))
	if minSpurPx < 5 {
		minSpurPx = 5
	}

	// RDP epsilon — derive from diameter unless overridden.
	smoothingMM := req.SmoothingMM
	if smoothingMM <= 0 {
		smoothingMM = math.Max(0.3, D/40)
	}

	var polys [][]point
	for iter := 0; iter < maxPruneIters; iter++ {
		g := newPixelGraph(skel)
		walked := g.extractPolylines()
		survived, pruned := prunePolylines(g, walked, minSpurPx)
		polys = survived
		if !pruned {
			break
		}
		// Re-skeletize: rebuild a binary image from the surviving
		// polylines so the next iteration's classifier sees the actual
		// post-prune topology.
		skel = polylinesToBinary(survived, skel.W, skel.H)
	}

	mmPolys := make([]MMPolyline, 0, len(polys))
	for _, p := range polys {
		mp := pixelsToMM(p, mmPerPx)
		if len(mp.Points) < 2 {
			continue
		}
		mp = RDPSimplify(mp, smoothingMM)
		if len(mp.Points) < 2 {
			continue
		}
		mmPolys = append(mmPolys, mp)
	}

	svg := EmitSVG(mmPolys, req.TargetWidthMM, heightMM)
	return &Result{
		SVG:           svg,
		WidthPx:       widthPx,
		HeightPx:      heightPx,
		WidthMM:       req.TargetWidthMM,
		HeightMM:      heightMM,
		ThresholdUsed: req.Threshold,
		Polylines:     mmPolys,
	}, nil
}

// polylinesToBinary rebuilds a 1-pixel-wide skeleton image from a set of
// pixel-space polylines. Used between prune iterations so the next
// classify pass sees the right degrees.
func polylinesToBinary(polys [][]point, w, h int) *BinaryImage {
	out := NewBinaryImage(w, h)
	for _, p := range polys {
		for _, pt := range p {
			if pt.X >= 0 && pt.X < w && pt.Y >= 0 && pt.Y < h {
				out.Pix[pt.Y*w+pt.X] = true
			}
		}
	}
	return out
}
