# Headless render

Produce the same bloom-correct PNG the preview's **Save PNG** button
produces, from one command:

```sh
node scripts/render-preview.mjs \
  --base-url http://127.0.0.1:7373 \
  --project 18 --version 62 \
  --preset iso --wall steel \
  --out iso.png
```

That is the whole workflow. No clicking a preset, no toggling the wall,
no catching a download.

## Why a script, and not `neonbench render` or `GET …/preview.png`

Both of those shapes were on the table (Tier 3 #137). Both mean the same
thing in practice: **the Go binary drives a browser.** The preview is
three.js in a WebGL context — bloom, the emissive tube material and the
camera presets all live there, and there is no second renderer that could
produce the same image server-side.

NeonBench ships as one static file with no runtime dependencies,
cross-compiled by `scripts/build.sh` to macOS arm64/amd64, Linux amd64
and Windows amd64. A browser cannot be cross-compiled into that. Adding
one — bundled or discovered at runtime — changes what NeonBench *is*, and
that is a product decision rather than an implementation detail.

So the split is: **the caller brings the browser, the repo brings the
automation.** The preview route gained a documented URL contract and a
capture handshake; `scripts/render-preview.mjs` drives them and lives in
the repo, maintained with the code instead of rewritten per job.

## The URL contract

Every knob is a query parameter on the ordinary preview route, so the URL
you automate is the URL you can paste into a browser and look at:

```
/projects/{id}/versions/{vid}/preview?preset=iso&wall=steel&bg=dark
```

| Parameter | Values | Meaning |
|---|---|---|
| `preset` | `front` `iso` `top` `side` | Camera view. Snaps on load rather than animating, so a shared link opens where it says it does. |
| `wall` | `off` `white` `steel` `black` `wood` `#rrggbb` | Backing panel. A bare hex turns the wall on. |
| `bg` | `black` `dark` `grey` `white` `#rrggbb` | Scene background. |
| `groupId` | a group id | Render only that group (pre-existing, Tier 3 #63). |
| `nobloom` | present / absent | Skip the post-processing pass entirely. Debug and A-B only. |
| `autocapture` | `1` / absent | Install the headless capture handshake (below). |
| `timeout` | ms | How long the page waits for the scene before giving up. |

**The URL beats the saved scene preferences.** Scene controls persist per
machine in `localStorage`; anything named in the URL overrides them, and
anything absent falls through. Without that rule the same link would
render differently on two machines, which is the opposite of what a proof
pipeline needs.

**Unknown values warn rather than silently defaulting.** `wall=steal`
logs a warning, leaves the wall alone, and surfaces the warning to the
driver; `--strict` turns it into a non-zero exit. A typo must not hand
back a plausible-looking file.

## The capture handshake

With `?autocapture=1` the page publishes
`window.__neonbenchPreviewCapture` — `{ ready: Promise, version }`. The
promise resolves once the design doc has loaded, the WebGL canvas has
registered, and the `EffectComposer` exists, with:

```js
{ dataURL, bloom, bloomDelta, bloomEnforced, bloomReason,
  preset, width, height, warnings }
```

It **rejects** rather than resolving with a degraded image. Any driver,
committed or ad-hoc, gets the same contract.

## Bloom is verified, not assumed

The preview's Save PNG path calls `composer.render()` before
`toDataURL()` so the post-processing pass lands in the file. A page
screenshot, or a call to the bare `gl.render`, comes back
**flat-emissive with no glow** — a visibly different product in a file
whose name says nothing about it. That is not hypothetical: it is the bug
Tier 1 #68 fixed once already.

So the headless path does not merely *call* the composer. Before handing
back an image it renders the frame twice — once bare, once composed —
and measures the mean absolute luminance difference. If the post-process
pass changed nothing, the capture **fails**:

```
render-preview: FAILED headless capture rejected: post-process pass changed
nothing: mean luminance delta 0.000000 is below the 0.002 floor while 2.19%
of pixels are above the bloom threshold. The capture almost certainly took
the bare gl.render path instead of composer.render() — this is the Tier 1
#68 regression.
```

Measured values, headless Chromium on SwiftShader at 1552×1053:

| Render | delta |
|---|---|
| two-run 600×400 mm design, `iso` preset | 0.021962 |
| single-run 3 m design, `front` preset | 0.020562 |
| same design with the composer bypassed | 0.000000 |

A frame with nothing above the bloom luminance threshold — an empty or
very dim design — legitimately produces no delta, so the check stands
down there and says so in `bloomReason` instead of failing.

`--compare-nobloom` renders the pair on demand, writes
`FILE.nobloom.png` alongside, and prints the measured delta. That is how
the floor in `web/src/preview/bloomMetric.ts` is calibrated.

## Installing Playwright

Playwright is **not** a repo dependency — a ~300 MB browser download in
every `npm install`, for a script most contributors never run, is a bad
trade. Install it wherever you like:

```sh
mkdir -p /tmp/nb-render && cd /tmp/nb-render
npm init -y && npm i playwright && npx playwright install chromium
```

then point the driver at it:

```sh
node scripts/render-preview.mjs \
  --playwright /tmp/nb-render/node_modules/playwright …
```

or set `NEONBENCH_PLAYWRIGHT` to the same path. `node
scripts/render-preview.mjs --help` lists every flag.

## Where the code lives

| File | Role |
|---|---|
| `web/src/preview/renderParams.ts` | Parses the URL contract; URL-over-prefs precedence |
| `web/src/preview/autocapture.ts` | Readiness gate, the capture itself, the `window` handshake |
| `web/src/preview/bloomMetric.ts` | The luminance measurement and the verdict |
| `web/src/preview/screenshot.ts` | `renderCanvasToDataURL` — the one place composer-vs-bare is decided |
| `scripts/render-preview.mjs` | The driver |
