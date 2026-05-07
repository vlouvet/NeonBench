package validate

// Issue is a single validation finding with a location in millimeters.
type Issue struct {
	Rule     string  `json:"rule"`     // min_bend_radius | max_segment_length | min_spacing | min_lead_in | sharp_bend_angle | unsupported_path | …
	Severity string  `json:"severity"` // "error" | "warning"
	Message  string  `json:"message"`
	XMM      float64 `json:"x_mm,omitempty"`
	YMM      float64 `json:"y_mm,omitempty"`
}

const (
	SeverityError   = "error"
	SeverityWarning = "warning"

	RuleMinBendRadius         = "min_bend_radius"
	RuleMaxSegmentLength      = "max_segment_length"
	RuleMinSpacing            = "min_spacing"
	RuleCrossingNeedsBlockout = "crossing_needs_blockout"
	RuleSpliceRecommended     = "splice_recommended"
	RuleMinLeadIn             = "min_lead_in"
	RuleSharpBendAngle        = "sharp_bend_angle"
	RuleUnsupportedPath       = "unsupported_path"
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
//
// MinLeadInMM and SharpBendAngleDeg are optional Tier 3 #29 rule limits.
// When zero (the natural default for callers that don't set them, and the
// fall-through value for tube_specs rows whose nullable columns are NULL),
// the rules derive a sensible default at evaluation time: MinLeadInMM
// falls back to 2 × DiameterMM (rule-of-thumb ~25 mm for 12 mm tube, per
// Miller App I §126 and Saving Neon), and SharpBendAngleDeg falls back to
// 85° (the trade-standard threshold below which a hand-bender starts
// fighting stress concentration on round tube).
//
// WallThicknessMM and BendTechnique are optional Tier 3 #31 inputs to the
// bend-radius derivation. When MinBendRadiusMM is zero, runBendLimitMM
// consults derivedMinBendRadius(DiameterMM, WallThicknessMM, BendTechnique)
// — see internal/validate/rules.go for the K-table and provenance. Both
// fields gracefully degrade to a diameter-only fallback when empty.
type Limits struct {
	DiameterMM         float64
	MinBendRadiusMM    float64
	MaxSegmentLengthMM float64
	MinSpacingMM       float64
	MinLeadInMM        float64
	SharpBendAngleDeg  float64
	WallThicknessMM    float64
	BendTechnique      string
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
