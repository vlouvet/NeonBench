package server

import (
	"archive/zip"
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/vlouvet/neonbench/internal/storage"
)

// currentBundleSchema is the highest bundle schema version this
// server understands. Bumping this is a coordinated change: add a
// new importBundleVN method, append it to the dispatcher switch,
// and only then update this constant. The export path references
// it directly so a server only ever writes bundles it can read.
const currentBundleSchema = 1

// bundleManifest is the top-level descriptor inside a .neonbench zip.
// Keeps an explicit schema version so future loaders can branch on
// it without parsing the rest first.
type bundleManifest struct {
	Bundle     string             `json:"bundle"`      // "neonbench"
	Schema     int                `json:"schema"`      // bundle schema version
	ExportedAt string             `json:"exported_at"` // ISO timestamp
	Project    bundleProject      `json:"project"`
	TubeSpec   storage.TubeSpec   `json:"tube_spec"`
	Versions   []bundleVersionRef `json:"versions"` // newest first
}

type bundleProject struct {
	Name      string `json:"name"`
	Units     string `json:"units"`
	CreatedAt string `json:"created_at"`
	UpdatedAt string `json:"updated_at"`
}

type bundleVersionRef struct {
	VersionNo int64  `json:"version_no"`
	Label     string `json:"label,omitempty"`
	CreatedAt string `json:"created_at"`
	HasDoc    bool   `json:"has_doc"`
	HasReport bool   `json:"has_report"`
}

