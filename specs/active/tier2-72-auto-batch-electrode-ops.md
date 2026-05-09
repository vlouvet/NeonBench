# Tier 2 #72 — Auto-batch electrode + doubleback + housing ops

> **Status:** active · drafted 2026-05-09 · branch `task/2-auto-batch-electrode-ops` · NW parity (#128 + #120 enrichment)

## Goal

NW one-click ops on the entire layout:

- **"Add doubleback at every termination"** — every electrode endpoint gets a doubleback splice (PR #18's `Insert DB` op, but applied to every termination in one pass).
- **"Add housing to every electrode"** — every electrode pin gets a default housing (PR #77's housing modal, but applied to every pin in one pass).

NeonBench has both operations as per-electrode interactions. For a 12-letter sign with 24 electrodes (one pair per letter), that's 24 doubleback clicks + 24 housing modal selections. NW is one click each.

"Done" means: two new sidebar actions — **"Auto-doubleback all terminations"** and **"Auto-housing all electrodes"** — that loop the existing single-target ops over every applicable target on the doc and coalesce into one undo step.

## Branch + setup

```sh
git fetch origin
git checkout -b task/2-auto-batch-electrode-ops origin/main
( cd web && npm install && npm run build )
```

## Strict file scope

**Modify:**

- `web/src/lib/docOps.ts` — `autoDoublebackAllTerminations(doc, opts)` and `autoHousingAllElectrodes(doc, housingType, opts)` — both wrap their per-target op (`insertDoubleback`, `setElectrodeHousing`) in a deterministic loop. Each returns a single `Doc` so undo restores everything in one step.
- `web/src/lib/docOps.test.ts` — pin: 4-letter doc with 8 terminations → 8 doublebacks; idempotent on re-run (don't double-apply if a doubleback already exists at that vertex); skip terminations that already have a doubleback within `~tubeDiameter` of the endpoint (avoid stacked U-bends).
- `web/src/pages/EditorPage.tsx` — two new sidebar buttons in the existing electrode actions section. Both gated on "doc has at least one electrode."

**Don't touch:**

- The single-target ops (`insertDoubleback`, the housing-picker modal). Both stay as the discoverable per-target affordance.
- Backend / schema — both already shipped.
- `Run.Annotations` / `Electrode` shapes.

## Deliverables

1. **`autoDoublebackAllTerminations(doc, { depthMM, gapMM })`** — walks every run with electrodes, inserts a doubleback at each terminating vertex via the existing `insertDoubleback` op. Defaults match PR #18 (`depth=1.5×ø`, `gap=1.0×ø`). Idempotent: skip terminations that already have a doubleback within `~ø` of the endpoint (detect via 4-vertex-hairpin shape signature).
2. **`autoHousingAllElectrodes(doc, housingType, { boreOverride? })`** — walks every electrode in `Doc.Runs[*].Electrodes`, sets `HousingType` + `BoreDiameterMM` + `ElevationMM` on each per the chosen housing (PR #77 stock library: `15-shell`, `19-shell`, custom). Skip electrodes that already have a housing set.
3. **Sidebar buttons.** Live in the editor's electrode-actions section. Each opens a small confirmation toast: "Added 24 doublebacks across 12 runs · Undo." Same for housings.
4. **Tests** — table-driven over 0-electrode docs, 1-electrode docs, mixed-already-housed docs, and the idempotency case.

## Constraints

- **One undo step.** The whole batch is wrapped in one `editDoc()` call so Cmd-Z restores the pre-batch state in one keystroke.
- **No silent overwrites.** Auto-housing skips electrodes that already have a `HousingType`. Auto-doubleback skips terminations that already have a hairpin signature within snap range.
- **No new schema fields.** Reuse what PR #18 + PR #77 shipped.

## Tests

Manual smoke:

1. Channel-letter sign with 24 electrodes (12 letters, 2 each). Click "Auto-doubleback all" → 24 hairpins emitted in ~200ms; PDF bend list reflects the new vertices; undo restores; redo re-applies.
2. Click "Auto-housing all" → housing modal opens with a "Apply to every electrode" radio + housing type select. Confirm → all 24 electrodes get the chosen housing; sidebar count updates.
3. Re-run "Auto-doubleback all" → message "0 added (all terminations already have doublebacks)"; no doc mutation, no undo entry.

## Pre-merge

Standard four.

## Workflow

1. Idempotency detector for hairpin shape signature first (drives the doubleback skip case).
2. `autoDoublebackAllTerminations` + tests.
3. `autoHousingAllElectrodes` + tests.
4. Sidebar UI + confirmation toasts.
5. Pre-merge + smoke.
6. PR titled `Auto-batch electrode ops: doubleback-all + housing-all (Tier 2 #72)`.

## Report back

Under 200 words. PR URL, idempotency signature for hairpin detection (geometric tolerances chosen), housing-batch UX (modal with type picker vs flat default), CI state, follow-ups (per-letter custom housing — rare but possible).

## Follow-ups

- Per-run override on the auto-housing batch (e.g. "use 19-shell on the W and 15-shell on the rest").
- Auto-electrode placement at every face termination (would compose with Tier 2 #71's wizard — emit electrodes alongside the tubes).
