package server

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sort"
	"strings"

	"github.com/vlouvet/neonbench/internal/storage"
)

// validBendTechniques is the whitelist for the bend_technique column. Kept
// in lock-step with derivedMinBendRadius's K-constant table (see
// internal/validate/rules.go) and the frontend's BEND_TECHNIQUES tuple in
// web/src/api.ts. Adding a new technique requires updating all three sites.
var validBendTechniques = map[string]struct{}{
	"ribbon":     {},
	"crossfire":  {},
	"hand_torch": {},
}

// Wall-thickness range bounds for the PATCH validator. The lower bound
// (0.1 mm) covers the very thinnest novelty / display-art tubing; the
// upper bound (10.0 mm) covers oversized borosilicate without forbidding
// experimentation. Realistic neon production tubing sits between 0.9 and
// 1.5 mm (NT Table 3.10, Miller p.115); the wide bounds let operators
// model unusual stock without bumping into a 422.
const (
	minWallThicknessMM = 0.1
	maxWallThicknessMM = 10.0
)

// Lead-in / sharp-bend bounds for the PATCH validator (Tier 3 #41).
// MinLeadIn upper bound (50 mm) covers the upper Miller p.124 trade
// envelope (2..10 in straight lead-in = 50..254 mm) with margin; values
// past 50 mm rarely fit a sign even with double-back exemption, so the
// gate catches typos like "100" vs "10". SharpBend bounds [0, 90]: a
// vertex more open than 90° is by definition a gentle bend, not a sharp
// concentrator, so allowing higher thresholds would just cause every
// vertex on a slightly-noisy polyline to flag.
const (
	minLeadInMM          = 0.0
	maxLeadInMM          = 50.0
	minSharpBendAngleDeg = 0.0
	maxSharpBendAngleDeg = 90.0
)

