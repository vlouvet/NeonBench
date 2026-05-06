package vectorize

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os/exec"
	"strconv"
	"strings"
	"sync"
)

// PotraceParams maps to the subset of potrace algorithm options we expose.
type PotraceParams struct {
	TurnPolicy   string  // black, white, left, right, minority, majority, random
	Turdsize     int     // suppress speckles smaller than this many pixels
	Alphamax     float64 // corner threshold (0.0 .. 1.3334)
	Opttolerance float64 // curve optimization tolerance
	WidthMM      float64 // output width in millimeters (drives uniform scaling)
	Tight        bool    // crop output to the bounding box of the design
}

// DefaultPotraceParams returns the parameters we use as starting defaults.
// Tuned for clean line art where neon-shop sharp corners matter more than
// curve smoothness.
func DefaultPotraceParams(widthMM float64) PotraceParams {
	return PotraceParams{
		TurnPolicy:   "minority",
		Turdsize:     2,
		Alphamax:     1.0,
		Opttolerance: 0.2,
		WidthMM:      widthMM,
		Tight:        true,
	}
}

var (
	potraceLookupOnce sync.Once
	potracePath       string
	potraceLookupErr  error
)

// ErrPotraceMissing is returned when the potrace binary cannot be found on PATH.
var ErrPotraceMissing = errors.New("potrace binary not found on PATH")

func potraceBinary() (string, error) {
	potraceLookupOnce.Do(func() {
		path, err := exec.LookPath("potrace")
		if err != nil {
			potraceLookupErr = ErrPotraceMissing
			return
		}
		potracePath = path
	})
	return potracePath, potraceLookupErr
}

// PotraceVersion reports the installed potrace version, or an error if
// potrace is missing or fails to run.
func PotraceVersion(ctx context.Context) (string, error) {
	bin, err := potraceBinary()
	if err != nil {
		return "", err
	}
	out, err := exec.CommandContext(ctx, bin, "--version").Output()
	if err != nil {
		return "", fmt.Errorf("potrace --version: %w", err)
	}
	// First line is e.g. "potrace 1.16. Copyright ..."
	first := strings.SplitN(string(out), "\n", 2)[0]
	return strings.TrimSpace(first), nil
}

// RunPotrace invokes potrace with the given PBM bytes on stdin and returns
// the SVG output on stdout.
func RunPotrace(ctx context.Context, pbm []byte, p PotraceParams) ([]byte, error) {
	bin, err := potraceBinary()
	if err != nil {
		return nil, err
	}
	if p.WidthMM <= 0 {
		return nil, fmt.Errorf("vectorize: WidthMM must be > 0 (got %v)", p.WidthMM)
	}
	if p.TurnPolicy == "" {
		p.TurnPolicy = "minority"
	}

	args := []string{
		"-s",     // SVG backend
		"-o", "-", // stdout
		"-z", p.TurnPolicy,
		"-t", strconv.Itoa(p.Turdsize),
		"-a", strconv.FormatFloat(p.Alphamax, 'f', -1, 64),
		"-O", strconv.FormatFloat(p.Opttolerance, 'f', -1, 64),
		"-W", fmt.Sprintf("%gmm", p.WidthMM),
	}
	if p.Tight {
		args = append(args, "--tight")
	}

	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Stdin = bytes.NewReader(pbm)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("potrace: %w (stderr: %s)", err, strings.TrimSpace(stderr.String()))
	}
	return out, nil
}
