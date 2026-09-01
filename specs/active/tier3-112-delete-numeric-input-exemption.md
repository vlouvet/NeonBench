# Tier 3 #112 — Delete the numeric-input lint exemption

**Filed by:** the #164 round, as leftover cleanup.
**Re-scoped 2026-09-01:** it is not cleanup. It is the one remaining hole in a
rule that exists because the bug it bans has shipped to `main` three times.

## Goal

Make `no-restricted-syntax`'s raw-`<input type="number">` ban apply to the
whole frontend with exactly one exemption — `NumericField.tsx`, the wrapper
itself — and pin that with the test the config already claims exists.

## Premises, verified 2026-09-01

Four things were measured against the tree at `a321173`. Two of them are not
what `todo.md` row 112 currently says, so read these before writing code.

### 1. The pinning test does not exist

`web/eslint.config.js:50` says the list is:

> Kept as a named export so the test suite can assert the list has not
> quietly grown.

A repo-wide grep for `NUMERIC_INPUT_EXEMPT_FILES` returns **two** hits, both
inside `eslint.config.js` itself — the declaration and its own use. No test
imports it. **The guard the comment advertises was never written.** That is
the mechanism behind premise 2.

### 2. The documented count is stale — the list grew unnoticed

The comment says the two files "still hold 8 raw numeric inputs between them
(EditorPage 4, ArrangePanel 4)". Measured today:

| file | documented | actual |
|---|---|---|
| `src/pages/EditorPage.tsx` | 4 | **8** |
| `src/components/ArrangePanel.tsx` | 4 | 4 |

(`grep -c 'type="number"'` reports 9 for EditorPage; one hit is prose inside a
comment at line 2078, not an element.)

Per-commit, the growth happened **inside** the exemption:

```
4  d9a574e  Numeric input hardening: shared component + lint rule (#164)
4  0f17392  Union overlapping outlines (#162)
8  5edb8f1  Raceway as a modelled hardware object (#165)   <-- +4, unchecked
9  a78c93a  Inline text editing on the canvas (#169)       <-- +1 comment, 0 elements
```

### 3. …but the code that slipped through is *safe*. Do not overclaim this.

All four inputs PR #165 added are the raceway geometry fields
(`x_mm`, `length_mm`, `height_mm`, `depth_mm`, EditorPage 2581/2590/2602/2615)
and **every one of them declares `step="any"`** — the correct pattern. The
exemption let them in without a check; it did not let a bug in. The finding is
that *nothing looked*, not that something broke.

### 4. The real lattice traps are the four LEGACY inputs, and they are latent

The four EditorPage inputs that predate the exemption all declare a numeric
step:

| line | field | declaration | off-lattice values operators type |
|---|---|---|---|
| 2158 | `snapMM` | `step="0.5" min="0.1"` | `1`, `2`, `5` — every whole mm |
| 2811 | `tube_diameter_mm` | `step="0.5" min="1"` | 12.7 (½"), 9.525 (⅜") |
| 2855 | `channel_letter_depth_mm` | `step="1" min="10"` | 76.2 (3"), 127 (5") |
| 3264 | `eps` (Douglas–Peucker) | `step="0.1" min="0"` | 0.05, 0.25 |

Line 2158 is the sharpest: `min="0.1"` with `step="0.5"` makes the valid set
`0.1, 0.6, 1.1, 1.6, …`, so a snap grid of **1 mm is off-lattice**.

**These are latent, not live.** There is no `<form>`, no `checkValidity()`, no
`reportValidity()` and no `:invalid` styling anywhere in either file — grep
returns nothing for all four. The submit-swallow failure mode documented in
`NumericField.tsx` therefore cannot fire here today; `onChange` still receives
the typed value. What *does* bite today is spinner/arrow-key stepping, which
snaps to the lattice and cannot reach 12.7. An agent must not report this as
fixing a live data-loss bug. It closes a trap that is one `<form>` wrapper away
from being live, in the two files most likely to get one.

## Deliverables

1. **Migrate all 12 raw inputs to `<NumericField>`.** Pass `integer` **only**
   for `ArrangePanel`'s two count fields (368 `countX`, 380 `countY`) — those
   are genuine discrete counters. Everything else, including all four legacy
   EditorPage fields, drops its numeric step and inherits `step="any"`.

2. **Delete both page entries from `NUMERIC_INPUT_EXEMPT_FILES`** so the list
   is exactly `['src/components/NumericField.tsx']`, and rewrite the comment
   block above it — most of it documents a follow-up that this PR completes and
   a count that is already wrong.

3. **Write the missing test.** Import `NUMERIC_INPUT_EXEMPT_FILES` and assert
   it equals `['src/components/NumericField.tsx']`, with a failure message that
   says *why* adding an entry is not the fix. This is the durable deliverable —
   deliverables 1 and 2 clean up the past, this one is what stops the next one.

4. **Add a repo-wide count guard** in the same test: scan `web/src/**/*.tsx`
   and assert the only file containing `type="number"` as a JSX attribute is
   `NumericField.tsx`. Deliverable 3 pins a list that a *future* file is not on;
   this catches the file that does not exist yet.

## Invariants

- **The rule stays `error`.** Never `warn`, not even transiently. A warning is
  precisely how the prose version of this rule failed (see the CLAUDE.md
  history referenced in `NumericField.tsx`).
- **The exemption list must not grow.** If a call site is hard to migrate, the
  answer is to fix the call site or extend `NumericField`, never to add a path.
- **Behaviour of the call sites is preserved.** In particular the state types
  differ on purpose and must stay different: `ArrangePanel` keeps its count and
  pitch state as **strings** (`onChange={(e) => setCountX(e.target.value)}`)
  while `EditorPage` converts with `Number(...)` at the boundary. Do not
  "unify" them.

## Watch-outs

- `NumericField` spreads `...rest` **before** applying `type`/`step`, so
  `className` (EditorPage 2158 `snap-input`), `style` (`fieldInputStyle`),
  `placeholder`, `min`, `max`, `value`, `onChange` and `data-testid` all pass
  through unchanged. `ArrangePanel`'s four `data-testid` hooks are used by
  existing tests — they must survive verbatim or those tests break.
- **`snapMM` changes spinner feel.** Going from `step="0.5"` to `step="any"`
  makes arrow keys move by the browser default of 1 rather than 0.5. That is a
  real, deliberate UX change and the documented cost of the rule. Note it in
  the PR body; do not "preserve" it by passing a numeric step.
- `min` is retained on all of these. With `step="any"` a `min` is a plain
  bound, not a lattice base — that is the entire point of the fix.
- Keep the diff to these three files plus the new test. **Do not otherwise
  touch `EditorPage.tsx`**: Tier 3 #111 lands a one-line change at
  `EditorPage.tsx:601` in a following round.

## Done when

- `NUMERIC_INPUT_EXEMPT_FILES` has exactly one entry.
- `npm run lint` is clean with the rule active on both pages.
- The new test fails if either page is re-added to the list, and fails if a raw
  numeric input is reintroduced anywhere under `web/src`. **Verify it is
  non-vacuous** by reverting one call site and watching it go red before you
  claim it works.
- Existing `ArrangePanel` tests still pass unmodified.
