# Bend radius

## What the four PDFs say (pre-Strattman)

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

## What Strattman (Neon Techniques, 4th ed., 1997) adds

Strattman's Chapter 7 **"Glass Bending"** is the modern successor to Miller Ch. VII. It is **still qualitative on bend radius — there is no per-diameter minimum-bend-radius table in this book either.** What Strattman *does* add:

- **Heat-zone length rule (Figure 7.20 "Steps to making a basic angle bend"):** the length of glass heated for a right-angle bend is **2× tube diameter** *(NT Fig. 7.20)*. For a 12-mm tube, heat ≈ 24 mm of glass length; for a 15-mm tube, ≈ 30 mm. This is a *heat-zone-length* spec, not a bend-radius spec. It bounds the minimum arc length of a 90° bend at ~2× tube ø. The implied bend radius for a clean 90° at this heat zone is roughly `arc / (π/2) = 2D / 1.571 ≈ 1.27D` — i.e. the inside curvature radius of a clean 90° angle bend is on the order of the tube diameter itself.
- **Three named bend categories (Figure 7.24, Ch. 7 "Bending"):**
  - **Right-angle bend / basic angle bend** — single heat, "pull up" then bend.
  - **Double-back bend** — "the tube is pulled up almost touching the wall thickness with the front of the tube. The double-back bend is straight retained looking right-angle bend." Modern Strattman drawings annotate three states: **correct wall**, **too heavy** (over-gathered, glass walls thick on outer radius), and **too thin** (under-gathered, glass thinned and weak on outer radius). *(NT Ch.7, Fig. 7.24)*. **No numeric threshold given for "too thin" — it is judged visually by the bender.**
  - **Combination bend** — the type of bend where two bends are formed in one heating operation, used for the letter T and similar where a stem joins a horizontal in one operation. *(NT Ch.7)*
- **"Diagnosing a correct bend" panel (Figure 7.21):** explicitly diagrams **correct wall vs. too heavy vs. too thin** as the failure modes of an angle bend. The **inside wall** of the bend should remain at the same wall thickness as the original tube; the **outside wall** thins slightly. If the bender does not gather glass during the bend, the outside wall thins to dangerous levels before the bend angle is reached. This is the failure mode that drives the "minimum bend radius" intuition, but Strattman never quantifies the threshold — it is left to the bender's judgement and to wall-thickness specs of the source tubing.
- **Ribbon-burner bends (Figure 7.25):** for circular shapes (letter O), the ribbon burner heats a long section uniformly, the glass is rolled and bent against the pattern. "Held and rotated approximately one inch above the burner. ... amount of bend per inch of heated length is usually slight so it is often unnecessary to use a blowhose." *(NT Fig. 7.25 caption)*. Confirms Miller's finding that ribbon-burner bends bottom out around 25 mm (1 in) of heated length per increment of bend angle.
- **Bending with fixtures:** "Most neon signage is made in small enough quantities that each operation is done but once and can be done on a glass bending pattern. Production line quantities of signs, however, require techniques to not only speed up production, but to provide uniformity to each tube. ... fixtures around which the heated tube can be bent." *(NT Ch.7, "Bending with fixtures")*. Strattman documents that production benders use jig fixtures for repeatable bend radii — implying that the "correct" bend radius is whatever the fixture is built for, not a universal table.
- **Glass tubing standardization (Table 3.5–3.6, Ch.3):** modern signage glass is **soft soda-lime (lead-free or low-lead)** for most colors and **borosilicate / Pyrex** for hard-glass applications. Wall thickness is **0.042–0.058 in (1.07–1.47 mm)** for clear glass and **0.052–0.058 in (1.32–1.47 mm)** for colored glass *(NT Table 3.10 Glass weights)*. This wall-thickness spec corroborates Miller p. 115 (1.14–1.52 mm) and bounds how tight a bend can be before the outside wall fails.

### What Strattman explicitly does NOT give us

- **No per-diameter minimum-bend-radius table.** Like Miller, Strattman treats bend radius as bender-craft, judged by inspection of the wall thickness of the completed bend. The 4th edition (1997) — written by an MIT-trained scientist-bender — reaches the same conclusion as Miller (1935): the threshold is when the outside wall thins past the original wall spec, and this is judged visually, not by a number.
- **No double-back inner-clearance number.** The "double-back bend" is shown only with the qualitative "tube wall almost touching" annotation in Figure 7.24.

### Supersession note

