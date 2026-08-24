# Tier 2 #81 — Quantity takeoff + estimate

> **Status:** active · started 2026-08-24 · branch `task/2-takeoff-estimate`

## Goal

A shop cannot quote a job from NeonBench today. The design carries every number a
price is built from — tube length, electrode count, blockout runs, backing area — and
none of it is ever totalled or surfaced. The bend-list PDF reports arc length *to each
bend apex*, so even total footage has to be added up by hand.

This slice adds two things: a **takeoff** (pure geometry → quantities, no money) and an
**estimate** (takeoff × a stored rate card → priced lines). Done looks like: open a
design version, hit Estimate, see net + gross glass footage, electrode pairs, blockout
linear feet, backing area, fabrication hours and a priced total — and print it as a
one-page quote sheet.

The takeoff half is useful on its own: "how much 12 mm do I need to order" is a
question NeonBench can answer today and doesn't.

**Explicitly NOT in this slice:** the Odoo bridge. Pulling rates from
`product.product` / `mrp.workcenter` and pushing a draft `sale.order` back is Tier 2 #82.
It is blocked anyway — every raw-material `standard_price` in that database is currently
0.00. This slice's schema is shaped so #82 is a data-plumbing job with no redesign
(see **Forward compatibility with #82**).

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-takeoff-estimate origin/main
( cd web && npm install && npm run build )   # required before any go command
./scripts/setup-hooks.sh
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**New:**

- `internal/takeoff/takeoff.go` — geometry → quantities
- `internal/takeoff/takeoff_test.go`
- `internal/estimate/estimate.go` — quantities × rate card → priced lines
- `internal/estimate/estimate_test.go`
- `internal/storage/migrations/0013_rate_cards.sql`
- `internal/storage/rate_cards.go`
- `internal/server/handlers_estimate.go`
- `internal/server/handlers_estimate_test.go` — NOT `integration_test.go`; see Tests
- `internal/printpdf/estimate.go` — standalone quote-sheet PDF
- `internal/printpdf/estimate_test.go`
- `web/src/pages/EstimatePage.tsx`
- `web/src/pages/EstimatePage.test.tsx`
- `web/src/components/RateCardEditor.tsx`
- `web/src/components/RateCardEditor.test.tsx`

**Modify:**

- `internal/server/api.go` — append routes only (append-only file, low conflict)
- `internal/storage/models.go` — `RateCard` / `RateCardItem` structs
- `internal/storage/design_versions.go` — read/write `estimate_inputs_json`
- `web/src/api.ts` — append client functions (append-only)
- `web/src/App.tsx` — one route registration
- `web/src/pages/ProjectDetail.tsx` — one "Estimate" link per version row

**Don't touch:**

- `web/src/components/EditorCanvas.tsx`, `web/src/pages/EditorPage.tsx` — the two
  highest-coupling files in the repo. The estimate lives on its own route precisely so
  this slice never opens them. If you find yourself wanting to add a sidebar panel to
  the editor, stop — that's a follow-up.
- `internal/printpdf/render.go` — the estimate PDF is a **separate** emitter in its own
  file with its own endpoint. Do not add a page to the existing print pipeline.
- `internal/designdoc/types.go` / `convert.go` — no schema change to the design doc.
  `specs/active/tier3-78-arc-line-segment-conversion.md` is in flight there.
- `internal/validate/*` — the takeoff reads geometry, it does not validate it.
- `todo.md` — the Appendix B row for #81 goes in the post-round cleanup PR, not here.

## Deliverables

1. **`internal/takeoff` package.** Pure function `Compute(doc *designdoc.Doc, spec
   TubeSpec, inputs Inputs) Takeoff`. No DB, no HTTP, no money. Every quantity carries
   its unit and a `derived` / `manual` provenance flag.
2. **Migration `0013_rate_cards.sql`** — `rate_cards`, `rate_card_items`, and an
   additive nullable `estimate_inputs_json TEXT` column on `design_versions`. Seeds one
   default rate card. Additive only; a reversible `-- +goose Down` is required.
3. **`internal/estimate` package.** `Price(t takeoff.Takeoff, card storage.RateCard)
   Estimate` — joins quantities to rates, applies labour and markup, and reports
   **unpriced lines explicitly** (see Constraints).
4. **API** (all under the existing project/design-version path shape):
   - `GET  /api/projects/{id}/design_versions/{vid}/takeoff`
   - `GET  /api/projects/{id}/design_versions/{vid}/estimate?rate_card_id=N`
   - `PUT  /api/projects/{id}/design_versions/{vid}/estimate_inputs`
   - `GET  /api/projects/{id}/design_versions/{vid}/estimate.pdf?rate_card_id=N`
   - `GET  /api/rate_cards`, `GET /api/rate_cards/{id}`
   - `PATCH /api/rate_cards/{id}`, `PATCH /api/rate_cards/{id}/items/{iid}`
5. **`EstimatePage`** at `/projects/:pid/versions/:vid/estimate` — quantity table,
   priced table, manual-input form, rate-card selector, unpriced banner, Print button.
6. **`RateCardEditor`** — inline edit of `unit_cost` per item plus the four card-level
   scalars. No card creation/deletion in this slice.
7. **Quote-sheet PDF** — one page, letter + A4, header / quantities / priced lines /
   totals / provisional banner.

## Constraints

- **No new dependencies.** `gofpdf` is already vendored for print; reuse it. No new npm
  packages — the tables are plain HTML.
- **No pricing logic in TypeScript.** The frontend renders what the API returns. The
  repo already pays for one duplicated algorithm (`bends.ts` ↔ `bends.go`); do not add
  a second.
- **A missing rate is never silently zero.** `rate_card_items.unit_cost` is
  **nullable**. `NULL` means "nobody has priced this yet" and the line comes back with
  `"unpriced": true`; `0.0` means "deliberately free". The estimate response carries
  `unpriced_count` and `is_provisional`, the page shows a banner, and the PDF prints a
  `PROVISIONAL — N UNPRICED LINES` rule above the total. A quote that quietly omits the
  glass because nobody typed a price in is the single worst failure mode here.
- **Deterministic and reproducible.** The estimate response echoes `rate_card_id` and
  the card's `updated_at`, so a printed quote can be traced to the rates that produced it.
- **Money is `REAL` and rounded only at the boundary.** Round to cents once, in the
  response serializer — never mid-calculation.
- **Migration number:** 0012 is the current head. If another branch lands 0013 first,
  renumber; do not reuse.
- Do not seed invented material prices — see **Seed rate card** below for exactly which
  numbers are real and which must stay `NULL`.

## Geometry / algorithms

All coordinates are mm. Reuse `designdoc.LiveArcIndices(run)` — do not reimplement
live-arc walking.

### Net tube length (what glows)

Per run, sum Euclidean distances between consecutive points of the live arc. For a run
with fewer than two electrodes, use the whole polyline (plus the closing segment when
`Polyline.Closed`). `Kind == "jumper"` runs are counted separately as
`jumper_length_mm`, never folded into `net_tube_length_mm`.

Group the totals by `(TubeDiameterMM, Color)` — the rate card prices coated colour
tubing differently from clear, and the pinball job alone has two colours.

### Gross glass — stick yield, not a waste percentage

Glass is bought in fixed-length sticks and cut down, so model the yield rather than
inventing a scrap percentage. **Both lengths are rate-card fields, not constants** —
the trade literature and the shop's actual supplier disagree, and the supplier wins:

| field | default | why |
|---|---|---|
| `stick_length_mm` | `1524` (5 ft) | FMS / Brillite ships 5 ft sticks. Confirmed with the shop 2026-08-24. |
| `stick_waste_mm` | `305` (6 in total) | Miller 1935 p.58/p.115 reserves 6 in **per end** on a 46 in blank; on a longer modern stick the shop's real figure may differ, so it is editable. |

`docs/neon-rules/segment-length.md` still records Miller's 46 in / 34 in blank. Do
**not** hardcode it — it describes 1935 stock, not what this shop buys. Cite it in the
field comment as the origin of the handling allowance and move on.

```
usable_mm      = stick_length_mm - stick_waste_mm      (1219 mm at the defaults)
lead_in_mm     = spec.MinLeadInMM  (fallback 2 × diameter, then clamped to Miller's
                                    50–254 mm band, docs/neon-rules/electrodes.md:172)
run_glass_mm   = live_arc_mm + 2 × lead_in_mm        (runs with ≥1 electrode)
               = live_arc_mm                          (jumpers, and runs with none)
sticks(run)    = ceil(run_glass_mm / usable_mm)
splices(run)   = max(0, sticks(run) - 1)
gross_glass_mm = Σ sticks(run) × stick_length_mm
```

Sticks are computed **per run** — leftover from one run cannot be used on another
without a splice, and a splice is a labour event, not free glass. Report
`net_tube_ft`, `gross_glass_ft`, `stick_count` and `splice_count` as separate lines.
Price tubing on **gross**; that is what leaves the supplier's shelf.

### Supplier minimums and packing — report, do not silently absorb

A one-off sign cannot buy the quantity the supplier will actually ship. FMS enforces a
**20-stick minimum** and a **$25 packing fee per box**; on a minimum order the fee alone
is +62%. Electrodes are min 50 pair, gas min 250, tube supports min 500.

Two costs exist and they are not the same number:

- `job_draw_cost` — quantity actually consumed × unit cost. What the sign costs if the
  glass is already on the shelf. **This is the estimate's basis.**
- `purchase_cost` — what a PO for this job alone would cost, rounding every line up to
  its minimum and adding packing.

Carry `min_qty` and `pack_fee` per rate-card item, compute both, and show
`purchase_cost` as an advisory line. Never fold a minimum-order overage into the
per-job price silently — that is how a one-off quote ends up carrying a whole case of
electrodes. When they differ by more than 2×, say so on the estimate.

### Counts

- `electrode_count` = Σ `len(run.Electrodes)` over non-jumper runs.
  `electrode_pairs` = `ceil(electrode_count / 2)` — EGL sells in pairs (`MAT-M55`).
  Group by `run.TubeDiameterMM`; a design mixing 10 mm and 12 mm needs both.
- `pumped_sections` = count of non-jumper runs with ≥ 2 electrodes. Drives gas fill.
- `bend_count` = Σ `len(designdoc.EffectiveBends(run, d))`, jumpers excluded.
- `blockout_length_mm` = Σ over runs, over `run.Blockouts`, of the live-arc length
  between `StartLiveIndex` and `EndLiveIndex`. Report in ft; it prices blockout paint
  and it is a real labour driver.
- `housing_count`, `support_count` (`Annotation.Kind == "support"`), `jump_count`,
  `channel_letter_strip_mm` (reuse `printpdf.polylinePerimeterMM`).

### Backing area — and sheet yield

`doc.ViewBoxMM[2] × doc.ViewBoxMM[3]` → ft². **This is a bounding box and it
overestimates** — a shaped acrylic panel cut to the sign silhouette is smaller. Report
it as `backing_bbox_ft2`, mark it `derived`, and let `estimate_inputs.backing_ft2`
override it. Say "bounding box" in the UI label; do not present it as the cut area.

Then apply the **same yield treatment as glass**, because acrylic is bought by the
sheet: `sheets = ceil(backing_ft2 / sheet_area_ft2)` with `sheet_area_ft2` a rate-card
field defaulting to `32.0` (a 48×96 sheet). A 36×24 sign draws 6 ft² out of a 32 ft²
sheet — pricing that at 6/32 of a sheet is only honest if the offcut gets used, so
report both `backing_ft2` (draw) and `backing_sheets` (purchase) and let the two costs
diverge exactly like sticks. Same rule: never silently charge the whole sheet, never
silently charge only the draw.

### Fabrication hours

Three coefficients on the rate card:

```
fab_minutes = labour_setup_minutes + labour_minutes_per_foot × net_tube_ft
fab_hours   = fab_minutes / 60
```

Calibration — the shop's Odoo instance carries three neon BoMs whose fabrication times
are an exact linear fit:

| BoM | tubing | fabrication |
|---|---|---|
| Custom Neon – Small | 4 ft | 150 min |
| Custom Neon – Medium | 7 ft | 240 min |
| Custom Neon – Large / Feature | 11 ft | 360 min |

`minutes = 30 + 30 × ft` reproduces all three exactly. Those are the seed values.
**Assumption to document in the code comment:** the BoM's ft figure is treated as *net*
(finished, visible tube), not gross blank footage. The BoM line is a material line so
it is genuinely ambiguous; net is the more plausible reading for a "feature piece", and
the coefficient is only meaningful relative to whichever basis is chosen. Revisit once
real jobs are logged.

Install and design hours are **manual** inputs — geometry cannot know whether the wall
is brick or drywall.

### Manual inputs (`estimate_inputs_json` on the design version)

Everything geometry cannot derive, all optional, all with a `manual` provenance flag:
`transformer_count` + `transformer_qualifier` (e.g. `"12kv-30ma"`), `gas_fill_sections`
(defaults to `pumped_sections`), `gto_cable_ft`, `tube_support_count`,
`standoff_set_count`, `backing_ft2` (overrides the bbox), `install_hours`,
`design_hours`, `freight`, and a free-form `misc[]` of `{label, qty, unit_cost}`.

Store as a JSON blob on `design_versions`, following the existing
`validation_report_json` precedent. No new table.

### Line kinds

A closed enum the takeoff emits and the rate card keys on. Match order is exact
`(kind, qualifier)` → then `(kind, "")` → then **unpriced**.

| kind | qualifier example | unit |
|---|---|---|
| `tube` | `12mm/coated` | `ft` |
| `electrode` | `12mm` | `pair` |
| `gas_fill` | `argon` | `each` |
| `transformer` | `12kv-30ma` | `each` |
| `gto_cable` | — | `ft` |
| `tube_support` | — | `each` |
| `boot_endcap` | `12mm` | `each` |
| `standoff_set` | — | `set` |
| `backing` | `acrylic-0.25` | `sheet` |
| `blockout_paint` | — | `ft` |
| `labour_fabrication` / `labour_install` / `labour_design` | — | `hour` |
| `freight` / `misc` | — | `each` |

Units are the ones the shop's supplier and ERP already use — `ft`, `ft²`, `pair`, `set`,
`each`, `hour` — so a rate pulled from anywhere drops in without conversion. NeonBench
is mm-internally; convert once, at the takeoff boundary (`mm → ft = / 304.8`,
`mm² → ft² = / 92903.04`).

### Totals

```
material_cost = Σ (qty × unit_cost) over non-labour lines
labour_cost   = Σ (hours × labour_rate_per_hour)
cost_subtotal = material_cost + labour_cost
price         = cost_subtotal × markup_multiplier
```

Report `material_cost`, `labour_cost`, `cost_subtotal`, `markup_multiplier`, `price`,
and `implied_margin_pct = 1 - 1/markup`. Show the cost side — a shop that can only see
the sell price cannot tell when a job has gone underwater.

## Seed rate card

Migration 0013 seeds one card named `"Default (provisional)"`. **Only these scalars get
real values** — they come from the shop's Odoo instance, not from invention:

| field | value | source |
|---|---|---|
| `labour_rate_per_hour` | `48.00` | `mrp.workcenter` "Artech Shop Labour" `costs_hour` (company 2) |
| `labour_setup_minutes` | `30.0` | exact fit to the three neon BoM operation times |
| `labour_minutes_per_foot` | `30.0` | same fit |
| `markup_multiplier` | `2.22` | mean of the neon SKUs' list ÷ cost — **see the warning below** |
| `stick_length_mm` | `1524` | FMS 5 ft sticks, confirmed with the shop |
| `stick_waste_mm` | `305` | Miller handling allowance; editable |

**Every `rate_card_items.unit_cost` seeds as `NULL`.** NeonBench ships to any shop; one
shop's contract pricing does not belong in a migration. Seed the `sku` column with the
codes (`MAT-M52`, `MAT-M55`, …) — the kind→SKU mapping is the part that needed human
judgement and it is already settled — and leave every price empty. Artech's actual
numbers are pasted in once through the Rate Card editor, and #82 will refresh them.

> **The 2.22× markup does not survive real costs and the code must not assume it does.**
> It was derived from hand-typed estimates. Now that verified supplier prices exist, the
> same products land at ~40% margin, not 55% — the A-Frame at 40.3%, Medium neon at
> 39.7%. Treat `markup_multiplier` purely as an editable input with a defensible
> default. Never derive margin from it and present that as fact; compute
> `implied_margin_pct` from the numbers actually in front of you.

## Tests

Go, table-driven:

- **Net length** — a straight 3-point run of known length; a 3-4-5 triangle; a closed
  square with two electrodes, asserted in **both** `forward` and `backward` directions
  (the two arcs differ; this is the regression that matters).
- **Stick yield boundaries** — at the default 1524/305 (usable 1219): `run_glass_mm`
  of exactly 1219 → 1 stick / 0 splices; 1220 → 2 sticks / 1 splice; 2438 → 2; 2439 → 3.
  Then repeat with `stick_length_mm = 1168, stick_waste_mm = 304` (Miller's blank) and
  assert the boundaries move to 864 — proving the lengths are really data and not
  constants that got inlined.
- **Minimum-order split** — a job drawing 6 pair of electrodes against a `min_qty` of 50
  reports `job_draw_cost` on 6 and `purchase_cost` on 50 plus the pack fee, and raises
  the >2× divergence flag.
- **Lead-in clamp** — a spec with `MinLeadInMM` nil falls back to 2×D; a spec with 500
  clamps to 254; a spec with 10 clamps to 50 (Miller's band).
- **Jumpers excluded** from `net_tube_length_mm`, `bend_count` and `electrode_count`,
  and present in `jumper_length_mm`.
- **Colour/diameter grouping** — a doc with purple 12 mm and green 12 mm emits two
  `tube` lines with distinct qualifiers, and their sum equals the ungrouped total.
- **Unpriced propagation** — a card with `NULL` tubing cost yields `unpriced: true` on
  that line, `unpriced_count ≥ 1`, `is_provisional: true`, and a total that **excludes**
  the unpriced line rather than treating it as zero-cost-included.
- **`0.0` is not `NULL`** — an item explicitly priced at zero is priced, not unpriced.
- **Underwater-tier detection** (replaces what would have been a "reproduce the Odoo
  tier costs" test — that test would have been wrong). Fixture: the Large tier at 11 ft
  with the real verified supplier prices. Assert the model returns a cost **above** the
  $429 currently recorded against that SKU. It has to: labour alone is 6 h × $48 = $288
  and the transformer is $195.68, so material + labour clears $480 before gas or
  electrodes, against a $950 list price. The recorded tier costs are stale hand-typed
  estimates. The test's job is to prove the estimator **notices** that, not to reproduce
  it. If this test ever starts failing because the model came in under $429, the model
  has lost a cost line.
- **Unit conversion** — mm→ft and mm²→ft² round-trip within 1e-9.
- **Empty doc** — zero runs returns a zero takeoff and a zero estimate, no panic, no
  divide-by-zero in `implied_margin_pct`.
- **Migration** — up/down/up leaves the schema and the seeded card intact; an existing
  `design_versions` row survives with `estimate_inputs_json` NULL.
- **Handlers** — round-trip each endpoint in `internal/server/handlers_estimate_test.go`,
  **not** `integration_test.go`. Per `AGENTS.md`, two agents appending test functions to
  that file is the single most common merge conflict in this repo; a new file avoids it
  entirely.

Vitest:

- `EstimatePage` renders quantity + priced tables from a mocked response.
- The provisional banner appears when `is_provisional` and not otherwise.
- `RateCardEditor` distinguishes an empty input (→ `NULL`) from a typed `0`.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )   # advisory; no NEW diagnostics
```

Plus a real browser pass: create a project, draw two runs in two colours, place
electrodes, mark a blockout, open the Estimate route, confirm the numbers move when you
edit the design and when you edit a rate.

## Forward compatibility with #82 (Odoo bridge)

Shape the schema now so #82 adds no columns:

- `rate_card_items.sku TEXT` — carries the external code (`MAT-M52`, `MAT-M55`, …).
  Populate the seeded rows with the codes even though the costs are `NULL`; the mapping
  from line kind to SKU is the part that needs human judgement, and it is already known.
- `rate_cards.source TEXT` + `rate_cards.synced_at TEXT` — `NULL` for a hand-edited
  card, `"odoo:production"` + timestamp for a pulled one.
- Keep `internal/estimate` free of any I/O, so #82 only has to write a card.

Do **not** add an Odoo client, credentials handling, or network calls in this slice.

## Workflow

1. Backend first — `takeoff` package and its tests, in isolation, before any HTTP.
2. Migration + storage layer + handlers.
3. PDF emitter.
4. Frontend last, against a working API.
5. Open PR "Tier 2 #81 — quantity takeoff + estimate". Watch CI.
6. **Move this spec** from `specs/active/` to `specs/done/` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary
- Judgment calls (especially: anything where you departed from the blank-yield model,
  the lead-in clamp, or the unpriced-line semantics — and why)
- File sizes for the new packages
- CI final state
- Follow-ups worth tracking as Tier 3 rows. Likely candidates already visible:
  transformer sizing validation from footage (Miller p.~100: 35 ft of 12 mm on a 30 mA
  transformer ≈ 350 VA; Saving Neon p.36: ~4 W/ft) as a cross-check that a specced
  transformer can actually drive the design; backing area from the true silhouette
  rather than the bounding box; and an editor-sidebar summary of the takeoff.
