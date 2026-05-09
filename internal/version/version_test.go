package version

import "testing"

func TestCurrentDefaultsToDev(t *testing.T) {
	// Save and restore the package-level Version so this test doesn't
	// leak state into other tests.
	orig := Version
	t.Cleanup(func() { Version = orig })

	Version = "dev"
	if got := Current(); got != "dev" {
		t.Errorf("Current() = %q, want %q", got, "dev")
	}
}

func TestCurrentReturnsInjectedValue(t *testing.T) {
	orig := Version
	t.Cleanup(func() { Version = orig })

	Version = "v1.2.3"
	if got := Current(); got != "v1.2.3" {
		t.Errorf("Current() = %q, want %q", got, "v1.2.3")
	}
}

func TestCurrentFallsBackWhenEmpty(t *testing.T) {
	// Defensive: if someone passes -X '...=' (empty), don't return "".
	orig := Version
	t.Cleanup(func() { Version = orig })

	Version = ""
	if got := Current(); got != "dev" {
		t.Errorf("Current() = %q, want %q", got, "dev")
	}
}
