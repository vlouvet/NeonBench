// Package version exposes the build-time version string of the NeonBench
// binary.
//
// The Version variable is overwritten at build time via:
//
//	go build -ldflags "-X 'github.com/vlouvet/neonbench/internal/version.Version=v1.0.0'"
//
// For local development (e.g. `go run ./cmd/neonbench`) Version stays at its
// default of "dev", which the rest of the system treats as "no released
// version" — the self-updater (sub-PR 70c) will self-disable in that case.
package version

// Version is the build-time version string. Override with -ldflags at
// release-build time. Defaults to "dev" so local builds and `go run`
// have a sensible value.
var Version = "dev"

// Current returns the current version string. If Version has been set to
// an empty string (e.g. via an explicit `-X '...=...'` with no value),
// it falls back to "dev" so callers always get a non-empty string.
func Current() string {
	if Version == "" {
		return "dev"
	}
	return Version
}
