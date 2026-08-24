# Handoff — Tier 2 #81, quantity takeoff + estimate

Written 2026-08-24 by the session that drafted the spec. Everything below was
verified live on that date, not recalled. Read this, then read
[`tier2-81-takeoff-and-estimate.md`](tier2-81-takeoff-and-estimate.md), which is
the actual implementation contract.

## Why this exists

A shop cannot quote a job from NeonBench. The design carries every quantity a price
is built from and none of it is ever totalled — the bend-list PDF reports arc length
*to each bend apex*, so even total footage has to be added up by hand.

The forcing case: Artech quoted the Monolith Brewing pinball sign at **$2,500** by
hand. Their Odoo tier table tops out at "Custom Neon – Large / Feature, $950", so the
tiers cannot price it. `work/artechNeon/grimco/STATUS.md` reaches the same conclusion
independently: *"the pinball sign at $2,500 is off the top of the Large tier ($950)
and needs costing from geometry, not from a tier."*

**Scope is takeoff + estimate only.** The Odoo bridge is #82 and is deliberately out.

## Start here

```sh
cd /Users/v/code/neonbench
git fetch origin
git checkout -b task/2-takeoff-estimate origin/main
( cd web && npm install && npm run build )   # MUST precede any go command
./scripts/setup-hooks.sh
```

`web/web.go` has `//go:embed all:dist`, so until `web/dist/` exists even `go vet`
fails with `pattern all:dist: no matching files found`. That is expected, not a break.

**The spec file is currently untracked on `main`.** `git add` it onto your new branch
as part of your first commit — do not leave it stranded.

## Repo state, verified 2026-08-24

| | |
|---|---|
| `origin/main` | `729be3d`, CI **green** (19:13) |
| Migration head | `0012` → **`0013` is free**, checked against every remote branch |
| Open PRs | **#126** editor right panel, **#127** move-run handle — both CI-green, both from June 5 |
| Conflict risk to you | **none** |

#126 and #127 both touch `EditorCanvas.tsx` + `App.css`, so they conflict with *each
other*, but neither touches a single file in #81's scope — no Go, no `App.tsx`, no
`api.ts`, no `ProjectDetail.tsx`. The spec puts the estimate on its own route
specifically to keep it out of those two files. **Keep it that way.** If you find
yourself wanting to add a panel to the editor, stop; that is a follow-up.

Re-check that `0013` is still free at the moment you write the migration.

## Four corrections are already applied — do not re-introduce them

The first draft of the spec got these wrong. Live data refuted them and the spec has
been fixed. They are called out here because each one looks reasonable and you might
"correct" it back.

1. **Glass comes in 5 ft sticks, not Miller's 46 in blanks.** `docs/neon-rules/`
   describes 1935 stock. FMS/Brillite ships 5 ft, confirmed with the shop. Stick
   length and waste are **rate-card fields**, not constants. There is a test that
   proves it by moving them.
2. **The "$8.32/ft back-calculated tubing cost" is deleted.** Real 12 mm is
   $0.40–$0.60/ft. The old figure was off by 14–20× and is gone from the spec.
3. **The "reproduce Odoo's $203/$297/$429" test is inverted.** Those tier costs are
   stale hand-typed estimates that real prices break: labour alone on the Large tier
   is 6 h × $48 = $288 and the transformer is $195.68, clearing $480 before gas or
   electrodes. The test now asserts the estimator comes in **above** $429 — it must
   notice the tier is underwater, not reproduce it.
4. **The 2.22× markup does not survive real costs.** It held against typed estimates
   only; with verified prices the same products land near 40% margin, not 55%
   (`STATUS.md`: A-Frame 40.3%, Medium neon 39.7%). It is an editable input with a
   defensible default. Never present a margin derived from it as fact.

## Verified rate-card data

From Odoo `product.supplierinfo`, company 2 (Artech Neon and Signs), 2026-08-24.
**Do not seed these into the migration** — NeonBench ships to any shop and one shop's
contract pricing does not belong in schema. Seed `sku` and leave `unit_cost` `NULL`.
This table is what gets pasted into the Rate Card editor once, and what the tests use
as a fixture.

| line kind | qualifier | SKU | vendor + code | unit | unit cost | min qty |
|---|---|---|---|---|---|---|
| `tube` | `12mm/clear` | `MAT-M52` | FMS `Clear-12mm` | ft | **0.4000** | 5 |
| `tube` | `12mm/coated` | `MAT-M53` | FMS `BL34-12mm` | ft | **0.5962** | 5 |
| `tube` | `10mm/clear` | `MAT-M51` | FMS `Clear-10mm` | ft | 0.3355 | 5 |
| `electrode` | `12mm` | `MAT-M55` | FMS `1245C` | pair | **1.3140** | **50** |
| `gas_fill` | `argon` | `MAT-M57` | FMS `Argon-Gas-2.25L` | each | **0.1380** | **250** |
| `gas_fill` | `neon` | `MAT-M56` | FMS `Neon-Gas-2.25L` | each | 0.1580 | 250 |
| `transformer` | `12kv-30ma` | `MAT-M58` | Grimco `VT12030-120` | each | **195.6800** | 1 |
| `transformer` | `6kv-30ma` | `MAT-M63` | Grimco `BRTVT6030120` | each | 104.4500 | 1 |
| `gto_cable` | — | `MAT-M59` | Grimco `VEN85373T-250B` | ft | **1.4684** | 250.01 |
| `tube_support` | — | `MAT-M60` | FMS `10T3PATW` | each | **0.4080** | **500** |
| `boot_endcap` | `12mm` | `MAT-M61` | Grimco `VEN88715` | each | **0.9390** | **100** |
| `blockout_paint` | — | `MAT-M62` | FMS `Stazon-Black-Gallon` | L | **27.7381** | 3.79 |
| `backing` | `acrylic-0.25` | `MAT-M40` | Grimco `CC489614C` | sheet (32 ft²) | **186.8500** | 1 |
| `standoff_set` | — | `MAT-M46` | **no vendor** | set | — | — |
| labour | — | — | `mrp.workcenter` "Artech Shop Labour" | hour | **48.00** | — |

