# Tier 2 #98 — Union overlapping outlines ("Weld")

> **Status:** active · drafted 2026-08-31 · branch `task/2-outline-union`

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

## The dependency question — resolve before implementing

Robust polygon booleans are genuinely hard: co-linear edges, touching vertices,
self-intersections, and holes all have to be right or the result is a shape
that looks fine and cannot be bent. Options:

1. **A library.** `github.com/ctessum/polyclip-go` or a Go port of Clipper for
   the backend; `polygon-clipping` npm for the frontend.
2. **Hand-rolled Greiner–Hormann / Vatti.** No dep, but this is exactly the
   category of algorithm where "works on my test cases" hides for months.

CLAUDE.md requires asking the user before adding any dependency. **Stop and ask
before writing code**, with a recommendation and the size of each option. Note
that `web/src/lib/shapes/offset.ts` already has `segmentIntersection`,
`trimSelfIntersections` and `signedArea`, so some machinery exists — evaluate
whether it is a foundation or a false friend.

Whichever side computes it, decide deliberately: the frontend already owns
Neonize and the offset code, which argues for TS.

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
