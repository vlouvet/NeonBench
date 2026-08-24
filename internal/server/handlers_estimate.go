package server

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"

	"github.com/vlouvet/neonbench/internal/designdoc"
	"github.com/vlouvet/neonbench/internal/estimate"
	"github.com/vlouvet/neonbench/internal/printpdf"
	"github.com/vlouvet/neonbench/internal/storage"
	"github.com/vlouvet/neonbench/internal/takeoff"
)

// estimateCtx bundles everything a takeoff or estimate needs. Resolving it in
// one place keeps the three handlers from drifting apart on which fallback
// applies when a version has no design doc or a project has no rate card.
type estimateCtx struct {
	project storage.Project
	version storage.DesignVersion
	spec    storage.TubeSpec
	doc     designdoc.Doc
	inputs  takeoff.Inputs
	card    estimate.RateCard
}

// takeoff runs the geometry using the card's stock and labour configuration.
func (c estimateCtx) takeoff() takeoff.Takeoff {
	return takeoff.Compute(&c.doc,
		takeoff.Spec{DiameterMM: c.spec.DiameterMM, MinLeadInMM: c.spec.MinLeadInMM},
		c.card.Yield(), c.card.LabourModel(), c.inputs)
}

func (c estimateCtx) versionLabel() string {
	if c.version.Label != nil {
		return fmt.Sprintf("v%d — %s", c.version.VersionNo, *c.version.Label)
	}
	return fmt.Sprintf("v%d", c.version.VersionNo)
}

// loadEstimateCtx resolves the project, version, tube spec, design doc, saved
// inputs and rate card. It writes its own error response and returns ok=false.
func (s *apiServer) loadEstimateCtx(w http.ResponseWriter, r *http.Request) (estimateCtx, bool) {
	var c estimateCtx
	pid, ok := pathID(w, r, "id")
	if !ok {
		return c, false
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return c, false
	}
	ctx := r.Context()

	project, err := storage.GetProject(ctx, s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return c, false
	}
	v, err := storage.GetDesignVersion(ctx, s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return c, false
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return c, false
	}
	spec, err := storage.GetTubeSpec(ctx, s.db, project.TubeSpecID)
	if err != nil {
		writeStorageError(w, err)
		return c, false
	}

	// A version with no design doc is not an error — it takes off to zero.
	// Returning 404 here would make the estimate route look broken on a
	// freshly vectorized project that has not been edited yet.
	if v.DesignDocJSON != nil && *v.DesignDocJSON != "" {
		if err := json.Unmarshal([]byte(*v.DesignDocJSON), &c.doc); err != nil {
			writeError(w, http.StatusUnprocessableEntity, "design doc is not valid JSON")
			return c, false
		}
	}

	rawInputs, err := storage.GetEstimateInputs(ctx, s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return c, false
	}
	if rawInputs != "" {
		if err := json.Unmarshal([]byte(rawInputs), &c.inputs); err != nil {
			// Stored inputs that no longer parse (a hand-edited database, a
			// rolled-back schema) must not brick the route. Fall back to
			// none and let the operator re-enter them.
			c.inputs = takeoff.Inputs{}
		}
	}

	card, cardOK := s.resolveRateCard(w, r)
	if !cardOK {
		return c, false
	}
	c.project, c.version, c.spec, c.card = project, v, spec, card
	return c, true
}

// resolveRateCard honours ?rate_card_id, falling back to the shop default.
func (s *apiServer) resolveRateCard(w http.ResponseWriter, r *http.Request) (estimate.RateCard, bool) {
	if raw := r.URL.Query().Get("rate_card_id"); raw != "" {
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || id <= 0 {
			writeError(w, http.StatusBadRequest, "invalid rate_card_id")
			return estimate.RateCard{}, false
		}
		card, err2 := storage.GetRateCard(r.Context(), s.db, id)
		if err2 != nil {
			writeStorageError(w, err2)
			return estimate.RateCard{}, false
		}
		return card, true
	}
	card, err := storage.DefaultRateCard(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return estimate.RateCard{}, false
	}
	return card, true
}

// handleTakeoff returns quantities only — no rates, no money. Useful on its
// own: "how much 12 mm do I need to order" does not require a priced card.
func (s *apiServer) handleTakeoff(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadEstimateCtx(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, c.takeoff())
}

func (s *apiServer) handleEstimate(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadEstimateCtx(w, r)
	if !ok {
		return
	}
	t := c.takeoff()
	writeJSON(w, http.StatusOK, map[string]any{
		"takeoff":  t,
		"estimate": estimate.Price(t, c.card),
	})
}

