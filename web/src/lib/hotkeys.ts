/**
 * hotkeys — the one place that knows what the editor's keyboard shortcuts are
 * (Tier 3 #102).
 *
 * Before this, bindings lived in separate handlers that each re-implemented
 * the "not while typing" guard, so nothing could list them, remap them or
 * show them in a tooltip. Everything here is pure except the localStorage
 * wrappers, which never throw.
 *
 * NOT in the registry: keys whose meaning depends on the gesture in progress
 * (Enter commits a pen run, Shift snaps an angle, Esc inside a drawing tool).
 * Those stay with EditorCanvas, which holds the state they read, and appear in
 * the reference as FIXED_KEYS.
 *
 * A binding is a canonical string: optional `mod+`, `alt+`, `shift+` in that
 * order, then the lower-cased key. `mod` is Cmd on macOS and Ctrl elsewhere,
 * and either key satisfies it, as the handlers this replaced did. Shift is
 * part of a letter's identity (`shift+r` is not `r`) but is implied by a
 * symbol: `?` already means "shift and /" on the keyboard that typed it.
 */
import type { EditorTool } from '../components/EditorCanvas';

export type HotkeyCategory = 'Edit' | 'Draw' | 'Neon marks' | 'Validation' | 'Help';

export const HOTKEY_CATEGORIES: HotkeyCategory[] = ['Edit', 'Draw', 'Neon marks', 'Validation', 'Help'];

export type HotkeyDef = {
  id: string;
  label: string;
  category: HotkeyCategory;
  defaults: string[];
  /** Still fires with a text caret live. Only Cmd/Ctrl combos should. */
  whileCaret?: boolean;
  /** Listed but not remappable. */
  fixed?: boolean;
};

const tool = (t: EditorTool, label: string, category: HotkeyCategory, key: string): HotkeyDef => ({
  id: `tool.${t}`,
  label,
  category,
  defaults: [key],
});

export const HOTKEYS: HotkeyDef[] = [
  { id: 'edit.undo', label: 'Undo', category: 'Edit', defaults: ['mod+z'], whileCaret: true },
  { id: 'edit.redo', label: 'Redo', category: 'Edit', defaults: ['mod+shift+z', 'mod+y'], whileCaret: true },
  { id: 'edit.selectAll', label: 'Select all runs', category: 'Edit', defaults: ['mod+a'] },
  { id: 'edit.delete', label: 'Delete selected runs', category: 'Edit', defaults: ['delete', 'backspace'] },
  { id: 'edit.cancel', label: 'Cancel, clear selection, then back to Select', category: 'Edit', defaults: ['escape'], fixed: true },
  tool('select', 'Select tool', 'Edit', 'v'),
  tool('node', 'Node edit', 'Edit', 'n'),
  tool('break-open', 'Break/Move Opening', 'Edit', 'o'),

  tool('pen', 'Pen', 'Draw', 'p'),
  tool('rect', 'Rectangle', 'Draw', 'r'),
  tool('circle', 'Circle', 'Draw', 'shift+r'),
  tool('arc', 'Arc', 'Draw', 'a'),
  tool('text', 'Text', 'Draw', 't'),
  tool('label', 'Label', 'Draw', 'l'),
  tool('dimension', 'Dimension', 'Draw', 'm'),

  tool('electrode', 'Place electrode', 'Neon marks', 'e'),
  tool('blockout', 'Mark blockout', 'Neon marks', 'b'),
  tool('jump', 'Mark jump', 'Neon marks', 'u'),
  tool('drop_bend', 'Mark drop', 'Neon marks', 'shift+u'),
  tool('support', 'Mark support', 'Neon marks', 's'),
  tool('doubleback', 'Mark double-back', 'Neon marks', 'd'),
  tool('insert-doubleback', 'Insert double-back', 'Neon marks', 'i'),
  tool('connect', 'Connect tubes', 'Neon marks', 'c'),
  tool('bend', 'Add bend', 'Neon marks', 'g'),

  { id: 'issue.next', label: 'Next validation issue', category: 'Validation', defaults: ['j', ']'] },
  { id: 'issue.prev', label: 'Previous validation issue', category: 'Validation', defaults: ['k', '['] },

  { id: 'help.shortcuts', label: 'Show this list', category: 'Help', defaults: ['?'] },
];

/** Gesture keys EditorCanvas owns. Reference only: see the module comment. */
export const FIXED_KEYS: { keys: string; label: string }[] = [
  { keys: 'Enter', label: 'Commit a pen run' },
  { keys: 'Esc', label: 'Cancel the drawing or connection in progress' },
  { keys: 'Shift', label: 'Snap to angles while drawing; uniform scale while resizing' },
  { keys: 'Alt+← / →', label: 'Kern the pair at the text caret' },
  { keys: 'Right-click', label: 'Open the node menu on a vertex in Node edit' },
];

export type Keymap = Record<string, string[]>;

export function defaultKeymap(): Keymap {
  return Object.fromEntries(HOTKEYS.map((h) => [h.id, [...h.defaults]]));
}

const MODIFIER_KEYS = new Set(['shift', 'control', 'alt', 'meta', 'dead', 'process', 'capslock', 'unidentified']);

type KeyLike = Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>;

/** The canonical binding a key press spells, or null for a bare modifier. */
export function bindingFromEvent(e: KeyLike): string | null {
  if (!e.key) return null;
  const key = e.key === ' ' ? 'space' : e.key.toLowerCase();
  if (MODIFIER_KEYS.has(key)) return null;
  const isSymbol = key.length === 1 && !/[a-z0-9]/.test(key);
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push('mod');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey && !isSymbol) parts.push('shift');
  parts.push(key);
  return parts.join('+');
}

