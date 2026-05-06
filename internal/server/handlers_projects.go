package server

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/vlouvet/neonbench/internal/storage"
)

type createProjectReq struct {
	Name       string `json:"name"`
	TubeSpecID int64  `json:"tube_spec_id"`
	Units      string `json:"units,omitempty"`
}

func (s *apiServer) handleListProjects(w http.ResponseWriter, r *http.Request) {
	projects, err := storage.ListProjects(r.Context(), s.db)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if projects == nil {
		projects = []storage.Project{}
	}
	writeJSON(w, http.StatusOK, projects)
}

func (s *apiServer) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req createProjectReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		writeError(w, http.StatusBadRequest, "name is required")
		return
	}
	if req.TubeSpecID == 0 {
		writeError(w, http.StatusBadRequest, "tube_spec_id is required")
		return
	}
	if _, err := storage.GetTubeSpec(r.Context(), s.db, req.TubeSpecID); err != nil {
		writeStorageError(w, err)
		return
	}
	if req.Units != "" && req.Units != "mm" && req.Units != "in" {
		writeError(w, http.StatusBadRequest, "units must be 'mm' or 'in'")
		return
	}
	p, err := storage.CreateProject(r.Context(), s.db, storage.CreateProjectParams{
		Name:       strings.TrimSpace(req.Name),
		TubeSpecID: req.TubeSpecID,
		Units:      req.Units,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, p)
}

func (s *apiServer) handleGetProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	p, err := storage.GetProject(r.Context(), s.db, id)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, p)
}

type updateProjectReq struct {
	Name       *string `json:"name,omitempty"`
	TubeSpecID *int64  `json:"tube_spec_id,omitempty"`
	Units      *string `json:"units,omitempty"`
}

func (s *apiServer) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	var req updateProjectReq
	if err := decodeJSON(r, &req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON: "+err.Error())
		return
	}
	if req.TubeSpecID != nil {
		if _, err := storage.GetTubeSpec(r.Context(), s.db, *req.TubeSpecID); err != nil {
			writeError(w, http.StatusBadRequest, "tube_spec_id does not exist")
			return
		}
	}
	if req.Units != nil && *req.Units != "mm" && *req.Units != "in" {
		writeError(w, http.StatusBadRequest, "units must be \"mm\" or \"in\"")
		return
	}
	if req.Name != nil && *req.Name == "" {
		writeError(w, http.StatusBadRequest, "name cannot be empty")
		return
	}
	out, err := storage.UpdateProject(r.Context(), s.db, id, storage.UpdateProjectParams{
		Name:       req.Name,
		TubeSpecID: req.TubeSpecID,
		Units:      req.Units,
	})
	if err != nil {
		writeStorageError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *apiServer) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	id, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if err := storage.DeleteProject(r.Context(), s.db, id); err != nil {
		writeStorageError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func pathID(w http.ResponseWriter, r *http.Request, name string) (int64, bool) {
	raw := r.PathValue(name)
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 {
		writeError(w, http.StatusBadRequest, "invalid "+name)
		return 0, false
	}
	return id, true
}
