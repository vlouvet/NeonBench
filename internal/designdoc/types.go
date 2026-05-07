package designdoc

// Doc is the structured editable representation of a neon design. It carries
// enough information to round-trip through the editor and re-render to SVG.
// All coordinates are in millimeters.
type Doc struct {
	Version    int         `json:"version"`     // schema version
	ViewBoxMM  [4]float64  `json:"view_box_mm"` // [x, y, w, h]
	Runs       []Run       `json:"runs"`
	Labels     []Label     `json:"labels,omitempty"`
	Dimensions []Dimension `json:"dimensions,omitempty"`
}

// Label is a free-form text marker placed in mm coordinates. Used for
// callouts ("transformer", "wall mount", "do not bend below 50mm") that
// belong to the design as a whole, not to any one run.
type Label struct {
	X    float64 `json:"x"` // mm
	Y    float64 `json:"y"` // mm
	Text string  `json:"text"`
}

// Dimension is a measured line between two world-space points. The editor
// auto-computes the distance from the endpoints; an optional Note can add
// context the measurement alone doesn't convey ("min spacing", "centerline").
type Dimension struct {
	X1   float64 `json:"x1"`
	Y1   float64 `json:"y1"`
	X2   float64 `json:"x2"`
	Y2   float64 `json:"y2"`
	Note string  `json:"note,omitempty"`
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
	Notes          string       `json:"notes,omitempty"` // free-form: transformer specs, voltage, gas, anything else worth printing on the pattern
	// IsChannelLetterFace marks this run's polyline as the silhouette of
	// a channel-letter face — a flat sheet-metal cut whose perimeter is
	// wrapped by a "return strip" forming the side wall of the 3D letter
	// box (Strattman NT Ch.5; Miller p.88). When true, the print PDF
	// emits an additional page per run with the unfolded return strip
	// and bend marks at every polyline vertex (NW #106).
	IsChannelLetterFace bool `json:"is_channel_letter_face,omitempty"`
	// ChannelLetterDepthMM optionally overrides the project-wide
	// channel-letter depth for this run (Tier 3 #26). nil means "use
	// the project default; if the project also has no value, the
	// renderer falls back to the 100 mm shop default." Only meaningful
	// when IsChannelLetterFace is true. Lets one project mix tall and
	// shallow returns (e.g. main letterforms vs. bracket frames).
	ChannelLetterDepthMM *float64 `json:"channel_letter_depth_mm,omitempty"`
	// RacewayID optionally groups runs that share a single back-channel
	// strip (Strattman raceway construction — e.g. all letters in
	// "OPEN" share one continuous return). Free-form short string;
	// runs with the same value are concatenated into one combined
	// unfolded strip page in declaration order. Empty = ungrouped
	// (one strip per face run, the original behavior).
	RacewayID string `json:"raceway_id,omitempty"`
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
