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
	mux.HandleFunc("DELETE /api/projects/{id}", s.handleDeleteProject)

	mux.HandleFunc("GET /api/projects/{id}/assets", s.handleListAssets)
	mux.HandleFunc("POST /api/projects/{id}/assets", s.handleUploadAsset)
	mux.HandleFunc("GET /api/projects/{id}/assets/{aid}", s.handleDownloadAsset)
}
