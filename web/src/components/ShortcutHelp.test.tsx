import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ShortcutHelp from './ShortcutHelp';
import { defaultKeymap, FIXED_KEYS, formatBinding, HOTKEYS, rebind } from '../lib/hotkeys';

// The reference's whole value is that it cannot drift from the real keys, so
// these pin that it renders the keymap it is given rather than the defaults.
const render = (keymap = defaultKeymap()) =>
  renderToStaticMarkup(<ShortcutHelp keymap={keymap} onChange={() => {}} onClose={() => {}} />);

describe('ShortcutHelp', () => {
  it('lists every registered hotkey and every fixed gesture key', () => {
    const html = render();
    for (const h of HOTKEYS) expect(html).toContain(h.label);
    for (const k of FIXED_KEYS) expect(html).toContain(k.keys);
  });

  it('shows the live binding, not the default', () => {
    const remapped = rebind(defaultKeymap(), 'tool.pen', 'shift+q');
    expect(render(remapped)).toContain(`>${formatBinding('shift+q')}<`);
    expect(render()).not.toContain(`>${formatBinding('shift+q')}<`);
  });

  it('offers a change control for remappable keys only', () => {
    const html = render();
    expect(html).toContain('aria-label="Change key for Pen"');
    expect(html).not.toContain('Change key for Cancel');
  });
});