export type HotkeyContext = {
  /** Focus is in a field that wants the keystroke. */
  typing: boolean;
  /** A text caret is live on the canvas. */
  textCaret: boolean;
  /** A dialog or menu is up and owns the keyboard. */
  overlayOpen: boolean;
};

export function matchHotkey(e: KeyLike, keymap: Keymap, ctx: HotkeyContext): string | null {
  if (ctx.typing || ctx.overlayOpen) return null;
  const binding = bindingFromEvent(e);
  if (!binding) return null;
  for (const h of HOTKEYS) {
    if (!keymap[h.id]?.includes(binding)) continue;
    if (ctx.textCaret && !h.whileCaret) return null;
    return h.id;
  }
  return null;
}

/** The tool a hotkey arms, or null for a command. */
export function toolForHotkey(id: string): EditorTool | null {
  return id.startsWith('tool.') ? (id.slice('tool.'.length) as EditorTool) : null;
}

/** True when focus is somewhere keystrokes already mean something. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== 'string') return false;
  return (
    el.tagName === 'INPUT' ||
    el.tagName === 'TEXTAREA' ||
    el.tagName === 'SELECT' ||
    !!el.isContentEditable
  );
}

/** The hotkey already using a binding, ignoring `exceptId`. */
export function findConflict(keymap: Keymap, binding: string, exceptId?: string): HotkeyDef | null {
  return HOTKEYS.find((h) => h.id !== exceptId && keymap[h.id]?.includes(binding)) ?? null;
}

// Browsers keep these for themselves, or quietly lose work if they do fire:
// close tab, reopen tab, new window, reload, address bar, quit.
const RESERVED = new Set([
  'mod+w', 'mod+shift+w', 'mod+t', 'mod+shift+t', 'mod+n', 'mod+shift+n', 'mod+r',
  'mod+shift+r', 'mod+l', 'mod+q', 'mod+h', 'mod+m', 'tab', 'shift+tab', 'f5', 'f11', 'f12',
]);

export function isReservedBinding(binding: string): boolean {
  return RESERVED.has(binding);
}

/** Point `id` at one binding. Callers check conflicts first. */
export function rebind(keymap: Keymap, id: string, binding: string): Keymap {
  return { ...keymap, [id]: [binding] };
}

/** Give `id` the binding `other` holds, and `other` what `id` had. */
export function swapBindings(keymap: Keymap, id: string, otherId: string, binding: string): Keymap {
  const displaced = (keymap[id] ?? []).find((b) => !keymap[otherId]?.includes(b));
  const remaining = (keymap[otherId] ?? []).filter((b) => b !== binding);
  const nextOther = displaced ? [displaced, ...remaining] : remaining;
  return { ...keymap, [id]: [binding], [otherId]: nextOther };
}

const STORAGE_KEY = 'nb.hotkeys.v1';

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Defaults plus any stored overrides. Never throws; a bad value is ignored. */
export function loadKeymap(): Keymap {
  const map = defaultKeymap();
  const store = storage();
  if (!store) return map;
  let stored: unknown;
  try {
    stored = JSON.parse(store.getItem(STORAGE_KEY) ?? 'null');
  } catch {
    return map;
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return map;
  for (const [id, value] of Object.entries(stored)) {
    const def = HOTKEYS.find((h) => h.id === id);
    if (!def || def.fixed || !Array.isArray(value)) continue;
    const bindings = value.filter((b): b is string => typeof b === 'string' && b.length > 0);
    if (bindings.some((b) => findConflict(map, b, id))) continue;
    map[id] = bindings;
  }
  return map;
}

/** Stores only what differs from the defaults, so new defaults still reach
 *  anyone who never touched that key. */
export function saveKeymap(keymap: Keymap): void {
  const store = storage();
  if (!store) return;
  const overrides = Object.fromEntries(
    HOTKEYS.filter((h) => JSON.stringify(keymap[h.id]) !== JSON.stringify(h.defaults)).map((h) => [
      h.id,
      keymap[h.id],
    ]),
  );
  try {
    if (Object.keys(overrides).length === 0) store.removeItem(STORAGE_KEY);
    else store.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // The map still works for this session.
  }
}

export function isMacPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform ?? '');
}

const KEY_NAMES: Record<string, string> = {
  escape: 'Esc',
  delete: 'Delete',
  backspace: 'Backspace',
  space: 'Space',
  enter: 'Enter',
  arrowleft: '←',
  arrowright: '→',
  arrowup: '↑',
  arrowdown: '↓',
};

/** Human text for a binding: `⌘⇧Z` on a Mac, `Ctrl+Shift+Z` elsewhere. */
export function formatBinding(binding: string, mac: boolean = isMacPlatform()): string {
  const parts = binding.split('+');
  // A bare `+` key splits into two empty parts.
  const key = binding.endsWith('+') ? '+' : parts[parts.length - 1];
  const name = KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  const mods = parts.slice(0, -1).filter(Boolean);
  if (mac) {
    const sym: Record<string, string> = { mod: '⌘', alt: '⌥', shift: '⇧' };
    return mods.map((m) => sym[m]).join('') + name;
  }
  const word: Record<string, string> = { mod: 'Ctrl', alt: 'Alt', shift: 'Shift' };
  return [...mods.map((m) => word[m]), name].join('+');
}
