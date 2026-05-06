package server

import (
	"net/http"

	"github.com/vlouvet/neonbench/internal/storage"
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
