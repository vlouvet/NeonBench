#!/usr/bin/env node
// scripts/render-preview.mjs — headless render entry point (Tier 3 #137).
//
// One command produces the same bloom-correct PNG the Save PNG button
// produces:
//
//   node scripts/render-preview.mjs \
//     --base-url http://127.0.0.1:7373 \
//     --project 18 --version 62 --preset iso --wall steel --out iso.png
//
// WHY THIS IS A SCRIPT AND NOT A GO SUBCOMMAND OR AN HTTP ENDPOINT
//
// The renderer is three.js in a WebGL context. Making `neonbench render`
// (or `GET .../preview.png`) work would mean the Go binary drives a
// browser — and NeonBench ships as one static file with no runtime
// dependencies, cross-compiled by `scripts/build.sh` to four targets.
// A browser cannot be cross-compiled into that, and the README sells
// "download one file". Trading that away to save a command is a product
// decision, not an implementation detail (see the spec).
//
// So the caller brings the browser and the repo brings the automation:
// the preview route grew a documented URL contract
// (`web/src/preview/renderParams.ts`) plus a capture handshake on
// `window` (`web/src/preview/autocapture.ts`), and this script drives
// them. Nothing here screen-scrapes the UI — no clicking a preset, no
// finding the wall checkbox, no catching a download. Restyle the sidebar
// and this keeps working.
//
// PLAYWRIGHT IS NOT A REPO DEPENDENCY. `web/package.json` stays free of
// it on purpose (a ~300 MB browser download in every `npm install`, for
// a script most contributors never run). Install it wherever you like:
//
//   mkdir -p /tmp/nb-render && cd /tmp/nb-render
//   npm init -y && npm i playwright && npx playwright install chromium
//   NODE_PATH=/tmp/nb-render/node_modules node scripts/render-preview.mjs …
//
// or point `--playwright /tmp/nb-render/node_modules/playwright` at it.
//
// THE BLOOM GUARD. The page verifies its own capture: it renders the
// frame through the bare renderer and through the composer, measures the
// luminance difference, and refuses to hand back an image if the
// post-process pass changed nothing. That refusal arrives here as a
// rejected promise and a non-zero exit. A flat-emissive PNG (Tier 1 #68)
// cannot be written silently — which is the entire point of the task.

import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';

const USAGE = `
Usage: node scripts/render-preview.mjs --project N --version M --out FILE [options]

Required:
  --project N          Project id
  --version M          Design version id
  --out FILE           Where to write the PNG

Scene:
  --preset NAME        front | iso | top | side          (default: front fit)
  --wall NAME          off | white | steel | black | wood | #rrggbb
  --bg NAME            black | dark | grey | white | #rrggbb
  --group ID           Render only this group (the route's ?groupId)
  --nobloom            Capture through the bare renderer (debug / A-B only).
                       The bloom verification is skipped: you asked for flat.

Driver:
  --base-url URL       NeonBench server (default: http://127.0.0.1:7373)
  --width N            Viewport width in px  (default: 1600)
  --height N           Viewport height in px (default: 1200)
  --timeout MS         Capture timeout (default: 30000)
  --playwright PATH    Module path / directory for playwright
  --strict             Treat URL warnings (unknown preset, wall, bg) as errors
  --compare-nobloom    Also render the same frame without bloom, report the
                       measured luminance delta, and write FILE.nobloom.png
  --keep-open          Leave the browser open (headed) for debugging
  -h, --help           This message

Playwright is not a repo dependency; see the header comment for how to
install it out-of-tree.
`.trimStart();

function parseArgs(argv) {
  const opts = {
    baseUrl: process.env.NEONBENCH_BASE_URL || 'http://127.0.0.1:7373',
    width: 1600,
    height: 1200,
    timeout: 30000,
    playwright: process.env.NEONBENCH_PLAYWRIGHT || null,
    strict: false,
    compareNobloom: false,
    keepOpen: false,
    nobloom: false,
  };
  const flags = {
    '--project': 'project',
    '--version': 'version',
    '--out': 'out',
    '--preset': 'preset',
    '--wall': 'wall',
    '--bg': 'bg',
    '--group': 'group',
    '--base-url': 'baseUrl',
    '--width': 'width',
    '--height': 'height',
    '--timeout': 'timeout',
    '--playwright': 'playwright',
  };
  const numeric = new Set(['width', 'height', 'timeout']);
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      process.stdout.write(USAGE);
      process.exit(0);
    } else if (a === '--strict') opts.strict = true;
    else if (a === '--compare-nobloom') opts.compareNobloom = true;
    else if (a === '--keep-open') opts.keepOpen = true;
    else if (a === '--nobloom') opts.nobloom = true;
    else if (Object.hasOwn(flags, a)) {
      const key = flags[a];
      const v = argv[++i];
      if (v === undefined) fatal(`${a} needs a value`);
      opts[key] = numeric.has(key) ? Number(v) : v;
      if (numeric.has(key) && !Number.isFinite(opts[key])) {
        fatal(`${a} needs a number, got "${v}"`);
      }
    } else fatal(`unknown argument "${a}"\n\n${USAGE}`);
  }
  for (const required of ['project', 'version', 'out']) {
    if (!opts[required]) fatal(`--${required} is required\n\n${USAGE}`);
  }
  if (opts.nobloom && opts.compareNobloom) {
    fatal('--nobloom and --compare-nobloom are mutually exclusive');
  }
  return opts;
}

function fatal(msg) {
  process.stderr.write(`render-preview: ${msg}\n`);
  process.exit(2);
}

/**
 * Build the preview URL. This *is* the contract — every knob is a query
 * parameter parsed by `web/src/preview/renderParams.ts`, so the same URL
 * pasted into a browser shows exactly what this script captures.
 */
