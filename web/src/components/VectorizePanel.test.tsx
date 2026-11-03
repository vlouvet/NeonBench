import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import VectorizePanel from './VectorizePanel';

const noop = vi.fn();

describe('VectorizePanel width hint', () => {
  it('says which width the field means in each mode (Tier 3 #144)', () => {
    const svg = renderToStaticMarkup(
      <VectorizePanel projectId={1} assetId={2} isSVG onCreated={noop} />,
    );
    expect(svg).toContain('Target width (mm)');
    expect(svg).toContain('Your SVG imports at its own width; this number is not used to resize it.');

    const raster = renderToStaticMarkup(
      <VectorizePanel projectId={1} assetId={2} isSVG={false} onCreated={noop} />,
    );
    expect(raster).toContain('Image width (mm)');
    expect(raster).toContain('Width of the whole image, edge to edge, blank margin included');
    expect(raster).toContain('not the artwork inside it.');
  });
});
