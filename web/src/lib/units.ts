/**
 * units — display-unit formatting for lengths (Tier 1 #130).
 *
 * NeonBench is millimetre-native and stays that way. Every value stored in a
 * design doc, sent over the API, handed to the validator, or printed onto a
 * bending pattern is millimetres, full stop. This module is a **display
 * layer** and nothing else: it turns a mm number into the string an operator
 * reads, and turns what an operator types back into mm. No caller should ever
 * store what `formatLengthMM` returns, and `parseLengthToMM` is the only way
 * a typed inch value re-enters the system.
 *
 * That split is the whole design. Inch display rounds — `48 1/2″` is
 * 1231.9 mm, not the 1231.8683 mm it came from — so a formatted value that
 * round-trips back into geometry walks the design a sixteenth of an inch at a
 * time. Format out, parse in, and never let the two meet.
 *
 * WHAT CONVERTS AND WHAT DOES NOT. Dimensions convert: bounding boxes, run
 * lengths, ruler ticks, dimension annotations, guide positions, raceway
 * callouts. Glass does not: tube diameter, wall thickness, end gap, minimum
 * bend radius, electrode and housing sizes. That is not a shortcut to save
 * work — it is how the trade talks. A shop says "a 48-inch sign in 13 mm"
 * without blinking, because signs are sold in inches and glass is bought in
 * millimetres. Callers pick the right formatter; this module does not guess.
 *
 * FEET ARE A DELIBERATE NON-GOAL. A ruler at 10 ft zoom labels 120, 240, 360
 * rather than 10', 20', 30'. One unit on one rule is worth more than the
 * convenience — "36" is never mistaken for three of anything, while a mixed
 * ladder makes 3' and 3″ one glance apart.
 */

/** The two display units a project may pick. Mirrors `projects.units`. */
export type DisplayUnits = 'mm' | 'in';

export const MM_PER_INCH = 25.4;

/**
 * Denominator for inch fractions. Sixteenths is the sign trade's norm — it is
 * what a tape measure is marked in, so it is what a bender can actually find
 * on the glass. Finer denominators print precision the bench cannot hold.
 */
export const INCH_DENOMINATOR = 16;

/** Unit suffixes, matching the notation `todo.md` and `docs/neon-rules` use. */
export const UNIT_SUFFIX: Record<DisplayUnits, string> = { mm: 'mm', in: '″' };

/**
 * Coerce anything (an API string, a stale localStorage value, undefined) to a
 * `DisplayUnits`. Millimetres win every tie: mm is what the doc holds, so an
 * unreadable preference degrades to showing the operator the stored number
 * rather than a converted guess.
 */
export function normalizeUnits(u: string | null | undefined): DisplayUnits {
  return u === 'in' ? 'in' : 'mm';
}

export function mmToInches(mm: number): number {
  return mm / MM_PER_INCH;
}

export function inchesToMM(inch: number): number {
  return inch * MM_PER_INCH;
}

// ---------------------------------------------------------------------------
// Fractions
// ---------------------------------------------------------------------------

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

/**
 * Render inches the way a tape measure reads: a whole part, then a reduced
 * fraction of `denominator`.
 *
 *   8       -> "8"
 *   7.875   -> "7 7/16"  ... no: 7.875 * 16 = 126 -> 126/16 -> 7 14/16 -> "7 7/8"
 *   0.5     -> "1/2"
 *   0.03    -> "0"        (rounds away — below a 32nd there is nothing to say)
 *   -7.875  -> "-7 7/8"
 *
 * The sign is carried on the whole part and applied once at the end, so
 * "-0 1/2" can never happen: a negative value smaller than one inch prints
 * "-1/2".
 *
 * Rounding to the denominator happens FIRST, which is what makes the carry
 * work: 7.9999 in sixteenths is 128/16, which must print "8" rather than
 * "7 16/16".
 */
