package server

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strings"
	"time"

	"github.com/pkg/browser"
	"github.com/vlouvet/neonbench/web"
)

type Config struct {
	Port        int
	Dev         bool
	OpenBrowser bool
	DB          *sql.DB
}

const viteDevURL = "http://localhost:5173"

func Run(ctx context.Context, cfg Config) error {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", cfg.Port))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	addr := fmt.Sprintf("http://127.0.0.1:%d", port)
	slog.Info("server listening", "url", addr, "dev", cfg.Dev)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})

	if cfg.Dev {
		proxy, err := newViteProxy()
		if err != nil {
			return err
		}
		mux.Handle("/", proxy)
	} else {
		dist, err := fs.Sub(web.DistFS, "dist")
		if err != nil {
			return fmt.Errorf("dist subfs: %w", err)
		}
		mux.Handle("/", spaHandler(dist))
	}

	srv := &http.Server{
		Handler:           withRequestLog(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	serverErr := make(chan error, 1)
	go func() {
		if err := srv.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
		close(serverErr)
	}()

	if cfg.OpenBrowser {
		go func() {
			if err := browser.OpenURL(addr); err != nil {
				slog.Warn("open browser failed; navigate manually", "url", addr, "err", err)
			}
		}()
	}

	select {
	case <-ctx.Done():
		slog.Info("shutdown signal received")
	case err := <-serverErr:
		if err != nil {
			return err
		}
	}

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		return fmt.Errorf("shutdown: %w", err)
	}
	return nil
}

func newViteProxy() (http.Handler, error) {
	target, err := url.Parse(viteDevURL)
	if err != nil {
		return nil, fmt.Errorf("parse vite url: %w", err)
	}
	return httputil.NewSingleHostReverseProxy(target), nil
}

// spaHandler serves files from distFS, falling back to index.html for any
// path that doesn't match a real file. This enables client-side routing.
func spaHandler(distFS fs.FS) http.Handler {
	fileServer := http.FileServerFS(distFS)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/")
		if path == "" {
			fileServer.ServeHTTP(w, r)
			return
		}
		if f, err := distFS.Open(path); err == nil {
			f.Close()
			fileServer.ServeHTTP(w, r)
			return
		}
		r2 := r.Clone(r.Context())
		r2.URL.Path = "/"
		fileServer.ServeHTTP(w, r2)
	})
}

func withRequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		slog.Debug("request", "method", r.Method, "path", r.URL.Path, "dur", time.Since(start))
	})
}
