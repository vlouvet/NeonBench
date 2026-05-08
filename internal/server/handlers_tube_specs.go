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

	if err := updateTubeSpecRow(r.Context(), s.db, id, merged); err != nil {
		writeStorageError(w, err)
		return
	}

	// Re-load so we hand the client a fresh row (and so the timestamps
	// returned in the response match what's actually persisted).
	updatedSpec, err := storage.GetTubeSpec(r.Context(), s.db, id)
	if err != nil {
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

// updateTubeSpecRow writes the merged row back to SQLite. We keep the SQL
// inline here (rather than adding a new storage.UpdateTubeSpec) so this
// PR's scope stays inside the handler layer; handlers_export.go already
// follows the same pattern for tube_specs INSERTs. min_lead_in_mm and
// sharp_bend_angle_deg (Tier 3 #29) flow through the PATCH surface added
// in Tier 3 #41 alongside wall_thickness_mm + bend_technique (Tier 3
// #43); all four optional columns share the same three-state semantics.
func updateTubeSpecRow(ctx context.Context, db *sql.DB, id int64, t storage.TubeSpec) error {
	wall := nullableFloat(t.WallThicknessMM)
	tech := nullableString(t.BendTechnique)
	leadIn := nullableFloat(t.MinLeadInMM)
	sharpBend := nullableFloat(t.SharpBendAngleDeg)
	res, err := db.ExecContext(ctx, `
		UPDATE tube_specs
		   SET name                  = ?,
		       diameter_mm           = ?,
		       min_bend_radius_mm    = ?,
		       max_segment_length_mm = ?,
		       min_spacing_mm        = ?,
		       wall_thickness_mm     = ?,
		       bend_technique        = ?,
		       min_lead_in_mm        = ?,
		       sharp_bend_angle_deg  = ?
		 WHERE id = ?`,
		t.Name, t.DiameterMM, t.MinBendRadiusMM, t.MaxSegmentLengthMM, t.MinSpacingMM,
		wall, tech, leadIn, sharpBend, id)
	if err != nil {
		// Surface UNIQUE name collisions as a 400-friendly error so the
		// frontend can show the trimmed message instead of a 500.
		if isUniqueConstraintErr(err) {
			return fmt.Errorf("tube_spec name already in use")
		}
		return fmt.Errorf("update tube_spec: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return storage.ErrNotFound
	}
	return nil
}

// isUniqueConstraintErr does a string-match on the SQLite error text
// because modernc.org/sqlite does not expose typed constraint errors.
// "UNIQUE constraint failed" is the canonical message; we match the
// substring rather than equality so we tolerate the column-name suffix.
func isUniqueConstraintErr(err error) bool {
	return err != nil && strings.Contains(err.Error(), "UNIQUE constraint failed")
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

// nullableFloat converts an optional pointer to a value suitable for
// database/sql interpolation: nil → SQL NULL, otherwise the underlying
// float. modernc.org/sqlite's driver accepts both nil and concrete values
// in the same arg slot via the empty-interface boundary.
func nullableFloat(v *float64) any {
	if v == nil {
		return nil
	}
	return *v
}

// nullableString mirrors nullableFloat for TEXT columns.
func nullableString(v *string) any {
	if v == nil {
		return nil
	}
	return *v
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
