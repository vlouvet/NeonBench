// BundlePreviewModal — pre-import preview dialog for .neonbench bundle
// imports. Tier 3 #38b. Surfaces the bundle's manifest (project name,
// schema version, version count, tube spec) so a wrong drag-drop is
// recoverable with a Cancel button rather than landing the user inside
// an unwanted project.
//
// The preview is read entirely client-side: we parse just enough of
// the .neonbench zip's central directory to extract `manifest.json`
// and decode it. We don't validate cross-version invariants here — the
// server still owns that on the actual POST. This is purely a "does
// this look right?" gate.
//
// Why not JSZip: the project hasn't taken a zip-parsing dep yet, and
// CLAUDE.md routes new third-party deps through the user. The ZIP
// central-directory format is small enough to read inline for the one
// entry we care about (manifest.json), and modern browsers ship
// DecompressionStream for the deflate branch. ~150 lines vs. a 30 KB
// dep felt like the boring choice.

import { useEffect, useState } from 'react';

// Subset of the server-side bundleManifest we actually display. Stays
// loose on unfamiliar fields so a future schema bump doesn't crash the
// preview — anything we don't render survives in the unparsed json.
type BundleManifest = {
  bundle?: string;
  schema?: number;
  exported_at?: string;
  project?: {
    name?: string;
    units?: string;
    created_at?: string;
    updated_at?: string;
  };
  tube_spec?: {
    id?: number;
    name?: string;
    diameter_mm?: number;
    min_bend_radius_mm?: number;
    max_segment_length_mm?: number;
    min_spacing_mm?: number;
  };
  versions?: Array<{
    version_no?: number;
    label?: string;
    created_at?: string;
  }>;
};

type Props = {
  file: File;
  onCancel: () => void;
  onConfirm: (file: File) => void;
};

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; manifest: BundleManifest }
  | { kind: 'error'; message: string };

export default function BundlePreviewModal({ file, onCancel, onConfirm }: Props) {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const manifest = await readBundleManifest(file);
        if (!cancelled) setState({ kind: 'ready', manifest });
      } catch (err) {
        if (!cancelled) {
          setState({ kind: 'error', message: (err as Error).message });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Import .neonbench bundle</h2>
        <p className="meta">
          From file: <code>{file.name}</code>{' '}
          <span className="meta">({formatBytes(file.size)})</span>
        </p>
        {state.kind === 'loading' && <p className="meta">Reading bundle…</p>}
        {state.kind === 'error' && (
          <>
            <p className="error">Couldn't preview this bundle: {state.message}</p>
            <p className="meta">
              The server may still accept it — Import anyway will retry the upload — but you usually
              want to Cancel and pick a different file.
            </p>
          </>
        )}
        {state.kind === 'ready' && <BundlePreviewBody manifest={state.manifest} />}
        <div className="actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onConfirm(file)}
            disabled={state.kind === 'loading'}
          >
            {state.kind === 'error' ? 'Import anyway' : 'Import'}
          </button>
        </div>
      </div>
    </div>
  );
}

function BundlePreviewBody({ manifest }: { manifest: BundleManifest }) {
  // Pull the fields the prompt calls out: name, schema, version count,
  // tube-spec dims, creation date. Versions array is the source of
  // truth for the count even when manifest.versions is empty (the
  // bundle might still be valid, but we want to surface that).
  const projectName = manifest.project?.name ?? '(unnamed)';
  const versionCount = manifest.versions?.length ?? 0;
  const exportedAt = manifest.exported_at ?? '';
  const projectCreatedAt = manifest.project?.created_at ?? '';
  const schema = manifest.schema;
  const tube = manifest.tube_spec;
  const isNeonBenchBundle = manifest.bundle === 'neonbench';

  return (
    <>
      {!isNeonBenchBundle && (
        <p className="error">
          Manifest header doesn't say "neonbench" — this may not be a NeonBench bundle.
        </p>
      )}
      <dl className="bundle-preview-fields">
        <dt>Project</dt>
        <dd>{projectName}</dd>
        <dt>Schema</dt>
        <dd>{schema === undefined ? '(missing)' : `v${schema}`}</dd>
        <dt>Versions</dt>
        <dd>
          {versionCount} {versionCount === 1 ? 'version' : 'versions'}
        </dd>
        <dt>Tube spec</dt>
        <dd>{formatTubeSpec(tube)}</dd>
        {projectCreatedAt && (
          <>
            <dt>Project created</dt>
            <dd>{formatTimestamp(projectCreatedAt)}</dd>
          </>
        )}
        {exportedAt && (
          <>
            <dt>Bundle exported</dt>
            <dd>{formatTimestamp(exportedAt)}</dd>
          </>
        )}
      </dl>
    </>
  );
}

