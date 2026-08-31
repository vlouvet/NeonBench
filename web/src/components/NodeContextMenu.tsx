import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { NodeMenuActionId, NodeMenuItem } from '../lib/nodeMenuItems';

// Tier 3 #76 — the floating menu that opens on right-click of a node-edit
// vertex. Purely presentational: it renders the items it is handed and
// reports which one was chosen. Every gate about WHICH items exist lives
// in availableActionsForVertex, so this component never has to know what
// a doubleback is.
export default function NodeContextMenu({
  x,
  y,
  items,
  onPick,
  onClose,
}: {
  // Viewport coordinates of the click (clientX / clientY).
  x: number;
  y: number;
  items: NodeMenuItem[];
  // `shiftKey` rides along because Insert doubleback picks its side from
  // the modifier, exactly as the toolbar tool does.
  onPick: (id: NodeMenuActionId, shiftKey: boolean) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  const [active, setActive] = useState(0);

  // Flip before paint, not after: measuring in useEffect would let the
  // operator see the menu hanging off the edge for a frame first.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const margin = 8;
    // Prefer down-right. Flip to the other side of the cursor when that
    // would overflow, and only then clamp — flipping keeps the cursor
    // outside the menu, where clamping alone can drop it underneath.
    let left = x;
    let top = y;
    if (left + width + margin > window.innerWidth) left = x - width;
    if (top + height + margin > window.innerHeight) top = y - height;
    left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
    top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
    setPos({ left, top });
  }, [x, y, items]);

  // Esc closes, arrows move, Enter activates. Bound on the document rather
  // than the menu so it works before the operator has moved focus into it,
  // and captured so the editor's own global shortcuts don't act on a
  // keystroke the menu has already consumed.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (items.length === 0) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setActive((i) => {
          const step = e.key === 'ArrowDown' ? 1 : -1;
          return (i + step + items.length) % items.length;
        });
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        const item = items[active];
        if (item) onPick(item.id, e.shiftKey);
        return;
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [items, active, onPick, onClose]);

  // Click-outside. Listens on pointerdown so the menu is gone before the
  // canvas beneath it starts a drag, and skips clicks that land inside.
  //
  // Attached synchronously rather than on a setTimeout: deferring even one
  // tick leaves a window where a click outside does nothing, and a browser
  // driver clicking that fast caught it. The timestamp guard covers what
  // the defer was there for — on macOS `contextmenu` fires during
  // pointerdown, so this must not treat the opening gesture as an outside
  // click. Any event predating the menu is ignored.
  useEffect(() => {
    const openedAt = performance.now();
    function onDown(e: PointerEvent) {
      if (e.timeStamp <= openedAt) return;
      if (ref.current?.contains(e.target as Node)) return;
      onClose();
    }
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [onClose]);

  useEffect(() => {
    // Close if the window moves under the menu; a menu anchored to a stale
    // viewport coordinate points at the wrong vertex.
    window.addEventListener('resize', onClose);
    window.addEventListener('scroll', onClose, true);
    return () => {
      window.removeEventListener('resize', onClose);
      window.removeEventListener('scroll', onClose, true);
    };
  }, [onClose]);

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="node-context-menu"
      style={{ left: pos.left, top: pos.top }}
      role="menu"
      aria-label="Node actions"
      onContextMenu={(e) => e.preventDefault()}
    >
      {items.map((item, i) => {
        // Rule between groups. Derived from the previous item rather than
        // a running variable so the map stays a pure function of `items`.
        const rule = i > 0 && item.group !== items[i - 1].group;
        return (
          <div key={item.id}>
            {rule && <div className="node-context-menu-rule" role="separator" />}
            <button
              type="button"
              role="menuitem"
              className={`node-context-menu-item${i === active ? ' is-active' : ''}${
                item.group === 'destructive' ? ' is-destructive' : ''
              }`}
              onPointerEnter={() => setActive(i)}
              onClick={(e) => onPick(item.id, e.shiftKey)}
            >
              <span className="node-context-menu-label">{item.label}</span>
              {item.hint && <span className="node-context-menu-hint">{item.hint}</span>}
            </button>
          </div>
        );
      })}
    </div>
  );
}
