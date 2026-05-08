# Tier 3 #62 — Common + Custom electrode housings (NW #120 + #126)

> **Status:** active · drafted 2026-05-08 · branch (when dispatched) `task/62-housings`

## Goal

NW splits "Add Common Housings" (#120) and "Create Custom Housings" (#126) into two sidebar entries; in NeonBench they share the same data model and most of the same UI, so this spec ships both at once. The single concept is **electrode housing**: the porcelain or ceramic enclosure that holds the spring contact at the cabinet end of an electrode lead-in (Miller Ch.IV p.62; Strattman Table 3.4). Today, a NeonBench `Electrode` is just a `PointIndex` — bare placement, no hardware metadata.

This spec extends `Electrode` with three optional fields (`HousingType`, `BoreDiameterMM`, `ElevationMM`) and adds a "Housings" sidebar action that opens a modal letting the operator pick a stock shell ("Common Housings": 15-shell `3/8" × 1-5/16"` or 19-shell `1/2" × 1-5/8"` per Strattman) or enter a custom bore + elevation ("Custom Housings"). The values flow into the print PDF (a "Housings" callout table on the bend list page) and into the 3D preview (housings render as small cylinders at each electrode position, matching the chosen bore size).

"Done" means: every electrode in a project has an editable housing record (defaults to `HousingType="none"`); operators can right-click any electrode pin in the canvas and pick a stock shell or enter custom dimensions; the bend-list PDF gets a per-run housings table; the 3D preview shows housing cylinders at each electrode position.

## Branch + setup

```sh
git fetch origin
git checkout -b task/62-housings origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/designdoc/types.go` — extend `Electrode`:
  ```go
  type Electrode struct {
      PointIndex     int     `json:"point_index"`
      HousingType    string  `json:"housing_type,omitempty"`     // "" | "shell-15" | "shell-19" | "custom"
      BoreDiameterMM float64 `json:"bore_diameter_mm,omitempty"` // populated for "custom"; ignored for stock shells
      ElevationMM    float64 `json:"elevation_mm,omitempty"`     // mounting height above substrate (mm)
  }
  ```
- `web/src/lib/housingLibrary.ts` (NEW) — the stock-shell dimensions table:
  ```ts
  export const HOUSING_LIBRARY = {
    "shell-15": { boreMM: 9.5,  outsideMM: 33.3, label: "15-shell (3/8\" × 1-5/16\")" },
    "shell-19": { boreMM: 12.7, outsideMM: 41.3, label: "19-shell (1/2\" × 1-5/8\")"  },
  } as const;
  ```
- `web/src/lib/housingLibrary.test.ts` (NEW) — tests covering: lookup of stock shells; custom housings return user-provided dimensions; resolved bore for `housing_type=""` is 0 (sentinel for "no housing").
- `web/src/lib/docOps.ts` — new `setElectrodeHousing(doc, runId, electrodeIndex, housing)` operation. Pure function, returns new Doc with the electrode's three housing fields updated. Reject if `housing.housing_type` not in `["", "shell-15", "shell-19", "custom"]`.
- `web/src/lib/docOps.test.ts` — three new tests: stock shell preserves library defaults; custom housing accepts arbitrary positive numbers; invalid housing_type throws.
- `web/src/components/HousingPickerModal.tsx` (NEW) — the modal component. Two tabs: "Common" (radio buttons for the two stock shells) and "Custom" (number inputs for bore + elevation). Save dispatches `setElectrodeHousing()` via `editDoc`.
- `web/src/components/EditorCanvas.tsx` — right-click on an electrode pin opens the housing picker via a new `onElectrodeContextMenu` callback prop. Hover state shows a small ⚙ icon overlay on each electrode pin to indicate the affordance is there.
- `web/src/pages/EditorPage.tsx` — wire `onElectrodeContextMenu` to mount the modal with the correct run+electrode context.
- `internal/printpdf/render.go` — add a "Housings" subsection to the bend-list page: small table per run listing each electrode with its housing type, bore size, and elevation. Skip the table for runs with no electrode having a configured housing.
- `web/src/preview/Electrode.tsx` — read the electrode's housing fields; if configured, render a small cylinder at the electrode position whose radius matches the bore (defaults to a thin shaft if no housing configured, matching today's behavior).

**New:**

- `specs/active/tier3-62-housings-common-and-custom.md` (this file) — moved to `specs/done/` on completion.

**Don't touch:**

