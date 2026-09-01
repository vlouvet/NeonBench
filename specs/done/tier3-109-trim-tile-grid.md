# Tier 3 #109 — Trim the tile grid to the design extent

**Filed by:** the Bug #12 agent, as a follow-up it deliberately did not fix.
**Class:** correct-but-wasteful output. Nothing here is wrong on paper; it
prints sheets the job does not need.

## Goal

Stop emitting tiles that carry no design. Today a multi-tile print can open
with a nearly blank sheet, and in the worst case a design that fits on **one**
page prints on **four**.

## Premise, verified by probe (2026-09-01)

`tileGrid` (`internal/printpdf/render.go:161`) is:

```go
cols = int(math.Ceil(designW / stepW))
rows = int(math.Ceil(designH / stepH))
```

where `stepW = contentW - OverlapMM`. Using `stepW` as the divisor is the bug:
**the last tile does not advance by `stepW`, it advances by `contentW`.** The
final sheet carries a full content width, not a step, so dividing the whole
design by `stepW` over-counts whenever the remainder falls inside the overlap
band.

Probed against the real default (`contentW = 190`, `OverlapMM = 10`,
`stepW = 180` — the default at `render.go:287`):

```
designW= 190.0  old=2  proposed=1  coverage=190.0 ok=true   <-- OLD WASTES 1 SHEET
designW= 370.0  old=3  proposed=2  coverage=370.0 ok=true   <-- OLD WASTES 1 SHEET
designW= 550.0  old=4  proposed=3  coverage=550.0 ok=true   <-- OLD WASTES 1 SHEET
designW= 730.0  old=5  proposed=4  coverage=730.0 ok=true   <-- OLD WASTES 1 SHEET
designW= 191.0  old=2  proposed=2  coverage=370.0 ok=true
designW= 400.0  old=3  proposed=3  coverage=550.0 ok=true
```

The proposed formula:

```go
if designW <= contentW { cols = 1 } else { cols = 1 + ceil((designW - contentW) / stepW) }
```

**The worst case is a design exactly the content size.** At 190 × 190 mm the
current code returns `cols=2, rows=2` — **four sheets for a one-sheet job.**

The wasteful band is `(k·stepW, k·stepW + overlap]` on each axis, i.e. about
`overlap/stepW` ≈ 5.6% of arbitrary widths per axis at the default settings.

**Why this reads worse than it is on mirrored jobs:** PR #160's fix walks the
mirrored axis backwards, which is correct — but it therefore relocates the
slack to the FIRST sheet. So the waste that used to hide on the last page now
greets the operator on page 1. That is the symptom that got this filed; the
grid math is the cause.

## Deliverables

1. Fix `tileGrid` to take `contentW/contentH` as well as the step, and use the
   formula above. Keep the `< 1` floors.
2. Update all four call sites (`render.go:250`, `:251`, `:351`, `:504`).
   **`:250`/`:251` are the `rotate=fit` comparison** — it asks "how many tiles
   the other way round?" and must keep comparing like with like, so both
   branches must use the new formula.
3. The footer's `Tile c,r of C×R` must stay consistent with the new counts.

## Non-negotiable invariant

**Coverage must never regress.** For every case you test, assert
`(cols-1)*stepW + contentW >= designW`. A formula that drops a sheet the design
actually needs is far worse than a blank sheet — it silently truncates the
pattern, and a truncated full-size pattern is not obviously wrong until it is
taped up on the bench.

## Tests

- Table-driven over the probed widths above, asserting **both** the expected
  count **and** the coverage invariant.
- The 190 × 190 exact-fit case, asserting `1 × 1`. This is the headline case;
  pin it by name.
- **Prove it through a real render, not just the helper.** Count pages from an
  actual `RenderFromDoc` on an exact-content-size design: it must drop from 4
  pages to 1 (plus whatever fixed pages the doc emits — count them before and
  after rather than hardcoding a total).
- A `rotate=fit` case where the old and new formulas would choose *different*
  orientations, so the `:250`/`:251` change is not vacuous.

## Strict file scope

**Modify:** `internal/printpdf/render.go`, `internal/printpdf/render_test.go`.

**Don't touch:** `web/**`, `internal/server/**`. No API or option changes — this
is pure page-count math.
