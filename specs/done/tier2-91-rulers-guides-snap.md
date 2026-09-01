# Tier 2 #91 — Rulers, construction guides, and snap-to-guides

> **Status:** active · started 2026-08-31 · branch `task/2-rulers-guides`

## Goal

The editor has grid snap, geometry snap, and angle snap, but no way to say
"this baseline, right here" and have everything line up to it. Layout artists
work from guides pulled off a ruler. This slice adds the standard trio:
mm rulers along the canvas top and left, drag-off-the-ruler construction
guides, and snap-to-guides wired into the existing snap chain.

Closes three NeonWizard Design Tools parity rows (rulers, guidelines,
snap-to-guides).

## Branch + setup

```sh
git checkout -b task/2-rulers-guides origin/main
./scripts/setup-hooks.sh
( cd web && npm install && npm run build )   # required before any Go command
```

## Premises already verified — do not re-derive, but do sanity-check

- `Doc.Guidelines []Guideline` **already exists** (`internal/designdoc/types.go`),
  added for Tier 2 #74. Today `Guideline` is `{ID, Kind, YMM}` with `Kind`
  taking exactly one value, `"raceway"`, and a horizontal-only Y.
- The doc comment on `Guideline` already anticipates this slice: *"Kind is an
  enum so vertical guidelines for stacked-letter signs can be added later
  without a breaking change."* You are cashing that in.
- Raceway guidelines are load-bearing: `splitTubesAtRaceway` stamps
  `Guideline.ID` onto each split run as `raceway_id`, which is what groups the
  pieces into one combined strip page in the PDF. **Construction guides must
  never enter that path.**
- `internal/server/json.go` sets `DisallowUnknownFields()`. Any field you add
  to the TS type without adding it to the Go struct makes every save 400.

## Strict file scope

**New:**

- `web/src/components/CanvasRulers.tsx` — the two ruler gutters
- `web/src/lib/guides.ts` + `web/src/lib/guides.test.ts` — tick generation,
  guide CRUD helpers, guide snapping

**Modify:**

- `internal/designdoc/types.go` — extend `Guideline` (see below)
- `internal/designdoc/types_test.go` (or the existing guideline test file) —
  round-trip + validation tests for the new kind/axis
- `web/src/api.ts` — mirror the type change
- `web/src/lib/snap.ts` + `snap.test.ts` — add guide snapping to `composeSnap`
- `web/src/components/EditorCanvas.tsx` — render rulers + guides, drag-create,
  drag-move, delete
- `web/src/pages/EditorPage.tsx` — a "Rulers & guides" toggle group only.
  Keep this diff SMALL; a parallel agent is adding a sidebar panel to this file.
- `README.md`

**Don't touch:** `web/src/lib/docOps.ts` (beyond reading it),
`web/src/lib/arrange.ts` / `ArrangePanel.tsx` (parallel agent),
`internal/printpdf/**` (parallel agent), `todo.md`.

## Schema change (additive only)

```go
type Guideline struct {
    ID   string  `json:"id"`
    Kind string  `json:"kind"`             // "raceway" | "construction"
    YMM  float64 `json:"y_mm"`             // horizontal position; 0 for vertical guides
    XMM  float64 `json:"x_mm,omitempty"`   // vertical position; omitted for horizontal
    Axis string  `json:"axis,omitempty"`   // "" | "h" (default) | "v"
}
```

`omitempty` on the two new fields is required, not cosmetic: it keeps every
pre-existing doc's JSON byte-identical, which is the back-compat invariant this
codebase uses elsewhere (`Group.Visible`, `Doc.Guidelines` itself).

Rules to enforce in `UnmarshalJSON` and to test:

- `axis` empty or `"h"` → horizontal, position is `y_mm`
- `axis == "v"` → vertical, position is `x_mm`
- `kind == "raceway"` **must** be horizontal; reject a vertical raceway guide
  with a clear error rather than silently producing a strip page that cannot
  exist
- any other `kind` or `axis` value is an error

No migration is needed — guidelines live inside the design-doc JSON blob.

## Deliverables

1. **Rulers.** A ~22px gutter top and left, ticks in mm, labelled at a decade
   that stays legible across the zoom range (pick from a 1/2/5/10/20/50/100…
   ladder against the current `scale`, so labels never collide). A cursor
   position indicator on each ruler. Rulers respect pan and zoom exactly — a
   tick at 100 mm must sit on the geometry at 100 mm at every zoom level. Hide
   behind the toggle; default on.
2. **Drag-create.** Press on the top ruler and drag into the canvas to create a
   horizontal guide; the left ruler creates a vertical one. Kind is
   `"construction"`. Dropping back onto the ruler cancels.
3. **Move / delete.** Drag an existing guide to move it; `Delete`/`Backspace`
   with a guide selected removes it; `Escape` deselects. The raceway guideline
   already implements select/move/delete in `EditorCanvas.tsx` — extend that
   code path rather than adding a second parallel one.
4. **Visual distinction.** Construction guides render in a different colour
   from the raceway guideline and are clearly not the same object — the
   raceway guide means "tubes get cut here", a construction guide means
   nothing to the fabricator. Both must be visually distinct from grid lines.
5. **Snap-to-guides.** Extend `composeSnap` with an optional `guides` input.
   Priority: **geometry > guides > angle > grid**. Geometry keeps the top slot
   because "land exactly on this existing vertex" is a harder promise than
   "land on this construction line". A guide snap locks only its own axis; the
   other coordinate is still free (or still grid-snapped). Snapping to a
   horizontal and a vertical guide at once must produce the intersection.
   Gate on the same snap-enabled toggle as grid snap.
6. **Print/DXF stay clean.** Construction guides must not appear in any
   emitted artifact. Verify by rendering a `print.pdf` for a doc with guides
   and confirming no new marks — and confirm the raceway strip page still
   appears for a doc with a raceway guide (this is the regression that matters).

## Constraints

- No new dependencies.
- Guide ids come from the existing `nextGuidelineId(doc)` so raceway and
  construction guides share one id space (`raceway_id` FKs stay unambiguous).
- Do not change `splitTubesAtRaceway`, `addRacewayGuideline`, or the raceway
  strip emitters. If a construction guide reaches any of them, that is a bug in
  your filtering.
- Keep the `EditorPage.tsx` diff to the toggle group. Everything else lives in
  `EditorCanvas.tsx` or the new files.

## Tests

Go (`internal/designdoc`):

- round-trip a doc with horizontal + vertical construction guides and a raceway
  guide; assert byte-identical JSON for a doc with only a legacy `{id,kind,y_mm}`
  guideline (the omitempty invariant)
- reject `kind:"raceway"` with `axis:"v"`; reject unknown kind; reject unknown axis

TS:

- `guides.test.ts` — tick ladder selection at several zoom scales (no label
  collisions, no zero/negative step); guide CRUD; guide hit-testing in screen px
- `snap.test.ts` — guide beats angle and grid, loses to geometry; single-axis
  lock leaves the other coordinate free; h+v guides yield the intersection;
  snapping off disables guide snap

## Pre-merge checks

```sh
./scripts/test.sh
( cd web && npm run lint && npm run build )
go vet ./...
```

Browser smoke test is mandatory here — rulers are pure geometry-under-transform
and unit tests will not catch a pan/zoom sign error. Drag a guide out at 100%,
zoom to 400%, pan, and confirm the guide still sits on the same geometry.
Save a new version and reload to confirm guides persist.

## Out of scope (log as follow-ups)

- Angled / rotated guides
- Guides from object edges ("smart guides" / alignment hints while dragging)
- Locking guides, or a guide manager list in the sidebar
