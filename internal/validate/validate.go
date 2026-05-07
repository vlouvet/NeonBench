package validate

import (
	"time"
)

// ValidateSVG runs the full validation pass on an SVG document against the
// given tube-spec limits. The returned report is non-nil unless parsing
// itself fatally failed.
func ValidateSVG(svgData []byte, limits Limits) (*Report, error) {
	polylines, bbox, parseIssues, err := extractMMPolylines(svgData)
	if err != nil {
		return nil, err
	}

	issues := append([]Issue(nil), parseIssues...)
	issues = append(issues, checkBendRadiusClustered(polylines, limits)...)
	issues = append(issues, checkSegmentLength(polylines, limits)...)
	issues = append(issues, checkSpacing(polylines, limits)...)
	issues = append(issues, checkMinLeadIn(polylines, limits)...)
	issues = append(issues, checkSharpBendAngles(polylines, limits)...)
	issues = append(issues, checkCapHeight(bbox)...)

	var totalLen float64
	for _, pl := range polylines {
		totalLen += pl.Length()
	}

	return &Report{
		Issues:        issues,
		TubeRuns:      len(polylines),
		TotalLengthMM: totalLen,
		BoundingBoxMM: bbox,
		GeneratedAt:   time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
	}, nil
}
