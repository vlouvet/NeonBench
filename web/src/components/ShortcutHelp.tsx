import { useEffect, useState } from 'react';
import {
  bindingFromEvent,
  defaultKeymap,
  findConflict,
  FIXED_KEYS,
  formatBinding,
  HOTKEY_CATEGORIES,
  HOTKEYS,
  isReservedBinding,
  rebind,
  swapBindings,
  type HotkeyDef,
  type Keymap,
} from '../lib/hotkeys';

// Tier 3 #102 — the keyboard reference, and where keys are remapped. It reads
// the live keymap, so it cannot drift from what the keys actually do.

type Props = {
  keymap: Keymap;
  onChange: (next: Keymap) => void;
  onClose: () => void;
};

type Clash = { id: string; binding: string; other: HotkeyDef };

export default function ShortcutHelp({ keymap, onChange, onClose }: Props) {
  // The hotkey waiting for a key press, if any.
  const [capturing, setCapturing] = useState<string | null>(null);
  const [clash, setClash] = useState<Clash | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (capturing) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') {
          setCapturing(null);
          return;
        }
        const binding = bindingFromEvent(e);
        if (!binding) return; // a bare modifier: keep waiting for the key
        const id = capturing;
        setCapturing(null);
        if (isReservedBinding(binding)) {
          setNotice(`${formatBinding(binding)} belongs to the browser, so it can't be used here.`);
          return;
        }
        const other = findConflict(keymap, binding, id);
        if (!other) {
          onChange(rebind(keymap, id, binding));
          setNotice(null);
        } else if (other.fixed) {
          setNotice(`${formatBinding(binding)} is fixed to “${other.label}”.`);
        } else {
          setClash({ id, binding, other });
        }
        return;
      }
      if (e.key === 'Escape' || e.key === '?') {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [capturing, keymap, onChange, onClose]);

  function swap() {
    if (!clash) return;
    onChange(swapBindings(keymap, clash.id, clash.other.id, clash.binding));
    setClash(null);
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal shortcut-help"
        role="dialog"
        aria-label="Keyboard shortcuts"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Keyboard shortcuts</h2>
        <p className="meta" role="status" aria-live="polite">
          {capturing
            ? 'Press the new key. Esc cancels.'
            : (notice ?? 'Click a key to change it.')}
        </p>
        {clash && (
          <div className="draft-offer" role="alert">
            <span>
              {formatBinding(clash.binding)} is already used by “{clash.other.label}”.
            </span>
            <button type="button" className="tool-btn" onClick={swap}>
              Swap keys
            </button>
            <button type="button" className="tool-btn" onClick={() => setClash(null)}>
              Keep as is
            </button>
          </div>
        )}
        <div className="shortcut-columns">
          {HOTKEY_CATEGORIES.map((category) => (
            <section key={category}>
              <h3>{category}</h3>
              <dl>
                {HOTKEYS.filter((h) => h.category === category).map((h) => (
                  <div key={h.id} className="shortcut-row">
                    <dt>{h.label}</dt>
                    <dd>
                      {h.fixed ? (
                        <kbd>{(keymap[h.id] ?? []).map((b) => formatBinding(b)).join(' / ')}</kbd>
                      ) : (
                        <button
                          type="button"
                          className={capturing === h.id ? 'tool-btn active' : 'tool-btn'}
                          aria-label={`Change key for ${h.label}`}
                          onClick={() => {
                            setClash(null);
                            setNotice(null);
                            setCapturing(h.id);
                          }}
                        >
                          {capturing === h.id
                            ? '…'
                            : (keymap[h.id] ?? []).map((b) => formatBinding(b)).join(' / ') || 'none'}
                        </button>
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
          <section>
            <h3>While working</h3>
            <dl>
              {FIXED_KEYS.map((k) => (
                <div key={k.label} className="shortcut-row">
                  <dt>{k.label}</dt>
                  <dd>
                    <kbd>{k.keys}</kbd>
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        </div>
        <div className="row">
          <button
            type="button"
            className="tool-btn"
            onClick={() => {
              setClash(null);
              setNotice(null);
              onChange(defaultKeymap());
            }}
          >
            Reset to defaults
          </button>
          <button type="button" className="tool-btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
