package main

import (
	"context"
	"flag"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/vlouvet/neonbench/internal/appdata"
	"github.com/vlouvet/neonbench/internal/server"
	"github.com/vlouvet/neonbench/internal/storage"
)

const appName = "NeonBench"

func main() {
	var (
		port    = flag.Int("port", 0, "HTTP port (0 = pick a free one)")
		dataDir = flag.String("data-dir", "", "Override data directory (default: per-OS app data path)")
		dev     = flag.Bool("dev", false, "Dev mode: proxy frontend to Vite dev server on :5173")
		noOpen  = flag.Bool("no-open", false, "Don't auto-open the browser on startup")
	)
	flag.Parse()

	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	dir := *dataDir
	if dir == "" {
		d, err := appdata.Dir(appName)
		if err != nil {
			logger.Error("resolve data directory", "err", err)
			os.Exit(1)
		}
		dir = d
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		logger.Error("create data directory", "dir", dir, "err", err)
		os.Exit(1)
	}
	logger.Info("data directory", "path", dir)

	db, err := storage.Open(dir)
	if err != nil {
		logger.Error("open database", "err", err)
		os.Exit(1)
	}
	defer db.Close()
	if err := storage.Migrate(db); err != nil {
		logger.Error("run migrations", "err", err)
		os.Exit(1)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	cfg := server.Config{
		Port:        *port,
		Dev:         *dev,
		OpenBrowser: !*noOpen,
		DB:          db,
		DataDir:     dir,
	}
	if err := server.Run(ctx, cfg); err != nil {
		logger.Error("server exited", "err", err)
		os.Exit(1)
	}
}
