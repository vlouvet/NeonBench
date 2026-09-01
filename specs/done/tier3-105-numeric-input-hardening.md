# Tier 3 #105 — A numeric-input component, and a lint rule behind it

> **Status:** done · 2026-09-01 · branch `task/3-numeric-input-hardening`
>
> There was no spec file when this task was dispatched — the agent prompt was
> the spec. This document is written after the fact to record what shipped and
> why, per `CLAUDE.md` → "Working with specs".

## Goal

Stop the same bug shipping a fourth time.

`<input type="number">` with a `min` and a `step` that is not `"any"` makes
`min` the **base of a lattice** of valid values: the browser accepts exactly
`min + k * step` for integer `k >= 0`, and nothing else. A value off that
lattice sets `validity.stepMismatch`, which fails HTML constraint validation.
Inside a `<form>`, that **silently swallows the submit** — the submit handler
never runs, nothing throws, nothing is logged, and the app state does not
change. Chrome anchors a transient native bubble to the offending field, which
the operator never sees when that field is scrolled out of view.

It shipped in **PR #146** (arc radius, `min=1 step=10`, default `500`) and
again in **PR #158** (flatten tolerance, `min=0.01 step=0.05`, default `0.25`),
weeks apart, in different dialogs. The hazard was already written into
`CLAUDE.md` as prose when the second one shipped. Prose did not work, so this
row moves the rule into the type system and into ESLint.

## What shipped

### 1. `web/src/components/NumericField.tsx`

Wraps `<input type="number">` and defaults to `step="any"`.

`step` and `type` are **omitted from the prop type**, so there is no way to ask
for an arbitrary numeric step at all. Both attributes are also applied *after*
the props spread, so a `{...record}` spread from loosely typed data cannot
smuggle one through at runtime either. Everything else — `id`, `ref`, labels,
`aria-*`, `className`, `placeholder`, `min`/`max`, handlers — forwards through
unchanged, and call sites keep whatever styling they already had. (React 19
treats `ref` as an ordinary prop, so no `forwardRef` wrapper is needed; the
type is `ComponentPropsWithRef<'input'>`.)

The one legitimate lattice is the integer counter, and a caller asks for it by
name:

```tsx
<NumericField integer min={1} max={99} value={copies} … />
```

`integer` renders `step={1}`. It is deliberate, greppable and reviewable.

**The rule the component encodes:** a numeric step is only safe when the
quantity is a genuine count of discrete things. Every physical measurement here
is a millimetre or a degree, and this is a neon shop — the trade runs on
imperial sizes converted to mm, so the values operators actually type are
12.7 (½"), 9.525 (⅜"), 6.35 (¼"), 3.175 (⅛"), 25.4 (1"), 76.2 (3"). Those fall
off essentially every lattice anyone picked here. Money behaves the same way.

### 2. The lint rule

`no-restricted-syntax` in `web/eslint.config.js`, at **error** severity,
selecting `JSXOpeningElement[name.name='input'] > JSXAttribute[name.name='type'][value.value='number']`
and pointing at `NumericField`.

The selector matches the literal attribute `type="number"`. A computed type
(`type={someVar}`) or a hand-rolled `React.createElement('input', …)` slips
past it. Neither pattern exists in this repo, and a selector chasing them would
be guesswork — the rule is a tripwire on the shape people actually write, not a
proof.

### 3. Migration — 45 call sites across 10 files

| File | Sites | `integer` |
|---|---|---|
| `ProjectDetail.tsx` | 14 | 0 |
| `VectorizePanel.tsx` | 8 | 4 (crop X/Y/W/H — source pixels) |
| `HersheyTextDialog.tsx` | 5 | 0 |
| `ChannelLetterWizardDialog.tsx` | 4 | 0 |
| `OutlineTextDialog.tsx` | 4 | 0 |
| `RateCardEditor.tsx` | 4 | 1 (`min_qty`) |
| `HousingPickerModal.tsx` | 3 | 0 |
| `PrintPopover.tsx` | 1 | 1 (print copies) |
| `ProjectList.tsx` | 1 | 0 |
| `EstimatePage.tsx` | 1 | 2 of 7 fields (see below) |

Two lookup tables carried a now-dead `step` column:

- `RateCardEditor`'s `SCALARS` — dropped; every entry is money, a rate, a ratio
  or a millimetre length, so all take `step="any"`.
- `EstimatePage`'s `INPUT_FIELDS` — `step: number` replaced by
  `integer?: boolean`. Only `transformer_count` and `standoff_set_count` are
  genuine counts. `gto_cable_ft`, `backing_sq_ft`, `install_hours`,
  `design_hours` and `freight` are measurements, durations and money: 25.5 ft
  of GTO, 3.75 sq ft of backing and $412.60 of freight are all legitimate, and
  a `step` would have rejected them.

