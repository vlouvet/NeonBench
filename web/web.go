package web

import "embed"

// DistFS holds the built Vite frontend bundle. Run `npm run build` in web/
// before building the Go binary in production mode.
//
//go:embed all:dist
var DistFS embed.FS
