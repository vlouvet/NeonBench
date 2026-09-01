# Bug #12 — Multi-tile mirrored prints mirror each tile, not the design

> **Status:** active · found 2026-08-31 · blocked on PR #145 merging first

## Symptom

Any design wide enough to need more than one tile column, printed with the
**default** settings, produces a pattern whose horizontal halves are swapped.
Each printed sheet is internally correct; taping them together left-to-right
does not reconstruct the mirrored design.

Mirroring is the trade default (`MirrorOn()` returns true for nil), so this is
the normal path, not an opt-in one. Small signs that fit on one sheet are
unaffected, which is why it has gone unnoticed.

## Evidence

`makePageProjector` (`internal/printpdf/render.go`) anchors the horizontal flip
to the **tile's page rectangle**: `page_x = margin + contentW + tileX - x`.
Probing it directly for a 200 mm design at contentW = 100 mm, margin = 10 mm:

```
tile 0: world x=  0.0 -> page x= 110.0     <- design LEFT edge, on PAGE 1
tile 0: world x=100.0 -> page x=  10.0
tile 1: world x=100.0 -> page x= 110.0
tile 1: world x=200.0 -> page x=  10.0     <- design RIGHT edge, on PAGE 2
```

A correct global mirror puts the design's **right** edge on page 1. The tiling
loop iterates columns in world order and labels them `c+1` with no compensation
(`drawTileOverlay(..., c, r, cols, rows)`), so both the geometry and the
"Tile 1,1 of 2×1" label point at the wrong sheet.

The existing code comment acknowledges the anchor choice — *"anchored to the
tile's page rectangle, not the design's bbox, so the printout stays inside the
page bounds"* — and that reasoning is sound for keeping content on the sheet.
It just does not address which sheet a given strip of the design belongs on.

## Fix options

1. **Reverse the column iteration when mirrored** — emit tile column
   `cols-1-c` first so page 1 carries the design's rightmost strip. Smallest
   diff; the tile labels then need to describe assembly order, not world order,
   and the overlay's "Tile c of N" text must stay consistent with it.
2. **Anchor the flip to the design bbox** — `page_x = margin + (bboxRight - x)
   - tileX'` with the tile origin recomputed in mirrored space. Conceptually
   cleaner (one global transform) but touches the clipping rectangle logic.

Prefer (1) unless it makes the overlay labelling incoherent. Whichever is
chosen, state in a comment why, because the current comment reads as if the
question was already settled.

## Interaction with PR #145

PR #145 (Tier 2 #93) adds rotation and composes it as `R·Mh = Mv·R`, and it
rewrote much of `render.go`. **Do not start this until #145 is merged**, then
branch fresh from `origin/main`. Rotation changes which axis the mirror lands
on, so the fix must be validated with rotate off AND rotate on.

## Strict file scope

**Modify:** `internal/printpdf/render.go`, `internal/printpdf/render_test.go`.
Nothing else.

## Tests

- The probe above, as a real test: for a 2-column mirrored design, the world
  coordinate at the design's right edge must project onto **page 1**.
- Assembling both tiles reconstructs the mirror of the design: for a set of
  known world points, the (page index, page x) pairs must be strictly
  monotonic in mirrored-world x.
- A single-tile mirrored design is unchanged (this is the case that works
  today — pin it so the fix does not regress it).
- Mirrored + rotated multi-tile: verify against a hand-computed point.
- Tile overlay labels match the assembly order the geometry implies.
- Un-mirrored multi-tile output stays byte-identical.

## Smoke test

Render a two-tile-wide asymmetric design (put an obvious feature near the left
edge only), print with defaults, and confirm that feature lands on the sheet
where a taped-up mirrored assembly needs it. Open the actual PDF and look.
