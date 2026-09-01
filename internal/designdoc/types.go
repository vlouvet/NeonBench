package designdoc

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math"
)

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
	// Guidelines are editor-drawn construction lines (Tier 2 #74, extended
	// by Tier 2 #91). Two kinds share the slice and one id space:
	// "raceway" — the horizontal Y at which every tube crossing it gets
	// split, so the pieces below the line terminate in a single back-channel
	// strip — and "construction", a pure layout aid dragged off the canvas
	// rulers. Both are DESIGN INTENT, not geometry: the validator, renderer,
	// PDF and DXF emitters all ignore them, and splitting is an explicit
	// operator action rather than something that happens because a line
	// exists. omitempty keeps pre-#74 doc JSON byte-identical.
	Guidelines []Guideline `json:"guidelines,omitempty"`
	// Raceways model the physical aluminium box the letters mount to
	// (Tier 2 #104 / NW #133). A Raceway's ID is the ID of the "raceway"
	// Guideline that supplies its top edge — NOT a new id space. That is
	// the same identity Run.RacewayID already carries, so "these tubes
	// share a raceway" still has exactly one source of truth and the box
	// is simply extra hardware detail hung off it. A Raceway whose ID
	// matches no raceway guideline is rejected at unmarshal.
	//
	// omitempty keeps every pre-#104 doc's JSON byte-identical, the same
	// back-compat invariant Groups, Guidelines and SegmentTypes rely on.
	Raceways []Raceway `json:"raceways,omitempty"`
}

// UnmarshalJSON enforces the one cross-field invariant the schema has:
// every Raceway hangs off a "raceway" Guideline with the same ID. A
// Raceway is the box for a guideline, not an object in its own right, so
// a dangling one has no top edge, no member runs, and no place on the
// canvas — it can only be the residue of a client that deleted the
// guideline and forgot the box. Rejecting here means the editor finds out
// on save instead of the fabricator finding out in the PDF.
//
// The nested decoder keeps DisallowUnknownFields, which the server's
// decoder sets on the outer request object — a custom UnmarshalJSON on
// Doc would otherwise quietly re-open the WHOLE document to typo'd keys,
// which is the loudest possible version of recurring bug class 2.
func (d *Doc) UnmarshalJSON(data []byte) error {
	type docAlias Doc
	var alias docAlias
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&alias); err != nil {
		return err
	}
	out := Doc(alias)
	if len(out.Raceways) > 0 {
		racewayGuides := make(map[string]bool, len(out.Guidelines))
		for _, g := range out.Guidelines {
			if g.Kind == GuidelineKindRaceway {
				racewayGuides[g.ID] = true
			}
		}
		seen := make(map[string]bool, len(out.Raceways))
		for _, rw := range out.Raceways {
			if !racewayGuides[rw.ID] {
				return fmt.Errorf(
					"raceway %q: no guideline with that id and kind %q — a raceway box is the hardware for a raceway guideline, it has no identity of its own",
					rw.ID, GuidelineKindRaceway)
			}
			if seen[rw.ID] {
				return fmt.Errorf("raceway %q: duplicated — one guideline carries at most one box", rw.ID)
			}
			seen[rw.ID] = true
		}
	}
	*d = out
	return nil
}

// Guideline is a construction line in the 2D editor.
//
// Two kinds share this type and one id space:
//
//   - "raceway" — DESIGN INTENT with teeth. Its ID doubles as the RacewayID
//     stamped on every run split at this line, which is what ties the pieces
//     together for the combined strip page the PDF emitter already builds
//     (PR #43 / Tier 3 #46). That coupling is deliberate: it means "these
//     tubes share a raceway" has exactly one source of truth rather than a
//     guideline and a separately-typed group that can drift. Horizontal only
//     — a vertical back-channel strip is not a thing that can be fabricated,
//     so we reject it at the door rather than emit a strip page that cannot
//     exist.
//   - "construction" — a layout aid (Tier 2 #91). Dragged off the canvas
//     rulers, snapped to while drawing, and otherwise inert: it never reaches
//     splitTubesAtRaceway, never stamps a RacewayID, and never appears in the
//     PDF or DXF. It means nothing to the fabricator.
//
// Axis picks which coordinate carries the position:
//
//	axis "" or "h" → horizontal line at YMM (XMM unused, stays 0)
//	axis "v"       → vertical line at XMM (YMM unused, stays 0)
//
// XMM and Axis are omitempty because a horizontal guideline has to keep
// marshaling to exactly {"id","kind","y_mm"} — the same byte-identical
// back-compat invariant Group.Visible and Doc.Guidelines itself rely on.
// Every pre-#91 doc round-trips unchanged.
type Guideline struct {
	ID   string  `json:"id"`
	Kind string  `json:"kind"`           // "raceway" | "construction"
	YMM  float64 `json:"y_mm"`           // horizontal position; 0 for vertical guides
	XMM  float64 `json:"x_mm,omitempty"` // vertical position; omitted for horizontal
	Axis string  `json:"axis,omitempty"` // "" | "h" (default) | "v"
}

