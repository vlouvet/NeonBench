package appdata

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
)

// Dir returns the per-user application data directory for the given app name,
// following OS conventions.
func Dir(app string) (string, error) {
	switch runtime.GOOS {
	case "darwin":
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "Library", "Application Support", app), nil
	case "windows":
		if v := os.Getenv("APPDATA"); v != "" {
			return filepath.Join(v, app), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, "AppData", "Roaming", app), nil
	case "linux":
		if v := os.Getenv("XDG_DATA_HOME"); v != "" {
			return filepath.Join(v, app), nil
		}
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		return filepath.Join(home, ".local", "share", app), nil
	default:
		return "", fmt.Errorf("unsupported OS: %s", runtime.GOOS)
	}
}