`HersheyTextDialog` and `OutlineTextDialog` each carried a multi-line comment
explaining why *that one field* used `step="any"`. Those comments came out with
the attribute they annotated — the rationale now lives in `NumericField.tsx`,
which is where the next person will look for it.

## The audit — every off-lattice value found

Method: rather than reason about IEEE-754 by hand, each `(min, step, value)`
triple from the source was fed to a real Chromium via
`input.checkValidity()` / `validity.stepMismatch`. Browsers use decimal
arithmetic for step validation, so hand-computed float reasoning is not
trustworthy here. 103 probes, 37 invalid.

**Shipped defaults that were already wrong** (not hypotheticals):

1. **`VectorizePanel` rotation — a live third instance of the bug.**
   `applyRotationFromDetected` computes `Math.round(-detectedDeg * 10) / 10`,
   i.e. a value with 0.1 resolution, and writes it into a field declared
   `min={-45} step={0.5}`. Its own comment says "Rounded to one decimal to
   match the slider step" — but the step is 0.5, not 0.1. Every odd tenth it
   produces (`-3.7`, `2.3`, `-0.1`) is off the lattice. The panel **is** a
   `<form>`, so pressing **Auto-rotate** — a first-class button — could leave
   Vectorize permanently un-submittable with no feedback.

2. **Seeded tube-spec wall thicknesses.** 3 of the 4 specs seeded by
   migration `0010_tube_spec_wall_thickness.sql` are off the wall field's
   `min=0.1 step=0.05` lattice:
   `0.91` (10mm clear), `1.07` (12mm clear), `1.32` (15mm clear). The field
   rendered invalid on load for three of four stock specs.

3. **Strip overlap.** Migration `0011` documents the shop default as
   12.7 mm (½ in) and `DEFAULT_STRIP_OVERLAP_MM = 12.7`, against a field
   declared `min={0} step={0.5}`. 12.7 is off that lattice.

**Reachable trade values that were rejected** (typed by an operator, or
loaded from a project that stored them):