// Guideline kinds. See the Guideline doc comment for what each one means to
// the fabricator (short version: raceway cuts tubes, construction does not).
const (
	GuidelineKindRaceway      = "raceway"
	GuidelineKindConstruction = "construction"
)

// Guideline axes. The empty string is a synonym for GuidelineAxisH so that
// pre-#91 blobs — which have no "axis" key at all — keep deserializing.
const (
	GuidelineAxisH = "h"
	GuidelineAxisV = "v"
)

// IsVertical reports whether the guideline's position is carried by XMM.
func (g Guideline) IsVertical() bool { return g.Axis == GuidelineAxisV }

// PositionMM returns the coordinate the guideline actually lives at, on
// whichever axis it is drawn.
func (g Guideline) PositionMM() float64 {
	if g.IsVertical() {
		return g.XMM
	}
	return g.YMM
}

// UnmarshalJSON rejects the combinations that have no meaning rather than
// letting them through to be reinterpreted downstream. In particular a
// vertical raceway is refused outright: splitTubesAtRaceway reads YMM, so a
// vertical raceway guideline would silently cut every tube at y=0 and group
// the debris into a strip page that no shop can build.
//
// The nested decoder keeps DisallowUnknownFields, which the server's decoder
// sets on the outer document — a custom UnmarshalJSON would otherwise quietly
// re-open this one object to typo'd keys.
func (g *Guideline) UnmarshalJSON(data []byte) error {
	type guidelineAlias Guideline
	var alias guidelineAlias
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&alias); err != nil {
		return err
	}
	out := Guideline(alias)
	switch out.Kind {
	case GuidelineKindRaceway, GuidelineKindConstruction:
	default:
		return fmt.Errorf("guideline %q: kind = %q, want %q or %q",
			out.ID, out.Kind, GuidelineKindRaceway, GuidelineKindConstruction)
	}
	switch out.Axis {
	case "", GuidelineAxisH, GuidelineAxisV:
	default:
		return fmt.Errorf("guideline %q: axis = %q, want %q, %q or empty",
			out.ID, out.Axis, GuidelineAxisH, GuidelineAxisV)
	}
	if out.Kind == GuidelineKindRaceway && out.Axis == GuidelineAxisV {
		return fmt.Errorf("guideline %q: kind %q must be horizontal — a vertical raceway strip cannot be fabricated",
			out.ID, GuidelineKindRaceway)
	}
	*g = out
	return nil
}

// Raceway is the physical enclosure the channel letters mount to and that
// houses the transformers, the wiring and the disconnect (Tier 2 #104 /
// NW #133). It is a rectangular aluminium box that spans the letter set and
// bolts to the building — the one component the installer actually anchors,
// and until now the only part of the assembly NeonBench did not model.
//
// IDENTITY: ID is the ID of the "raceway" Guideline that supplies the box's
// TOP EDGE, which is the same value Run.RacewayID already carries on every
// tube split at that line. There is no third id space and no new foreign
// key: the guideline gives Y, this record gives X, length, height and depth,
// and every member run is already pointing at it. Doc.UnmarshalJSON rejects
// a Raceway whose ID matches no raceway guideline.
//
// Every dimension is operator-overridable, and deliberately so: the numbers
// in docs/neon-rules/raceway.md come from supplier pages and a trade forum,
// not from the trade textbooks the rest of docs/neon-rules/ cites. Zero on
// HeightMM / DepthMM means "use the shop default" (RacewayDefaultHeightMM /
// RacewayDefaultDepthMM) rather than "a box with no height".
type Raceway struct {
	ID       string  `json:"id"`
	XMM      float64 `json:"x_mm"` // left edge, world mm
	LengthMM float64 `json:"length_mm"`
	HeightMM float64 `json:"height_mm,omitempty"` // 0 = shop default
	DepthMM  float64 `json:"depth_mm,omitempty"`  // 0 = shop default
}