func (s *apiServer) handleListTubeSpecs(w http.ResponseWriter, r *http.Request) {
	specs, err := storage.ListTubeSpecs(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if specs == nil {
		specs = []storage.TubeSpec{}
	}
	writeJSON(w, http.StatusOK, specs)
}

// updateTubeSpecReq is the PATCH body for /api/tube_specs/{id}. Every
// dimensional field is a pointer so the caller can update one knob at a
// time (e.g. tightening just the bend radius without re-stating the
// diameter). Tube-spec dimensional bounds match the seeded data: realistic
// neon tubes are 5..30mm diameter, the bend radius is at least 1mm and
// always >= the diameter (so a tube can physically curve), the segment
// budget is 100..5000mm (NW practical envelope), and minimum spacing is
// in [1, 100] mm.
type updateTubeSpecReq struct {
	Name               *string  `json:"name,omitempty"`
	DiameterMM         *float64 `json:"diameter_mm,omitempty"`
	MinBendRadiusMM    *float64 `json:"min_bend_radius_mm,omitempty"`
	MaxSegmentLengthMM *float64 `json:"max_segment_length_mm,omitempty"`
	MinSpacingMM       *float64 `json:"min_spacing_mm,omitempty"`
	// WallThicknessMM and BendTechnique use json.RawMessage so the
	// handler can distinguish three PATCH states: omitted (preserve
	// current value), explicit `null` (clear → DB NULL), or a value
	// (write through). A bare *float64 / *string would collapse
	// "absent" and "null" into the same nil. Tier 3 #43.
	WallThicknessMM json.RawMessage `json:"wall_thickness_mm,omitempty"`
	BendTechnique   json.RawMessage `json:"bend_technique,omitempty"`
	// MinLeadInMM and SharpBendAngleDeg use the same three-state
	// json.RawMessage encoding as WallThicknessMM (Tier 3 #41). The
	// columns were added in migration 0009 and the validator already
	// consults them; this PATCH surface lets operators edit the
	// per-spec overrides through the UI instead of raw SQL.
	MinLeadInMM       json.RawMessage `json:"min_lead_in_mm,omitempty"`
	SharpBendAngleDeg json.RawMessage `json:"sharp_bend_angle_deg,omitempty"`
}

// updateTubeSpecResponse wraps the updated row plus a fan-out summary so
// the frontend can show "re-validated N versions across M projects" as a
// transient toast. version_count is the number of design versions whose
// report was successfully refreshed; failed_count is the number that were
// skipped because their stored SVG could not be re-validated. Both are
// purely informational — the spec UPDATE itself always commits before the
// fan-out runs.
type updateTubeSpecResponse struct {
	TubeSpec    storage.TubeSpec   `json:"tube_spec"`
	Revalidated revalidatedSummary `json:"revalidated"`
}

type revalidatedSummary struct {
	ProjectCount int `json:"project_count"`
	VersionCount int `json:"version_count"`
	FailedCount  int `json:"failed_count"`
}

// handleUpdateTubeSpec lets an operator edit a tube spec's dimensional
// fields and atomically re-runs validation across every design version in
// every project that uses this spec. Implements Tier 3 #18: fan-out the
// stale-report invalidation that PR #6 only handled for the
// currently-loaded version.
//
// Partial-failure policy: the spec UPDATE commits first (it's the user's
// primary action). The fan-out then loops over every (project, version)
// independently. A per-version failure is logged and counted in
// `failed_count` but does NOT roll back the spec change — the alternative
// (one bad SVG vetoes a whole shop's spec edit) is worse for production
// shops where stale or hand-rolled versions are common.
func (s *apiServer) handleUpdateTubeSpec(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var req updateTubeSpecReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if msg := validateTubeSpecPatch(req); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	wall, wallSet, msg := parseWallThicknessPatch(req.WallThicknessMM)
	if msg != "" {
		// Range/format failures on the optional fields surface as 422
		// per the spec (the request was syntactically valid JSON; the
		// values were semantically out of bounds), distinguishing them
		// from the 400s the four primary fields emit.
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	tech, techSet, msg := parseBendTechniquePatch(req.BendTechnique)
	if msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	leadIn, leadInSet, msg := parseFloatRangePatch(req.MinLeadInMM,
		"min_lead_in_mm", minLeadInMM, maxLeadInMM)
	if msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}
	sharpBend, sharpBendSet, msg := parseFloatRangePatch(req.SharpBendAngleDeg,
		"sharp_bend_angle_deg", minSharpBendAngleDeg, maxSharpBendAngleDeg)
	if msg != "" {
		writeError(w, http.StatusUnprocessableEntity, msg)
		return
	}

	cur, err := storage.GetTubeSpec(r.Context(), s.db, id)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	merged := mergeTubeSpecPatch(cur, req)
	if wallSet {
		merged.WallThicknessMM = wall
	}
	if techSet {
		merged.BendTechnique = tech
	}
	if leadInSet {
		merged.MinLeadInMM = leadIn
	}
	if sharpBendSet {
		merged.SharpBendAngleDeg = sharpBend
	}
	if msg := validateMergedTubeSpec(merged); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}

	updatedSpec, err := storage.UpdateTubeSpec(r.Context(), s.db, id, merged)
	if err != nil {
		// Surface UNIQUE name collisions as a 400 so the frontend can
		// show the trimmed message instead of a generic 500. Tier 3 #51.
		if errors.Is(err, storage.ErrTubeSpecNameTaken) {
			writeError(w, http.StatusBadRequest, err.Error())
			return
		}
		writeStorageError(w, err)
		return
	}

	projectCount, versionCount, failedCount := s.revalidateAllForTubeSpec(r, id)
	writeJSON(w, http.StatusOK, updateTubeSpecResponse{
		TubeSpec: updatedSpec,
		Revalidated: revalidatedSummary{
			ProjectCount: projectCount,
			VersionCount: versionCount,
			FailedCount:  failedCount,
		},
	})
}

// createTubeSpecReq is the POST body for /api/tube_specs. Same field
// vocabulary as the PATCH body but with the four primary dimensional
// fields required (no pointer / omitted semantics). The four optional
// override columns are nilable; explicit nulls are equivalent to
// omission for create — the column simply stays NULL.
type createTubeSpecReq struct {
	Name               string   `json:"name"`
	DiameterMM         float64  `json:"diameter_mm"`
	MinBendRadiusMM    float64  `json:"min_bend_radius_mm"`
	MaxSegmentLengthMM float64  `json:"max_segment_length_mm"`
	MinSpacingMM       float64  `json:"min_spacing_mm"`
	WallThicknessMM    *float64 `json:"wall_thickness_mm,omitempty"`
	BendTechnique      *string  `json:"bend_technique,omitempty"`
	MinLeadInMM        *float64 `json:"min_lead_in_mm,omitempty"`
	SharpBendAngleDeg  *float64 `json:"sharp_bend_angle_deg,omitempty"`
}