// formatTubeSpec mirrors the dims surfaced on the project list rows —
// name plus the few dimensions a fabricator cares about at a glance.
// Returns "(missing)" when the manifest didn't ship a tube_spec entry,
// which can happen on schema-0 bundles from a hypothetical older build.
function formatTubeSpec(tube: BundleManifest['tube_spec']): string {
  if (!tube) return '(missing)';
  const name = tube.name ?? '(unnamed)';
  const parts: string[] = [];
  if (typeof tube.diameter_mm === 'number') parts.push(`Ø ${tube.diameter_mm} mm`);
  if (typeof tube.min_bend_radius_mm === 'number')
    parts.push(`r ≥ ${tube.min_bend_radius_mm} mm`);
  if (typeof tube.max_segment_length_mm === 'number')
    parts.push(`segment ≤ ${tube.max_segment_length_mm} mm`);
  return parts.length === 0 ? name : `${name} — ${parts.join(', ')}`;
}

function formatTimestamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Date(t).toLocaleString();
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader. Reads only what's needed to extract a single named
// entry (manifest.json) from a .neonbench bundle. Supports Store
// (method 0) and Deflate (method 8); zip64 and encrypted entries are
// not in our export path so we surface a clear error instead of a
// bogus parse.
//
// Reference: PKWARE APPNOTE.TXT, sections 4.3 (local file header), 4.4
// (central directory), 4.5 (EOCD). All multi-byte fields are
// little-endian.
// ---------------------------------------------------------------------------

const SIG_LOCAL = 0x04034b50;
const SIG_CD = 0x02014b50;
const SIG_EOCD = 0x06054b50;

const MANIFEST_NAME = 'manifest.json';

