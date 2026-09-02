# Tier 2 #136 — Transformers should hang off circuits, not runs

> **Status:** done · drafted 2026-09-02 · shipped in PR #200 from `task/2-circuits`
> · source: [`docs/proof-workflow-gaps.md`](../../docs/proof-workflow-gaps.md) B2
>
> **Deliverable 5 was implemented differently from what this spec asked for,
> and deliberately.** "Glass yield reported per circuit — the 90 ft / 26 ft gap
> is the number a shop most wants to see move" reads as an instruction to ceil
> sticks per circuit. That would **under-order glass**: four 700 mm letters in
> one circuit are four separate physical pieces of bent glass and need four
> sticks, while `ceil(2800/1219)` says three. Sticks therefore stay **per run**,
> `CircuitSummary.StickCount` is the sum over members rather than a re-ceil, and
> what is reported per circuit is a genuine breakdown. The 90/26 gap belongs to
> Tier 2 #134 (joining fragments into runs), not to this row; the glass that
> does move here is the lead-in allowance, which follows the electrodes. See the
> PR body for the worked numbers.

## Goal

`internal/takeoff` computes `ElectrodePairs = ceilDiv(ElectrodeCount, 2)` and
derives one transformer per pair. On Chachi's job that produced **17
transformers needing 3135 mm laid along a 2170 mm raceway**, and
`raceway_transformer_fit` correctly refused it.

But 17 is not a fabrication decision. It is an artifact of how the medial axis
happened to fragment the script. **Every downstream number inherits it**:
electrode count, boots and endcaps, gas fills, glass yield (**90 ft gross for
26 ft net** — 18 sticks at 5 ft with 305 mm waste each) and fabrication hours.

**Done** means a shop can group runs into the circuits it will actually wire,
and the transformer count, the raceway-fit check and the yield reflect that
grouping rather than the tracer's accidents.

## Why this is worth a schema change

Today the only route to a sensible transformer count is to get the run count
right first, which needs #134 plus human judgement. That couples a **wiring**
decision to a **geometry** decision, and they are not the same decision: two
strokes can be one circuit whether or not they are one tube, because a circuit
is glass in series between one pair of electrodes, spliced as needed.

Modelling it directly also makes `raceway_transformer_fit` mean something. Right
now the check is arithmetically correct and its input is fictional.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-circuits origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `internal/designdoc/types.go` + `convert.go` — `Doc.Circuits`, additive with
  `omitempty`, plus `Run.CircuitID`.
- `web/src/api.ts` — the mirror. **The Go decoder runs with
  `DisallowUnknownFields`, so this type and the Go struct move together or every
  save 400s.**
- `internal/takeoff/takeoff.go` — derive per circuit where circuits exist.
- `internal/validate/rules.go` — `raceway_transformer_fit` counts circuits.
- `web/src/pages/EditorPage.tsx` — assign selected runs to a circuit.

**Don't touch:**

- Electrode placement ops. A circuit groups runs; it does not move electrodes.
- The estimate's money path. Quantities change; rates do not.

## The compatibility rule that decides the whole design

**A doc with no circuits must produce byte-identical takeoff output to today.**
Not "equivalent" — identical. Every existing design, every stored
`validation_report`, and the golden PDF digests all depend on the current
per-run derivation. So:

- `Circuits` is `omitempty`; a doc without it serialises exactly as now.
- The takeoff branches: circuits present → derive per circuit; absent → the
  existing per-run path, untouched.
- Do **not** "migrate" existing docs by synthesising one circuit per run. It
  would be a no-op numerically and would change every doc's JSON, which is worse
  than leaving them alone.

Follow `Doc.Guidelines` (#74) and `Doc.Raceways` (#104) as the precedent for an
additive doc slice — including their id-space discipline. And note Tier 3 #140:
`Raceway.ID` having to match a guideline id is invisible from the API and cost
an afternoon. **Do not repeat that.** If `Circuit.ID` has a relationship to
anything, say so in the API, not only in `types.go`.

## Deliverables

1. `Doc.Circuits` + `Run.CircuitID`, additive, both languages.
2. Takeoff derives electrode pairs, transformers, boots/endcaps and gas fills
   per circuit when circuits exist.
3. `raceway_transformer_fit` counts circuits, not runs.
4. Editor: assign the selection to a circuit; show which circuit a run is in.
5. Glass yield reported per circuit — the 90 ft / 26 ft gap is the number a shop
   most wants to see move.

## Tests

- **Byte-identical without circuits**: golden takeoff JSON for a real fixture,
  unchanged.
- Grouping four runs into one circuit yields one electrode pair and one
  transformer, not four.
- `raceway_transformer_fit` flips from refusing to passing on a fixture where
  grouping is the only change — the Chachi case, reduced.
- Round-trip: a doc with circuits saves and reloads through the Go decoder
  (this is where a TS/Go type mismatch shows up as a 400).
- A run whose `CircuitID` names a circuit that does not exist must be rejected
  at decode, with a message naming the problem — the failure mode #140 records.

## Constraints

- No migration. This is doc JSON, not SQLite schema.
- No new third-party dependencies.
- Coordinate with Tier 3 #126: the proof sheet quotes transformer count and
  glass yield, and it is signed by a customer. If both are in flight, #126 reads
  whatever this produces; do not let the sheet keep its own copy of the
  derivation.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

## Workflow

1. Types + round-trip first — a 400 on save is the failure that wastes the most
   time here.
2. Takeoff branch, with the byte-identical golden guarding the default path.
3. Validator, then UI.
4. **Move this spec** to `specs/done/` in the final commit.

## Report back

Transformer count and glass yield before/after on a grouped fixture, and
confirmation that the no-circuits golden is unchanged.
