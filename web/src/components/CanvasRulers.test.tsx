import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import CanvasRulers from './CanvasRulers';
import { MM_PER_INCH } from '../lib/units';

// Tier 1 #130. The units prop is a DISPLAY switch, and the thing worth
// pinning is what actually reaches the DOM — a ladder chosen correctly in
// `guides.ts` still buys nothing if the component forgets to pass `units`
// down to one of its two rules. That has to be checked on the emitted markup,
// not on the pure function, which is exactly what this repo's node-only test
// environment can do via `renderToStaticMarkup` (see NumericField.test.tsx).

const base = {
  width: 900,
  height: 600,
  tx: 40,
  ty: 40,
  cursor: null,
  guidelines: [],
  onRulerPointerDown: () => {},
};

// Pull the text content of every <text class="ruler-label"> out of the markup.
function labels(html: string): string[] {
  return [...html.matchAll(/class="ruler-label"[^>]*>([^<]*)</g)].map((m) => m[1]);
}

describe('CanvasRulers', () => {
  it('labels in bare millimetres by default', () => {
    const html = renderToStaticMarkup(<CanvasRulers {...base} scale={1} />);
    const ls = labels(html);
    expect(ls.length).toBeGreaterThan(0);
    for (const l of ls) expect(l).toMatch(/^-?\d+(\.\d+)?$/);
    expect(html).toContain('>mm<');
  });

  // The regression this exists for: passing `units` to one rule and not the
  // other. Both gutters have to speak the same unit or the design is a
  // different size depending on which edge you read.
  it('labels BOTH rules in inches when the project says so', () => {
    const scale = 76 / MM_PER_INCH; // ~1" rung
    const html = renderToStaticMarkup(<CanvasRulers {...base} scale={scale} units="in" />);
    const ls = labels(html);
    // Horizontal rule spans 900px, vertical 600px — at a 1" rung that is
    // roughly 11 and 7 majors, so both must have contributed labels.
    expect(ls.length).toBeGreaterThan(12);
    // No mm label survives: at this scale the mm ladder would emit 20mm rungs
    // (20, 40, 60...), and 25.4mm rungs read 1, 2, 3 in inches.
    expect(ls).toContain('1');
    expect(ls).toContain('2');
    expect(ls.every((l) => /^-?\d+( \d+\/\d+)?$|^-?\d+\/\d+$/.test(l))).toBe(true);
  });

  it('renders sub-inch rungs as reduced fractions', () => {
    const scale = 80 / (MM_PER_INCH / 4); // ~1/4" rung
    const html = renderToStaticMarkup(<CanvasRulers {...base} scale={scale} units="in" />);
    const ls = labels(html);
    expect(ls).toContain('1/4');
    expect(ls).toContain('1/2');
    expect(ls).toContain('3/4');
  });

  // Every tick label is a bare number, so the corner box is the only place
  // that says which unit the operator is reading.
  it('names the active unit in the corner box', () => {
    expect(renderToStaticMarkup(<CanvasRulers {...base} scale={1} units="mm" />)).toContain('>mm<');
    expect(renderToStaticMarkup(<CanvasRulers {...base} scale={1} units="in" />)).toContain('>″<');
  });
});