**Miller (1935) and Strattman (1997) agree that the per-diameter minimum bend radius is not a tabulated quantity in the trade.** Both editions independently reached the same answer 62 years apart. Our code's defaults of 16/20/25/30 mm for tube ø 8/10/12/15 mm therefore have **no numeric source corroboration in the trade literature** and should be marked as our own engineering heuristic, derived from the qualitative "outside wall must not thin below the spec" failure mode.

A **first-principles derivation** consistent with both editions: the outside-wall arc length of a 90° bend of inside radius *r* over tube of OD *D* is `(π/2)(r + D/2)`, while the inside-wall arc length is `(π/2)(r − D/2)`. The ratio of outside thinning is `(r + D/2)/(r − D/2)`. To keep the outside wall at ≥80% of original thickness (a typical engineering target), we need `(r − D/2)/(r + D/2) ≥ 0.8`, i.e. `r ≥ 4.5D/2 = 2.25D`. For 8/10/12/15 mm tubes this gives 18/22.5/27/33.75 mm — **slightly more conservative than our current 16/20/25/30 mm defaults**. Recommend bumping defaults to 18/22/27/34 mm or marking the existing values as "industry-typical lower bound, derived from wall-thinning analysis; neither Miller (1935) nor Strattman (1997) tabulates this."

## Implication for validation

The PDFs treat bend radius as the bender's craft, not a CAD parameter. They do not validate our code's defaults of 16 / 20 / 25 / 30 mm for tube ø 8 / 10 / 12 / 15 mm.

What the sources *do* support:

- A **double-back** is a specific named operation that is structurally different from a generic small-radius bend. A 180° hairpin around a single point is recognized and constructible — see Blazek's "180 Degree Bend" illustration **and** Miller, p. 119–120, Fig. 49-A. **We should not flag a double-back as a "tight bend" error**; if anything, double-backs may need their *own* clearance rule (see `spacing.md`).
- 50° (acute) bends are a normal vocabulary item, not an exception.
- For **ribbon-burner curved bends in tall letters**, the practical curvature radius observed in Miller's worked example bottoms out around **150 mm (6 in)** for a 12-mm-diameter tube. This is a *worked-example bound*, not a stated minimum.

## Current code vs gap

| | Code default | Source | Verdict |
|---|---|---|---|
| Min bend radius @ 8mm | 16mm | (none cited); Miller silent; **NT Fig. 7.20 implies r ≈ 1.27 D = 10 mm minimum from 2× tube ø heat zone** | unverified by table; lower-bound corroborated |
| Min bend radius @ 10mm | 20mm | (none cited); NT 2D heat zone implies r ≈ 13 mm minimum | unverified |
| Min bend radius @ 12mm | 25mm | (none cited); Miller p. 118 worked-example bottom ≈ 150 mm radius for 12-mm tube in an 18-in O; NT 2D heat zone implies r ≈ 15 mm minimum | unverified, but conservative |
| Min bend radius @ 15mm | 30mm | (none cited); NT 2D heat zone implies r ≈ 19 mm minimum | unverified |
| **Heat-zone length for a 90° bend** | not modeled | **NT Fig. 7.20: 2× tube ø** | new informational rule |
| **Wall-thickness preserved on inside of bend** | not modeled | NT Ch.7 Fig. 7.21 ("correct wall / too heavy / too thin"); base wall = NT Table 3.10 (0.042–0.058 in) | failure-mode flag, not numeric |

**Recommendation (post-Strattman, 1997)**: **Strattman confirms Miller — the trade does not tabulate minimum bend radius by diameter.** Both editions defer to bender judgement of the outside-wall thickness post-bend. Our 16/20/25/30 mm defaults remain a NeonBench-internal engineering heuristic with no direct trade citation. Treat them as **industry-typical lower bounds** rather than absolute minima, and add an explicit note in code/docs that the threshold is "outside-wall thickness ≥ ~80% of source spec" rather than a single radius number. See `missing-rules.md`.

**Anti-pattern flag**: the rule should distinguish between *continuous-arc tight bends* (problem) and *180° double-backs* (legitimate construction). Our current 3-point circumradius check probably treats a perfect hairpin as a near-zero-radius failure. If we look at a double-back, the local radius is small *by design*; the bender intentionally bends a tight U. Validate by recognizing the bend type, not just the geometry. See `glossary.md` and `letter-construction.md`.

**New from Miller — letter-size threshold**: above ~305 mm cap height a letter cannot be made from a single 46-in (1168-mm) tube blank, so a *splice* (or planned WELD) is implied *(Miller, p. 125)*. We can warn at this height threshold rather than silently passing. See `letter-construction.md`.
