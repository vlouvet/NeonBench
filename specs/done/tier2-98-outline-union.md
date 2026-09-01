# Tier 2 #98 — Union overlapping outlines ("Weld")

> **Status:** done · PR #162 · drafted 2026-08-31 · branch `task/2-outline-union`

## Goal

Script and connected lettering is drawn as overlapping glyph outlines. Neon is
bent as **one continuous tube per stroke**, so before Neonize can run, those
overlapping outlines have to become a single outline. NeonBench cannot do that
today — there is no boolean operation anywhere in the codebase — so connected
script has to be hand-traced.

Closes NeonWizard Effects **Weld** and **Common Weld**, the two highest-value
unbuilt rows in that category.

## ⚠️ Do not call this "weld"

`weld` already means something else here: `internal/validate/rules.go` uses
`weldRadius` for a **physical glass weld**, the joint where a glassblower fuses
two tubes, and the spacing rules depend on it. A boolean-union feature sharing
that name would make both unreadable. Use **union** / **merge outlines** in
code, UI and tests. Reference NW's "Weld" only in the parity table.

## The dependency question — RESOLVED

The spec originally said to stop and ask before writing code. That happened,
and the user approved **a TypeScript polygon-boolean library on the frontend**.

**Decision: `martinez-polygon-clipping@0.8.1`, pinned exact, MIT.**

Why this one:

- **TypeScript, frontend.** The frontend already owns Neonize, the offset code
  and `flatRunPoints`, so the union sits next to the code that consumes it and
  the operator sees the result before it is ever saved. A Go implementation
  would have had to re-derive the flattening rules on the other side of the
  Go/TS twin boundary, which CLAUDE.md class 4 is a standing warning about.
- **Not `polygon-clipping`.** That is the more famous npm package, and it was
  checked first: unpublished since 2023 and roughly half the weekly downloads.
  Martinez is maintained (last published 2025-12), MIT, 36 kB unpacked, ships
  its own `.d.ts`, and depends only on `robust-predicates`, `splaytree` and
  `tinyqueue`.
- **Not hand-rolled.** Greiner–Hormann and Vatti are exactly the category the
  spec warned about, and the probes below show why: the failure modes are
  tangency and degeneracy, not the happy path.
- **`shapes/offset.ts` is a false friend.** It has `segmentIntersection`,
  `trimSelfIntersections` and `signedArea`, but no sweep-line, no event queue
  and no ring classification. `signedArea` and `fonts/outline.ts`'s
  `pointInPolygon` are reused; nothing else was a foundation.

**Bundle cost: paid on first use only.** `EditorPage` reaches the module
through `await import('../lib/booleanOps')`, the way PR #158 lazy-loads
opentype.js. Measured with vite 8: main chunk 583.98 kB / 169.47 kB gzip
before, 586.33 kB / 170.25 kB gzip after (+2.35 kB / +0.78 kB gzip), plus a
23.82 kB / 8.47 kB-gzip `booleanOps` chunk fetched on the first merge. Imported
eagerly it put the main chunk at 612.68 kB / 179.57 kB gzip instead. Confirmed
in a real browser: the chunk is not requested on page load and IS requested on
the click.

**Verified against the library before committing to it** (probes run on 0.8.1,
now pinned as tests in `booleanOps.test.ts`):

| Case | Result |
|---|---|
| Two overlapping squares | one shell, area exactly 175 |
| Full co-linear shared edge | one 200 mm² rectangle, exact |
| Touching at one vertex | reported as two disjoint shells — correct |
| Nested square in square | shell + hole |
| Two overlapping rings ('O' ∪ 'O') | one shell + both counters |
| Counter partly covered by the neighbouring body | counter correctly clipped to 50 mm² |
| Ring without its closing duplicate | **silently wrong** (112.5 instead of 175) — always append the closure |
| Zero-area ring | **throws** — filter degenerates before the call |
| Exactly tangent flattened arcs | **degrades**: main body plus ~8 slivers, ~0.9% of area lost |

The last row is a real limitation and is not in the spec's list of hard cases;
it is reported to the operator rather than hidden (see Deliverables).

## Strict file scope

**New:** `web/src/lib/booleanOps.ts` + tests (or the Go equivalent if the
backend wins the argument above). A sidebar action in the existing panel
pattern.

**Modify:** `web/src/pages/EditorPage.tsx` (one action), `README.md`.

**Don't touch:** `internal/validate/**`, `docOps.ts` beyond adding the op entry.

## Deliverables

1. `unionRuns(doc, runIds)` — replaces two or more **closed** runs with their
   union. Fewer than two closed runs is a no-op returning the same doc object.
