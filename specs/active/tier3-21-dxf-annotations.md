# Tier 3 #21 — DXF annotations layer (electrodes, labels, dimensions)

> **Status:** active · started 2026-05-07 · branch `task/21-dxf-annotations`

## Goal

PR #12 shipped geometry-only DXF — one `LWPOLYLINE` per run, layered by run ID. CAM software opens it cleanly but bender operators currently can't see *which* run is which, where the electrodes go, or what a measurement means. From `todo.md` Appendix B row 21:

1. Electrode positions emitted as `CIRCLE` entities on a dedicated `ELECTRODES` layer.
2. Run identifiers + free-form `Doc.Labels` emitted as `TEXT` entities on a `LABELS` layer.
3. `Doc.Dimensions` emitted as `LINE` + `TEXT` pairs on a `DIMENSIONS` layer.

"Done" means the DXF still parses in mainstream CAM tools (Pines/Eagle controllers, Mastercam, generic Autodesk viewers), the existing tests pass unchanged, every new entity type has a regression test, and a doc with no electrodes/labels/dimensions produces output that's byte-identical to today's. **G-code direct export** is explicitly out of scope (`todo.md` punts it until a shop asks for a specific bender).

## Branch + setup

```sh
git fetch origin
git checkout -b task/21-dxf-annotations origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command can compile
```

## Strict file scope

You may touch ONLY these files. Do not touch anything else.

**Modify:**

- `internal/printdxf/dxf.go` — add three new entity emitters (electrode CIRCLEs, label TEXTs, dimension LINE+TEXT pairs) alongside the existing LWPOLYLINE emission. Add a `pairFloat`-style helper for radius/text-height if needed; otherwise reuse what's there. Add layer-name constants at the top of the file (`layerElectrodes = "ELECTRODES"`, etc.) so the test file can reference the same strings.
- `internal/printdxf/dxf_test.go` — add tests for each new entity type and a backward-compatibility test asserting that a doc with no electrodes/labels/dimensions produces the same byte output as today's two-polyline golden.

**Don't touch:**

- `internal/server/handlers_dxf.go`, `internal/server/api.go` — handler/route stay identical; same Doc → DXF pipeline, same response shape.
- `internal/designdoc/types.go` — schema is fine as-is; this task consumes existing fields.
- `internal/printpdf/` — entirely separate exporter; do not mirror or refactor anything across.
- Anything in `web/` — pure backend change.
- Storage / migrations — no schema changes.

**New:**

