import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindingFromEvent,
  defaultKeymap,
  findConflict,
  formatBinding,
  HOTKEYS,
  isReservedBinding,
  isTypingTarget,
  loadKeymap,
  matchHotkey,
  rebind,
  saveKeymap,
  swapBindings,
  toolForHotkey,
  type HotkeyContext,
} from './hotkeys';

const key = (k: string, mods: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}) => ({
  key: k,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

const idle: HotkeyContext = { typing: false, textCaret: false, overlayOpen: false };

function makeStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'window', {
    value: { localStorage: makeStorage() },
    configurable: true,
    writable: true,
  });
});
afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('bindingFromEvent', () => {
  it('treats Cmd and Ctrl as the same modifier', () => {
    expect(bindingFromEvent(key('z', { metaKey: true }))).toBe('mod+z');
    expect(bindingFromEvent(key('z', { ctrlKey: true }))).toBe('mod+z');
  });

  it('is case-insensitive, and Shift is part of a letter', () => {
    expect(bindingFromEvent(key('o'))).toBe('o');
    expect(bindingFromEvent(key('O', { shiftKey: true }))).toBe('shift+o');
  });

  it('treats Shift as already implied by a symbol', () => {
    expect(bindingFromEvent(key('?', { shiftKey: true }))).toBe('?');
    expect(bindingFromEvent(key(']'))).toBe(']');
  });

  it('keeps Shift on a digit, which is not a symbol', () => {
    expect(bindingFromEvent(key('1', { shiftKey: true }))).toBe('shift+1');
  });

  it('orders modifiers canonically', () => {
    expect(bindingFromEvent(key('Z', { shiftKey: true, metaKey: true, altKey: true }))).toBe('mod+alt+shift+z');
  });

  it('returns null for a bare modifier', () => {
    for (const k of ['Shift', 'Control', 'Alt', 'Meta']) expect(bindingFromEvent(key(k))).toBeNull();
  });
});

describe('every binding that shipped before the registry', () => {
  // Spec deliverable 2: the migration must not change an existing shortcut.
  // Table-driven so a dropped or altered default fails by name.
  it.each([
    ['z', { metaKey: true }, 'edit.undo'],
    ['z', { ctrlKey: true }, 'edit.undo'],
    ['Z', { metaKey: true, shiftKey: true }, 'edit.redo'],
    ['Z', { ctrlKey: true, shiftKey: true }, 'edit.redo'],
    ['y', { metaKey: true }, 'edit.redo'],
    ['y', { ctrlKey: true }, 'edit.redo'],
    ['a', { metaKey: true }, 'edit.selectAll'],
    ['a', { ctrlKey: true }, 'edit.selectAll'],
    ['Delete', {}, 'edit.delete'],
    ['Backspace', {}, 'edit.delete'],
    ['Escape', {}, 'edit.cancel'],
    ['o', {}, 'tool.break-open'],
    ['c', {}, 'tool.connect'],
    ['j', {}, 'issue.next'],
    [']', {}, 'issue.next'],
    ['k', {}, 'issue.prev'],
    ['[', {}, 'issue.prev'],
  ] as const)('%s %o still means %s', (k, mods, id) => {
    expect(matchHotkey(key(k, mods), defaultKeymap(), idle)).toBe(id);
  });

  it('kept the old guards on O and C', () => {
    expect(matchHotkey(key('O', { shiftKey: true }), defaultKeymap(), idle)).toBeNull();
    expect(matchHotkey(key('o', { altKey: true }), defaultKeymap(), idle)).toBeNull();
    expect(matchHotkey(key('c', { metaKey: true }), defaultKeymap(), idle)).toBeNull();
  });
});