| Field | Old `min` / `step` | Rejected values |
|---|---|---|
| ChannelLetterWizard · tube outside diameter | 1 / 1 | 12.7 (½"), 9.525 (⅜") |
| ProjectDetail · channel letter depth | 10 / 1 | 76.2 (3") |
| ProjectDetail · tube end gap | 0 / 0.05 | 3.175 (⅛"), 2.54 |
| ProjectList · tube end gap (new project form) | 0 / 0.05 | 3.175, 2.54 |
| ProjectDetail · min bend radius | 1 / 0.5 | 12.7, 25.4 |
| ProjectDetail · min spacing | 1 / 0.5 | 6.35, 3.175 |
| ProjectDetail · lead-in | 0 / 0.5 | 19.05 (¾"), 25.4 |
| ProjectDetail · tube diameter | 5 / 0.1 | 9.525 |
| ProjectDetail · max segment length | 100 / 10 | 2438.4 (8 ft) |
| HousingPickerModal · elevation | 0 / 0.5 | 6.35, 12.7 |
| HousingPickerModal · bore diameter | 0 / 0.1 | 9.525 |
| VectorizePanel · smoothing ε | 0 / 0.1 | 0.25 |
| VectorizePanel · min spur | 0 / 0.5 | 0.7, 3.2 |
| VectorizePanel · target width | 1 / (implicit 1) | 609.6 (24") |
| OutlineTextDialog · letter spacing | — / 1 | any fractional mm |
| RateCardEditor · setup minutes, minutes/ft | — / 5 | 8, 12 |
| RateCardEditor · labour rate | — / 0.5 | 68.75 |
| RateCardEditor · pack fee, unit cost | 0 / 1, 0.0001 | 7.50, 1.23456 |
| EstimatePage · backing/install/design | 0 / 0.5 | 3.75, 2.25 |
| EstimatePage · GTO ft, freight | 0 / 1 | any fractional value |

Only 5 of the 12 files were inside a `<form>` (`HersheyTextDialog`,
`OutlineTextDialog`, `ChannelLetterWizardDialog`, `VectorizePanel`,
`ProjectList`), so only those could swallow a submit. The rest commit via
`onBlur`/`onClick` and merely rendered a red invalid field — the same defect,
one refactor away from becoming fatal.

## Verification in a real browser

The failure is invisible to unit tests: it is HTML constraint validation inside
a form. Reproduced against a build of unmodified `origin/main`, then re-checked
after the fix, driving real Chromium through Playwright.

**Before** — Channel letter wizard, "Tube outside diameter (mm)" set to `12.7`:

```
tube-diameter field: value=12.7 min=1 step=1 valid=false stepMismatch=true
  message="Please enter a valid value. The two nearest valid values are 12 and 13."
submit button "Insert": enabled, not disabled
after clicking Insert:  dialog still open
                        runs in doc: 0
                        console output: NOTHING
```

The dialog's own live preview kept reporting "2 faces · 4 tube runs · 212mm
wide" while Insert did nothing.

**After** — same dialog, same value:

```
tube-diameter field: value=12.7 min=1 step=any valid=true
after clicking Insert:  dialog closed
```

Then, asserting on data read back **out of the API** rather than the render
layer (per `CLAUDE.md` recurring bug class 3) — saved as a version and re-read
from `design_doc_json`:

```
run count: 6
channel letter faces: 2
distinct tube diameters: [12.7]
run ids: letter-1 … letter-6
```

Also re-checked live: the tube-spec editor's seeded wall thickness `1.07`, and
its diameter / bend / segment / spacing fields, all now report
`step=any valid=true`.

## Tests

`web/src/components/NumericField.test.tsx` — 13 assertions. There is no DOM
test environment in this repo by design, so rendering goes through
`renderToStaticMarkup` and reads the emitted HTML; `step` is an HTML attribute,
so that is the right altitude. The lint half drives the repo's real flat config
through the ESLint Node API, so it exercises the same selector CI does rather
than a copy of it. No new dependencies (`react-dom` and `eslint` are already
present).

Covered: `step="any"` by default; `step="1"` under `integer`; the spread cannot
override `type` or `step`; ids/labels/aria/class/placeholder forward; the five
imperial trade values render valid; the rule fires on a raw numeric input at
severity 2; the rule does **not** fire on `NumericField`, `type="text"` or
`type="range"`; the exemption list has not grown; the rule is still `error` for
a normal source file.

**Negative controls run** (per `CLAUDE.md` bug class 7 — a test that asserts X
passes only means something if you have seen it fail):

- Changed the component's default to `step={0.05}` → 7 tests failed.
- Changed the lint selector to `name.name='inputX'` → the "fires on a raw
  input" test failed.

Both were reverted; the suite is green.

## Judgment calls

**Spinner granularity changed.** Moving a field from `step={0.5}` to
`step="any"` changes what the up/down arrows increment by (browsers step by 1
under `step="any"`). This is a real, if small, visible behaviour change on the
measurement fields. It is the deliberate trade: these fields are typed into,
not spun, and the alternative is a lattice that rejects half the dimensions the
trade actually uses. Every other aspect of every call site is unchanged.

**`EditorPage.tsx` / `ArrangePanel.tsx` are exempted in the config, not with
inline comments.** Those two files hold the remaining 8 raw numeric inputs and
were out of this task's file scope — a parallel branch owned them, and
`CLAUDE.md`'s file-coupling map names them as the repo's worst conflict
sources. Adding 8 `eslint-disable-next-line` comments to files another branch
was rewriting would have created a near-certain merge conflict in exactly the
place the playbook says to avoid one. Instead `web/eslint.config.js` carries a
final config block naming those two paths, with the row number and the
follow-up written into the comment.

The rule is **not** downgraded to a warning anywhere — a warning is precisely
how the prose version of this rule failed. The exemption list is exported as
`NUMERIC_INPUT_EXEMPT_FILES` and pinned by a test, so a future contributor
cannot quietly add a file to it to make a lint error go away.

An ESLint subtlety worth recording: the first attempt wrote the exemption as
`['error', ...list.filter(…)]`, which for an empty list collapses to
`['error']`. ESLint treats a **severity-only** rule entry as "keep the
inherited options", so the ban stayed fully in force and the override was
silently inert. `eslint --print-config` is what caught it; the fix is a plain
`'off'`, and the reason is commented at the site.

## Follow-ups worth tracking

1. **Migrate the last 8 raw numeric inputs** in `EditorPage.tsx` (4) and
   `ArrangePanel.tsx` (4), then delete those two entries from
   `NUMERIC_INPUT_EXEMPT_FILES` and the assertion in the test. This is the
   only thing standing between the repo and a rule with no exceptions.
2. **Fix `applyRotationFromDetected` properly.** `step="any"` makes the
   Vectorize form submittable again, but the function still rounds to 0.1
   while its paired `type="range"` slider keeps `step={0.5}` — so the number
   field and the slider disagree about what values exist, and the slider will
   snap a value the number field accepted. Either round to 0.5 or give the
   slider a finer step; the two should be derived from one constant.
3. ~~Seeded wall thicknesses~~ — checked, no action needed.
   `0010_tube_spec_wall_thickness.sql` cites Strattman NT (0.042–0.058 in =
   1.07–1.47 mm) and derives each spec's bend radius from its `t`, so
   `0.91` / `1.07` / `1.32` are deliberate measured stock values. The data was
   right and the input's `step` was wrong — which is the whole shape of this
   row, and the reason the fix belongs in the field rather than the seed.
4. **`type="range"` has the same lattice semantics** and was not in scope. A
   range input silently *snaps* an off-lattice value instead of rejecting it,
   which is quieter still. Several sliders pair with a migrated number field
   (rotation, slant); an audit of those pairs is worth a row.
