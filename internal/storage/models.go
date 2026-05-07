package storage

// Timestamps are stored and returned as ISO8601 strings; modernc.org/sqlite
// returns TEXT columns as strings and the frontend parses them as needed.

type TubeSpec struct {
	ID                 int64   `json:"id"`
	Name               string  `json:"name"`
	DiameterMM         float64 `json:"diameter_mm"`
	MinBendRadiusMM    float64 `json:"min_bend_radius_mm"`
	MaxSegmentLengthMM float64 `json:"max_segment_length_mm"`
	MinSpacingMM       float64 `json:"min_spacing_mm"`
	IsDefault          bool    `json:"is_default"`
	CreatedAt          string  `json:"created_at"`
}

type Project struct {
	ID         int64  `json:"id"`
	Name       string `json:"name"`
	TubeSpecID int64  `json:"tube_spec_id"`
	Units      string `json:"units"`
	// Optional Job Manager metadata. Stored as nullable TEXT in SQLite;
	// we render absent values as empty strings to keep the JSON shape
	// stable (the frontend treats "" the same as missing).
	Customer  string `json:"customer"`
	Designer  string `json:"designer"`
	DueDate   string `json:"due_date"`
	JobNumber string `json:"job_number"`
	// Optional tube end gap in millimeters. Distance from the tube's
	// actual endpoint to the inside edge of the channel letter or
	// substrate it sits in (NW #135). Pointer so that nil means "no
	// per-project override; consumers should fall back to the shop
	// default of 6.35 mm (¼ in, Miller App I §126)".
	TubeEndGapMM *float64 `json:"tube_end_gap_mm,omitempty"`
	CreatedAt    string   `json:"created_at"`
	UpdatedAt    string   `json:"updated_at"`
}

type AssetKind string

const (
	AssetKindSource AssetKind = "source_image"
	AssetKindVector AssetKind = "vector"
	AssetKindPrint  AssetKind = "print_output"
)

type Asset struct {
	ID        int64     `json:"id"`
	ProjectID int64     `json:"project_id"`
	Kind      AssetKind `json:"kind"`
	Filename  string    `json:"filename"`
	MIME      string    `json:"mime"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt string    `json:"created_at"`
}