func (s *apiServer) handleEstimatePDF(w http.ResponseWriter, r *http.Request) {
	c, ok := s.loadEstimateCtx(w, r)
	if !ok {
		return
	}
	opts := printpdf.DefaultEstimateOptions()
	if name := r.URL.Query().Get("paper"); name != "" {
		p, found := printpdf.PaperByName(name)
		if !found {
			writeError(w, http.StatusBadRequest, "unknown paper: "+name)
			return
		}
		opts.Paper = p
	}
	opts.ProjectName = c.project.Name
	opts.DesignVersionLabel = c.versionLabel()
	opts.Customer = c.project.Customer
	opts.JobNumber = c.project.JobNumber
	opts.TubeSpecName = c.spec.Name

	t := c.takeoff()
	pdfBytes, err := printpdf.RenderEstimate(t, estimate.Price(t, c.card), opts)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "render failed")
		return
	}
	w.Header().Set("content-type", "application/pdf")
	w.Header().Set("content-disposition", `inline; filename="estimate.pdf"`)
	w.Header().Set("content-length", strconv.Itoa(len(pdfBytes)))
	_, _ = w.Write(pdfBytes)
}

// handleUpdateEstimateInputs stores the manual quantities for a version.
//
// The body is decoded into takeoff.Inputs before being persisted, so a typo'd
// field is a 400 now rather than a silently-ignored number that makes an
// estimate wrong later. It is re-marshalled rather than stored verbatim so the
// column always holds one canonical shape.
func (s *apiServer) handleUpdateEstimateInputs(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	vid, ok := pathID(w, r, "vid")
	if !ok {
		return
	}
	v, err := storage.GetDesignVersion(r.Context(), s.db, vid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if v.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	var in takeoff.Inputs
	if err := decodeJSON(r, &in); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if msg := validateEstimateInputs(in); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	raw, err := json.Marshal(in)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "encode inputs")
		return
	}
	if err := storage.SetEstimateInputs(r.Context(), s.db, vid, string(raw)); err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, in)
}

// validateEstimateInputs rejects negatives. Every field here is a count, a
// length or a number of hours; a negative one is a typo, and letting it
// through would quietly subtract from a quote.
func validateEstimateInputs(in takeoff.Inputs) string {
	neg := func(name string, v float64) string {
		if v < 0 {
			return name + " must not be negative"
		}
		return ""
	}
	checks := []string{
		neg("transformer_count", in.TransformerCount),
		neg("gto_cable_ft", in.GTOCableFt),
		neg("standoff_set_count", in.StandoffSetCount),
		neg("install_hours", in.InstallHours),
		neg("design_hours", in.DesignHours),
		neg("freight", in.Freight),
	}
	if in.GasFillSections != nil {
		checks = append(checks, neg("gas_fill_sections", *in.GasFillSections))
	}
	if in.TubeSupportCount != nil {
		checks = append(checks, neg("tube_support_count", *in.TubeSupportCount))
	}
	if in.BootEndcapCount != nil {
		checks = append(checks, neg("boot_endcap_count", *in.BootEndcapCount))
	}
	if in.BackingSqFt != nil {
		checks = append(checks, neg("backing_sq_ft", *in.BackingSqFt))
	}
	for i, m := range in.Misc {
		if m.Qty < 0 {
			checks = append(checks, fmt.Sprintf("misc[%d].qty must not be negative", i))
		}
	}
	for _, c := range checks {
		if c != "" {
			return c
		}
	}
	return ""
}

func (s *apiServer) handleListRateCards(w http.ResponseWriter, r *http.Request) {
	cards, err := storage.ListRateCards(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if cards == nil {
		cards = []estimate.RateCard{}
	}
	writeJSON(w, http.StatusOK, cards)
}

func (s *apiServer) handleGetRateCard(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	card, err := storage.GetRateCard(r.Context(), s.db, id)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, card)
}

type patchRateCardReq struct {
	Name                 *string  `json:"name"`
	Currency             *string  `json:"currency"`
	MarkupMultiplier     *float64 `json:"markup_multiplier"`
	LabourRatePerHour    *float64 `json:"labour_rate_per_hour"`
	LabourSetupMinutes   *float64 `json:"labour_setup_minutes"`
	LabourMinutesPerFoot *float64 `json:"labour_minutes_per_foot"`
	StickLengthMM        *float64 `json:"stick_length_mm"`
	StickWasteMM         *float64 `json:"stick_waste_mm"`
	SheetAreaSqFt        *float64 `json:"sheet_area_sq_ft"`
}