function previewURL(opts, { nobloom }) {
  const u = new URL(
    `/projects/${opts.project}/versions/${opts.version}/preview`,
    opts.baseUrl,
  );
  if (opts.preset) u.searchParams.set('preset', opts.preset);
  if (opts.wall) u.searchParams.set('wall', opts.wall);
  if (opts.bg) u.searchParams.set('bg', opts.bg);
  if (opts.group) u.searchParams.set('groupId', opts.group);
  u.searchParams.set('autocapture', '1');
  u.searchParams.set('timeout', String(opts.timeout));
  if (nobloom) u.searchParams.set('nobloom', '1');
  return u.toString();
}

async function loadPlaywright(hint) {
  const require = createRequire(import.meta.url);
  const candidates = [];
  if (hint) {
    candidates.push(hint);
    candidates.push(path.resolve(hint));
  }
  candidates.push('playwright', 'playwright-core');
  for (const c of candidates) {
    try {
      const mod = await import(
        c.startsWith('.') || c.startsWith('/') ? require.resolve(c) : c
      );
      // Playwright ships CommonJS. Depending on how the specifier
      // resolved, node may or may not have detected the named exports,
      // so `chromium` can be on the namespace or behind `.default`.
      const resolved = mod?.chromium ? mod : mod?.default;
      if (resolved?.chromium) return resolved;
    } catch {
      /* try the next candidate */
    }
  }
  fatal(
    'could not load playwright.\n' +
      '  Playwright is deliberately not a repo dependency. Install it out of tree:\n' +
      '    mkdir -p /tmp/nb-render && cd /tmp/nb-render\n' +
      '    npm init -y && npm i playwright && npx playwright install chromium\n' +
      '  then re-run with --playwright /tmp/nb-render/node_modules/playwright',
  );
}

/**
 * Drive one capture. Returns the result object the page resolved with.
 *
 * The console/pageerror forwarding is not decoration: when a capture
 * fails, the reason is nearly always a message the page already logged,
 * and a driver that swallows it turns a five-second diagnosis into a
 * twenty-minute one.
 */
async function capture(browser, opts, { nobloom }) {
  const page = await browser.newPage({
    viewport: { width: opts.width, height: opts.height },
    deviceScaleFactor: 1,
  });
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') {
      process.stderr.write(`  [page ${m.type()}] ${m.text()}\n`);
    }
  });

  const url = previewURL(opts, { nobloom });
  process.stderr.write(`render-preview: ${url}\n`);
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const result = await page.evaluate(
    async ({ globalName, timeout }) => {
      const started = Date.now();
      // The handle is installed by a React effect, so it may not exist
      // on the first tick after DOMContentLoaded.
      while (!window[globalName]) {
        if (Date.now() - started > timeout) {
          throw new Error(
            `no ${globalName} on window after ${timeout} ms — is ?autocapture set, ` +
              `and is this build new enough to have the Tier 3 #137 handshake?`,
          );
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return await window[globalName].ready;
    },
    { globalName: '__neonbenchPreviewCapture', timeout: opts.timeout },
  ).catch((e) => {
    for (const pe of pageErrors) process.stderr.write(`  [page error] ${pe}\n`);
    throw e;
  });

  if (!opts.keepOpen) await page.close();
  return result;
}

function dataURLToBuffer(dataURL) {
  const comma = dataURL.indexOf(',');
  if (comma < 0 || !dataURL.startsWith('data:image/png;base64,')) {
    throw new Error('capture did not return a base64 PNG data URL');
  }
  return Buffer.from(dataURL.slice(comma + 1), 'base64');
}

async function main() {
  const opts = parseArgs(process.argv);
  const pw = await loadPlaywright(opts.playwright);

  const browser = await pw.chromium.launch({
    headless: !opts.keepOpen,
    // Headless Chromium has no GPU; ANGLE-on-SwiftShader gives it a
    // software WebGL2 implementation good enough for the post-process
    // chain. Without these the page falls back to no WebGL at all and
    // the capture times out waiting for a canvas that never appears.
    args: [
      '--use-gl=angle',
      '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader',
      '--disable-lcd-text',
    ],
  });

  try {
    const result = await capture(browser, opts, { nobloom: opts.nobloom });

    for (const w of result.warnings ?? []) {
      process.stderr.write(`render-preview: WARNING ${w}\n`);
    }
    if (opts.strict && (result.warnings ?? []).length > 0) {
      throw new Error(
        '--strict: the URL contained values the page did not understand (above)',
      );
    }

    await writeFile(opts.out, dataURLToBuffer(result.dataURL));
    process.stdout.write(
      `${opts.out}  ${result.width}x${result.height}  ` +
        `bloom=${result.bloom}  ${result.bloomReason}\n`,
    );

    if (opts.compareNobloom) {
      // The A-B the spec asks for, on demand: same version, same preset,
      // one render through the composer and one deliberately bypassing
      // it. The delta printed here is what calibrates BLOOM_DELTA_FLOOR
      // in web/src/preview/bloomMetric.ts.
      const flat = await capture(browser, opts, { nobloom: true });
      const flatPath = opts.out.replace(/(\.png)?$/i, '.nobloom.png');
      await writeFile(flatPath, dataURLToBuffer(flat.dataURL));
      process.stdout.write(
        `${flatPath}  ${flat.width}x${flat.height}  bloom=false\n` +
          `measured post-process luminance delta: ${result.bloomDelta}\n`,
      );
    }
  } catch (e) {
    process.stderr.write(`render-preview: FAILED ${e.message ?? e}\n`);
    process.exitCode = 1;
  } finally {
    if (!opts.keepOpen) await browser.close();
  }
}

await main();
