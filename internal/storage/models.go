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
	// Optional per-spec lead-in rule (Tier 3 #29). Pointer so nil means
	// "no override; validator falls back to 2 × DiameterMM, the
	// rule-of-thumb minimum from Miller App I §126 and Saving Neon".
	MinLeadInMM *float64 `json:"min_lead_in_mm,omitempty"`
	// Optional per-spec sharp-bend angle threshold in degrees (Tier 3
	// #29). Vertices whose interior angle is at or below this value get
	// flagged as bender-unfriendly stress concentrators. Pointer so nil
	// means "no override; validator falls back to 85°". Hairpin
	// double-backs are exempted regardless of this threshold.
	SharpBendAngleDeg *float64 `json:"sharp_bend_angle_deg,omitempty"`
	// Optional outer-wall thickness in millimeters (Tier 3 #31). Lets
	// the bend-radius derivation in validate/rules.go pick a tighter
	// or looser default when min_bend_radius_mm is left blank. nil
	// means "no per-spec value; the derivation falls back to the
	// diameter-only 2.25×D bound from docs/neon-rules/bend-radius.md".
	// Typical clear-glass values: 1.0 mm (8 mm tube) → 1.5 mm (15 mm
	// tube), per Miller p.115 / NT Table 3.10.
	WallThicknessMM *float64 `json:"wall_thickness_mm,omitempty"`
	// Optional bend technique (Tier 3 #31). One of "ribbon",
	// "crossfire", or "hand_torch" — see derivedMinBendRadius for the
	// K-constant table. nil means "no per-spec value; the derivation
	// falls back to the diameter-only 2.25×D bound".
	BendTechnique *string `json:"bend_technique,omitempty"`
	IsDefault     bool    `json:"is_default"`
	CreatedAt     string  `json:"created_at"`
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
	// Optional channel-letter depth in millimeters (NW #106). Height
	// of the U-channel sheet-metal box that surrounds each face;
	// drives the height of the return-strip pages on the print PDF.
	// nil means "no per-project override; renderers fall back to the
	// shop default of 100 mm (≈ 4 in)".
	ChannelLetterDepthMM *float64 `json:"channel_letter_depth_mm,omitempty"`
	// Optional channel-letter strip-overlap allowance in millimeters
	// (Tier 3 #26). The fabricator leaves this much extra metal at one
	// end of an unfolded return strip so the seam can be welded or
	// pop-riveted through doubled-up sheet. nil means "no per-project
	// override; the renderer falls back to the shop default of 12.7 mm
	// (½ in, Strattman NT Ch.5 trade convention)".
	StripOverlapMM *float64 `json:"strip_overlap_mm,omitempty"`
	// FacePerimeterStrictMode escalates RuleFacePerimeterExceedsBlank
	// from a warning to a hard error when set (Tier 3 #46). Default
	// false preserves the historical warning-level behaviour so
	// existing reports stay identical post-migration. Stored as
	// INTEGER 0/1 in SQLite per the project conventions; surfaced as
	// a JSON boolean to the frontend.
	FacePerimeterStrictMode bool   `json:"face_perimeter_strict_mode"`
	CreatedAt               string `json:"created_at"`
	UpdatedAt               string `json:"updated_at"`
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