func (s *apiServer) handlePatchRateCard(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var req patchRateCardReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}
	if msg := validateRateCardPatch(req); msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	card, err := storage.UpdateRateCard(r.Context(), s.db, id, storage.UpdateRateCardParams{
		Name: req.Name, Currency: req.Currency,
		MarkupMultiplier:     req.MarkupMultiplier,
		LabourRatePerHour:    req.LabourRatePerHour,
		LabourSetupMinutes:   req.LabourSetupMinutes,
		LabourMinutesPerFoot: req.LabourMinutesPerFoot,
		StickLengthMM:        req.StickLengthMM,
		StickWasteMM:         req.StickWasteMM,
		SheetAreaSqFt:        req.SheetAreaSqFt,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, card)
}

func validateRateCardPatch(req patchRateCardReq) string {
	if req.Name != nil && *req.Name == "" {
		return "name must not be empty"
	}
	// A markup below 1 sells below cost. It is allowed — a shop may
	// deliberately loss-lead — but zero or negative is always a typo, and it
	// would invert the price.
	if req.MarkupMultiplier != nil && *req.MarkupMultiplier <= 0 {
		return "markup_multiplier must be greater than zero"
	}
	if req.LabourRatePerHour != nil && *req.LabourRatePerHour < 0 {
		return "labour_rate_per_hour must not be negative"
	}
	if req.LabourSetupMinutes != nil && *req.LabourSetupMinutes < 0 {
		return "labour_setup_minutes must not be negative"
	}
	if req.LabourMinutesPerFoot != nil && *req.LabourMinutesPerFoot < 0 {
		return "labour_minutes_per_foot must not be negative"
	}
	// Stock geometry: a stick shorter than its own handling waste yields no
	// usable glass, and a zero-area sheet divides by zero.
	if req.StickLengthMM != nil && *req.StickLengthMM <= 0 {
		return "stick_length_mm must be greater than zero"
	}
	if req.StickWasteMM != nil && *req.StickWasteMM < 0 {
		return "stick_waste_mm must not be negative"
	}
	if req.StickLengthMM != nil && req.StickWasteMM != nil && *req.StickWasteMM >= *req.StickLengthMM {
		return "stick_waste_mm must be less than stick_length_mm"
	}
	if req.SheetAreaSqFt != nil && *req.SheetAreaSqFt <= 0 {
		return "sheet_area_sq_ft must be greater than zero"
	}
	return ""
}

// patchRateCardItemReq uses a NON-POINTER json.RawMessage for unit_cost so an
// explicit JSON null can be told apart from an absent field. Without that
// distinction a wrong rate could only be overwritten, never removed, and a bad
// price nobody can delete is worse than no price at all.
//
// Both obvious alternatives fail here, in the same way: *float64 decodes null
// and absent alike to nil, and so does *json.RawMessage — encoding/json sets a
// pointer field to nil on null before any custom unmarshaller runs. A bare
// RawMessage implements json.Unmarshaler, which encoding/json calls even for
// null, so it lands as the literal bytes "null" and absent stays nil.
type patchRateCardItemReq struct {
	Label    *string         `json:"label"`
	SKU      *string         `json:"sku"`
	Unit     *string         `json:"unit"`
	UnitCost json.RawMessage `json:"unit_cost"`
	MinQty   *float64        `json:"min_qty"`
	PackFee  *float64        `json:"pack_fee"`
}

func (s *apiServer) handlePatchRateCardItem(w http.ResponseWriter, r *http.Request) {
	cardID, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	itemID, ok := pathID(w, r, "iid")
	if !ok {
		return
	}
	var req patchRateCardItemReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid body: "+err.Error())
		return
	}

	p := storage.UpdateRateCardItemParams{
		Label: req.Label, SKU: req.SKU, Unit: req.Unit,
		MinQty: req.MinQty, PackFee: req.PackFee,
	}
	if len(req.UnitCost) > 0 {
		if bytes.Equal(bytes.TrimSpace(req.UnitCost), []byte("null")) {
			p.ClearUnitCost = true
		} else {
			var v float64
			if err := json.Unmarshal(req.UnitCost, &v); err != nil {
				writeError(w, http.StatusBadRequest, "unit_cost must be a number or null")
				return
			}
			if v < 0 {
				writeError(w, http.StatusUnprocessableEntity, "unit_cost must not be negative")
				return
			}
			p.UnitCost = &v
		}
	}
	if req.MinQty != nil && *req.MinQty < 0 {
		writeError(w, http.StatusUnprocessableEntity, "min_qty must not be negative")
		return
	}
	if req.PackFee != nil && *req.PackFee < 0 {
		writeError(w, http.StatusUnprocessableEntity, "pack_fee must not be negative")
		return
	}

	card, err := storage.UpdateRateCardItem(r.Context(), s.db, cardID, itemID, p)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, card)
}
