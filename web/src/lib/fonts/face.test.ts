import { describe, expect, it } from 'vitest';
import { FontLoadError, describeLicence, loadFace, missingChars } from './face';
import { SYNTH_UPM, buildSynthFontBuffer, synthFace } from './synthFont';

describe('loadFace', () => {
  it('parses a face and reads its own names and metrics', () => {
    const face = loadFace(buildSynthFontBuffer(), 'NeonBenchSynth-Regular.otf');
    expect(face.familyName).toBe('NeonBench Synth');
    expect(face.styleName).toBe('Regular');
    expect(face.unitsPerEm).toBe(SYNTH_UPM);
    expect(face.numGlyphs).toBe(5);
    expect(face.capHeight.source).toBe('measured-H');
  });

  it('rejects an empty buffer', () => {
    expect(() => loadFace(new ArrayBuffer(0), 'empty.ttf')).toThrow(FontLoadError);
  });

  it('rejects a file that is not a font, naming the file', () => {
    const junk = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]).buffer;
    expect(() => loadFace(junk, 'notes.txt')).toThrow(/notes\.txt could not be read as a font/);
  });

  it('explains the .ttc case, which is what macOS ships', () => {
    // 'ttcf' + a plausible header. opentype.js throws "Unsupported
    // OpenType signature ttcf"; the operator needs to be told what to do
    // about it, not shown the parser's wording.
    const bytes = new Uint8Array(16);
    bytes.set([0x74, 0x74, 0x63, 0x66], 0);
    let err: unknown;
    try {
      loadFace(bytes.buffer, 'Helvetica.ttc');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FontLoadError);
    expect((err as Error).message).toMatch(/font COLLECTION/);
    expect((err as Error).message).toMatch(/\.ttf or \.otf/);
  });
});

describe('missingChars', () => {
  it('lists only characters with no glyph, de-duplicated and in order', () => {
    const face = synthFace();
    expect(missingChars(face, 'HOI')).toEqual([]);
    expect(missingChars(face, 'HщOщZ')).toEqual(['щ', 'Z']);
  });

  it('treats whitespace as layout, never as a missing glyph', () => {
    const face = synthFace();
    expect(missingChars(face, 'H O\nI\t')).toEqual([]);
  });
});

describe('describeLicence', () => {
  it('names the face and puts the licence on the operator, not on us', () => {
    const text = describeLicence(synthFace());
    expect(text).toContain('NeonBench Synth Regular');
    expect(text).toMatch(/not stored by NeonBench/);
    expect(text).toMatch(/your licence with its foundry/);
  });
});
