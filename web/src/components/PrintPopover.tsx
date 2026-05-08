import { useEffect, useRef } from 'react';
import { PAPER_OPTIONS } from '../api';

// Tier 3 #52 — popover surface for the editor toolbar's Print button.
// Mirrors <PrintPanel>'s control set (paper / landscape) plus the
// Tier 3 #50 strips-only toggle (the backend half shipped in PR #51
// but the editor had no UI to drive it). Reuses the field shapes
// rather than importing <PrintPanel> directly because <PrintPanel>
// owns its own form state + download buttons; this popover is a
// stateless render-only surface — the parent (EditorPage) owns the
// values and calls back into setters when fields change.
//
// Positioning: rendered inline under the toolbar's Print group with
// `position: absolute`. The parent wraps the button group in a
// `position: relative` container so the popover anchors to it. We
// install a window-level mousedown listener for click-outside and a
// keydown listener for Escape, both of which fire `onClose` so the
// parent can unmount us. `stopPropagation` on the popover's own
// mousedown avoids self-dismissal when the user clicks inside to
// pick a paper size.
export type PrintPopoverValues = {
  paper: string;
  landscape: boolean;
  stripsOnly: boolean;
};

export default function PrintPopover({
  values,
  onChange,
  onClose,
  anchorRef,
}: {
  values: PrintPopoverValues;
  onChange: (next: PrintPopoverValues) => void;
  onClose: () => void;
  // The toolbar button group ref. The mousedown listener treats
  // clicks inside this element as "no-op" (the parent's own toggle
  // logic already handles open/close on the button itself; we don't
  // want this popover to fight with that).
  anchorRef: React.RefObject<HTMLElement | null>;
}) {
  const popoverRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node;
      if (popoverRef.current?.contains(target)) return;
      if (anchorRef.current?.contains(target)) return;
      onClose();
    }
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onMouseDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onMouseDown);
    };
  }, [onClose, anchorRef]);

  return (
    <div
      ref={popoverRef}
      className="print-popover"
      role="dialog"
      aria-label="Print options"
    >
      <label className="print-popover-field">
        Paper
        <select
          value={values.paper}
          onChange={(e) => onChange({ ...values, paper: e.target.value })}
        >
          {PAPER_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="print-popover-checkbox">
        <input
          type="checkbox"
          checked={values.landscape}
          onChange={(e) => onChange({ ...values, landscape: e.target.checked })}
        />
        Landscape
      </label>
      <label
        className="print-popover-checkbox"
        title="Skip the main pattern + bend-list pages and print only the channel-letter return strips (Tier 3 #50). Empty when there are no channel-letter faces in the design."
      >
        <input
          type="checkbox"
          checked={values.stripsOnly}
          onChange={(e) =>
            onChange({ ...values, stripsOnly: e.target.checked })
          }
        />
        Strips only
      </label>
    </div>
  );
}
