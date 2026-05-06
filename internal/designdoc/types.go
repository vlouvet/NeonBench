package designdoc

// Doc is the structured editable representation of a neon design. It carries
// enough information to round-trip through the editor and re-render to SVG.
// All coordinates are in millimeters.
type Doc struct {
	Version   int        `json:"version"`     // schema version
	ViewBoxMM [4]float64 `json:"view_box_mm"` // [x, y, w, h]
	Runs      []Run      `json:"runs"`
}

// Run is one continuous tube path (one disjoint subpath in the source SVG).
// In Phase 2 v1 the geometry is held as a flattened polyline (not Beziers);
// adequate for selection, pan/zoom, and electrode placement. Bezier-aware
// editing is a later slice.
type Run struct {
	ID             string      `json:"id"`
	Polyline       Polyline    `json:"polyline"`
	TubeDiameterMM float64     `json:"tube_diameter_mm,omitempty"`
	Color          string      `json:"color,omitempty"`
	Electrodes     []Electrode `json:"electrodes,omitempty"`
}

type Polyline struct {
	Points [][2]float64 `json:"points"` // pairs of [x, y] in mm
	Closed bool         `json:"closed"`
}

// Electrode marks a tube end. PointIndex is the index into the parent run's
// polyline. A run with two electrodes is "open" between them; a run with no
// electrodes is unassigned.
type Electrode struct {
	PointIndex int `json:"point_index"`
}

const SchemaVersion = 1
