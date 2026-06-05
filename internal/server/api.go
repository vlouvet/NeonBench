package server

import (
	"database/sql"
	"net/http"
)

type apiServer struct {
	db      *sql.DB
	dataDir string
}

func registerAPI(mux *http.ServeMux, db *sql.DB, dataDir string) {
	s := &apiServer{db: db, dataDir: dataDir}

	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	mux.HandleFunc("GET /api/tube_specs", s.handleListTubeSpecs)
	mux.HandleFunc("POST /api/tube_specs", s.handleCreateTubeSpec)
	mux.HandleFunc("PATCH /api/tube_specs/{id}", s.handleUpdateTubeSpec)
	mux.HandleFunc("DELETE /api/tube_specs/{id}", s.handleDeleteTubeSpec)

	mux.HandleFunc("GET /api/projects", s.handleListProjects)
	mux.HandleFunc("POST /api/projects", s.handleCreateProject)
	mux.HandleFunc("GET /api/projects/{id}", s.handleGetProject)
	mux.HandleFunc("PATCH /api/projects/{id}", s.handleUpdateProject)
	mux.HandleFunc("DELETE /api/projects/{id}", s.handleDeleteProject)

	mux.HandleFunc("GET /api/projects/{id}/assets", s.handleListAssets)
	mux.HandleFunc("POST /api/projects/{id}/assets", s.handleUploadAsset)
	mux.HandleFunc("GET /api/projects/{id}/assets/{aid}", s.handleDownloadAsset)

	mux.HandleFunc("POST /api/projects/{id}/vectorize", s.handleVectorize)
	mux.HandleFunc("POST /api/projects/{id}/design_versions", s.handleCreateDesignVersion)
	mux.HandleFunc("POST /api/projects/{id}/validate_doc", s.handleValidateDoc)
	mux.HandleFunc("GET /api/projects/{id}/design_versions", s.handleListDesignVersions)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/latest", s.handleLatestDesignVersion)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}", s.handleGetDesignVersion)
	mux.HandleFunc("PATCH /api/projects/{id}/design_versions/{vid}", s.handleUpdateDesignVersion)
	mux.HandleFunc("DELETE /api/projects/{id}/design_versions/{vid}", s.handleDeleteDesignVersion)
	mux.HandleFunc("POST /api/projects/{id}/design_versions/{vid}/validate", s.handleRevalidate)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/print.pdf", s.handlePrintPDF)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/print.dxf", s.handlePrintDXF)
	// Vector-graphics flavors (Tier 3 #80) — SVG / EPS / AI.
	// SVG is the rich format (per-run groups, dedicated annotation
	// layers); EPS is the procedural sibling; AI is EPS-bytes-with-
	// .ai-extension (modern Illustrator opens EPS-shaped .ai files
	// natively, see handlers_vector.go for the trade-off rationale).
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/export.svg", s.handleExportSVG)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/export.eps", s.handleExportEPS)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/export.ai", s.handleExportAI)
	mux.HandleFunc("GET /api/projects/{id}/export.neonbench", s.handleExportBundle)
	mux.HandleFunc("POST /api/projects/import", s.handleImportBundle)
}
