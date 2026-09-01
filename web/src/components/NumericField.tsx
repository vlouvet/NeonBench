import type { ComponentPropsWithRef } from 'react';

// Tier 3 #105 — the one sanctioned way to render a numeric input.
//
// WHY THIS EXISTS
//
// `<input type="number">` treats `min` as the BASE OF A LATTICE whenever
// `step` is a number rather than the string `"any"`. The set of values the
// browser considers valid is exactly
//
//     min + k * step        for integer k >= 0
//
// and nothing else. A value off that lattice sets `validity.stepMismatch`,
// which makes the input fail HTML constraint validation. Inside a `<form>`
// that **silently swallows the submit**: the submit handler never runs, no
// exception is thrown, nothing is logged to the console, and the app state
// does not change. The browser anchors a transient native bubble to the
// offending field — which the operator never sees if that field is scrolled
// out of view, which is exactly how this shipped the second time.
//
// This has shipped to `main` THREE times now:
//
//   * PR #146 — arc radius, `min=1 step=10`, default `500`.
//   * PR #158 — flatten tolerance, `min=0.01 step=0.05`, default `0.25`.
//   * Found by the row 105 audit — the Vectorize panel's Auto-rotate button
//     computes `Math.round(-deg * 10) / 10`, i.e. a value with 0.1
//     resolution, and writes it into a field declared `step={0.5}`. Every
//     odd tenth it produces (`-3.7`, `2.3`, `-0.1`) is off the lattice, so
//     pressing Auto-rotate could leave the Vectorize form permanently
//     un-submittable.
//
// It was written into CLAUDE.md as prose before the second one shipped.
// Prose did not work, so the rule now lives in the type system and in
// `no-restricted-syntax` (see `web/eslint.config.js`), which bans the raw
// element and points here.
//
// THE RULE THIS COMPONENT ENCODES
//
// A numeric step is only ever safe when the quantity is a genuine count of
// discrete things. Every physical measurement in this app is a millimetre or
// a degree, and this is a neon shop: the trade runs on imperial sizes that
// are converted to mm, so the values operators actually type are 12.7 (½"),
// 9.525 (⅜"), 6.35 (¼"), 3.175 (⅛"), 25.4 (1"), 76.2 (3"). Those land off
// essentially every lattice anyone has picked here. Money is the same story.
// So the default is `step="any"`, and there is no way to ask for an
// arbitrary numeric step at all — `step` is omitted from the prop type.
//
// The one legitimate lattice is the integer counter, and a caller asks for
// it by name:
//
//     <NumericField integer min={1} max={99} value={copies} … />
//
// `integer` renders `step={1}`. It is a deliberate, greppable, reviewable
// declaration that the quantity really is discrete (copies of a page, source
// pixels, a line-item quantity) rather than a measurement that happens to
// look round today.

export type NumericFieldProps = Omit<ComponentPropsWithRef<'input'>, 'type' | 'step'> & {
  /**
   * Opt in to the integer lattice (`step={1}`).
   *
   * Only for genuine counts of discrete things — page copies, source
   * pixels, line-item quantities. NOT for millimetres, degrees, ratios or
   * money, however round the current default happens to look: `min` becomes
   * a lattice base and any off-lattice value silently kills the form submit.
   * Leave it off and the field accepts any value (`step="any"`).
   */
  integer?: boolean;
};

export function NumericField({ integer = false, ...rest }: NumericFieldProps) {
  // `type` and `step` are applied AFTER the spread on purpose. The prop type
  // already forbids passing them, but a `{...props}` spread from a loosely
  // typed record could still smuggle one through at runtime, and the whole
  // point of this component is that the invariant cannot be bypassed.
  return <input {...rest} type="number" step={integer ? 1 : 'any'} />;
}
