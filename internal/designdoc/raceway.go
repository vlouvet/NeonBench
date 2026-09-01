package designdoc

import (
	"github.com/vlouvet/neonbench/internal/validate"
)

// Raceway geometry and the bridge to the validator (Tier 2 #104 / NW #133).
//
// The validator cannot import designdoc — designdoc imports validate, so the
// dependency only runs one way. Everything the two raceway rules need is
// therefore assembled here, in doc terms, and handed over as a slice of
// validate.RacewayInput. That keeps the rule logic (thresholds, messages,
// severity) in internal/validate/rules.go where every other rule lives.

// RacewayMemberExtentMM is the arc-aware X extent of every run carrying this
// raceway id.
//
// ARC-AWARENESS IS LOAD-BEARING: an arc segment bows outside the hull of its
// own two vertices, so an extent taken from Polyline.Points clips the bow and
// under-sizes the box. FlatPoints is the only honest source, exactly as
// runBBoxMM / flatRunPoints are on the TypeScript side.
//
// Jumpers count. A jumper is short splice glass bridging two primary runs,
// but it is still glass that has to physically pass into the box, so a
// raceway that does not reach it is still wrong.
func RacewayMemberExtentMM(doc *Doc, racewayID string) (minX, maxX float64, ok bool) {
	if doc == nil || racewayID == "" {
		return 0, 0, false
	}
	for i := range doc.Runs {
		run := &doc.Runs[i]
		if run.RacewayID != racewayID {
			continue
		}
		for _, p := range run.Polyline.FlatPoints() {
			if !ok {
				minX, maxX, ok = p[0], p[0], true
				continue
			}
			if p[0] < minX {
				minX = p[0]
			}
			if p[0] > maxX {
				maxX = p[0]
			}
		}
	}
	return minX, maxX, ok
}

// FitRacewayToRuns sizes a raceway to the runs tagged with its id, returning
// the fitted box and whether there was anything to fit to. Height and depth
// are carried through untouched — auto-fit answers "where does the box start
// and how long is it", never "what shop stock is it made from".
//
// This is the Go twin of fitRacewayToRuns in web/src/lib/docOps.ts. The
// editor drives the TS one; this one exists so the rule that checks the fit
// and the fit itself cannot drift apart, and both apply RacewayEndMarginMM
// at exactly one place (see that constant for why it is zero).
func FitRacewayToRuns(doc *Doc, rw Raceway) (Raceway, bool) {
	minX, maxX, ok := RacewayMemberExtentMM(doc, rw.ID)
	if !ok {
		return rw, false
	}
	out := rw
	out.XMM = minX - RacewayEndMarginMM
	out.LengthMM = (maxX - minX) + 2*RacewayEndMarginMM
	return out, true
}

// RacewayTransformerCount is the number of transformers the design implies
// for one raceway: one per electrode PAIR on the runs tagged with that id.
//
// The pair arithmetic is deliberately the same as
// takeoff.Summary.ElectrodePairs — ceil(electrodes / 2), with jumper runs
// skipped because a jumper's ends are splices, not electrodes. Read
// internal/takeoff/takeoff.go rather than re-deriving it; if that definition
// ever changes, this is the other place that has to move.
func RacewayTransformerCount(doc *Doc, racewayID string) int {
	if doc == nil || racewayID == "" {
		return 0
	}
	electrodes := 0
	for i := range doc.Runs {
		run := &doc.Runs[i]
		// The literal matches internal/takeoff/takeoff.go, which is where
		// the "jumpers are not electrode-bearing" rule is defined.
		if run.RacewayID != racewayID || run.Kind == "jumper" {
			continue
		}
		electrodes += len(run.Electrodes)
	}
	return (electrodes + 1) / 2 // ceil(electrodes / 2)
}

// RacewayInputs assembles the validator's view of every raceway on the doc.
// Returns nil when the doc models no raceways, which is the overwhelmingly
// common case and keeps the rules off the hot path entirely.
func RacewayInputs(doc *Doc) []validate.RacewayInput {
	if doc == nil || len(doc.Raceways) == 0 {
		return nil
	}
	out := make([]validate.RacewayInput, 0, len(doc.Raceways))
	for _, rw := range doc.Raceways {
		minX, maxX, hasMembers := RacewayMemberExtentMM(doc, rw.ID)
		out = append(out, validate.RacewayInput{
			ID:                  rw.ID,
			XMM:                 rw.XMM,
			LengthMM:            rw.LengthMM,
			YMM:                 racewayGuidelineY(doc, rw.ID),
			MemberMinXMM:        minX,
			MemberMaxXMM:        maxX,
			HasMembers:          hasMembers,
			TransformerCount:    RacewayTransformerCount(doc, rw.ID),
			TransformerLengthMM: TransformerLengthMM,
		})
	}
	return out
}

// racewayGuidelineY looks up the Y of the guideline that gives this raceway
// its top edge. Used only to place the validation marker on the canvas, so a
// missing guideline (impossible after unmarshal, possible on a doc built in
// memory by a test) answers 0 rather than failing.
func racewayGuidelineY(doc *Doc, racewayID string) float64 {
	for _, g := range doc.Guidelines {
		if g.ID == racewayID && g.Kind == GuidelineKindRaceway {
			return g.YMM
		}
	}
	return 0
}
