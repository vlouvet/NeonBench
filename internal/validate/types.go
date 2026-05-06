package validate

// Issue is a single validation finding with a location in millimeters.
type Issue struct {
	Rule     string  `json:"rule"`     // min_bend_radius | max_segment_length | min_spacing | unsupported_path
	Severity string  `json:"severity"` // "error" | "warning"
	Message  string  `json:"message"`
	XMM      float64 `json:"x_mm,omitempty"`
	YMM      float64 `json:"y_mm,omitempty"`
}

const (
	SeverityError   = "error"
	SeverityWarning = "warning"

	RuleMinBendRadius        = "min_bend_radius"
	RuleMaxSegmentLength     = "max_segment_length"
	RuleMinSpacing           = "min_spacing"
	RuleCrossingNeedsBlockout = "crossing_needs_blockout"
	RuleSpliceRecommended    = "splice_recommended"
	RuleUnsupportedPath      = "unsupported_path"
)

// Report summarizes the validation pass for a design version.
type Report struct {
	Issues          []Issue   `json:"issues"`
	TubeRuns        int       `json:"tube_runs"`         // disjoint subpaths (each needs electrodes)
	TotalLengthMM   float64   `json:"total_length_mm"`   // sum of all polyline arc lengths
	BoundingBoxMM   [4]float64 `json:"bounding_box_mm"`  // [minX, minY, maxX, maxY]
	GeneratedAt     string    `json:"generated_at"`
}

// Limits packages the tube_spec values relevant to validation.
type Limits struct {
	DiameterMM         float64
	MinBendRadiusMM    float64
	MaxSegmentLengthMM float64
	MinSpacingMM       float64
}

// HasErrors returns true if any issue has SeverityError.
func (r *Report) HasErrors() bool {
	for _, i := range r.Issues {
		if i.Severity == SeverityError {
			return true
		}
	}
	return false
}