// handleCreateTubeSpec inserts a new tube spec row. Tier 3 #51: shops
// with a custom diameter or different glass had to fork the binary or
// hand-write SQL to add a new spec — this endpoint surfaces it through
// the API. We validate the same bounds as PATCH, plus a case-insensitive
// uniqueness check on `name` so a user-friendly 409 takes priority over
// the bare SQLite UNIQUE-constraint error (which would otherwise surface
// as a 400 via the storage layer's collision mapping).
//
// No fan-out on create: a brand-new spec has no design versions
// referencing it yet, so there's nothing to re-validate.
func (s *apiServer) handleCreateTubeSpec(w http.ResponseWriter, r *http.Request) {
	var req createTubeSpecReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if len(name) > 100 {
		writeError(w, http.StatusBadRequest, "name must be at most 100 characters")
		return
	}
	if req.DiameterMM < 5 || req.DiameterMM > 30 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("diameter_mm must be between 5 and 30 (got %g)", req.DiameterMM))
		return
	}
	if req.MinBendRadiusMM < 1 || req.MinBendRadiusMM > 200 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("min_bend_radius_mm must be between 1 and 200 (got %g)", req.MinBendRadiusMM))
		return
	}
	if req.MaxSegmentLengthMM < 100 || req.MaxSegmentLengthMM > 5000 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("max_segment_length_mm must be between 100 and 5000 (got %g)", req.MaxSegmentLengthMM))
		return
	}
	if req.MinSpacingMM < 1 || req.MinSpacingMM > 100 {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("min_spacing_mm must be between 1 and 100 (got %g)", req.MinSpacingMM))
		return
	}
	if req.MinBendRadiusMM < req.DiameterMM {
		writeError(w, http.StatusBadRequest,
			fmt.Sprintf("min_bend_radius_mm (%g) must be >= diameter_mm (%g)",
				req.MinBendRadiusMM, req.DiameterMM))
		return
	}
	// Optional-column range / whitelist checks reuse the bounds the
	// PATCH validator enforces — out-of-range values surface as 422
	// (semantic mismatch on a syntactically valid body), in line with
	// the existing PATCH behaviour.
	if req.WallThicknessMM != nil {
		if *req.WallThicknessMM < minWallThicknessMM || *req.WallThicknessMM > maxWallThicknessMM {
			writeError(w, http.StatusUnprocessableEntity,
				fmt.Sprintf("wall_thickness_mm must be between %g and %g (got %g)",
					minWallThicknessMM, maxWallThicknessMM, *req.WallThicknessMM))
			return
		}
	}
	if req.BendTechnique != nil {
		if _, ok := validBendTechniques[*req.BendTechnique]; !ok {
			writeError(w, http.StatusUnprocessableEntity, fmt.Sprintf(
				"bend_technique must be one of \"ribbon\", \"crossfire\", \"hand_torch\" (got %q)",
				*req.BendTechnique))
			return
		}
	}
	if req.MinLeadInMM != nil {
		if *req.MinLeadInMM < minLeadInMM || *req.MinLeadInMM > maxLeadInMM {
			writeError(w, http.StatusUnprocessableEntity,
				fmt.Sprintf("min_lead_in_mm must be between %g and %g (got %g)",
					minLeadInMM, maxLeadInMM, *req.MinLeadInMM))
			return
		}
	}
	if req.SharpBendAngleDeg != nil {
		if *req.SharpBendAngleDeg < minSharpBendAngleDeg || *req.SharpBendAngleDeg > maxSharpBendAngleDeg {
			writeError(w, http.StatusUnprocessableEntity,
				fmt.Sprintf("sharp_bend_angle_deg must be between %g and %g (got %g)",
					minSharpBendAngleDeg, maxSharpBendAngleDeg, *req.SharpBendAngleDeg))
			return
		}
	}
	// Case-insensitive uniqueness pre-flight. The `name` column carries
	// a UNIQUE constraint that is case-sensitive in SQLite by default,
	// so without this check we would happily accept "12mm Clear" next
	// to the seeded "12mm clear". Two specs that differ only by case
	// confuse the dropdown and the DXF/PDF footer; matching by lowered
	// name across the existing list keeps the visual identifier set
	// stable. The caller learns about the conflict via 409 + a clear
	// message rather than a generic 500. The check races with parallel
	// inserts; we rely on the storage-layer ErrTubeSpecNameTaken check
	// (case-sensitive) as the final gate so the worst case is a 400
	// instead of a 409 — acceptable for an admin-only surface.
	existing, err := storage.ListTubeSpecs(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	lname := strings.ToLower(name)
	for _, t := range existing {
		if strings.ToLower(t.Name) == lname {
			writeError(w, http.StatusConflict,
				fmt.Sprintf("tube_spec name %q already exists (case-insensitive match against %q)",
					name, t.Name))
			return
		}
	}

	created, err := storage.CreateTubeSpec(r.Context(), s.db, storage.CreateTubeSpecParams{
		Name:               name,
		DiameterMM:         req.DiameterMM,
		MinBendRadiusMM:    req.MinBendRadiusMM,
		MaxSegmentLengthMM: req.MaxSegmentLengthMM,
		MinSpacingMM:       req.MinSpacingMM,
		WallThicknessMM:    req.WallThicknessMM,
		BendTechnique:      req.BendTechnique,
		MinLeadInMM:        req.MinLeadInMM,
		SharpBendAngleDeg:  req.SharpBendAngleDeg,
	})
	if err != nil {
		if errors.Is(err, storage.ErrTubeSpecNameTaken) {
			// Lost the race against another insert — surface as 409
			// so the frontend can retry with a different name.
			writeError(w, http.StatusConflict, err.Error())
			return
		}
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, created)
}

