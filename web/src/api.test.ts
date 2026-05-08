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
});
