import { useEffect, useRef } from 'react';

/**
 * Hidden iframe that loads a PDF URL and triggers the browser's native
 * print dialog against it. Mounting this component starts the flow;
 * the parent unmounts it once `onClose` fires (after the print dialog
 * is dismissed or after a fallback timeout for browsers that don't
 * dispatch `focus` on close).
 *
 * Why iframe + native PDF viewer instead of a print stylesheet:
 *   - The server already produces a 1:1, page-tiled, registration-marked
 *     PDF (`/api/projects/{id}/design_versions/{vid}/print.pdf`). Printing
 *     that PDF through the browser is byte-identical to "Download PDF +
 *     print from Preview/Acrobat", which is the fidelity contract we
 *     promise.
 *   - Recreating the same layout via DOM + `@media print` would re-do the
 *     paper-tiling math the server already does, and would diverge over
 *     time. The CSS-print rules in App.css are only a safety net in case
 *     a future code path prints the editor DOM directly.
 *
 * Per-browser quirks (observed during smoke):
 *   - Chrome (Chromium, Edge): `iframe.contentWindow.print()` works
 *     immediately after the iframe `onload` fires.
 *   - Safari: `print()` called inside the `onload` handler is sometimes
 *     ignored — needs a `setTimeout(..., 0)` to break out of the load
 *     event loop. We always defer, so this is unconditional.
 *   - Firefox: works like Chrome, but the PDF-viewer iframe steals focus
 *     from the surrounding page. We set `pointer-events: none` on the
 *     iframe to avoid intercepting clicks while the dialog is open.
 *
 * Cleanup: the parent re-renders without the iframe once `onClose` is
 * called. We listen for a `focus` event on the parent window — modern
 * browsers fire it when the print dialog is dismissed. If no focus event
 * arrives within 60s (e.g. user wandered to another tab), we give up
 * and unmount anyway so a stale iframe doesn't accumulate.
 */
export default function PrintHost({
  src,
  onClose,
}: {
  src: string;
  onClose: () => void;
}) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // Guard so we only call onClose once — Safari sometimes fires both
  // `focus` and the fallback timeout in quick succession.
  const closedRef = useRef(false);

  useEffect(() => {
    function handleFocus() {
      // Print dialog dismissed → window regains focus. Defer slightly so
      // the dialog has fully closed before we tear the iframe down (some
      // browsers fire focus mid-dismissal, and removing the iframe
      // before the dialog finishes can cancel the spool).
      window.setTimeout(() => {
        if (closedRef.current) return;
        closedRef.current = true;
        onClose();
      }, 250);
    }
    window.addEventListener('focus', handleFocus);
    // Fallback: if focus never returns (user closed the source tab,
    // browser quirk, etc.) tear down after a minute.
    const timeout = window.setTimeout(() => {
      if (closedRef.current) return;
      closedRef.current = true;
      onClose();
    }, 60_000);
    return () => {
      window.removeEventListener('focus', handleFocus);
      window.clearTimeout(timeout);
    };
  }, [onClose]);

  function handleLoad() {
    const iframe = iframeRef.current;
    if (!iframe) return;
    // Defer one tick — Safari needs this; Chrome/Firefox tolerate it.
    window.setTimeout(() => {
      try {
        iframe.contentWindow?.focus();
        iframe.contentWindow?.print();
      } catch {
        // Cross-origin or print-blocked: nothing we can do from JS.
        // Fall through to onClose so the iframe is removed and the user
        // can retry / use Download PDF instead.
        if (!closedRef.current) {
          closedRef.current = true;
          onClose();
        }
      }
    }, 0);
  }

  return (
    <iframe
      ref={iframeRef}
      src={src}
      onLoad={handleLoad}
      title="Print"
      aria-hidden="true"
      className="print-host-frame"
    />
  );
}