describe('the registry itself', () => {
  it('has unique ids and no default bound twice', () => {
    const ids = HOTKEYS.map((h) => h.id);
    expect(new Set(ids).size).toBe(ids.length);
    const bindings = HOTKEYS.flatMap((h) => h.defaults);
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it('binds nothing the browser reserves', () => {
    expect(HOTKEYS.flatMap((h) => h.defaults).filter(isReservedBinding)).toEqual([]);
  });

  it('only lets modified keys through a text caret', () => {
    // A bare letter here is typed into the sign, so it must never be a command.
    const leaky = HOTKEYS.filter((h) => h.whileCaret).flatMap((h) => h.defaults).filter((b) => !b.startsWith('mod+'));
    expect(leaky).toEqual([]);
  });
});

describe('matchHotkey context', () => {
  const map = defaultKeymap();

  it('never fires while typing in a field', () => {
    expect(matchHotkey(key('o'), map, { ...idle, typing: true })).toBeNull();
    expect(matchHotkey(key('z', { metaKey: true }), map, { ...idle, typing: true })).toBeNull();
  });

  it('never fires under an open dialog or menu', () => {
    expect(matchHotkey(key('v'), map, { ...idle, overlayOpen: true })).toBeNull();
  });

  it('lets undo through a text caret but not tool keys, delete or select-all', () => {
    const caret = { ...idle, textCaret: true };
    expect(matchHotkey(key('z', { metaKey: true }), map, caret)).toBe('edit.undo');
    expect(matchHotkey(key('o'), map, caret)).toBeNull();
    expect(matchHotkey(key('Backspace'), map, caret)).toBeNull();
    expect(matchHotkey(key('a', { metaKey: true }), map, caret)).toBeNull();
  });

  it('honours a remap and drops the old key', () => {
    const next = rebind(map, 'tool.pen', 'shift+p');
    expect(matchHotkey(key('P', { shiftKey: true }), next, idle)).toBe('tool.pen');
    expect(matchHotkey(key('p'), next, idle)).toBeNull();
  });
});

describe('isTypingTarget', () => {
  it.each([
    ['INPUT', true],
    ['TEXTAREA', true],
    ['SELECT', true],
    ['BUTTON', false],
    ['DIV', false],
  ])('%s -> %s', (tagName, expected) => {
    expect(isTypingTarget({ tagName, isContentEditable: false } as unknown as EventTarget)).toBe(expected);
  });

  it('counts contenteditable, and survives a non-element target', () => {
    expect(isTypingTarget({ tagName: 'DIV', isContentEditable: true } as unknown as EventTarget)).toBe(true);
    expect(isTypingTarget(null)).toBe(false);
    expect(isTypingTarget({} as EventTarget)).toBe(false);
  });
});

describe('conflicts', () => {
  it('finds an exact duplicate', () => {
    expect(findConflict(defaultKeymap(), 'v')?.id).toBe('tool.select');
  });

  it('finds a modifier-equivalent one, because both spell the same binding', () => {
    const fromMac = bindingFromEvent(key('z', { metaKey: true }))!;
    const fromPc = bindingFromEvent(key('z', { ctrlKey: true }))!;
    expect(findConflict(defaultKeymap(), fromMac)?.id).toBe('edit.undo');
    expect(findConflict(defaultKeymap(), fromPc)?.id).toBe('edit.undo');
  });

  it('does not report a hotkey as conflicting with itself', () => {
    expect(findConflict(defaultKeymap(), 'v', 'tool.select')).toBeNull();
  });

  it('swaps two keys without losing either', () => {
    const next = swapBindings(defaultKeymap(), 'tool.pen', 'tool.select', 'v');
    expect(next['tool.pen']).toEqual(['v']);
    expect(next['tool.select']).toEqual(['p']);
    expect(findConflict(next, 'v', 'tool.pen')).toBeNull();
  });

  it('keeps the other key of a two-key hotkey when one is taken', () => {
    const next = swapBindings(defaultKeymap(), 'tool.pen', 'issue.next', 'j');
    expect(next['issue.next']).toEqual(['p', ']']);
  });
});

describe('persistence', () => {
  it('round-trips a remap', () => {
    saveKeymap(rebind(defaultKeymap(), 'tool.pen', 'shift+p'));
    expect(loadKeymap()['tool.pen']).toEqual(['shift+p']);
  });

  it('stores only overrides, so a future default still arrives', () => {
    saveKeymap(rebind(defaultKeymap(), 'tool.pen', 'shift+p'));
    const raw = window.localStorage.getItem('nb.hotkeys.v1')!;
    expect(Object.keys(JSON.parse(raw))).toEqual(['tool.pen']);
  });

  it('clears storage when reset to defaults', () => {
    saveKeymap(rebind(defaultKeymap(), 'tool.pen', 'shift+p'));
    saveKeymap(defaultKeymap());
    expect(window.localStorage.getItem('nb.hotkeys.v1')).toBeNull();
  });

  it.each([
    ['not JSON', '{oops'],
    ['an array', '[1,2]'],
    ['a string', '"x"'],
    ['null', 'null'],
    ['an unknown id', '{"tool.nope":["q"]}'],
    ['a non-array value', '{"tool.pen":"q"}'],
    ['a fixed key', '{"edit.cancel":["q"]}'],
    ['a binding that collides', '{"tool.pen":["v"]}'],
  ])('falls back to defaults when storage holds %s', (_name, raw) => {
    window.localStorage.setItem('nb.hotkeys.v1', raw);
    expect(loadKeymap()).toEqual(defaultKeymap());
  });
});

describe('toolForHotkey', () => {
  it('names the tool, and nothing for a command', () => {
    expect(toolForHotkey('tool.break-open')).toBe('break-open');
    expect(toolForHotkey('edit.undo')).toBeNull();
  });
});

describe('formatBinding', () => {
  it('uses symbols on a Mac and words elsewhere', () => {
    expect(formatBinding('mod+shift+z', true)).toBe('⌘⇧Z');
    expect(formatBinding('mod+shift+z', false)).toBe('Ctrl+Shift+Z');
  });

  it('names special keys', () => {
    expect(formatBinding('escape', false)).toBe('Esc');
    expect(formatBinding('v', false)).toBe('V');
    expect(formatBinding('?', false)).toBe('?');
  });
});