`MAT-M58` is named "6-10kV" in Odoo but the matched part is a **Ventex VT12030-120,
12 kV / 30 mA**, which is exactly what the pinball proof specifies. Trust the SKU, not
the product name.

**The minimums are the interesting part.** Electrodes min 50 pair, gas min 250,
supports min 500, boots min 100, and FMS enforces a 20-stick minimum with a $25/box
packing fee on top. A one-off sign cannot buy what the supplier will ship. That is why
the spec requires two separate numbers — `job_draw_cost` (what the sign consumes) and
`purchase_cost` (what a PO for this job alone would cost) — and forbids folding the
overage silently into either one.

## Decided

**Coloured tubing is the coated standard range, `BL34-12mm` at $2.98/stick
($0.5962/ft) — confirmed by the shop 2026-08-24.** Not the through-coloured
`BL98` glass at $21.00/stick. This was the largest open risk on the job: a 7×
swing on the green, which is a lot of tube on this design.

The rate-card table below already carries $0.5962/ft, so **no number changes** — the
decision retires the risk rather than moving the estimate. It also settles a knock-on:
coated standard colours run argon-mercury, so mercury is a real consumable, not a
maybe.

Still flagged as open in three places on the Artech side —
`grimco/add_suppliers.py:26`, `grimco/GRIMCO_PRICES.md:73`, and the
`STATUS.md` open list. Whoever owns that tree should clear them.

## Still open — none of it blocks you

Every one of these lands in a `NULL`-seeded rate-card row. Build against the schema and
the numbers arrive later.

**Blocking a correct price, not the code:**

- **Mercury** — no SKU anywhere. Coated standard colours run argon-mercury, so with the
  decision below this is now definitely needed, not conditionally.
- **Purple: clear glass or coated?** A residual, and a small one — `Clear-12mm` at
  $0.40/ft vs `BL34-12mm` at $0.5962/ft, ~1.5×, not the 7× that mattered. Argon in
  clear glass reads lavender, so `MAT-M52` is the likely answer, but the proof's spec
  box just says "ARGON" for both colours. Assume clear, flag it on the estimate.
- **`MAT-M46` standoffs has no vendor.** `STATUS.md` names `MonoMountsAluminum` /
  `MultiMountsAluminum` as the replacement, but the proof calls for *clear plastic,
  tube-mounted* standoffs, which may be a third part again.
- **Crating / freight** — no SKU.
- **Is the BoM's "11 ft" net or gross?** Decides whether `minutes = 30 + 30 × ft` is
  calibrated on finished tube or purchased stick. Only the shop owner knows. The spec
  assumes **net** and says so; if that flips, the coefficient re-fits, the model does not.

**Questions for whoever owns the shop data, not for you:** does the shop stock glass or
buy per job (all these SKUs are `is_storable` with zero stock quants), and does a
modern bender really lose 6 in per stick end.

## Traps

- **`web/dist` before any `go` command.** Fresh branch means fresh build.
- **Never commit to `main`.** Branch protection plus a local pre-push hook enforce it.
- **Handler tests go in `internal/server/handlers_estimate_test.go`, never
  `integration_test.go`** — per `AGENTS.md` that file is the repo's most frequent merge
  conflict, two agents appending test functions to it.
- **`NULL` ≠ `0.0`.** `NULL` means unpriced and must be flagged; `0.0` means
  deliberately free. Artech's own `sync/rollup.py` independently arrived at the same
  rule — it rolls up *only fully priced BoMs*, because "a BOM holding one unpriced
  material produces a confident-looking cost that is simply too low." That is exactly
  the failure this feature must not ship.
- **Don't touch `todo.md`.** The Appendix B row for #81 goes in the post-round cleanup
  PR. Next free task number is **81**; highest currently used is 80.
- **Move the spec** from `specs/active/` to `specs/done/` in your final commit.

## Related work happening in parallel

`/Users/v/code/work/artechNeon/` — another session is actively pricing materials and
syncing Odoo. `grimco/STATUS.md` is its live status doc and is worth reading before you
assume anything about a price. As of 2026-08-24: 35 of 63 materials priced, 21 of 46
BoMs fully priced, `product.supplierinfo` populated, everything correctly on company 2.
Material costs are **not** yet rolled up onto `standard_price` — all still 0.00.

Nothing in that repo blocks this work, and this work does not touch it.
