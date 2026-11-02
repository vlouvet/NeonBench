import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LengthField } from './LengthField';

const render = (props: Partial<Parameters<typeof LengthField>[0]> = {}) =>
  renderToStaticMarkup(<LengthField valueMM={1231.9} units="in" onChangeMM={() => {}} {...props} />);

describe('LengthField', () => {
  it('is a text input, because a number input cannot hold 48 1/2', () => {
    expect(render()).toContain('type="text"');
    expect(render()).not.toContain('type="number"');
  });

  it('shows the display unit, not the stored millimetres', () => {
    expect(render()).toContain('value="48 1/2"');
    expect(render({ units: 'mm' })).toContain('value="1231.9"');
  });

  it('cannot be turned back into a lattice input by a spread', () => {
    const hostile = { type: 'number', step: 0.5, min: 1 } as object;
    const html = render(hostile);
    expect(html).toContain('type="text"');
  });

  it('passes other attributes through', () => {
    expect(render({ 'aria-label': 'Cap height', placeholder: '8' } as object)).toContain('aria-label="Cap height"');
  });
});
