package server

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/vlouvet/neonbench/internal/storage"
)

const maxUploadBytes = 50 << 20 // 50 MB

var allowedSourceMIME = map[string]string{
	"image/png":     ".png",
	"image/jpeg":    ".jpg",
	"image/svg+xml": ".svg",
}

func (s *apiServer) handleListAssets(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}
	assets, err := storage.ListAssets(r.Context(), s.db, pid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if assets == nil {
		assets = []storage.Asset{}
	}
	writeJSON(w, http.StatusOK, assets)
}

func (s *apiServer) handleUploadAsset(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	if _, err := storage.GetProject(r.Context(), s.db, pid); err != nil {
		writeStorageError(w, err)
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadBytes)
	if err := r.ParseMultipartForm(maxUploadBytes); err != nil {
		writeError(w, http.StatusBadRequest, "upload too large or malformed: "+err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		writeError(w, http.StatusBadRequest, "missing 'file' form field")
		return
	}
	defer file.Close()

	mime := strings.ToLower(header.Header.Get("Content-Type"))
	ext, allowed := allowedSourceMIME[mime]
	if !allowed {
		// Fall back to extension sniff if browser didn't set MIME.
		switch strings.ToLower(filepath.Ext(header.Filename)) {
		case ".png":
			mime, ext, allowed = "image/png", ".png", true
		case ".jpg", ".jpeg":
			mime, ext, allowed = "image/jpeg", ".jpg", true
		case ".svg":
			mime, ext, allowed = "image/svg+xml", ".svg", true
		}
	}
	if !allowed {
		writeError(w, http.StatusUnsupportedMediaType,
			"unsupported file type; accepted: PNG, JPG, SVG")
		return
	}

	storedName, err := randomFilename(ext)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	dir := filepath.Join(s.dataDir, "assets", fmt.Sprintf("%d", pid))
	if err := os.MkdirAll(dir, 0o755); err != nil {
		writeStorageError(w, fmt.Errorf("create asset dir: %w", err))
		return
	}
	dst, err := os.Create(filepath.Join(dir, storedName))
	if err != nil {
		writeStorageError(w, fmt.Errorf("create asset file: %w", err))
		return
	}
	written, copyErr := io.Copy(dst, file)
	closeErr := dst.Close()
	if copyErr != nil {
		_ = os.Remove(dst.Name())
		writeStorageError(w, fmt.Errorf("write asset: %w", copyErr))
		return
	}
	if closeErr != nil {
		_ = os.Remove(dst.Name())
		writeStorageError(w, fmt.Errorf("close asset: %w", closeErr))
		return
	}

	asset, err := storage.CreateAsset(r.Context(), s.db, storage.CreateAssetParams{
		ProjectID: pid,
		Kind:      storage.AssetKindSource,
		Filename:  storedName,
		MIME:      mime,
		SizeBytes: written,
	})
	if err != nil {
		_ = os.Remove(dst.Name())
		writeStorageError(w, err)
		return
	}
	_ = storage.TouchProject(r.Context(), s.db, pid)
	writeJSON(w, http.StatusCreated, asset)
}

func (s *apiServer) handleDownloadAsset(w http.ResponseWriter, r *http.Request) {
	pid, ok := pathID(w, r, "id")
	if !ok {
		return
	}
	aid, ok := pathID(w, r, "aid")
	if !ok {
		return
	}
	asset, err := storage.GetAsset(r.Context(), s.db, aid)
	if err != nil {
		writeStorageError(w, err)
		return
	}
	if asset.ProjectID != pid {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	path := filepath.Join(s.dataDir, "assets", fmt.Sprintf("%d", pid), asset.Filename)
	f, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			writeError(w, http.StatusNotFound, "asset file missing")
			return
		}
		writeStorageError(w, fmt.Errorf("open asset: %w", err))
		return
	}
	defer f.Close()
	w.Header().Set("content-type", asset.MIME)
	w.Header().Set("content-length", fmt.Sprintf("%d", asset.SizeBytes))
	_, _ = io.Copy(w, f)
}

func randomFilename(ext string) (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("rand: %w", err)
	}
	return hex.EncodeToString(b) + ext, nil
}