// handleExportBundle streams a zip containing every design version's SVG
// and design doc plus a manifest. Suitable for sharing a project across
// installs or archiving before destructive edits.
func (s *apiServer) handleExportBundle(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	project, err := storage.GetProject(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	tubeSpec, err := storage.GetTubeSpec(r.Context(), s.db, project.TubeSpecID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	versions, err := storage.ListDesignVersions(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return
	}

	manifest := bundleManifest{
		Bundle:     "neonbench",
		Schema:     currentBundleSchema,
		ExportedAt: time.Now().UTC().Format("2006-01-02T15:04:05.000Z"),
		Project: bundleProject{
			Name:      project.Name,
			Units:     project.Units,
			CreatedAt: project.CreatedAt,
			UpdatedAt: project.UpdatedAt,
		},
		TubeSpec: tubeSpec,
		Versions: make([]bundleVersionRef, 0, len(versions)),
	}

	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)

	for _, v := range versions {
		// ListDesignVersions returns the row without SVG data; reload to grab it.
		full, err := storage.GetDesignVersion(r.Context(), s.db, v.ID)
		if err != nil {
			writeStorageError(w, err)
			return
		}
		ref := bundleVersionRef{
			VersionNo: v.VersionNo,
			CreatedAt: v.CreatedAt,
			HasDoc:    full.DesignDocJSON != nil && *full.DesignDocJSON != "",
			HasReport: full.ValidationReportJSON != nil && *full.ValidationReportJSON != "",
		}
		if v.Label != nil {
			ref.Label = *v.Label
		}
		manifest.Versions = append(manifest.Versions, ref)

		base := fmt.Sprintf("history/v%03d", v.VersionNo)
		if err := writeZipEntry(zw, base+".svg", []byte(full.SVGData)); err != nil {
			http.Error(w, "zip svg: "+err.Error(), http.StatusInternalServerError)
			return
		}
		if ref.HasDoc {
			if err := writeZipEntry(zw, base+".design.json", []byte(*full.DesignDocJSON)); err != nil {
				http.Error(w, "zip doc: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
		if ref.HasReport {
			if err := writeZipEntry(zw, base+".report.json", []byte(*full.ValidationReportJSON)); err != nil {
				http.Error(w, "zip report: "+err.Error(), http.StatusInternalServerError)
				return
			}
		}
	}

	manifestJSON, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		http.Error(w, "marshal manifest: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := writeZipEntry(zw, "manifest.json", manifestJSON); err != nil {
		http.Error(w, "zip manifest: "+err.Error(), http.StatusInternalServerError)
		return
	}
	if err := zw.Close(); err != nil {
		http.Error(w, "zip close: "+err.Error(), http.StatusInternalServerError)
		return
	}

	filename := fmt.Sprintf("%s.neonbench", safeFilename(project.Name))
	w.Header().Set("content-type", "application/zip")
	w.Header().Set("content-disposition", fmt.Sprintf("attachment; filename=%q", filename))
	w.Header().Set("content-length", fmt.Sprintf("%d", buf.Len()))
	_, _ = w.Write(buf.Bytes())
}

func writeZipEntry(zw *zip.Writer, name string, data []byte) error {
	w, err := zw.Create(name)
	if err != nil {
		return err
	}
	_, err = w.Write(data)
	return err
}

// tubeSpecMatchEpsilon is the float tolerance used when looking up an
// existing tube spec by its dimensional fields. Manifest values come back
// out of JSON parsing and may have tiny rounding differences; treat
// values within 1µm as equal.
const tubeSpecMatchEpsilon = 1e-6

// handleImportBundle accepts a previously-exported `.neonbench` zip and
// recreates the project + every design version. Closes the export
// round-trip so users can move projects between installs (migration,
// shared review, restore-from-backup).
//
// This entry point is a thin dispatcher: it parses the multipart
// upload, unzips, decodes the manifest, validates the cross-version
// invariants ("bundle"=="neonbench", non-empty name, ≥1 version),
// then switches on `manifest.Schema` to pick the right importer.
// Each schema version owns its own importBundleVN method which
// writes the response on its happy path. Adding a v2 importer means
// dropping in `importBundleV2` and bumping `currentBundleSchema` —
// the dispatcher itself shouldn't grow.
func (s *apiServer) handleImportBundle(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "upload too large or malformed: "+err.Error())
		return
	}
	file, _, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing 'file' form field")
		return
	}
	defer file.Close()

	zipBytes, err := io.ReadAll(file)
	if err != nil {
		writeError(w, http.StatusBadRequest, "read upload: "+err.Error())
		return
	}
	zr, err := zip.NewReader(bytes.NewReader(zipBytes), int64(len(zipBytes)))
	if err != nil {
		writeError(w, http.StatusBadRequest, "not a valid zip: "+err.Error())
		return
	}

	manifestRaw, files, err := readBundleEntries(zr)
	if err != nil {
		writeError(w, http.StatusBadRequest, err.Error())
		return
	}

	var manifest bundleManifest
	if err := json.Unmarshal(manifestRaw, &manifest); err != nil {
		writeError(w, http.StatusBadRequest, "invalid manifest.json: "+err.Error())
		return
	}
	if manifest.Bundle != "neonbench" {
		writeError(w, http.StatusBadRequest, "manifest.json missing bundle=\"neonbench\" marker")
		return
	}
	if strings.TrimSpace(manifest.Project.Name) == "" {
		writeError(w, http.StatusBadRequest, "manifest.json missing project.name")
		return
	}
	if len(manifest.Versions) == 0 {
		writeError(w, http.StatusBadRequest, "manifest.json has no versions to import")
		return
	}

	// Schema dispatch. We treat 0 (zero-value / missing field) as
	// legacy v1: bundles produced by handleExportBundle always set
	// schema=1, but a hand-crafted manifest without the field should
	// still import as v1 rather than 422-ing on a technicality. Use
	// `>` for the upgrade branch so a v3 bundle on a v1 server gets
	// the upgrade message rather than a generic 400.
	switch {
	case manifest.Schema < 0:
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid bundle schema: %d", manifest.Schema))
		return
	case manifest.Schema > currentBundleSchema:
		writeError(w, http.StatusUnprocessableEntity,
			fmt.Sprintf("bundle schema %d is newer than this NeonBench supports (max %d); upgrade to import.",
				manifest.Schema, currentBundleSchema))
		return
	case manifest.Schema == 0 || manifest.Schema == 1:
		s.importBundleV1(w, r, manifest, files)
		return
	default:
		// Unreachable today (covered by the cases above for 0..currentBundleSchema)
		// but guards against a future bump that forgets to add a case.
		writeError(w, http.StatusBadRequest, fmt.Sprintf("invalid bundle schema: %d", manifest.Schema))
		return
	}
}

// importBundleV1 is the schema-1 importer. Owns every step from
// version-asset resolution through the final JSON response. Kept as
// a method on *apiServer so it can hit s.db without threading deps
// through the call site. Behavior is byte-identical to the
// pre-dispatcher handler — the structural split is purely so a
// future importBundleV2 has an obvious place to land.
//
// Per-version flow:
//  1. Resolve each manifest version's SVG / doc / report blobs from
//     the in-memory file map; bail if any are missing before we
//     touch the DB.
//  2. Resolve a tube spec: reuse an existing one whose dimensional
//     fields match the manifest snapshot, otherwise insert a new spec
//     so we don't pollute the seed list with duplicates that only
//     differ by name.
//  3. Open a transaction, insert the project (appending "(imported)"
//     if the name collides with an existing project), then insert
//     every design version in version_no order. Roll back on any
//     failure so the user never sees a half-imported project.
//  4. Return the new project as JSON, mirroring `handleCreateProject`.
func (s *apiServer) importBundleV1(w http.ResponseWriter, r *http.Request, manifest bundleManifest, files map[string][]byte) {
	// Resolve every version's bundled SVG / doc / report up-front so a
	// missing entry fails before we touch the DB.
	type pendingVersion struct {
		manifestRef bundleVersionRef
		svg         string
		doc         string
		report      string
	}
	pending := make([]pendingVersion, 0, len(manifest.Versions))
	for _, v := range manifest.Versions {
		base := fmt.Sprintf("history/v%03d", v.VersionNo)
		svg, ok := files[base+".svg"]
		if !ok {
			writeError(w, http.StatusBadRequest, fmt.Sprintf("bundle missing SVG for version %d (%s.svg)", v.VersionNo, base))
			return
		}
		entry := pendingVersion{manifestRef: v, svg: string(svg)}
		if v.HasDoc {
			doc, ok := files[base+".design.json"]
			if !ok {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("bundle missing design doc for version %d", v.VersionNo))
				return
			}
			entry.doc = string(doc)
		}
		if v.HasReport {
			rep, ok := files[base+".report.json"]
			if !ok {
				writeError(w, http.StatusBadRequest, fmt.Sprintf("bundle missing validation report for version %d", v.VersionNo))
				return
			}
			entry.report = string(rep)
		}
		pending = append(pending, entry)
	}
	// Insert versions in ascending version_no order; CreateDesignVersion
	// computes the next version_no atomically, so feeding it ascending
	// input keeps the imported numbering in step with the original.
	sort.SliceStable(pending, func(i, j int) bool {
		return pending[i].manifestRef.VersionNo < pending[j].manifestRef.VersionNo
	})

	ctx := r.Context()
	units := manifest.Project.Units
	if units != "mm" && units != "in" {
		units = "mm"
	}

	// Resolve / create the tube spec OUTSIDE the project transaction.
	// tube_specs is shared seed-style data; if creation fails, no
	// project rows have been written yet so there is nothing to roll
	// back. The reverse order (project first, then spec) would orphan
	// the project on a spec-creation failure.
	tubeSpecID, err := resolveTubeSpec(ctx, s.db, manifest.TubeSpec)
	if err != nil {
		writeStorageError(w, fmt.Errorf("resolve tube_spec: %w", err))
		return
	}

	projectName, err := uniqueProjectName(ctx, s.db, manifest.Project.Name)
	if err != nil {
		writeStorageError(w, fmt.Errorf("name collision check: %w", err))
		return
	}

	// Hand-roll the project + versions transaction so a mid-import
	// failure leaves zero rows behind. Mirrors the SQL CreateDesignVersion
	// uses internally, but keeps everything under one tx.
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		writeStorageError(w, fmt.Errorf("begin import tx: %w", err))
		return
	}
	defer tx.Rollback()

	res, err := tx.ExecContext(ctx,
		`INSERT INTO projects (name, tube_spec_id, units) VALUES (?, ?, ?)`,
		projectName, tubeSpecID, units)
	if err != nil {
		writeStorageError(w, fmt.Errorf("insert project: %w", err))
		return
	}
	projectID, err := res.LastInsertId()
	if err != nil {
		writeStorageError(w, fmt.Errorf("project last insert id: %w", err))
		return
	}

	for _, v := range pending {
		label := v.manifestRef.Label
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO design_versions (project_id, version_no, label, svg_data, design_doc, validation_report_json)
			 VALUES (?, ?, NULLIF(?, ''), ?, NULLIF(?, ''), NULLIF(?, ''))`,
			projectID, v.manifestRef.VersionNo, label, v.svg, v.doc, v.report); err != nil {
			writeStorageError(w, fmt.Errorf("insert version %d: %w", v.manifestRef.VersionNo, err))
			return
		}
	}

	if err := tx.Commit(); err != nil {
		writeStorageError(w, fmt.Errorf("commit import: %w", err))
		return
	}

	imported, err := storage.GetProject(ctx, s.db, projectID)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, imported)
}

// readBundleEntries pulls every regular-file entry into memory and
// extracts manifest.json. Bundle is bounded by maxUploadBytes so this
// is safe to keep entirely in RAM.
func readBundleEntries(zr *zip.Reader) ([]byte, map[string][]byte, error) {
	files := make(map[string][]byte, len(zr.File))
	var manifest []byte
	for _, f := range zr.File {
		if f.FileInfo().IsDir() {
			continue
		}
		rc, err := f.Open()
		if err != nil {
			return nil, nil, fmt.Errorf("open %q: %w", f.Name, err)
		}
		// Cap each entry too, so a zip-bomb with a tiny manifest and a
		// gigantic exploded payload can't OOM the server.
		data, err := io.ReadAll(io.LimitReader(rc, maxUploadBytes))
		rc.Close()
		if err != nil {
			return nil, nil, fmt.Errorf("read %q: %w", f.Name, err)
		}
		files[f.Name] = data
		if f.Name == "manifest.json" {
			manifest = data
		}
	}
	if manifest == nil {
		return nil, nil, errors.New("bundle is missing manifest.json")
	}
	return manifest, files, nil
}

// resolveTubeSpec finds an existing spec whose dimensional fields match
// the manifest snapshot or inserts a new one. Matching by dimensions
// (not by name) keeps re-imports from creating "12mm clear", "12mm clear
// (2)", "12mm clear (3)" duplicates on the seeded list — the bundle
// roundtrip is the common case.
func resolveTubeSpec(ctx context.Context, db *sql.DB, snap storage.TubeSpec) (int64, error) {
	specs, err := storage.ListTubeSpecs(ctx, db)
	if err != nil {
		return 0, err
	}
	for _, s := range specs {
		if floatNear(s.DiameterMM, snap.DiameterMM) &&
			floatNear(s.MinBendRadiusMM, snap.MinBendRadiusMM) &&
			floatNear(s.MaxSegmentLengthMM, snap.MaxSegmentLengthMM) &&
			floatNear(s.MinSpacingMM, snap.MinSpacingMM) {
			return s.ID, nil
		}
	}

	// No dimensional match → create a new spec from the snapshot. The
	// `name` column is UNIQUE so we may need to suffix the name to
	// avoid colliding with an existing differently-shaped spec that
	// happens to share the imported name.
	name, err := uniqueTubeSpecName(ctx, db, snap.Name)
	if err != nil {
		return 0, err
	}
	if name == "" {
		name = fmt.Sprintf("imported %.0fmm", snap.DiameterMM)
	}
	res, err := db.ExecContext(ctx,
		`INSERT INTO tube_specs (name, diameter_mm, min_bend_radius_mm, max_segment_length_mm, min_spacing_mm, is_default)
		 VALUES (?, ?, ?, ?, ?, 0)`,
		name, snap.DiameterMM, snap.MinBendRadiusMM, snap.MaxSegmentLengthMM, snap.MinSpacingMM)
	if err != nil {
		return 0, fmt.Errorf("insert tube_spec: %w", err)
	}
	return res.LastInsertId()
}

func floatNear(a, b float64) bool {
	d := a - b
	if d < 0 {
		d = -d
	}
	return d <= tubeSpecMatchEpsilon
}

// uniqueProjectName appends "(imported)" — and "(imported 2)", "(3)", …
// if needed — until the candidate name is free. Mirrors the spirit of
// macOS Finder's "(copy)" suffix; users can rename later.
func uniqueProjectName(ctx context.Context, db *sql.DB, base string) (string, error) {
	base = strings.TrimSpace(base)
	candidate := base
	for attempt := 0; attempt < 100; attempt++ {
		var n int
		if err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM projects WHERE name = ?`, candidate).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return candidate, nil
		}
		if attempt == 0 {
			candidate = base + " (imported)"
		} else {
			candidate = fmt.Sprintf("%s (imported %d)", base, attempt+1)
		}
	}
	return "", errors.New("could not find a free project name after 100 attempts")
}

// uniqueTubeSpecName returns the requested name if free, otherwise a
// suffixed variant. Uses the same "(imported)" / "(imported N)" pattern
// as project names for visual consistency.
func uniqueTubeSpecName(ctx context.Context, db *sql.DB, base string) (string, error) {
	base = strings.TrimSpace(base)
	if base == "" {
		return "", nil
	}
	candidate := base
	for attempt := 0; attempt < 100; attempt++ {
		var n int
		if err := db.QueryRowContext(ctx,
			`SELECT COUNT(*) FROM tube_specs WHERE name = ?`, candidate).Scan(&n); err != nil {
			return "", err
		}
		if n == 0 {
			return candidate, nil
		}
		if attempt == 0 {
			candidate = base + " (imported)"
		} else {
			candidate = fmt.Sprintf("%s (imported %d)", base, attempt+1)
		}
	}
	return "", errors.New("could not find a free tube_spec name after 100 attempts")
}
