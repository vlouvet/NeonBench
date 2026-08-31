# Bug #09 — 3D preview renders crossing tubes coplanar ("glass crosses glass")

> **Status:** shipped (remedy 1) · drafted 2026-06-05 · found via Playwright manual-authoring session (cursive "Salon" build, project 16) · branch (when dispatched) `task/bug-09-preview-crossing-depth`

## Goal

In the 3D preview, wherever two tubes cross, they render at the **same standoff plane** and the glass
visibly passes **through** the other tube. Real neon can't do that — at a crossing one tube either
**jumps over** the other (lifted standoff) or the crossing is hidden with **block-out paint** and the
tubes sit on different planes.

"Done" means a design with tube crossings no longer shows interpenetrating glass in the preview by
default — either by auto-offsetting depth at detected crossings, or by making the existing jump
workflow discoverable enough that the common path produces a physically-plausible render.

## Reproduction (Playwright-verified)

1. New project → **8 mm** tube spec → editor → **Add text** `Salon`, **Cursive** font, cap height 220 mm → Insert.
2. The validator reports **4 × `crossing_needs_blockout`** (connected cursive crosses itself).
3. Open the **3D preview** (any camera with an oblique angle, e.g. **Iso**). At each crossing the two
   pink tubes intersect flat — glass through glass. See the originally-flagged frame:
   `.playwright-mcp/Salon-preview-2026-06-05T06-14-30Z.png` (not committed; reproduce locally).

## Root cause (code-verified)

- The preview lifts a tube in Z **only** where a `kind: 'jump'` annotation is explicitly placed
  (Tier 3 #68), via the kernel in [web/src/preview/tube-geom.ts](../../web/src/preview/tube-geom.ts)
  (`JUMP_LIFT_HEIGHT_MULT = 2.5`, `JUMP_LIFT_SPAN_MULT = 4.0`). A `drop_bend` dips
  (`DROP_BEND_LIFT_HEIGHT_MULT = 0.5`). With **no** jump at a crossing, both tubes keep the same Z and
  interpenetrate.
- Nothing connects the validator's `crossing_needs_blockout` finding to the jump tool: the warning is
  about **block-out paint** (hiding the unlit tube), a *different* real-world remedy than a jump
  (physical routing). A user who paints the crossing still gets coplanar glass in 3D.
- The jump lift is **2.5 × diameter** (≈ 20 mm at 8 mm tube). Against a ~1.4 m-wide sign the lift is
  geometrically correct (it produces proper occlusion in the **Front** camera) but visually subtle in
  oblique views — easy to mistake for "still crossing."

## Why it matters

The 3D preview is the customer-facing sign-off render. Glass-through-glass reads as broken, and it
mis-teaches the engineering: every crossing is a real fabrication decision (jump vs. paint vs. split).
Today the designer must already *know* to hide the validation markers, then hand-mark a jump on each
crossing — discovered only by reading the code.

## Proposed remedies (pick one or combine)

1. **Auto-depth at detected crossings (preferred).** Where the geometry detects a crossing, give the
   "under" tube a small deterministic Z-offset in the preview even without an explicit jump, so glass
   never interpenetrates by default. Keep explicit jumps as the larger, intentional horseshoe.
2. **Link the warning to the fix.** On a `crossing_needs_blockout` finding, offer a one-click
   *"mark jump-over here"* (and/or *"mark block-out here"*) that drops the annotation at the crossing
   point on the appropriate run.
3. **Make the lift legible.** Revisit `JUMP_LIFT_HEIGHT_MULT` / falloff so a marked jump reads as a
   clear over-pass at storefront scale, not a 20 mm bump.

Option 1 fixes the default render with no user action; option 2 makes the existing model
discoverable; option 3 is polish. 1 + 2 together is the complete fix.

## Workaround (used in the user manual walkthrough)

Hide the warning/error markers (the **Show warnings / Show errors** toggles) so the marker glyphs
don't intercept clicks, activate **Mark jump**, and click each crossing. Confirm with the **Side**
camera (standoff profile). Documented in [docs/USER_MANUAL.md](../../docs/USER_MANUAL.md) Part 2 Step 6.

## Tests

- `web/src/preview/tube-geom.test.ts` — add a case: two runs crossing at a shared XY with **no** jump
  annotation produce **different** Z at the crossing (option 1), so they don't interpenetrate.
- If option 2: a unit test that a `crossing_needs_blockout` finding exposes a crossing point + run id
  that the "mark jump" action can consume.

## Out of scope

Block-out **paint rendering** in 3D (showing the opaque painted segment) — that's a separate
visual-fidelity item; this spec is only about tubes not occupying the same space.


## What shipped (2026-08-31)

**Remedy 1 — auto-depth at detected crossings.** Remedies 2 (link the warning to
a one-click "mark jump") and 3 (retune `JUMP_LIFT_HEIGHT_MULT` for legibility at
storefront scale) are **not** done and remain open follow-ups.

The framing was sharpened by the user during implementation: **glass can stack,
but must not intersect.** Tubes sitting at different standoff depths is real
neon; interpenetration is not. That converts the goal into a hard geometric
constraint — two tubes of diameter dA and dB clear each other once their centre
lines are `(dA + dB) / 2` apart — rather than a matter of taste.
`AUTO_CROSSING_LIFT_HEIGHT_MULT = 1.25` carries 25% over that minimum, and stays
well under a jump's 2.5× so an explicit jump still reads as the louder,
intentional gesture (`max()` composition lets it win where both apply).

Detection is **segment-pairwise**, not run-pairwise, because the originating
repro is a cursive "Salon" whose single connected run crosses *itself*. Per-run
depth layering cannot fix that case at all.

### The trap this hit, recorded so it is not re-introduced

The first implementation computed the correct crossing arc position and still
rendered **byte-identically** to `main`. `liftPointsAtJumps` returns one Z per
*existing vertex*, and a crossing halfway along a two-point line has no vertex
inside the falloff — so every vertex evaluated to zero and the glass kept
interpenetrating. Dense vectorised polylines happen to carry a vertex close
enough, which is why the unit tests passed; **Line and Rect output is sparse, so
the common hand-drawn case was entirely unfixed.** `densifyAroundArcs` now
inserts vertices around each crossing (locally only — a 10 m run with one
crossing gains a handful of points, not thousands) and returns an index map so
jump / drop-bend indices survive.

This was caught only by rendering both builds and diffing the images. A unit
test alone would have shipped it.

### Verification

Playwright against real Windows builds of `main` and the fix, on a doc with an
explicit X crossing plus a self-crossing bow-tie:

| camera | `main` | fixed |
|---|---|---|
| Iso | crossings merge flat | visible depth break at both crossings |
| **Side** (standoff profile) | **perfectly flat bar** — all tubes coplanar | crossing tube stands proud of the backing plane |

Renders were compared by hash, not by eye — the first (broken) attempt produced
images identical to `main`, which is precisely what eyeballing a bloom-heavy
neon render would have missed.
