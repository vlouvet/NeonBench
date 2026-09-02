# Bug #18 — a closed run's closing segment is drawn straight and measured curved

> **Status:** done · found 2026-09-01 while implementing Tier 3 #111.
> Fixed by the "honour it" option. A THIRD consumer with the same hole turned up
> during the fix and moved with the twins: `RenderFromDoc` in
> `internal/printpdf/render.go` closed a closed run with a straight `LineTo`, so
> the bender's printed pattern would have kept the chord after the canvas and
> the SVG learned the curve. The DXF emitter was already correct — it writes a
> vertex bulge for `SegmentType(i)` at every vertex including `n-1`, so a
> closing arc has always reached CAM.

## Symptom

`setSegmentType` accepts `segmentIndex` up to `segmentCount(run) - 1`, and for a
CLOSED run `segmentCount` is `n` — the last entry describes the closing segment
from `points[n-1]` back to `points[0]`. So an operator can mark a loop's closing
segment as an arc, and the doc stores it happily.

Three consumers then disagree about what that means:

| consumer | closing arc |
|---|---|
| `indicesToD` (`web/src/lib/runArcs.ts`) — what the canvas draws | **ignored**, emits a bare `Z` |
| `emitPath` (`internal/designdoc/convert.go`) — SVG for the validator, PDF, DXF | **ignored**, emits a bare `Z` |
| `flatRunPoints` / `runPathDistanceMM` (`web/src/lib/arcGeom.ts`) | **honoured**, flattens the arc |

## Evidence

A 100mm closed square through the real Go pipeline
(`designdoc.ToSVG` → `validate.ExtractMMPolylines` → `(*Polyline).Length()`):

```
segment_types ["arc","arc","arc","arc"]  →  98 pts, Length = 447.6891
segment_types ["arc","arc","arc","line"] →  98 pts, Length = 447.6891
```

Identical. Four arcs measure the same as three arcs plus a straight closing
chord (3 × 115.8964 + 100 = 447.689), because the fourth is never emitted as a
curve. `flatRunPoints` on the same run returns 463.51 — it walks the closing
arc.

## Why it matters

The two loops that read `flatRunPoints` — the curve-aware hit test (Tier 3 #87)
and now the arc-aware run length (Tier 3 #111) — measure glass the operator
cannot see and the bender will never receive. It is the same "shown one shape,
handed another" failure the arc twins exist to prevent (`CLAUDE.md` →
Recurring bug classes → 4), just confined to one segment.

Low blast radius today: it needs a closed run whose *closing* segment was
deliberately curved. It is trivially reachable from the UI, though, and both
consumers of `flatRunPoints` are new.

## Fix

Decide which side is right and move both twins together:

- **Honour it** (preferred — the field exists, the editor lets you set it):
  `indicesToD` and `emitPath` walk the wrap-around segment through
  `arcCubics` before emitting `Z`. Both already resolve the segment index for
  every other step via `segmentIndexBetween` / `SegmentIndexBetween`, which
  handles `n-1 → 0`; the closing step just never asks.
- **Or forbid it**: `setSegmentType` refuses `segmentIndex === n-1` on a closed
  run, and the Go decoder rejects an arc there. Cheaper, but it makes a whole
  circle undrawable as arcs, which is a shape operators do want.

Either way, pin it with a Go/TS agreement test on a closed run whose closing
segment is curved — the case that currently disagrees by 15.9mm on a 100mm
chord.
