# Tier 3 #137 — A headless render entry point

> **Status:** DONE · drafted 2026-09-02 · shipped 2026-09-02 · branch `task/3-headless-render`
> · **Option 2 taken** (documented URL contract + committed driver), and
> within it the **CLI form** rather than the HTTP endpoint — see
> [`docs/headless-render.md`](../../docs/headless-render.md) for the
> reasoning and the contract.
> · One correction to the spec's framing is recorded in the PR body: the
> two "wanted shapes" at the top (`neonbench render …` and
> `GET …/preview.png`) both imply option 1, because either one puts the
> render inside the Go process. The shipped CLI is a Node driver under
> `scripts/`, not a Go subcommand.
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) A5

## Goal

Producing the proof's ISO view meant driving the browser with Playwright:
navigate, wait for the canvas, toggle the wall, click a preset, click Save PNG,
catch the download. That is a lot of moving parts for "render this version", and
it puts a customer-facing image behind a UI automation script.

**Done** means one command, or one request, produces the same bloom-correct PNG
the Save PNG button produces.

Wanted shape (either, not both):

```sh
neonbench render --project 18 --version 62 --preset iso --wall steel --out iso.png
```

```
GET /api/projects/{id}/design_versions/{vid}/preview.png?preset=iso&wall=steel
```

## The trap — this is the whole reason the spec exists

`captureCanvasToPNG` (`web/src/preview/screenshot.ts:73`) calls
`composer.render()` **before** `toDataURL`, so the post-processing pass lands in
the file. A naive page screenshot, or a call to the bare `gl.render`, comes back
**flat-emissive with no bloom** — a different-looking product, in a file whose
name says nothing about it.

That is not hypothetical: it is exactly the bug **Tier 1 #68** fixed once
already, where `screenshot.ts` bypassed the `EffectComposer` and every PNG came
out without the glow. Whatever ships headless must take the composer path.

**A test must pin it.** The difference is invisible in a filename, obvious to a
customer, and the codebase has already regressed on it once.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-headless-render origin/main
( cd web && npm install && npm run build )
```

## Decide the approach first, and say why

The renderer is three.js in a browser. Two honest options:

1. **Headless browser driven by the server.** Reuses the real render path
   exactly, so bloom, presets and materials are guaranteed identical. Cost: a
   browser dependency for a Go binary that currently ships as one static file
   with no runtime deps. That is a significant change to what NeonBench *is*.
2. **A documented, stable automation entry point** — a query-parameterised
   preview route (`?preset=iso&wall=steel&autocapture=1`) that configures the
   scene from the URL and exposes a promise the driver can await, so the caller
   still brings its own browser but stops screen-scraping the UI.

**Option 2 is the recommendation** and the reason is the single-static-binary
property: `scripts/build.sh` cross-compiles to four targets and the README sells
"download one file". Bundling a browser to render a picture trades that away for
convenience. Option 1 is defensible if the user wants it — but it is a product
decision, not an implementation detail, so raise it rather than assume it.

If option 2 is taken, the deliverable is the route, the URL contract, and a
committed driver script under `scripts/` — so the automation lives in the repo
and is maintained with the code, instead of being rewritten per job.

## Deliverables

1. The chosen entry point, with its contract documented where a caller looks
   first.
2. Scene configuration from parameters: at minimum `preset`, `wall`, and
   background — the three the proof needed.
3. A committed driver (`scripts/render-preview.*`) if option 2.
4. The bloom regression test below.

## Tests

- **Bloom is present.** Render the same version twice, once through the
  composer path and once deliberately bypassing it, and assert the two images
  differ measurably — e.g. luminance above a threshold in a ring around a tube.
  Asserting "a PNG was produced" is the vacuous version of this test and is
  what would let #68 regress again.
- **Preset determinism**: the same version and preset produce the same image
  twice.
- **Framing**: a large design is not culled. Tier 1 #66 fixed a frustum bug
  where anything over ~660 mm vanished entirely; a headless path that picks its
  own camera could reintroduce it. Render a 3 m design and assert non-empty.

## Constraints

- **Do not add a browser dependency to the Go binary without an explicit
  decision.** See above.
- No new third-party dependencies in `web/` — the render path already exists.
- The `?nobloom` debug path must keep working; it is how the test above forces
  the bypass.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. **Raise the option-1-vs-2 decision before writing code.**
2. Implement, then the bloom test.
3. **Move this spec** to `specs/done/` in the final commit.

## Report back

Which option was taken and why, the command that produces a PNG, and the
measured luminance delta proving bloom is in the file.
