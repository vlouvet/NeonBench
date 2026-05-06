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

## What Miller (1935) adds

Miller does **not** publish a min-radius-by-diameter table either. The 1935 book treats radius as a function of bender skill, not a tabulated value. What Miller does give:

- **Three named bend categories** (Miller Ch. VII, "Glass Bending"):
  - **The Angle Bend** — "may be a right angle or sharper or broader than a right angle… made in the cross fires" *(Miller, Ch. VII, p. ~116)*. Cross-fire heating concentrates heat to a small section ≈1 in (25 mm) wide.
  - **The Ribbon-burner Bend** — "for the gradual curving or circular bends, the ribbon fire is used… the tubing is laid against the layout while still soft" *(Miller, Ch. VII, p. ~117)*. Used for curved letters O, C, G, B, R.
  - **The Double-back** — "for such letters as R, E, F, G… a longer length of tube is heated, about 1 inch, and more glass is gathered together" *(Miller, Ch. VII, p. 119–120)*. **Treated as a primary construction technique, not an error condition.**
- **Indirect lower-bound clue from a worked example:** Miller's letter-O recipe (Ch. VII, p. 118) builds an **18-in (457 mm) diameter O** from two 46-in lengths of tubing using a **12-in (305 mm) initial bend FB** matched to the arc of the circle, then **18-in bends BD′ and FD** matching the outline, with double-backs at the ends. The smallest planned curvature radius in his largest worked example is therefore on the order of **6 in (152 mm) radius for 12-in-diameter O** *(Miller, p. 118)*. **He does not state a minimum below this.**
- **"Gathering" rule:** Miller repeatedly notes that for short-radius bends the bender must "gather" extra glass at the bend — i.e. push the soft tube together so the wall does not thin out *(Miller, p. 116, p. 119)*. Thinning from a too-tight bend without gathering is the failure mode.
- **"Cold + hot glass" rule:** "On no account should a piece of cold glass be allowed to come into contact with a piece of hot or melted glass" *(Miller, p. 115)* — relevant for double-backs where the returning leg can hit the in-progress bend.
- **Wall-thickness range** of standard G-1 lead glass is **0.045 to 0.060 in (1.14–1.52 mm)** *(Miller, p. 115; also Table VIII)*. Pyrex is 0.040–0.070 in (1.0–1.78 mm) *(Miller, p. ~58)*. Miller does not derive a min-radius rule from wall thickness, but a thicker wall tolerates a tighter bend before it collapses, which justifies using the same tubing for tighter feature work.
- **Letter-size threshold:** "for letters of 12 inches in height or larger, one or more 46-inch lengths of tube must be used for each letter" *(Miller, p. 125)*. Implies that letters under 12 in (305 mm) cap height fit in a single 46-in piece. Below this, splices must be hidden in painted-out crossovers between letters; above this, splices appear inside the letter.

## Implication for validation

The PDFs treat bend radius as the bender's craft, not a CAD parameter. They do not validate our code's defaults of 16 / 20 / 25 / 30 mm for tube ø 8 / 10 / 12 / 15 mm.

What the sources *do* support:

- A **double-back** is a specific named operation that is structurally different from a generic small-radius bend. A 180° hairpin around a single point is recognized and constructible — see Blazek's "180 Degree Bend" illustration **and** Miller, p. 119–120, Fig. 49-A. **We should not flag a double-back as a "tight bend" error**; if anything, double-backs may need their *own* clearance rule (see `spacing.md`).
- 50° (acute) bends are a normal vocabulary item, not an exception.
- For **ribbon-burner curved bends in tall letters**, the practical curvature radius observed in Miller's worked example bottoms out around **150 mm (6 in)** for a 12-mm-diameter tube. This is a *worked-example bound*, not a stated minimum.

## Current code vs gap

| | Code default | Source | Verdict |
|---|---|---|---|
| Min bend radius @ 8mm | 16mm | (none cited) | unverified — Miller silent on per-diameter minimum |
| Min bend radius @ 10mm | 20mm | (none cited) | unverified |
| Min bend radius @ 12mm | 25mm | (none cited); Miller p. 118 worked-example bottom ≈ 150 mm radius for 12-mm tube in an 18-in O | unverified, but our 25 mm is well below the worked-example bound (so likely conservative) |
| Min bend radius @ 15mm | 30mm | (none cited) | unverified |

**Recommendation**: leave defaults in place but add a note in code that they are unverified. Pull from *Neon Techniques* (Miller/Strattman, 1997) or *Neon Engineers Notebook* (Crook/Fishman, 2002) when those become available. See `missing-rules.md`.

**Anti-pattern flag**: the rule should distinguish between *continuous-arc tight bends* (problem) and *180° double-backs* (legitimate construction). Our current 3-point circumradius check probably treats a perfect hairpin as a near-zero-radius failure. If we look at a double-back, the local radius is small *by design*; the bender intentionally bends a tight U. Validate by recognizing the bend type, not just the geometry. See `glossary.md` and `letter-construction.md`.

**New from Miller — letter-size threshold**: above ~305 mm cap height a letter cannot be made from a single 46-in (1168-mm) tube blank, so a *splice* (or planned WELD) is implied *(Miller, p. 125)*. We can warn at this height threshold rather than silently passing. See `letter-construction.md`.