- None. Keep `dxf.go` single-file (it's ~140 lines today; +three emitters and helpers should land it ~280 lines, well within readable scope).

## Deliverables

1. **Electrode markers.** For each `Run.Electrodes[i]`, emit a `CIRCLE` at `Run.Polyline.Points[Electrodes[i].PointIndex]` with radius `3.0 mm`, on layer `ELECTRODES`. Skip silently if `PointIndex` is out of range (the storage layer should prevent this, but defensive index check is cheap).
2. **Run labels.** For each non-empty run, emit a `TEXT` entity on layer `LABELS` at the run's first polyline point, content `"Run N"` (1-based index in `Doc.Runs`), text height `5.0 mm`. The run's full `ID` remains on the LWPOLYLINE's layer name (`RUN_<id>`) so anyone needing the canonical ID has it; the human-readable label is for shop-floor recognition.
3. **Free-form labels.** For each `Doc.Labels[i]`, emit a `TEXT` entity at `(label.X, label.Y)` with content `label.Text`, text height `5.0 mm`, on layer `LABELS` (same layer as run labels — they're the same conceptual category from a CAM perspective).
4. **Dimensions.** For each `Doc.Dimensions[i]`, emit two entities on layer `DIMENSIONS`:
   - One `LINE` from `(X1, Y1)` to `(X2, Y2)`.
   - One `TEXT` at the midpoint of the line with content `"<length> mm"` or `"<length> mm (<note>)"` if `Dimension.Note` is non-empty. Length is `math.Hypot(X2-X1, Y2-Y1)` formatted at 1 decimal place. Text height `5.0 mm`. Offset the text perpendicular to the line by `5.0 mm` (one text-height) so it doesn't sit on top of the line — pick a fixed perpendicular convention (e.g. always offset to the +Y side, or perpendicular to the right-hand normal). Document the convention in a comment.

All three emitters are **append-only** in the existing ENTITIES section — they ship after the LWPOLYLINE loop, in the order: electrodes, run labels, free-form labels, dimensions. A predictable order makes regression diffing easy.

## Constraints

- **No new third-party deps.** R12 ASCII is hand-written; no DXF library.
- **No real `DIMENSION` entities.** True R12 `DIMENSION` requires a `BLOCK` reference for the leader/arrow geometry — 5× the complexity for zero real benefit because every CAM importer renders `LINE + TEXT` identically. This is a deliberate judgment call; mention it in the file header comment so future maintainers don't "fix" it.
- **No schema changes.** This task only adds emission; the design-doc shape is already adequate.
- **Backwards compatibility is a hard requirement.** A doc with empty `Electrodes`, `Labels`, `Dimensions` (which is most of the existing test corpus) MUST produce byte-identical output to the pre-change emitter. Add an explicit test for this.
- **Layer names are stable contracts.** `ELECTRODES`, `LABELS`, `DIMENSIONS` — uppercase, no prefix. The existing `RUN_<id>` convention stays unchanged; do not retroactively prefix it.
- **Coordinate precision stays at 1 decimal place** via the existing `pairFloat` helper. Don't promote to 2 places "for dimensions" — bender CAM truncates anyway and the resulting diff would be noisy.

## Geometry / algorithms

**CIRCLE entity (R12 ASCII).** Group codes:
- `0` `CIRCLE`
- `8` `<layer>`
- `10` `<center-X>`
- `20` `<center-Y>`
- `40` `<radius>`

**TEXT entity (R12 ASCII).** Group codes:
- `0` `TEXT`
- `8` `<layer>`
- `10` `<insert-X>` (left baseline)
- `20` `<insert-Y>`
- `40` `<text-height>`
- `1` `<string>` — must be plain ASCII; substitute `?` for any non-ASCII character (run IDs are alphanumeric in practice, but free-form `Label.Text` may contain anything).

**LINE entity (R12 ASCII).** Group codes:
- `0` `LINE`
- `8` `<layer>`
- `10` `<start-X>` / `20` `<start-Y>`
- `11` `<end-X>` / `21` `<end-Y>`

**Dimension text placement.** Mid-point is `((X1+X2)/2, (Y1+Y2)/2)`. The right-hand perpendicular unit vector is `(dy, -dx) / length`. Offset the mid-point by `5 mm * perpendicular`. If the dimension is a degenerate point (length < 0.01 mm), skip the dimension entirely — emitting a TEXT-only marker without a line is misleading.

**Run-label placement.** Use the first polyline point as the insert. No offset — keeping the label at the polyline endpoint makes it click-locatable in CAM. Multi-run labels at the same coordinate is the user's problem (and the editor should already prevent two runs sharing endpoint 0).

## Tests

Add to `dxf_test.go`. Keep the existing `TestEmitDXFTwoPolylines`, `TestEmitDXFEmptyDoc`, `TestEmitDXFNilDoc`, `TestEmitDXFSkipsEmptyPolylines`, and `TestLayerNameSanitization` exactly as-is — they're the regression net.

New tests:

- **`TestEmitDXFElectrodes`**: a doc with one open run plus two electrodes at point indices 0 and 2. Assert: exactly two `CIRCLE` entities, both on layer `ELECTRODES`, centers match `Polyline.Points[0]` and `Polyline.Points[2]`, radius is `3.0`. Out-of-range PointIndex is silently skipped (test that too: a third electrode at index 99 produces no extra circle).
- **`TestEmitDXFRunLabels`**: a doc with two runs. Assert two `TEXT` entities on `LABELS`, content `"Run 1"` and `"Run 2"`, inserts match each run's first polyline point.
- **`TestEmitDXFFreeFormLabels`**: a doc with `Doc.Labels = [{X:50, Y:50, Text:"transformer"}]`. Assert one additional `TEXT` entity on `LABELS` at `(50, 50)` with content `transformer`.
- **`TestEmitDXFDimensions`**: a doc with `Doc.Dimensions = [{X1:0, Y1:0, X2:100, Y2:0, Note:""}, {X1:0, Y1:0, X2:0, Y2:50, Note:"centerline"}]`. Assert two `LINE` entities and two `TEXT` entities on `DIMENSIONS`, with text content `"100.0 mm"` and `"50.0 mm (centerline)"` respectively.
- **`TestEmitDXFDegenerateDimensionSkipped`**: a `Dimension{X1:0, Y1:0, X2:0.001, Y2:0}` (length < 0.01 mm) produces no LINE and no TEXT.
- **`TestEmitDXFBackwardsCompatible`**: the exact `doc` from `TestEmitDXFTwoPolylines` (no electrodes/labels/dimensions) produces output identical to a frozen golden string. The simplest implementation captures the current output once into a `const wantOutput = "..."` and asserts string equality. This is the regression guard — if a future change to layer ordering or whitespace alters byte-level output for the legacy case, this test catches it.

## Pre-merge checks

```sh
./scripts/test.sh                # Go tests + vitest, all green
( cd web && npm run build )      # tsc -b + vite build
go vet ./...
( cd web && npm run lint )       # advisory; no NEW diagnostics
```

Manual smoke test:

1. Boot the binary, load any project that has runs + at least one electrode + at least one dimension.
2. `curl -O http://localhost:<port>/api/projects/<id>/design_versions/<vid>/print.dxf`.
3. Open the DXF in a free viewer (e.g. https://sharecad.org/, or LibreCAD if installed). Verify electrodes appear as small circles, run labels are visible, and dimension lines + text render correctly.
4. Confirm the file still opens in a CAM importer if you have one available; otherwise grep the output for the new layer names and entity counts.

## Workflow

1. Write the new tests first (TDD-style); they'll fail against the current emitter.
2. Add the layer-name constants + electrode emitter; make `TestEmitDXFElectrodes` pass.
3. Add the run-label + free-form-label emitters; make those tests pass.
4. Add the dimension emitter; make those tests pass.
5. Add `TestEmitDXFBackwardsCompatible` last (after capturing the byte-identical golden).
6. Run `./scripts/test.sh` and the manual smoke test.
7. Open PR titled "DXF annotations: electrodes, labels, dimensions (Tier 3 #21)". Link to `todo.md` Appendix B row 21.
8. **Move this spec** from `specs/active/tier3-21-dxf-annotations.md` to `specs/done/tier3-21-dxf-annotations.md` as part of your final commit.

## Report back

Under 300 words. Include:

- PR URL
- Implementation summary
- Judgment calls — especially the LINE+TEXT vs real DIMENSION call, the perpendicular-offset convention chosen for dimension text, and the run-label content choice (`"Run N"` vs `Run.ID`).
- File-size delta on `dxf.go`
- CI final state
- Tier 3 follow-ups worth tracking (annotation markers for jump/support, blockout shading on a BLOCKOUTS layer, R2000+ DXF dialect for shops that ask, per-bender G-code post-processors)