export function formatInchesFraction(
  inches: number,
  denominator: number = INCH_DENOMINATOR,
): string {
  if (!Number.isFinite(inches)) return '—';
  const neg = inches < 0;
  const total = Math.round(Math.abs(inches) * denominator);
  const whole = Math.floor(total / denominator);
  let num = total - whole * denominator;
  let den = denominator;
  const sign = neg && total !== 0 ? '-' : '';
  if (num === 0) return `${sign}${whole}`;
  const g = gcd(num, den);
  num /= g;
  den /= g;
  return whole === 0 ? `${sign}${num}/${den}` : `${sign}${whole} ${num}/${den}`;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export type FormatLengthOpts = {
  /** Append the unit suffix ("mm" / "″"). Default true. */
  suffix?: boolean;
  /** Decimal places for millimetre output. Default 1. */
  mmDecimals?: number;
  /** Fraction denominator for inch output. Default INCH_DENOMINATOR. */
  denominator?: number;
};

/**
 * The general readout formatter: a millimetre value in, the operator's string
 * out. This is what a sidebar, a canvas label or a status line should call.
 *
 * Non-finite input prints an em dash rather than "NaN mm". A readout is read
 * at a glance during layout, and "NaN" reads as a number-shaped thing that is
 * merely very odd; "—" reads as "no answer", which is the truth.
 */
export function formatLengthMM(
  mm: number,
  units: DisplayUnits,
  opts: FormatLengthOpts = {},
): string {
  const { suffix = true, mmDecimals = 1, denominator = INCH_DENOMINATOR } = opts;
  if (!Number.isFinite(mm)) return '—';
  if (units === 'in') {
    const s = formatInchesFraction(mmToInches(mm), denominator);
    return suffix ? `${s}${UNIT_SUFFIX.in}` : s;
  }
  const s = mm.toFixed(mmDecimals);
  const norm = Number(s) === 0 ? (0).toFixed(mmDecimals) : s; // kill "-0.0"
  return suffix ? `${norm} ${UNIT_SUFFIX.mm}` : norm;
}

/**
 * A width × height pair, formatted once with a single trailing suffix rather
 * than twice — "203.2 × 101.6 mm", not "203.2 mm × 101.6 mm". Two suffixes on
 * one dimension line is noise the operator has to read past every time.
 */
export function formatSizeMM(
  wMM: number,
  hMM: number,
  units: DisplayUnits,
  opts: FormatLengthOpts = {},
): string {
  const w = formatLengthMM(wMM, units, { ...opts, suffix: false });
  const h = formatLengthMM(hMM, units, { ...opts, suffix: false });
  if (opts.suffix === false) return `${w} × ${h}`;
  const sfx = UNIT_SUFFIX[units];
  return units === 'in' ? `${w} × ${h}${sfx}` : `${w} × ${h} ${sfx}`;
}

/** Millimetres in a foot. Exact, like MM_PER_INCH. */
export const MM_PER_FOOT = 304.8;

/**
 * Bulk footage — "how much glass is this job", not a dimension anyone measures
 * with a rule. It gets its own formatter because it wants a different unit
 * from a dimension at the same magnitude: 1256 mm of tube is `1.26 m` to a
 * metric shop and `4.12 ft` to an imperial one, and neither of them wants to
 * read it as 1256 mm or 49 7/16″.
 *
 * Feet here and nowhere else is the same call `internal/takeoff` already
 * made — it prices glass in `UnitFoot`. A ruler stays in one unit because a
 * mixed rule is misread; a materials figure follows the unit the material is
 * BOUGHT in, because that is the number being checked against an invoice.
 */
export function formatFootageMM(
  mm: number,
  units: DisplayUnits,
  decimals: number = 2,
): string {
  if (!Number.isFinite(mm)) return '—';
  return units === 'in'
    ? `${(mm / MM_PER_FOOT).toFixed(decimals)} ft`
    : `${(mm / 1000).toFixed(decimals)} m`;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Turn what an operator typed into millimetres, or null if it is not a length.
 *
 * In inch mode the accepted forms are everything a sign shop actually writes:
 *
 *   48        48.5       48 1/2      48-1/2      1/2
 *   4'        4' 6"      4'6         48"         4 ft 6 in
 *
 * In mm mode only a plain decimal is accepted — nobody writes 1219 1/2 mm,
 * and accepting it would silently invent a precision the unit does not carry.
 *
 * Returns null rather than throwing or guessing. A field that cannot read its
 * own contents must leave the stored value alone; the caller decides whether
 * that is an error or just an unfinished keystroke.
 *
 * NOTE: this is the ONLY sanctioned route from typed text back to geometry.
 * Re-parsing a string that `formatLengthMM` produced is not a round trip —
 * inch display rounds to the denominator, so the value comes back changed.
 */
export function parseLengthToMM(text: string, units: DisplayUnits): number | null {
  const raw = text.trim();
  if (raw === '') return null;

  if (units === 'mm') {
    const n = Number(raw.replace(/\s*mm$/i, '').trim());
    return Number.isFinite(n) ? n : null;
  }

  // Normalise the unit marks to a canonical foot/inch pair so one grammar
  // handles ' " ″ ′ and the spelled-out ft/in.
  let s = raw
    .replace(/[′’]/g, "'")
    .replace(/[″”]/g, '"')
    .replace(/\bfeet\b|\bfoot\b|\bft\b/gi, "'")
    .replace(/\binches\b|\binch\b|\bin\b/gi, '"');

  let feet = 0;
  const footIdx = s.indexOf("'");
  if (footIdx >= 0) {
    const f = Number(s.slice(0, footIdx).trim());
    if (!Number.isFinite(f)) return null;
    feet = f;
    s = s.slice(footIdx + 1);
  }
  s = s.replace(/"/g, '').trim();

  // Bare feet ("4'") leaves nothing after the mark.
  if (s === '') return inchesToMM(feet * 12);

  // whole + fraction ("48 1/2", "48-1/2"), or either alone.
  const m = s.match(/^(-?\d+(?:\.\d+)?)?(?:[\s-]*(\d+)\s*\/\s*(\d+))?$/);
  if (!m || (m[1] === undefined && m[2] === undefined)) return null;
  const whole = m[1] === undefined ? 0 : Number(m[1]);
  let frac = 0;
  if (m[2] !== undefined) {
    const den = Number(m[3]);
    if (!Number.isFinite(den) || den === 0) return null;
    frac = Number(m[2]) / den;
  }
  if (!Number.isFinite(whole)) return null;
  // A negative whole part owns the fraction: "-48 1/2" is -48.5, not -47.5.
  const inches = whole < 0 ? whole - frac : whole + frac;
  return inchesToMM(feet * 12 + inches);
}