async function readBundleManifest(file: File): Promise<BundleManifest> {
  const buf = await file.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  const eocd = findEOCD(bytes, view);
  if (!eocd) throw new Error('not a zip (no end-of-central-directory)');

  // Walk the central directory looking for manifest.json. We don't
  // need a full file table — bail on the first match.
  let offset = eocd.cdOffset;
  const end = eocd.cdOffset + eocd.cdSize;
  while (offset < end) {
    if (view.getUint32(offset, true) !== SIG_CD) {
      throw new Error('central directory entry signature missing');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compSize = view.getUint32(offset + 20, true);
    const uncompSize = view.getUint32(offset + 24, true);
    const nameLen = view.getUint16(offset + 28, true);
    const extraLen = view.getUint16(offset + 30, true);
    const commentLen = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const nameBytes = bytes.subarray(offset + 46, offset + 46 + nameLen);
    const name = decodeName(nameBytes);
    if (name === MANIFEST_NAME) {
      if (flags & 0x1) throw new Error('encrypted bundle entry');
      if (compSize === 0xffffffff || uncompSize === 0xffffffff) {
        throw new Error('zip64 entry not supported');
      }
      const data = await readEntryData(bytes, view, localOffset, method, compSize, uncompSize);
      return parseManifest(data);
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error(`${MANIFEST_NAME} not found in bundle`);
}

// findEOCD scans the trailing 64 KiB for the end-of-central-directory
// signature. ZIP comments can be up to 65535 bytes; small bundles let
// us start much closer to the end, so we cap the scan range at
// (fileSize, 0xffff + 22) and walk backwards.
function findEOCD(
  bytes: Uint8Array,
  view: DataView,
): { cdOffset: number; cdSize: number } | null {
  const fileLen = bytes.length;
  // Minimum EOCD is 22 bytes (no comment). Maximum scan window is
  // 22 + 0xffff. Walking from the back is faster than from the front.
  const minOffset = Math.max(0, fileLen - 22 - 0xffff);
  for (let i = fileLen - 22; i >= minOffset; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      const cdSize = view.getUint32(i + 12, true);
      const cdOffset = view.getUint32(i + 16, true);
      // Sanity check: the CD must lie inside the file. A false-positive
      // EOCD signature (e.g. inside a bundled SVG) would fail this.
      if (cdOffset + cdSize <= fileLen) {
        return { cdOffset, cdSize };
      }
    }
  }
  return null;
}

async function readEntryData(
  bytes: Uint8Array,
  view: DataView,
  localOffset: number,
  method: number,
  compSize: number,
  uncompSize: number,
): Promise<Uint8Array> {
  if (view.getUint32(localOffset, true) !== SIG_LOCAL) {
    throw new Error('local file header signature missing');
  }
  // Local header has its own name + extra lengths; trust those over
  // the central-directory copy (the spec allows them to differ).
  const nameLen = view.getUint16(localOffset + 26, true);
  const extraLen = view.getUint16(localOffset + 28, true);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const compressed = bytes.subarray(dataStart, dataStart + compSize);
  if (method === 0) {
    // Store. compressed and uncompressed sizes are equal in a
    // well-formed file; we slice to compSize so a trailing data
    // descriptor (when flag 0x8 is set) doesn't sneak in.
    return compressed;
  }
  if (method === 8) {
    return inflateDeflateRaw(compressed, uncompSize);
  }
  throw new Error(`unsupported compression method ${method}`);
}

// inflateDeflateRaw decompresses a raw-deflate payload using the
// browser's DecompressionStream. The 'deflate-raw' format (no zlib
// header) matches what ZIP stores. We assemble the resulting chunks
// into a single Uint8Array for the JSON parser.
async function inflateDeflateRaw(input: Uint8Array, expectedSize: number): Promise<Uint8Array> {
  // Some older browsers don't ship 'deflate-raw' — guard for that so
  // the error is clear instead of a runtime TypeError.
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('DecompressionStream not available in this browser');
  }
  let stream: ReadableStream<Uint8Array>;
  try {
    // Note: we copy `input` into a fresh ArrayBuffer because Blob
    // accepts an ArrayBufferLike but some bundlers' type defs are
    // narrower. Plain new Blob([input]) works in every modern engine.
    stream = new Blob([new Uint8Array(input)]).stream().pipeThrough(
      new DecompressionStream('deflate-raw'),
    );
  } catch (err) {
    throw new Error(`deflate-raw not supported: ${(err as Error).message}`, { cause: err });
  }
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }
  // Concat in one allocation. We don't compare against expectedSize
  // strictly — a mismatched size would already throw above when the
  // deflate stream rejects truncated input.
  void expectedSize;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

// decodeName treats CP-437 / UTF-8 ZIP entry names. Modern Go
// archive/zip writes UTF-8 by default; we only look for the literal
// ASCII string "manifest.json", so a lossy decode is fine.
function decodeName(b: Uint8Array): string {
  return new TextDecoder('utf-8').decode(b);
}

function parseManifest(b: Uint8Array): BundleManifest {
  const text = new TextDecoder('utf-8').decode(b);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`manifest.json is not valid JSON: ${(err as Error).message}`, { cause: err });
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('manifest.json is not a JSON object');
  }
  // Cast is safe — we only read known fields, and the type is
  // intentionally lax about shape mismatches above.
  return raw as BundleManifest;
}
