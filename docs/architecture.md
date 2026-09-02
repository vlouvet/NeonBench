# Architecture

```
cmd/neonbench/        ← main; HTTP server bootstrap, CLI flags
internal/
  appdata/            ← per-OS data-directory resolution
  designdoc/          ← Doc/Run/Bend/Annotation types + ToSVG/FromSVG
  printpdf/           ← gofpdf-based 1:1 tile renderer + bend list
  server/             ← HTTP API: projects, assets, vectorize, design_versions, validate_doc, print, export
  storage/            ← modernc.org/sqlite + goose migrations
  validate/           ← polyline extraction, bend-radius/spacing/length rules
  vectorize/          ← skeleton-graph centerline extraction (Zhang-Suen thinning
                        + graph walk + RDP simplify), Hough-transform auto-deskew
web/
  src/                ← React + TypeScript editor (no canvas library; raw SVG + custom pan/zoom)
  src/lib/docOps.ts   ← pure-function editor mutations (vitest-tested)
docs/
  neon-rules/         ← extracted trade rules from PDFs/Kindle screenshots
scripts/test.sh       ← runs Go tests + vitest
```

## Testing

```sh
./scripts/test.sh         # full suite
go test ./...             # Go tests only
cd web && npm test        # editor unit tests (vitest)
cd web && npm run test:watch
```

On Windows, use the PowerShell sibling — it handles the `npm.cmd` execution-policy
quirk and the `web/dist` embed ordering that trip up the bash scripts:

```powershell
.\scripts\test.ps1          # same scope as test.sh
.\scripts\test.ps1 -Smoke   # also build the .exe and boot it (what CI runs)
```

The integration test
(`internal/server/integration_test.go`) drives the full upload →
vectorize → edit-every-tool → save → reload → print pipeline using
`internal/server/testdata/open_neon.png`. A separate vectorize-package
integration test
(`internal/vectorize/integration_test.go`) confirms the centerline
extractor produces ~7 polylines on the same image with no junction-weld
spacing false positives. The vitest suite covers every editor mutation
as a pure function.

---

Back to the [README](../README.md) · [Design notes](design-notes.md)
