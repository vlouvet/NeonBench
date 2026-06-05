import { describe, expect, it } from 'vitest';
import { api } from './api';

// printPDFURL is the URL builder for the editor's Print button + the
// Tier 3 #52 popover. The popover passes paper / landscape /
// strips-only through `opts`; the existing single-arg call shape
// (no options) must keep producing the bare URL so the legacy
// callers stay byte-identical.
describe('api.printPDFURL', () => {
  it('returns the bare endpoint when no options are supplied', () => {
    expect(api.printPDFURL(7, 42)).toBe(
      '/api/projects/7/design_versions/42/print.pdf',
    );
  });

  it('omits query params for falsy options (single source of truth: server defaults)', () => {
    expect(
      api.printPDFURL(7, 42, { landscape: false, stripsOnly: false }),
    ).toBe('/api/projects/7/design_versions/42/print.pdf');
  });

  // Tier 2 #73 — the trade default is MIRRORED (server-side
  // Mirror=true). The URL builder MUST omit the mirror param when
  // the caller leaves `mirror` undefined OR sets it explicitly true,
  // because emitting `?mirror=1` would duplicate the server's
  // default. Only an explicit `mirror: false` adds `?mirror=0`.
  it('omits mirror param when mirror is undefined (trade default = mirrored)', () => {
    expect(api.printPDFURL(7, 42)).toBe(
      '/api/projects/7/design_versions/42/print.pdf',
    );
  });

  it('omits mirror param when mirror is true (matches server default)', () => {
    expect(api.printPDFURL(7, 42, { mirror: true })).toBe(
      '/api/projects/7/design_versions/42/print.pdf',
    );
  });

  it('encodes mirror=0 when explicitly disabled (front-facing print)', () => {
    expect(api.printPDFURL(7, 42, { mirror: false })).toBe(
      '/api/projects/7/design_versions/42/print.pdf?mirror=0',
    );
  });

  it('encodes the paper option', () => {
    expect(api.printPDFURL(1, 2, { paper: 'tabloid' })).toBe(
      '/api/projects/1/design_versions/2/print.pdf?paper=tabloid',
    );
  });

  it('encodes landscape as 1 (matches the server flag)', () => {
    expect(api.printPDFURL(1, 2, { landscape: true })).toBe(
      '/api/projects/1/design_versions/2/print.pdf?landscape=1',
    );
  });

  it('encodes strips_only as 1 (Tier 3 #50 backend toggle)', () => {
    expect(api.printPDFURL(1, 2, { stripsOnly: true })).toBe(
      '/api/projects/1/design_versions/2/print.pdf?strips_only=1',
    );
  });

  it('combines paper + landscape + strips-only in a single query string', () => {
    expect(
      api.printPDFURL(11, 22, {
        paper: 'a4',
        landscape: true,
        stripsOnly: true,
      }),
    ).toBe(
      '/api/projects/11/design_versions/22/print.pdf?paper=a4&landscape=1&strips_only=1',
    );
  });

  it('combines paper + landscape + strips-only + mirror=false (every param)', () => {
    // Tier 2 #73 — full opt-out combo: explicit front-facing print
    // on A4 landscape strips-only. Pins the param order
    // (paper, landscape, strips_only, mirror) so a future refactor
    // that reshuffles the URLSearchParams set() calls shows up here
    // before it ships.
    expect(
      api.printPDFURL(11, 22, {
        paper: 'a4',
        landscape: true,
        stripsOnly: true,
        mirror: false,
      }),
    ).toBe(
      '/api/projects/11/design_versions/22/print.pdf?paper=a4&landscape=1&strips_only=1&mirror=0',
    );
  });
});

// Vector-graphics URL builders (Tier 3 #80). The three sibling formats
// (SVG / EPS / AI) share the same query-string shape; we pin their
// output here so a future refactor that touches buildExportURL can't
// silently drift one format's wire form away from the others.
describe('api.exportSVGURL / exportEPSURL / exportAIURL', () => {
  it('returns the bare endpoint when no options are supplied', () => {
    expect(api.exportSVGURL(7, 42)).toBe(
      '/api/projects/7/design_versions/42/export.svg',
    );
    expect(api.exportEPSURL(7, 42)).toBe(
      '/api/projects/7/design_versions/42/export.eps',
    );
    expect(api.exportAIURL(7, 42)).toBe(
      '/api/projects/7/design_versions/42/export.ai',
    );
  });

  it('omits the mirror param when explicitly false', () => {
    expect(api.exportSVGURL(7, 42, { mirror: false })).toBe(
      '/api/projects/7/design_versions/42/export.svg',
    );
  });

  it('encodes mirror as 1 (matches the server flag)', () => {
    expect(api.exportSVGURL(1, 2, { mirror: true })).toBe(
      '/api/projects/1/design_versions/2/export.svg?mirror=1',
    );
    expect(api.exportEPSURL(1, 2, { mirror: true })).toBe(
      '/api/projects/1/design_versions/2/export.eps?mirror=1',
    );
    expect(api.exportAIURL(1, 2, { mirror: true })).toBe(
      '/api/projects/1/design_versions/2/export.ai?mirror=1',
    );
  });
});
