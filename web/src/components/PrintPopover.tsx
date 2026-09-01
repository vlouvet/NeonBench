import { useEffect, useRef } from 'react';
import { PAPER_OPTIONS } from '../api';
import {
  MAX_PRINT_COPIES,
  ROTATE_OPTIONS,
  type PrintPopoverValues,
  type PrintRotate,
} from '../lib/printPrefs';
import { NumericField } from './NumericField';

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
//
// The value shape (`PrintPopoverValues`), its option lists and the
// localStorage persistence behind Quick plot all live in
// `lib/printPrefs` — a component module can only export components
// without breaking Fast Refresh, and the settings need to be testable
// without mounting React anyway.
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
      <label
        className="print-popover-checkbox"
        title="Default is mirrored — the bender works against the BACK of the glass tube. Check this to print a front-facing pattern instead, useful for marketing renders and design review (Tier 2 #73)."
      >
        <input
          type="checkbox"
          checked={values.frontFacing}
          onChange={(e) =>
            onChange({ ...values, frontFacing: e.target.checked })
          }
        />
        Print front-facing (un-mirrored)
      </label>
      <label
        className="print-popover-field"
        title="Rotate the pattern 90° on the paper. “Rotate to fit” only rotates when doing so needs fewer sheets, and keeps the un-rotated orientation on a tie, so the same design prints the same way round every time. Rotated sheets say so in the page footer (Tier 2 #93)."
      >
        Rotate
        <select
          value={values.rotate}
          onChange={(e) =>
            onChange({ ...values, rotate: e.target.value as PrintRotate })
          }
        >
          {ROTATE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label
        className="print-popover-field"
        title="Print N copies of the whole page set in one job — step-and-repeat for a shop bending several identical letters. Copies multiply PAGES, not geometry: the pattern stays 1:1 and every sheet is footer-stamped “copy k of N” (Tier 2 #93)."
      >
        Copies
        <NumericField
          integer
          min={1}
          max={MAX_PRINT_COPIES}
          value={values.copies}
          onChange={(e) => {
            // Clamp here as well as on the server. A bare number input
            // will happily hand us '' or 999, and the resulting 400
            // would land in a hidden print iframe where the operator
            // never sees the message — so the UI never builds one.
            const n = Math.round(Number(e.target.value));
            const safe = Number.isFinite(n)
              ? Math.min(MAX_PRINT_COPIES, Math.max(1, n))
              : 1;
            onChange({ ...values, copies: safe });
          }}
        />
      </label>
    </div>
  );
}
