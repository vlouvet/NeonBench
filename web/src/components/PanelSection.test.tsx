import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CategoryIcon, SectionHeader, type IconKind } from './PanelSection';

// RTL isn't wired up in this repo (see PreviewPage.test.tsx), so we render
// to static markup and assert on the HTML string. Enough to catch the icon
// set regressing or the disclosure header losing its a11y wiring.

describe('CategoryIcon', () => {
  const kinds: IconKind[] = [
    'electrode',
    'blockout',
    'bend',
    'annotation',
    'jump',
    'support',
    'doubleback',
    'drop_bend',
  ];
  for (const kind of kinds) {
    it(`renders an svg for kind "${kind}"`, () => {
      const html = renderToStaticMarkup(<CategoryIcon kind={kind} />);
      expect(html).toContain('<svg');
      expect(html).toContain('width="14"');
    });
  }
});

describe('SectionHeader', () => {
  it('exposes aria-expanded=true and a ▾ chevron when expanded', () => {
    const html = renderToStaticMarkup(
      <SectionHeader icon="bend" collapsed={false} onToggle={() => {}}>
        Bends · 3
      </SectionHeader>,
    );
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('▾');
    expect(html).toContain('Bends · 3');
    expect(html).toContain('<svg');
  });

  it('exposes aria-expanded=false and a ▸ chevron when collapsed', () => {
    const html = renderToStaticMarkup(
      <SectionHeader icon="electrode" collapsed onToggle={() => {}}>
        Electrodes · 2
      </SectionHeader>,
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('▸');
  });
});
