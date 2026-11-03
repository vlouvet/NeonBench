# Tier 3 #147 — CI does not exercise the headless bloom guard

> **Status:** active · drafted 2026-09-02 · branch `task/3-bloom-guard-ci`
> · follow-up from Tier 3 #137

## Goal

Tier 3 #137 shipped a runtime guard that renders each frame twice — bare and
composed — and **refuses the capture** if post-processing changed nothing. It was
verified against a deliberately injected Tier 1 #68 regression: 0.0220 with the
composer, 0.0000 without, capture refused, exit 1.

Nothing in CI runs it. `.github/workflows/ci.yml` runs ESLint, the frontend
build, `go vet`, `./scripts/test.sh` and a cross-compile smoke — no browser.
Playwright is deliberately **not** a repo dependency, because it would add a
~300 MB browser download to every `npm install` for a script most contributors
never run.

So the guard protects a human running `scripts/render-preview.mjs`, and protects
nothing in the pipeline. **Tier 1 #68 was exactly a regression that shipped
green.**

**Done** means a bloom regression fails CI, without putting a browser in every
contributor's `npm install`.

## The tension is the whole row

Two costs, and this row exists to choose between them rather than to write code:

- **Browser in CI, not in `npm install`.** A separate job that installs Chromium
  on the runner only. Costs CI minutes on every push and adds a flake surface;
  costs contributors nothing.
- **No browser at all.** Assert the composer path structurally rather than
  visually — `renderCanvasToDataURL` is now the single decision point (#137
  extracted it precisely so there is one), so a test can assert that every
  caller routes through it and that it drives the composer when one is present.
  Cheap and always-on, but it pins *wiring* rather than *output*, and #68 was a
  wiring bug, so this may well be sufficient.

**Recommendation to evaluate first, not to assume:** the structural test is
probably enough, because the failure mode is "a call site bypassed the composer"
and that is exactly what it catches. Try to write it and see whether it would
have caught #68. If it would, ship it and close the row without a browser. Say
which you chose and why — a browser job added without that reasoning is a
recurring maintenance cost.

Note the honest limit either way, already recorded in #137: the delta proves
post-processing **ran**, not that bloom looks right. Do not oversell whichever
guard you ship.

## Branch + setup

```sh
git fetch origin
git checkout -b task/3-bloom-guard-ci origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/preview/screenshot.test.ts` and/or a new test — the structural route.
- `.github/workflows/ci.yml` — only if you choose the browser job.
- `docs/headless-render.md` — record what CI does and does not cover.

**Don't touch:**

- `web/package.json` — **Playwright must not become a repo dependency.** That is
  the constraint this row is built around, not an incidental preference.
- `screenshot.ts`, `bloomMetric.ts`, `autocapture.ts`. They are correct; this
  row is about coverage.
- The `web/` test environment. Still no jsdom, by design.

## Tests

The deliverable *is* a test, so the meta-requirement matters more than usual:
**demonstrate it fails on the #68 regression.** Inject the bypass, watch the new
check go red, revert. A guard nobody has seen fail is not a guard — that is the
lesson #137 recorded and this row inherits it.

## Report back

PR URL, which option you chose and the reasoning, evidence the check fails on an
injected #68 regression, and what remains uncovered.