// Raceway shop defaults, all in millimetres. See docs/neon-rules/raceway.md
// for the citations — and for the warning that this file's source class is
// weaker than the rest of docs/neon-rules/, which is why every one of these
// is overridable per raceway rather than baked in.
const (
	// RacewayDefaultDepthMM and RacewayDefaultHeightMM are 8 in (203.2 mm),
	// NOT the 4–5 in figures most of the modern web quotes.
	//
	// Those smaller boxes are LED-era: an LED driver is small, so the box
	// shrank around it. A neon transformer did not shrink. A typical modern
	// 10 kV / 30 mA electronic transformer measures 159 mm long
	// (TransformerLengthMM below) — it physically cannot sit ACROSS a 127 mm
	// (5 in) raceway, it has to lie along the run, and there is then no room
	// left for GTO routing or for a hand to reach in and make the connection.
	// 8 in × 8 in is the only figure any source ties specifically to NEON
	// letters (Signs101: "an 8x8 raceway was the defacto standard").
	//
	// This comment exists so nobody "corrects" these back down to the LED
	// numbers on the strength of a supplier page. If you are about to, read
	// docs/neon-rules/raceway.md section "Cross-section" first.
	RacewayDefaultDepthMM  = 203.2
	RacewayDefaultHeightMM = 203.2

	// RacewaySpliceMM is the longest section that ships as one piece
	// (10 ft). Longer raceways are butt-spliced, so the PDF marks a splice
	// line at every multiple — a fabrication and shipping fact, the same way
	// the tube-length limit already is.
	RacewaySpliceMM = 3048.0

	// TransformerLengthMM is the measured length of a 10 kV / 30 mA
	// electronic neon transformer (6.25 in). Used by the validator to check
	// that the implied transformer count fits ALONG the raceway.
	TransformerLengthMM = 159.0

	// RacewayEndMarginMM is how far the box extends PAST the outermost
	// letters at each end.
	//
	// THIS IS AN OPEN QUESTION, NOT A MEASURED RULE. Every source says the
	// raceway "spans the entire length of the letters"; not one states
	// whether it stops flush with the first and last letter or overhangs by
	// some margin. See docs/neon-rules/raceway.md section "Open questions"
	// item 1, which says to ask a shop before encoding a formula.
	//
	// V1 is therefore FLUSH — zero is the only number here that was not
	// invented. It lives in this one named constant, applied at exactly one
	// place in each of the two auto-fit implementations (fitRacewayToRuns in
	// web/src/lib/docOps.ts and FitRacewayToRuns in raceway.go), so that
	// answering the open question is a one-line edit rather than an
	// archaeology exercise. Do not distribute it through the arithmetic.
	RacewayEndMarginMM = 0.0
)

// EffectiveHeightMM resolves the box height: the per-raceway override when
// set, else the shop default. Zero is "unset", not "flat".
func (r Raceway) EffectiveHeightMM() float64 {
	if r.HeightMM > 0 {
		return r.HeightMM
	}
	return RacewayDefaultHeightMM
}

// EffectiveDepthMM resolves the box depth the same way. Note this is a
// different quantity from Run.ChannelLetterDepthMM (how far the LETTER
// projects, default 100 mm): the raceway is ~203 mm deep for the unrelated
// reason that a transformer has to fit inside it. Two objects, two depths —
// see docs/neon-rules/raceway.md, "Terminology collision".
func (r Raceway) EffectiveDepthMM() float64 {
	if r.DepthMM > 0 {
		return r.DepthMM
	}
	return RacewayDefaultDepthMM
}

// SpliceCount is the number of butt splices a raceway of this length needs:
// sections ship at RacewaySpliceMM or shorter, so a 25 ft box arrives in
// three pieces with two seams. Exactly 10 ft needs none.
func (r Raceway) SpliceCount() int {
	if r.LengthMM <= RacewaySpliceMM {
		return 0
	}
	n := int(math.Ceil(r.LengthMM/RacewaySpliceMM)) - 1
	if n < 0 {
		return 0
	}
	return n
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
	// SegmentTypes classifies each SEGMENT, so it is one shorter than
	// Points for an open polyline (Tier 3 #78). nil — the shape every
	// pre-#78 blob has — means every segment is a straight line, so old
	// docs load and render identically.
	//
	// The non-default values are "arc" and "arc_r": the glass between those
	// two vertices follows a circular arc rather than the chord. Crucially
	// this does NOT change the vertex list. Electrodes, bends, blockouts and
	// annotations all index into Points, and an arc that inserted vertices
	// would silently renumber every one of them. An arc changes what is
	// drawn BETWEEN two vertices, nothing else.
	SegmentTypes []string `json:"segment_types,omitempty"`
}