2. **Arcs must be flattened first.** A union of curved boundaries has no
   exact representation in `segment_types` (a single fixed bulge of 0.5), so
   flatten via `flatRunPoints` and emit the result as line segments with no
   `segment_types` array. Say so in the UI — the operator is trading curve
   fidelity for a joinable outline, and should know.
3. **Holes.** Two overlapping rings (an O joined to an O) produce an outer
   boundary and inner boundaries. Emit each boundary as its own closed run.
   Do not silently discard holes — a channel-letter face with a dropped
   counter is wrong at the bench, not just on screen.
4. **Carry the classification** per CLAUDE.md's carry-and-remap table:
   `is_channel_letter_face`, `channel_letter_depth_mm`, `raceway_id`,
   `group_id`, `kind`. Union of a face and a face is a face. Refuse to union a
   `jumper` with a live tube and explain why.
5. Electrodes, blockouts, bends and annotations on the inputs **cannot** be
   carried — their indices refer to vertices that no longer exist. Warn and
   drop them explicitly rather than producing garbage indices, and state the
   count in the toast.

## Tests

- Two overlapping squares → one 8-vertex outline of the correct area
- Two disjoint squares → unchanged (a union of disjoint shapes is not one run)
- Nested square in square → outer boundary plus one hole
- Touching-at-a-single-vertex, and sharing a full co-linear edge — the two
  cases that break naive implementations
- An arc run unions correctly after flattening, and the result carries no
  `segment_types`
- Classification carried; a face ∪ face is still a face
- Round-trip: the union saves without a 400 and re-loads identically
- **The consumer test:** union two overlapping letter outlines, Neonize the
  result, and confirm it produces one continuous tube path rather than two

## Out of scope

Intersection, difference, and XOR. Union is the operation the trade needs;
adding the other three is cheap once the library question is settled, but each
needs its own UI affordance and its own answer for holes.

## What shipped — deviations and additions

Everything above shipped. Four things the spec did not anticipate:

1. **The rings have to be nested before they reach the library.** A `DesignRun`
   is one closed polyline, so an 'O' is TWO runs — the same shape
   `fonts/text.ts` already emits. Handing martinez a flat list of rings as one
   polygon applies even-odd across the WHOLE selection, so the overlap of two
   glyph bodies comes back as a hole; probed directly, four rings as one
   polygon returned three polygons including a zero-area triangle.
   `nestRings` builds the containment forest first (even depth = shell, odd =
   hole of its nearest enclosing shell), reusing `pointInPolygon` from
   `fonts/outline.ts`. `booleanOps.test.ts` keeps the un-nested call as a
   **negative control**, so if it ever starts agreeing the nested test stops
   being vacuous (CLAUDE.md class 7).
   The containment test is stricter than the glyph pipeline's three-vertex
   majority vote on purpose: here contours cross by definition, and "mostly
   inside" nests a counter under the wrong parent and fills the hole in.
2. **"Nested square in square" is not a no-op.** The op declines only when
   there were two or more polygons and none of them merged. A single nested
   pair still runs, because resolving it into a shell and an oppositely-wound
   hole is exactly what the spec's test asks for.
3. **Exactly tangent arcs degrade, and the op says so.** See the table above.
   Rings below 0.01 mm² (a 0.1 mm square — three orders of magnitude below
   anything bendable) are dropped and counted; anything larger is KEPT, and a
   union that comes apart into more than one shell warns instead of quietly
   adding runs to the doc. Report, don't repair.
4. **Winding is normalised on the way out** — shells positive, holes negative —
   because martinez returns holes with the same winding as their shell, and
   the rest of the codebase reads a counter's role off the opposite sign.
   Safe here precisely because the output has no arcs; reversing a run WITH
   arcs moves the bow to the other side of the chord (Bug #11).

Follow-ups worth tracking:

- **Cusps at the seam.** The union of two overlapping circles has two sharp
  re-entrant corners, and the validator correctly flags them
  (`min_bend_radius`). An automatic fillet at union cusps belongs with
  `specs/active/tier3-86-corner-fillet-radius.md`.
- **Intersection / difference / XOR** are one function call away now; each
  still needs its own affordance.
- **Simplify after merge.** A merged pair of 96-point circles is 144 points.
  Douglas-Peucker already exists (`simplifyRun`); offering it in the same
  toast would save a trip to the node editor.
- `neonize` drops `is_channel_letter_face`, `raceway_id`, `group_id` and
  `kind` (its `withMeta` carries only diameter, colour and notes). Defensible
  for the face flag — a tube centreline is not a face silhouette — but the
  raceway and group FKs look like an oversight of the same class as Bug #15.
