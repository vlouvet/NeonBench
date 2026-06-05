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
	// Groups bind multiple runs into a logical unit (Tier 3 #33b /
	// NW #139). The slice is the source-of-truth for group display
	// names; runs only carry the foreign key Run.GroupID. omitempty
	// keeps pre-33b doc JSON byte-identical when no groups are
	// defined. Groups are editor-only metadata — the validator and
	// renderer ignore membership; they exist purely so the editor
	// can extend selection and apply ops to many runs at once.
	Groups []Group `json:"groups,omitempty"`
}

// Group is a named binding of two-or-more runs. Membership is recorded
// on the Run side (Run.GroupID), so dropping a group entry here without
// also clearing the FKs leaves orphan IDs — see docOps.dissolveGroup
// for the canonical "drop entry + clear FKs" mutation. A run can only
// belong to one group at a time (Tier 3 #33b deliberately rejects M:N
// — keeps the model simple; nested groups are explicitly out of scope
// for this slice).
//
// Visible and Locked are display-only flags carried by the Layers panel
// (Tier 3 #33c). Visible is a pointer-bool so a nil value (the only
// shape possible in pre-33c persisted JSON) deserializes as "visible"
// — the back-compat invariant. A non-nil *false hides the group's
// runs from the canvas; a non-nil *true is functionally identical to
// nil but lets a caller emit an explicit "visible: true" if it wants
// to. Locked is a plain bool (zero-value false = unlocked) because
// "unlocked" is the only sane default for a brand-new group; no
// pointer trickery is needed there.
//
// Both flags are *display* filters — the validator, save path, PDF,
// and DXF emitters all see hidden + locked runs identically to any
// other run. Hidden ≠ deleted; locked ≠ read-only-everywhere. Lock
// blocks click-selection on the canvas; the Layers sidebar bypasses
// the lock on its own click handlers (sidebar entry-point is the
// escape hatch for selecting a locked group's members so the user
// can edit colors / delete via the explicit selection ops).
type Group struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Visible *bool  `json:"visible,omitempty"` // nil = visible (back-compat); *false = hidden
	Locked  bool   `json:"locked,omitempty"`  // false = unlocked (default)
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
	// Kind classifies the run for downstream rendering / validation.
	// Allowed values: "" (default — primary tube run) and "jumper" (a
	// short splice tube — Strattman Fig.11.3 10–11 mm OD with a flared
	// end, or Miller p.204–205 16 mm OD glass-sleeved twisted lead-
	// wire — that bridges the live electrical path between two adjacent
	// primary runs whose physical ends sit close together). Jumpers
	// render dashed on the 2D pattern, thinner / dimmer in the 3D
	// preview, and are skipped by the bend-list summary page (a 2-
	// vertex polyline has no bends). Empty / missing for old design
	// blobs deserializes cleanly to "" (primary tube), so this field
	// requires no schema migration — it flows through the existing
	// design_doc JSON blob (Tier 3 #60 / NW #125).
	Kind string `json:"kind,omitempty"`
	// GroupID is the foreign key into Doc.Groups (Tier 3 #33b /
	// NW #139). Empty (zero-value) means "ungrouped"; non-empty
	// means this run is bound to the group with that ID and the
	// editor extends selection to every sibling sharing the same
	// value. omitempty keeps pre-33b doc JSON byte-identical for
	// runs that aren't grouped. A run can only belong to one
	// group at a time — re-grouping replaces the prior value, it
	// doesn't introduce M:N membership.
	GroupID string `json:"group_id,omitempty"`
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
// Kind is "jump" (a horseshoe lift over another tube or obstacle),
// "support" (a chassis-mount point holding the tube to the substrate),
// "doubleback" (a hairpin where the tube reverses direction; suppresses
// the bend-radius warning for that vertex), or "drop_bend" (Tier 3 #77
// — an out-of-plane drop where the tube dips slightly away from the
// substrate; distinct trade vocabulary from a jump, smaller 3D lift
// multiplier, dedicated "DROP" bend-list entry). LiveIndex is a position
// WITHIN the live arc, same convention as Blockout.StartLiveIndex, so
// user intent survives later edits to electrodes or direction.
type Annotation struct {
	Kind      string `json:"kind"` // "jump" | "support" | "doubleback" | "drop_bend"
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
//
// HousingType, BoreDiameterMM, and ElevationMM describe the porcelain or
// ceramic housing that holds the spring contact at the cabinet end of the
// electrode lead-in (Miller Ch.IV p.62; Strattman NT Ch.3 Table 3.4). All
// three fields are optional and serialize as zero values for old design-doc
// blobs (omitempty), so adding them required no schema migration.
//
// HousingType is one of "" (no housing — the V1 default), "shell-15"
// (15-shell, 3/8" × 1-5/16"), "shell-19" (19-shell, 1/2" × 1-5/8"), or
// "custom". When stock shells are picked, BoreDiameterMM is ignored — the
// frontend's HOUSING_LIBRARY is authoritative for those dimensions. When
// HousingType == "custom", BoreDiameterMM carries the operator-supplied
// inner diameter. ElevationMM is the housing's mounting height above the
// substrate (raceway / cabinet face) in millimeters; meaningful for any
// non-empty HousingType.
type Electrode struct {
	PointIndex     int     `json:"point_index"`
	HousingType    string  `json:"housing_type,omitempty"`
	BoreDiameterMM float64 `json:"bore_diameter_mm,omitempty"`
	ElevationMM    float64 `json:"elevation_mm,omitempty"`
}

const SchemaVersion = 1
