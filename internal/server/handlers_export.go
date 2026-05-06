package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/vlouvet/neonbench/internal/storage"
)

// bundleManifest is the top-level descriptor inside a .neonbench zip.
// Keeps an explicit schema version so future loaders can branch on
// it without parsing the rest first.
type bundleManifest struct {
	Bundle      string             `json:"bundle"`             // "neonbench"
	Schema      int                `json:"schema"`             // bundle schema version
	ExportedAt  string             `json:"exported_at"`        // ISO timestamp
	Project     bundleProject      `json:"project"`
	TubeSpec    storage.TubeSpec   `json:"tube_spec"`
	Versions    []bundleVersionRef `json:"versions"`           // newest first
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
		Schema:     1,
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
