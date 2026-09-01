/**
 * printPrefs — per-project persistence for the print popover's settings,
 * and the URL/label derivations that "Quick plot" is built from
 * (Tier 2 #93).
 *
 * Scope is **per project**, unlike scenePrefs' global scope: paper size,
 * rotation and copy count are properties of the job on the bench, not of
 * the operator's taste. A shop printing a 3 m storefront run on A2 does
 * not want that carried into the next 300 mm window sign.
 *
 * Storage key: `nb.printOpts.v1.<projectId>`. The `.v1` segment lets a
 * future shape change orphan old state without migration code.
 *
 * Validation: `loadPrintPrefs` never throws and never returns a partial
 * object. Every field is sanitized independently against the defaults,
 * so a payload written by an older build (missing `rotate`/`copies`) is
 * upgraded in place rather than discarded, while a hand-mangled one
 * degrades to defaults field by field. Broken print settings are not
 * worth an error toast — the operator fixes them by opening the popover.
 *
 * SSR / private-mode safe: every entry point guards `typeof window` and
 * wraps the localStorage call in try/catch. Safari in private browsing
 * throws on `setItem`, and a print button that explodes because the
 * browser declined to remember a paper size would be a poor trade.
 */
import { PAPER_OPTIONS } from '../api';

/**
 * The print popover's value shape. <PrintPopover> is a stateless render
 * surface — EditorPage owns these values — so the type and its option
 * lists live here rather than in the component, both because a
 * component module can only export components without breaking Fast
 * Refresh and because the settings logic is worth testing without
 * mounting React.
 */
export type PrintPopoverValues = {
  paper: string;
  landscape: boolean;
  stripsOnly: boolean;
  // Tier 2 #73 — when true, the URL builder adds ?mirror=0 and the
  // server skips the horizontal flip, emitting a front-facing
  // pattern. The trade default is MIRRORED (operators bend against
  // the BACK of the glass tube while reading the pattern), so this
  // is an OPT-OUT: leaving it false yields the mirrored print.
  // Named `frontFacing` (the affirmative form of the opt-out) so the
  // value matches the checkbox's semantics.
  frontFacing: boolean;
  // Tier 2 #93 — 90° rotation of the pattern at plot time.
  //   ''    no rotation (default; the URL builder emits no param)
  //   '90'  always rotate
  //   'fit' rotate only when it needs fewer sheets; a tie keeps the
  //         un-rotated orientation so the same design comes off the
  //         bench the same way round every time.
  rotate: PrintRotate;
  // Tier 2 #93 step-and-repeat — how many copies of the whole page set
  // to put in one PDF. 1..MAX_PRINT_COPIES; copies multiply pages,
  // never geometry.
  copies: number;
};

/** Accepted `rotate` values. Mirrors printpdf's Rotate* constants. */
export type PrintRotate = '' | '90' | 'fit';

/** Dropdown entries for the rotate control, in menu order. */
export const ROTATE_OPTIONS: { value: PrintRotate; label: string }[] = [
  { value: '', label: 'No rotation' },
  { value: 'fit', label: 'Rotate to fit (fewer sheets)' },
  { value: '90', label: 'Always rotate 90°' },
];

/** Server-side clamp (printpdf.MaxCopies). Mirrored for the input's max. */
export const MAX_PRINT_COPIES = 50;

/** Key prefix. Bump the version segment to orphan an older shape. */
export const PRINT_PREFS_KEY_PREFIX = 'nb.printOpts.v1.';

/** Storage key for one project's last-used print settings. */
export function printPrefsKey(projectId: number): string {
  return `${PRINT_PREFS_KEY_PREFIX}${projectId}`;
}

/**
 * Defaults. Deliberately identical to what <PrintPanel> on the project
 * page sends, so a first-ever Quick plot and a first-ever Download PDF
 * produce the same document.
 */
export const DEFAULT_PRINT_PREFS: PrintPopoverValues = {
  paper: 'letter',
  landscape: false,
  stripsOnly: false,
  // Trade default is MIRRORED, and `frontFacing` is the opt-out, so
  // false here means "leave the mirror on" (Tier 2 #73).
  frontFacing: false,
  rotate: '',
  copies: 1,
};

const VALID_PAPERS = new Set<string>(PAPER_OPTIONS.map((o) => o.value));
const VALID_ROTATES = new Set<string>(ROTATE_OPTIONS.map((o) => o.value));

function asBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Sanitize an arbitrary parsed value into a complete settings object.
 * Exported for the tests, and because it is the honest description of
 * what "corrupt values fall back to defaults" actually means here.
 */
export function sanitizePrintPrefs(raw: unknown): PrintPopoverValues {
  if (!raw || typeof raw !== 'object') return { ...DEFAULT_PRINT_PREFS };
  const o = raw as Record<string, unknown>;
  const paper =
    typeof o.paper === 'string' && VALID_PAPERS.has(o.paper)
      ? o.paper
      : DEFAULT_PRINT_PREFS.paper;
  const rotate =
    typeof o.rotate === 'string' && VALID_ROTATES.has(o.rotate)
      ? (o.rotate as PrintRotate)
      : DEFAULT_PRINT_PREFS.rotate;
  // Copies is clamped rather than rejected: a stored 999 is a bounds
  // problem, not a corruption, and 50 is the answer the server would
  // give anyway.
  let copies = DEFAULT_PRINT_PREFS.copies;
  if (typeof o.copies === 'number' && Number.isFinite(o.copies)) {
    copies = Math.min(MAX_PRINT_COPIES, Math.max(1, Math.round(o.copies)));
  }
  return {
    paper,
    landscape: asBool(o.landscape, DEFAULT_PRINT_PREFS.landscape),
    stripsOnly: asBool(o.stripsOnly, DEFAULT_PRINT_PREFS.stripsOnly),
    frontFacing: asBool(o.frontFacing, DEFAULT_PRINT_PREFS.frontFacing),
    rotate,
    copies,
  };
}

/** Read this project's last-used print settings, or the defaults. */
export function loadPrintPrefs(projectId: number): PrintPopoverValues {
  if (typeof window === 'undefined') return { ...DEFAULT_PRINT_PREFS };
  try {
    const raw = window.localStorage.getItem(printPrefsKey(projectId));
    if (!raw) return { ...DEFAULT_PRINT_PREFS };
    return sanitizePrintPrefs(JSON.parse(raw));
  } catch {
    // Malformed JSON, a disabled storage API, or a security error in
    // private browsing. None of them are worth failing a print over.
    return { ...DEFAULT_PRINT_PREFS };
  }
}

/** Remember this project's print settings. Silently no-ops on failure. */
export function savePrintPrefs(
  projectId: number,
  values: PrintPopoverValues,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      printPrefsKey(projectId),
      JSON.stringify(values),
    );
  } catch {
    // Quota exceeded or storage denied — the settings still work for
    // this session, they just won't be there next time.
  }
}

/**
 * Translate popover settings into `api.printPDFURL` options.
 *
 * The two shapes differ deliberately: the popover stores `frontFacing`
 * (the affirmative form of the mirror opt-out checkbox) while the URL
 * builder takes `mirror`, and only an explicit `false` emits a param —
 * `?mirror=1` would duplicate the server's trade default. Same idea for
 * `rotate: ''` and `copies: 1`, which emit nothing at all. That is what
 * makes an untouched settings object produce the bare, byte-identical
 * legacy URL.
 */
export function printPrefsToURLOpts(values: PrintPopoverValues) {
  return {
    paper: values.paper,
    landscape: values.landscape,
    stripsOnly: values.stripsOnly,
    mirror: values.frontFacing ? false : undefined,
    rotate: values.rotate || undefined,
    copies: values.copies,
  };
}

/**
 * One-line human summary of what a print will do. Shown in the Quick
 * plot button's `title` so a one-click print is never a mystery print —
 * the operator can read exactly what is about to come out of the
 * printer without opening the popover.
 */
export function describePrintPrefs(values: PrintPopoverValues): string {
  const paper =
    PAPER_OPTIONS.find((o) => o.value === values.paper)?.label ?? values.paper;
  const parts = [
    paper,
    values.landscape ? 'landscape' : 'portrait',
    values.frontFacing ? 'front-facing (un-mirrored)' : 'mirrored',
  ];
  if (values.stripsOnly) parts.push('strip pages only');
  if (values.rotate === '90') parts.push('rotated 90°');
  else if (values.rotate === 'fit') parts.push('rotated to fit');
  parts.push(values.copies > 1 ? `${values.copies} copies` : '1 copy');
  return parts.join(' · ');
}