// Segment type values. Anything else is rejected at unmarshal.
//
// Tier 3 #87 — the SIDE the bow falls on is part of the value, because a
// boolean "is an arc" cannot survive a point-order reversal. ArcFor bows to
// the left of travel, so reversing a chord moves the centre to the other side
// (probed: forward (50,-37.5), reversed (50,+37.5)), and no amount of index
// remapping undoes it — Bug #11. With the side stored, an op that reverses
// point order flips each arc's value and the drawn shape is preserved.
//
// "arc" keeps its pre-#87 meaning exactly: bow to the LEFT of travel, i.e.
// toward the chord direction rotated to (-dy, dx). Every stored document
// therefore reads back as the shape it was saved as, with no migration; and
// omitempty keeps a pre-#78 blob byte-identical.
//
// "arc_r" is the mirror of "arc" about the chord — same endpoints, same
// radius, same arc length, other side.
const (
	SegmentLine = "line"
	SegmentArc  = "arc"
	SegmentArcR = "arc_r"
)

// IsArcType reports whether a segment-type value draws a curve. Consumers ask
// this rather than comparing against SegmentArc, which is now only one of the
// two curved values — a bare `== SegmentArc` silently straightens every
// flipped arc.
func IsArcType(t string) bool { return t == SegmentArc || t == SegmentArcR }

// ArcFlipped reports whether a segment-type value bows to the RIGHT of
// travel. False for "line", which has no side at all.
func ArcFlipped(t string) bool { return t == SegmentArcR }

// FlipArcType returns the same segment with its bow on the other side of the
// chord. A line has no side and comes back unchanged.
//
// This is what every point-order reversal owes each of its arcs: travelling a
// chord backwards flips which side is "left", so the stored side must flip to
// keep the glass where it was.
func FlipArcType(t string) string {
	switch t {
	case SegmentArc:
		return SegmentArcR
	case SegmentArcR:
		return SegmentArc
	}
	return SegmentLine
}

// ArcBulge is the arc's sagitta expressed as a fraction of half the chord —
// the same quantity AutoCAD calls a bulge. 0.5 means the arc bows out from
// its chord by a quarter of the chord's length, which is the "simplest gentle
// curve through these two endpoints" the spec asks for.
//
// Everything else about the arc falls out of this one number, so the curve
// stays a genuine circle: included angle 4·atan(0.5) ≈ 106.26°, radius
// 0.625·chord, arc length ≈ 1.159·chord. That matters more than it might
// look. A circle is exactly representable as an SVG `A`, a PDF arc and a DXF
// ARC entity, so no emitter has to approximate; and the min-bend-radius rule
// is about a real radius, so an arc too tight for the glass is caught by the
// validator rather than discovered at the bending table.
const ArcBulge = 0.5

// SegmentType returns the type of the segment leaving vertex i. Out-of-range
// indices and a nil/short SegmentTypes all answer "line", which is what makes
// the field safe to omit.
func (p *Polyline) SegmentType(i int) string {
	if i < 0 || i >= len(p.SegmentTypes) {
		return SegmentLine
	}
	switch p.SegmentTypes[i] {
	case SegmentArc:
		return SegmentArc
	case SegmentArcR:
		return SegmentArcR
	}
	return SegmentLine
}

// HasArcs reports whether any segment is an arc — lets every consumer keep
// its existing fast path untouched for the overwhelmingly common case.
func (p *Polyline) HasArcs() bool {
	for _, t := range p.SegmentTypes {
		if IsArcType(t) {
			return true
		}
	}
	return false
}

// SegmentCount is the number of segments the polyline draws: one per gap for
// an open run, plus the closing segment when Closed.
func (p *Polyline) SegmentCount() int {
	n := len(p.Points)
	if n < 2 {
		return 0
	}
	if p.Closed {
		return n
	}
	return n - 1
}

// UnmarshalJSON enforces the SegmentTypes invariants at the door: one entry
// per segment, and only known values. A mismatched array is a bug in whatever
// wrote the blob, and letting it through would mean every consumer silently
// disagreeing about which segment is curved.
//
// The nested decoder keeps DisallowUnknownFields, which the server's decoder
// sets on the outer document — a custom UnmarshalJSON would otherwise quietly
// re-open this one object to typo'd keys.
func (p *Polyline) UnmarshalJSON(data []byte) error {
	type polylineAlias Polyline
	var alias polylineAlias
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&alias); err != nil {
		return err
	}
	out := Polyline(alias)
	if len(out.SegmentTypes) > 0 {
		want := out.SegmentCount()
		if len(out.SegmentTypes) != want {
			return fmt.Errorf(
				"polyline: segment_types has %d entries, want %d (one per segment for %d points, closed=%v)",
				len(out.SegmentTypes), want, len(out.Points), out.Closed)
		}
		for i, t := range out.SegmentTypes {
			if t != SegmentLine && !IsArcType(t) {
				return fmt.Errorf("polyline: segment_types[%d] = %q, want %q, %q or %q",
					i, t, SegmentLine, SegmentArc, SegmentArcR)
			}
		}
	}
	*p = out
	return nil
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