// deleteTubeSpecConflict is the 409 response body returned when the
// caller tries to delete a spec that one or more projects still
// reference. Surfaces both the count and the human-readable names so
// the UI can list the projects the operator must migrate first instead
// of asking them to spelunk through the project list. Tier 3 #51.
type deleteTubeSpecConflict struct {
	Error        string                          `json:"error"`
	ProjectCount int                             `json:"project_count"`
	Projects     []deleteTubeSpecConflictProject `json:"projects"`
}

type deleteTubeSpecConflictProject struct {
	ID   int64  `json:"id"`
	Name string `json:"name"`
}

// handleDeleteTubeSpec removes a tube spec row by id, refusing with 409
// if any project still references the spec. The pre-flight projects-by-
// spec query both gives us the count we need for the response body and
// avoids relying on the SQLite FOREIGN KEY error message (which the
// modernc driver doesn't surface as a typed constraint error). Tier 3
// #51.
func (s *apiServer) handleDeleteTubeSpec(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetTubeSpec(r.Context(), s.db, id); err != nil {
		writeStorageError(w, err)
		return
	}
	refs, err := projectsReferencingTubeSpec(r.Context(), s.db, id)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if len(refs) > 0 {
		// Sort by name for a stable, human-readable response — the
		// frontend renders this list verbatim in the "switch these
		// projects first" tooltip.
		sort.Slice(refs, func(i, j int) bool { return refs[i].Name < refs[j].Name })
		writeJSON(w, http.StatusConflict, deleteTubeSpecConflict{
			Error: fmt.Sprintf("tube_spec is in use by %d project(s); reassign them before deleting",
				len(refs)),
			ProjectCount: len(refs),
			Projects:     refs,
		})
		return
	}
	if err := storage.DeleteTubeSpec(r.Context(), s.db, id); err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// projectsReferencingTubeSpec returns id+name for every project whose
// tube_spec_id matches the given id. Used by handleDeleteTubeSpec to
// build the 409 conflict body. Sort happens at the call site so the
// SELECT itself stays primary-key-ordered (cheapest plan; the conflict
// list is tiny so the post-fetch sort is free).
func projectsReferencingTubeSpec(ctx context.Context, db *sql.DB, tubeSpecID int64) ([]deleteTubeSpecConflictProject, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, name FROM projects WHERE tube_spec_id = ? ORDER BY id`, tubeSpecID)
	if err != nil {
		return nil, fmt.Errorf("query projects by tube_spec: %w", err)
	}
	defer rows.Close()
	var out []deleteTubeSpecConflictProject
	for rows.Next() {
		var p deleteTubeSpecConflictProject
		if err := rows.Scan(&p.ID, &p.Name); err != nil {
			return nil, fmt.Errorf("scan project: %w", err)
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// validateTubeSpecPatch enforces the dimensional bounds on a PATCH body.
// Returns "" when every supplied field is in range, or a human-readable
// error otherwise. Cross-field rules (bend radius >= diameter) are
// applied later in validateMergedTubeSpec, after the patch is merged onto
// the current row, so a partial PATCH can omit either field.
func validateTubeSpecPatch(req updateTubeSpecReq) string {
	if req.Name != nil {
		n := strings.TrimSpace(*req.Name)
		if n == "" {
			return "name cannot be empty"
		}
		if len(n) > 100 {
			return "name must be at most 100 characters"
		}
	}
	if req.DiameterMM != nil {
		if *req.DiameterMM < 5 || *req.DiameterMM > 30 {
			return fmt.Sprintf("diameter_mm must be between 5 and 30 (got %g)", *req.DiameterMM)
		}
	}
	if req.MinBendRadiusMM != nil {
		if *req.MinBendRadiusMM < 1 || *req.MinBendRadiusMM > 200 {
			return fmt.Sprintf("min_bend_radius_mm must be between 1 and 200 (got %g)", *req.MinBendRadiusMM)
		}
	}
	if req.MaxSegmentLengthMM != nil {
		if *req.MaxSegmentLengthMM < 100 || *req.MaxSegmentLengthMM > 5000 {
			return fmt.Sprintf("max_segment_length_mm must be between 100 and 5000 (got %g)", *req.MaxSegmentLengthMM)
		}
	}
	if req.MinSpacingMM != nil {
		if *req.MinSpacingMM < 1 || *req.MinSpacingMM > 100 {
			return fmt.Sprintf("min_spacing_mm must be between 1 and 100 (got %g)", *req.MinSpacingMM)
		}
	}
	return ""
}

// mergeTubeSpecPatch overlays a PATCH onto the current spec row. Fields
// not supplied by the caller pass through unchanged.
func mergeTubeSpecPatch(cur storage.TubeSpec, req updateTubeSpecReq) storage.TubeSpec {
	out := cur
	if req.Name != nil {
		out.Name = strings.TrimSpace(*req.Name)
	}
	if req.DiameterMM != nil {
		out.DiameterMM = *req.DiameterMM
	}
	if req.MinBendRadiusMM != nil {
		out.MinBendRadiusMM = *req.MinBendRadiusMM
	}
	if req.MaxSegmentLengthMM != nil {
		out.MaxSegmentLengthMM = *req.MaxSegmentLengthMM
	}
	if req.MinSpacingMM != nil {
		out.MinSpacingMM = *req.MinSpacingMM
	}
	return out
}

// validateMergedTubeSpec runs cross-field invariants that only make sense
// after the patch is overlaid: a tube physically cannot bend tighter than
// its own outer wall, so min_bend_radius_mm must be >= diameter_mm.
func validateMergedTubeSpec(t storage.TubeSpec) string {
	if t.MinBendRadiusMM < t.DiameterMM {
		return fmt.Sprintf("min_bend_radius_mm (%g) must be >= diameter_mm (%g)",
			t.MinBendRadiusMM, t.DiameterMM)
	}
	return ""
}

// revalidateAllForTubeSpec fans the post-edit revalidation out across
// every design version belonging to a project that references this spec.
// Returns the project / version / failure counts so the handler can wrap
// them into the response. A per-version error is logged and counted as a
// failure but never aborts the loop — partial success is the correct
// semantics here (see handleUpdateTubeSpec for rationale).
//
// The fan-out is a synchronous loop; neon shops have tens of versions per
// project at most, validation is millisecond-scale, and the spec-edit
// path is interactive (the user just clicked Save). If a project ever
// balloons past 10k versions we'll move this to a background worker, but
// premature engineering before that hurts more than it helps.
func (s *apiServer) revalidateAllForTubeSpec(r *http.Request, tubeSpecID int64) (projectCount, versionCount, failedCount int) {
	ctx := r.Context()
	projects, err := projectsForTubeSpec(ctx, s.db, tubeSpecID)
	if err != nil {
		slog.Warn("revalidate fan-out: list projects", "tube_spec_id", tubeSpecID, "err", err)
		return 0, 0, 0
	}
	projectCount = len(projects)

	for _, pid := range projects {
		versions, err := storage.ListDesignVersions(ctx, s.db, pid)
		if err != nil {
			slog.Warn("revalidate fan-out: list versions", "project_id", pid, "err", err)
			// Skip this project's versions but keep going so other
			// projects sharing the spec still get refreshed.
			continue
		}
		for _, v := range versions {
			if _, err := s.revalidateOne(r, v.ID); err != nil {
				if errors.Is(err, errValidationFailed) {
					// runValidation already logged the cause.
					failedCount++
					continue
				}
				slog.Warn("revalidate fan-out: write report",
					"version_id", v.ID, "project_id", pid, "err", err)
				failedCount++
				continue
			}
			versionCount++
		}
	}
	return projectCount, versionCount, failedCount
}

// parseWallThicknessPatch interprets the raw JSON for wall_thickness_mm
// in a PATCH body. Three-state semantics matching parseTubeEndGapPatch:
//   - (nil, false, "") when the field was omitted entirely;
//   - (nil, true,  "") when the field was explicitly `null` (clear it);
//   - (&v,  true,  "") when the field was a valid number in range;
//   - (nil, false, "<msg>") on any parse / validation failure.
func parseWallThicknessPatch(raw json.RawMessage) (*float64, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return nil, false, "wall_thickness_mm must be a number or null"
	}
	if v < minWallThicknessMM || v > maxWallThicknessMM {
		return nil, false, fmt.Sprintf("wall_thickness_mm must be between %g and %g (got %g)",
			minWallThicknessMM, maxWallThicknessMM, v)
	}
	return &v, true, ""
}

// parseFloatRangePatch is the generic three-state PATCH parser for an
// optional REAL column with an inclusive [min, max] range. Returns the
// same (value, set, errMsg) triple as parseWallThicknessPatch:
//   - (nil, false, "") when the field was omitted entirely;
//   - (nil, true,  "") when the field was explicitly `null` (clear it);
//   - (&v,  true,  "") when the field was a valid number in range;
//   - (nil, false, "<msg>") on any parse / validation failure.
//
// Used for min_lead_in_mm and sharp_bend_angle_deg (Tier 3 #41); both
// reuse the same shape as wall_thickness_mm — three-state nullable
// numeric — so a shared helper avoids open-coding the same JSON
// branching three times.
func parseFloatRangePatch(raw json.RawMessage, field string, min, max float64) (*float64, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var v float64
	if err := json.Unmarshal(trimmed, &v); err != nil {
		return nil, false, fmt.Sprintf("%s must be a number or null", field)
	}
	if v < min || v > max {
		return nil, false, fmt.Sprintf("%s must be between %g and %g (got %g)", field, min, max, v)
	}
	return &v, true, ""
}

// parseBendTechniquePatch interprets the raw JSON for bend_technique in
// a PATCH body. Three-state plus an explicit empty-string clear, since
// the column is TEXT not REAL:
//   - (nil, false, "") when the field was omitted entirely;
//   - (nil, true,  "") when the field was explicit `null` or "" (clear);
//   - (&s,  true,  "") when the field was one of the whitelisted values;
//   - (nil, false, "<msg>") on any parse / whitelist failure.
//
// Whitelist (rather than free-form-with-warning) is the right call here
// because the technique selects a K constant in the validator's bend-
// radius derivation — an unknown string would silently fall back to the
// 2.25·D bound and the operator would never see why their derived radius
// stopped tightening. The frontend already constrains the input to the
// three values via a <select>; the server enforces the same envelope so
// curl / scripted callers can't drift.
func parseBendTechniquePatch(raw json.RawMessage) (*string, bool, string) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 {
		return nil, false, ""
	}
	if bytes.Equal(trimmed, []byte("null")) {
		return nil, true, ""
	}
	var s string
	if err := json.Unmarshal(trimmed, &s); err != nil {
		return nil, false, "bend_technique must be a string or null"
	}
	if s == "" {
		// An explicit empty string is the frontend's "(none)" option —
		// same intent as null. Clear the column.
		return nil, true, ""
	}
	if _, ok := validBendTechniques[s]; !ok {
		return nil, false, fmt.Sprintf(
			"bend_technique must be one of \"ribbon\", \"crossfire\", \"hand_torch\" (got %q)", s)
	}
	return &s, true, ""
}

// projectsForTubeSpec returns the IDs of every project that references
// the given tube spec. Kept inline in the handler file (rather than a
// storage.ListProjectsByTubeSpec) to honor this PR's "no storage layer
// changes" scope rule. Sort by id so the fan-out order is deterministic
// for tests.
func projectsForTubeSpec(ctx context.Context, db *sql.DB, tubeSpecID int64) ([]int64, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id FROM projects WHERE tube_spec_id = ? ORDER BY id`, tubeSpecID)
	if err != nil {
		return nil, fmt.Errorf("query projects by tube_spec: %w", err)
	}
	defer rows.Close()

	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan project id: %w", err)
		}
		out = append(out, id)
	}
	return out, rows.Err()
}
