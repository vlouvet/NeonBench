#!/usr/bin/env node
// Convert the public-domain Hershey Roman Simplex font (`rowmans.jhf`) into
// a small JSON file that the editor's "Add text" tool consumes directly.
//
// Why a script (not a one-time hand-conversion checked in raw): the JHF
// format is a 1970s text-mode encoding ("each coordinate is one byte
// relative to ASCII 'R'"). Doing the parse at build time lets us keep the
// JSON small and trivially re-runnable from a fresh source if we ever swap
// fonts (e.g. switch to Roman Duplex for thicker channel-letter strokes).
//
// Source: kamalmostafa/hershey-fonts on GitHub, which mirrors Jim Hurt's
// 1980s Usenet redistribution of Dr. A. V. Hershey's original NBS data.
// License: U.S. National Bureau of Standards public-domain font data;
// Hurt's redistribution permits any use with attribution. The attribution
// is baked into the generated JSON's "_license" field and the consumer
// module's header comment.
//
// Usage:
//   node scripts/build-hershey-font.mjs
//
// Output:
//   web/src/lib/hershey/rowmans.json
//
// Reproducibility: the script is deterministic given the same upstream
// .jhf bytes; the upstream URL is pinned by file path (the repo is
// effectively frozen — no upstream releases since 2014).

import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..');
const CACHE_DIR = join(REPO_ROOT, '.hershey-cache');
const CACHE_FILE = join(CACHE_DIR, 'rowmans.jhf');
const OUT_FILE = join(REPO_ROOT, 'web', 'src', 'lib', 'hershey', 'rowmans.json');
const SOURCE_URL =
  'https://raw.githubusercontent.com/kamalmostafa/hershey-fonts/master/hershey-fonts/rowmans.jhf';

async function fetchOrCache() {
  if (existsSync(CACHE_FILE)) {
    return readFileSync(CACHE_FILE, 'utf8');
  }
  console.error(`Downloading ${SOURCE_URL}…`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) throw new Error(`fetch ${SOURCE_URL}: ${res.status}`);
  const text = await res.text();
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(CACHE_FILE, text);
  return text;
}

// JHF parser. Each glyph record:
//   cols  0..4  : glyph ID (5 chars, right-justified, ignored — we use sequence position)
//   cols  5..7  : vertex count N (3 chars)
//   cols  8..   : 2*N coordinate bytes. The first pair encodes (left, right)
//                 horizontal extents (= advance bracket), not a draw-point.
//                 Subsequent pairs are draw points; the literal pair " R"
//                 (space + 'R') is a "pen up" sentinel that starts a new
//                 stroke. All coordinates are byte offsets from ASCII 'R'
//                 (so " R" = (-50, 0) which the doc reader treats as a
//                 magic move-pen marker).
//
// Records can wrap across multiple physical lines if vertex count is large.
function parseJhf(text) {
  const lines = text.split(/\r?\n/);
  const glyphs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || line.length < 8) {
      i++;
      continue;
    }
    const nverts = parseInt(line.substring(5, 8).trim(), 10);
    if (!Number.isFinite(nverts) || nverts < 1) {
      i++;
      continue;
    }
    let body = line.substring(8);
    const needed = nverts * 2;
    while (body.length < needed && i + 1 < lines.length) {
      i++;
      body += lines[i];
    }
    body = body.substring(0, needed);
    glyphs.push(body);
    i++;
  }
  return glyphs;
}

// Convert a raw JHF body (2*N chars) into { left, right, strokes }.
function decodeGlyph(body) {
  const R = 'R'.charCodeAt(0);
  // First pair = left/right horizontal bracket.
  const left = body.charCodeAt(0) - R;
  const right = body.charCodeAt(1) - R;
  const strokes = [];
  let current = null;
  for (let p = 1; p < body.length / 2; p++) {
    const c0 = body[p * 2];
    const c1 = body[p * 2 + 1];
    if (c0 === ' ' && c1 === 'R') {
      // Pen up — finalize current stroke and start a fresh one on next pair.
      if (current && current.length >= 2) strokes.push(current);
      current = null;
      continue;
    }
    const x = c0.charCodeAt(0) - R;
    const y = c1.charCodeAt(0) - R;
    if (!current) current = [];
    current.push([x, y]);
  }
  if (current && current.length >= 2) strokes.push(current);
  return { left, right, strokes };
}

const text = await fetchOrCache();
const rawGlyphs = parseJhf(text);

// Standard Hershey ASCII mapping for the simplex fonts: glyphs are stored
// in sequence and map to ASCII 32 ('space') onwards. rowmans has 96 glyphs
// covering 32..127.
const out = { _license: '', glyphs: {} };
out._license =
  'Hershey Roman Simplex font data. Originally created by Dr. A. V. Hershey at the U.S. National Bureau of Standards (public domain). Format by James Hurt, 1980s Usenet Font Consortium; redistribution permitted with attribution. Coordinate units: byte offsets from ASCII R (~ 1/21 of cap height). Cap height in source units is approximately 21.';

for (let i = 0; i < rawGlyphs.length && i < 96; i++) {
  const ascii = 32 + i;
  const decoded = decodeGlyph(rawGlyphs[i]);
  // Drop empty-stroke glyphs to keep JSON small (e.g. space).
  out.glyphs[ascii] = {
    left: decoded.left,
    right: decoded.right,
    strokes: decoded.strokes,
  };
}

mkdirSync(dirname(OUT_FILE), { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out));
const size = readFileSync(OUT_FILE).byteLength;
console.error(`wrote ${OUT_FILE} (${size} bytes, ${Object.keys(out.glyphs).length} glyphs)`);
