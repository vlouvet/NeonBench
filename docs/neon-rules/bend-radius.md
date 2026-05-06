# Bend radius

## What the four PDFs say

**Nothing quantitative.** Neither *Saving Neon* nor any of the three Blazek alphabet books give a numeric minimum bend radius for any tube diameter. This is the single biggest gap in our research sources.

What the sources *do* say, qualitatively:

- **Bend types are categorical, not parametric.** Blazek (Book 1, p. 4 of intro illustrations) names the bends as a finite vocabulary:
  - **90° Bend** — the corner bend (e.g. first bend of letter "E")
  - **50° Bend** — acute (e.g. bends 1 and 2 of letter "Z")
  - **180° Bend** — also called "double back" / "DB" — second bend of letter "E"
  - **Rise or Drop** — Z-shaped offset (last bends of "E", bends 6 and 8 of "E")
  - **Crossfire Flyover with Rise and Drop** — script bend
  - **Ribbon Fire Flyover** — produced in one ribbon heat (script "D", "H")
  - **Double Back with Angle** — combination (first bend of "V", "W")
  - **Ribbon Heat** (Book 2 script pages)
  - **Correction Bend** (Book 2 script pages)
- **The bender heats one section at a time on a gas-fired ribbon burner**, makes the bend in mid-air against the pattern, and adjusts before it cools — "all in about five seconds" *(Saving Neon, p. 19)*.
- **Air pressure prevents collapse:** the bender puffs through a latex hose corked at one end so the heated section doesn't collapse — i.e. there is a real minimum radius below which the tube pinches/collapses, but the source doesn't state the number *(Saving Neon, p. 19)*.

## Implication for validation

The PDFs treat bend radius as the bender's craft, not a CAD parameter. They do not validate our code's defaults of 16 / 20 / 25 / 30 mm for tube ø 8 / 10 / 12 / 15 mm.

What the PDFs *do* support:

- A **double-back** is a specific named operation that is structurally different from a generic small-radius bend. A 180° hairpin around a single point is recognized and constructible — see Blazek's "180 Degree Bend" illustration. **We should not flag a double-back as a "tight bend" error**; if anything, double-backs may need their *own* clearance rule (see `spacing.md`).
- 50° (acute) bends are a normal vocabulary item, not an exception.

## Current code vs gap

| | Code default | Source | Verdict |
|---|---|---|---|
| Min bend radius @ 8mm | 16mm | (none) | unverified |
| Min bend radius @ 10mm | 20mm | (none) | unverified |
| Min bend radius @ 12mm | 25mm | (none) | unverified |
| Min bend radius @ 15mm | 30mm | (none) | unverified |

**Recommendation**: leave defaults in place but add a note in code that they are unverified. Pull from *Neon Techniques* (Miller/Strattman) or *Neon Engineers Notebook* (Crook/Fishman) when those become available. See `missing-rules.md`.

**Anti-pattern flag**: the rule should distinguish between *continuous-arc tight bends* (problem) and *180° double-backs* (legitimate construction). Our current 3-point circumradius check probably treats a perfect hairpin as a near-zero-radius failure. If we look at a double-back, the local radius is small *by design*; the bender intentionally bends a tight U. Validate by recognizing the bend type, not just the geometry. See `glossary.md` and `letter-construction.md`.
