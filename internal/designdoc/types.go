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
//
// Direction matters only for closed runs with two electrodes: it tells us
// which of the two arcs around the loop is the live tube ("forward" walks
// indices up from electrode[0] to electrode[1]; "backward" walks down).
// For open polylines or runs with fewer than two electrodes, direction is
// ignored.
type Run struct {
	ID             string       `json:"id"`
	Polyline       Polyline     `json:"polyline"`
	TubeDiameterMM float64      `json:"tube_diameter_mm,omitempty"`
	Color          string       `json:"color,omitempty"`
	Electrodes     []Electrode  `json:"electrodes,omitempty"`
	Direction      string       `json:"direction,omitempty"` // "forward" | "backward"
	Blockouts      []Blockout   `json:"blockouts,omitempty"`
	Annotations    []Annotation `json:"annotations,omitempty"`
	Bends          []Bend       `json:"bends,omitempty"`
}

// Bend is a single user-authored bend apex along the run's live arc.
// LiveIndex matches the convention used by Blockout and Annotation. When
// the run has no manual bends, the editor and printer fall back to
// ComputeBends auto-detection.
type Bend struct {
	LiveIndex int `json:"live_index"`
}

// Annotation is a single point marker on a run's live arc, informational
// only — the bender's pattern picks them up so they know where to leave
// extra clearance (jumps) or where to mount supports.
//
// Kind is "jump" (a horseshoe lift over another tube or obstacle) or
// "support" (a chassis-mount point holding the tube to the substrate).
// LiveIndex is a position WITHIN the live arc, same convention as
// Blockout.StartLiveIndex, so user intent survives later edits to
// electrodes or direction.
type Annotation struct {
	Kind      string `json:"kind"` // "jump" | "support"
	LiveIndex int    `json:"live_index"`
}

// Blockout is a segment of a run's live arc covered by black-out paint.
// Indices reference live-arc positions (0-based), not raw polyline points,
// so the user marks "from this point on the visible tube to that point" and
// the back-end translates to the underlying polyline indices when rendering.
//
// Per Saving Neon (p.19) and Miller (1935 p.60), block-out paint is the
// standard way crossings and run-to-run jumps are hidden so they don't
// glow.
type Blockout struct {
	StartLiveIndex int `json:"start_live_index"`
	EndLiveIndex   int `json:"end_live_index"`
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
