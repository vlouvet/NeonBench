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
	mux.HandleFunc("POST /api/projects/{id}/design_versions/{vid}/validate", s.handleRevalidate)
	mux.HandleFunc("GET /api/projects/{id}/design_versions/{vid}/print.pdf", s.handlePrintPDF)
	mux.HandleFunc("GET /api/projects/{id}/export.neonbench", s.handleExportBundle)
}