- `internal/storage/migrations/` — no migration. `Electrode` is stored inside `design_versions.doc_json`; new optional fields deserialize with zero values for old blobs (Go's `omitempty` semantics).
- `validate/rules.go` — no validator implications; housing dimensions don't gate the validator in V1.
- `Tube.tsx` — primary tube material is unchanged.

## Deliverables

### Doc model

`Electrode` gains three optional fields, all omitempty. Existing saved design versions deserialize cleanly with zero values for all three (effectively "no housing"). Rountrip-test this in `internal/server/integration_test.go`.

### Stock library

```ts
HOUSING_LIBRARY = {
  "shell-15": { boreMM: 9.5,  outsideMM: 33.3, label: "15-shell (3/8\" × 1-5/16\")" },
  "shell-19": { boreMM: 12.7, outsideMM: 41.3, label: "19-shell (1/2\" × 1-5/8\")"  },
}
```

Citations in JSDoc: Strattman Ch.3 Table 3.4 for the dimensions; "common" trade convention is one of these two for ~95% of installs.

### Operation

```ts
function setElectrodeHousing(
  doc: DesignDoc,
  runId: string,
  electrodeIndex: number,  // index INTO run.electrodes, not point index
  housing: {
    housing_type: "" | "shell-15" | "shell-19" | "custom";
    bore_diameter_mm?: number;  // required when housing_type === "custom"
    elevation_mm?: number;      // optional always
  },
): DesignDoc;
```

Validation: throw `OperationError` if `housing_type === "custom"` and `bore_diameter_mm` is missing or `<= 0`. Stock shells silently overwrite any user-provided bore (the library is authoritative).

### UX

- Right-click an electrode pin → housing picker modal opens, contextual to that electrode.
- Two tabs: "Common" (radio) + "Custom" (numeric inputs with mm suffix).
- "None" option in Common tab clears the housing.
- Save closes the modal and pushes a new doc state via `editDoc`.
- Cancel closes without changes.

### Print rendering

On the bend-list page, after the existing per-run bend-count summary, add a "Housings" subsection:

```
Housings:
  E1 — 15-shell (bore 9.5 mm, elev 50 mm)
  E2 — Custom (bore 11.0 mm, elev 75 mm)
```

Skip the section entirely if no electrode in this run has a configured housing.

### 3D preview

In `Electrode.tsx`:
- If the electrode has `housing_type` set, render a `<cylinderGeometry>` whose radius matches the bore (resolved via `housingLibrary` for stock; raw value for custom).
- Cylinder height: 30 mm default; rotation aligned to the polyline tangent at the electrode point (Phase 3 #6 already computes this tangent).
- Material: `meshStandardMaterial color="#666" roughness=0.4 metalness=0.6` to suggest a porcelain housing in the ambient light.

## Constraints

- **No new third-party deps.**
- **No migration** — `Electrode` lives in JSON blob storage.
- **Backwards compat** — old blobs deserialize with zero values; the editor sees electrodes with `HousingType=""` and treats them as "no housing".
- **Stock library is read-only** at runtime — adding a new shell size is a code change. (Operator-extensible library deferred.)
- **Per-electrode UI only**; no batch "set all electrodes to 15-shell" in V1 (also deferred).

## Geometry / algorithms

Trivial:

1. **Stock-shell resolution**: lookup in `HOUSING_LIBRARY`. Returns `{boreMM, outsideMM, label}`.
2. **3D cylinder placement**: position = electrode world position; orientation = polyline tangent at that point (already computed by Phase 3 #6's `computeElectrodeTangent`).
3. **PDF table layout**: columns [Electrode index, Type label, Bore (mm), Elevation (mm)]; right-aligned numbers.

## Tests

- **`housingLibrary.test.ts`**: lookup returns expected shells; custom is identity; empty returns sentinel.
- **`docOps.test.ts`**: stock-shell set; custom-housing set with valid inputs; custom rejects missing bore; invalid housing_type throws.
- **`integration_test.go`**: round-trip — create doc with one electrode → set housing via API or save-design path → reload → assert all three fields persist.
- **`render.go`**: golden test — small doc with two electrodes (one stock, one custom). PDF byte-compare against `internal/printpdf/testdata/housings_golden.pdf`.

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run build )
go vet ./...
( cd web && npm run lint )
```

Manual smoke:

1. Open a project with at least one electrode placed.
2. Right-click the electrode pin; modal opens.
3. Pick "15-shell"; save; reload page; housing persists.
4. Print the project; bend list shows "Housings" subsection with the correct row.
5. Open 3D preview; small cylinder appears at the electrode position with bore-matching radius.
6. Switch to "Custom" tab; enter bore=11.0, elevation=75; save; PDF + 3D preview update accordingly.

## Workflow

1. Backend: extend `Electrode` struct; add JSON round-trip integration test.
2. Frontend: stock library + `setElectrodeHousing` op + tests.
3. UI: HousingPickerModal + EditorCanvas right-click wiring + EditorPage modal mount.
4. Print: bend-list "Housings" subsection + golden.
5. 3D: cylinder rendering in Electrode.tsx.
6. Pre-merge checks + manual smoke.
7. Open PR titled "Electrode housings: common shells + custom (Tier 3 #62, NW #120 + #126)".
8. Move spec `specs/active/ → specs/done/` in final commit.

## Report back

Under 300 words. Include:

- PR URL
- File deltas
- Tests added (count by file)
- CI state
- Judgment calls — particularly: did the right-click affordance feel natural in manual smoke, or does this need a sidebar action too? How did the 3D cylinder integrate with Phase 3 #6's existing electrode-cap geometry (replace, layer on top, or skip if a housing is set)?
- Tier 3 follow-ups: batch "set all electrodes" action; operator-extensible housing library (JSON file in app-data); housing-aware bend-radius validation (housings consume the first ~50 mm of each end, reducing usable lead-in length); raceway-mounted housing detection (group electrodes whose elevations cluster).
