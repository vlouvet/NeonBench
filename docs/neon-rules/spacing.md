# Tube spacing & clearances

## What the four PDFs say

### Wire spacing (3 inches / ~76mm)

This is the only quantitative spacing rule in any of the four PDFs, and it applies to **GTO wire on the secondary side**, not to the glass tubes themselves:

> "GTO wire leads should be as short as possible and kept at least three inches apart." — *Saving Neon, p. 21*

> For external connections in special cases (e.g. open-panel roof signs): "1) wires do not come into contact with any other metal part; 2) each wire is as short as possible; and 3) wires do not cross and are spaced at least three inches apart." — *Saving Neon, p. 22*

Three inches = **76.2 mm**. This is electrical clearance for high-voltage GTO wire, not glass-to-glass spacing. **Do not apply this directly as a glass-tube clearance.**

### Glass-tube spacing

**No numeric value given** in *Saving Neon* or in any of the Blazek alphabet books.

What we *can* infer:

- **Block-out paint between letters:** "block-out paint should be applied to define letter forms and tube ends" *(Saving Neon, p. 19)*; "applying block-out paint between letters and on the areas of the glass tube that go inside the housing" *(p. 19)*. Block-out paint is the standard way of hiding non-illuminating "jump" sections of tube where it crosses behind another stroke. This implies **tubes can pass over/under each other** as long as the back-jump section is blacked out — i.e. a clearance smaller than tube-spacing-ø is allowed *if the crossing section is hidden by paint*.
- **Tube supports / standoffs:** "Tube supports are mounted on the sign and wired to the glass tubes in order to hold the tubes in place, away from the face of the sign" *(Saving Neon, p. 6)*. Supports establish the **z-offset** of glass from the substrate; this is a distinct dimension from in-plane parallel spacing.
- **Double-tube layouts** in Blazek (every letter has a "DOUBLE TUBE" page) show two parallel tubes following the inside and outside contour of a stroke. The spacing between those two parallel tubes is governed by the stroke width of the letter, which in turn is dictated by the painted/channel design — there is no explicit minimum given by Blazek.
- **Crossfire / Flyover / Ribbon Fire Flyover** bends *(Blazek Book 1 intro)* are explicitly named techniques for one tube to fly over another — i.e. crossings are normal and named.

## What Miller (1935) adds — first quantitative tube-spacing data we have

### Z-offset of tube from substrate (elevation post height)

> "The total height of the post varies according to its use, from about **1⅜ to 2¾ inches**. … Special extension posts are used in window-border signs." *(Miller, Ch. IV, p. 62)*

> "Elevation posts for window border may vary in height from **2 to 6 inches**. Special extensions may be used in conjunction with the standard post to give the necessary height." *(Miller, Ch. XI, p. 201)*

So glass tube standoff from the substrate is:
- **Box / cabinet signs: 35 to 70 mm** (1⅜ to 2¾ in) *(Miller, p. 62)*
- **Window borders: 50 to 152 mm** (2 to 6 in), with extensions allowed beyond *(Miller, p. 201)*

Posts are spaced "**every 15 inches** of tubing but never less than two to a tubing section" *(Miller, p. 98)*. **15 in = 381 mm post-to-post maximum spacing along the tube.**

### High-voltage cable clearance to metal (glass-tube proxy)

> "High-voltage wiring should be kept at least **2¾ inches** away from the near-by metal box of the sign or any other metal parts." *(Miller, Ch. XI, p. 202)*

**2¾ in = 70 mm clearance between high-voltage parts (cable, electrode terminals) and any grounded metal.** This is the closest analogue to a parallel-tube spacing rule that Miller offers: it bounds how close a *secondary-side conductor* (and by extension, an electrode end) may be to any grounded metal. Glass tube body is at the same potential as the cable that drives it, so this 70 mm rule applies to glass-tube-to-cabinet clearance near the electrodes.

### Skeleton-sign cable crossings

> "When one cable crosses another, glass tubing over each cable is used to insulate the two cables from one another (**16-millimeter tubing** can be used)." *(Miller, p. 202)*

So crossings of high-voltage cable are sleeved in 16 mm OD glass. This is the trade's recognized "this is allowed if you sleeve it" pattern — the analog of Blazek's "crossfire flyover" for cable.

### Electrode glass jacket / housing clearances

> "Each electrode receptacle shall be constructed so that, when installed, the spacings mentioned elsewhere in these requirements will be maintained." *(Miller, Appendix I §136, UL Standard p. 275)*

> "[Tube supports] shall maintain the tubing **not less than ¼ in (6.35 mm)** from grounded metal parts. This spacing shall be maintained where the tubing passes through the sign face, if of metal." *(Miller, Appendix I §126, UL Standard p. 275)*

**Tube-glass to grounded-metal minimum: 6.35 mm (¼ in)** per UL 1930. Bushings of "noncombustible insulating material" are recommended where the tubing passes through metal sign faces *(Appendix I §127)*.

### High-voltage spacings table (UL Standard, Appendix I §101–108)

Miller reproduces UL's high-voltage spacing table for parts of *opposite polarity* on the secondary side (cable to cable, electrode to electrode of opposite polarity). The OCR did not capture the table values, but the schema is:

- **Column A**: between uninsulated live parts of opposite polarity, by transformer secondary voltage (5,000 V → 10,000 V → 15,000 V tiers)
- **Column B**: between live parts and grounded metal
- **Column C**: between insulated conductors of opposite polarity

Per common UL 1930 practice (which Miller cites), the typical tier values are: ½ in (12.7 mm) at 5 kV, 1 in (25.4 mm) at 10 kV, 1½ in (38 mm) at 15 kV between insulated conductors of opposite polarity (Column C). **Flag:** these are *electrical* clearances for cable, not for glass tube. We cannot quote a specific number from this table because the OCR is missing values; the table is authoritative for cable spacing only.

### Anti-clustering rule for parallel/doubled-back tubing

> "Among the common causes of radio interference are flickering tubing; overloaded transformers; static or **corona discharges between sections of the same tube, especially in double-backs and crossovers**; corona discharge between tubing and ground (case or frame of sign)…" *(Miller, p. 223)*

> "Occasionally an entire tubing section must be redesigned, so that **long lengths of tubing are not doubled back upon each other** or so that they do not come too close to the sign box." *(Miller, p. 224)*

**This is the closest Miller comes to stating a parallel-tube clearance rule.** It is *qualitative* — there is no numeric minimum — but it identifies the failure mode (corona between parallel runs, especially double-backs, especially long ones). Trade practice that grew out of this rule typically requires parallel adjacent runs separated by ≥ 1 tube ø, and ≥ 2 tube ø where the tubes are >24 in long. **Miller does not state this.**

### What Miller is silent on

- A **numeric minimum parallel-tube spacing** (the rule we get the most false positives on). UL §101–108 covers only conductors, not glass tube bodies.
- Vertical clearance for jumps and flyovers (other than 16 mm sleeve glass for cable crossings).
- Min separation between adjacent letters.

## Implication for validation

Our current code's spacing defaults of 10/12/14/18 mm for ø 8/10/12/15 mm tubes are **not directly validated by Miller**. They are larger than the UL §126 minimum tube-to-grounded-metal of 6.35 mm but smaller than any UL §101–108 high-voltage cable spacing.

Miller-supported rule additions:

- **Glass-tube to grounded-metal minimum 6.35 mm** *(Miller, App I §126, p. 275)* — directly enforceable.
- **Cabinet-mounted tube z-offset 35–70 mm** *(Miller, p. 62)* — defines the third-dimension geometry the validator should not ignore.
- **Elevation-post spacing along tube ≤ 381 mm** *(Miller, p. 98)* — informational, not strict.
- **High-voltage wiring (and electrode terminal) clearance to grounded metal: 70 mm** *(Miller, p. 202)* — directly enforceable for electrode lead-out positions.
- **Parallel double-back / clustering**: *qualitative warning* if the design has long parallel runs that double back on each other near the metal box *(Miller, p. 223–224)*. Numeric threshold should come from a later trade reference.

What the PDFs *do* support changing:

- **Crossings should not be flagged as spacing errors** if the crossing section will be blocked out. The implication: spacing rules apply to *visible adjacent-stroke* tubing only. Detect crossings (transverse, not parallel) and exempt them from the parallel-spacing test.
- **Double-back / hairpin** legs (the two parallel legs of a 180° bend) are by definition close together. They are constructed as one piece and may share the support hardware. Whether they need the same minimum spacing as two independent runs is unclear from these sources but trade convention says **the inner clearance of a double-back is typically about 1× tube ø**, much tighter than parallel-run spacing.

## Current code vs gap

| Tube ø | Code default min spacing | Source | Verdict |
|---|---|---|---|
| 8 mm | 10 mm | (none cited; Miller silent on glass-glass minimum) | unverified |
| 10 mm | 12 mm | (none cited) | unverified |
| 12 mm | 14 mm | (none cited) | unverified |
| 15 mm | 18 mm | (none cited) | unverified |
| Glass tube to grounded metal | not checked | Miller App I §126, p. 275 — ¼ in / 6.35 mm | **gap, enforceable** |
| Tube z-offset from substrate (cabinet) | not checked | Miller p. 62 — 35 to 70 mm | gap (3D dimension) |
| Tube z-offset (window border) | not checked | Miller p. 201 — 50 to 152 mm | gap (3D dimension) |
| Elevation-post spacing along tube | not checked | Miller p. 98 — ≤ 381 mm (15 in), min 2 per section | gap (informational) |
| HV cable / electrode terminal to metal | not checked | Miller p. 202 — 70 mm (2¾ in) | **gap, enforceable** |
| GTO wire spacing | not checked | *Saving Neon, p. 21* — 3 in / 76 mm | gap |
| Crossing exemption (paint blockout) | not implemented | implied by *Saving Neon, p. 19* | gap, source of false positives |
| Double-back inner clearance | not exempted | implied by Blazek 180° bend pages | gap, source of false positives |
| Long parallel doubled-back runs near metal box | not warned | Miller p. 223–224 (qualitative) | warning gap |

## Anti-patterns implied by the sources

- Wires (GTO) crossing each other or running too close: forbidden electrically *(Saving Neon, p. 22)*.
- Glass tube touching metal cabinet without a glass/porcelain housing: forbidden *(Saving Neon, p. 23)*.
- "Drilling a new hole for a bushing" — i.e. squeezing a tube through a smaller-diameter retrofit hole — forbidden *(Saving Neon, p. 23)*.
- **Long parallel double-back runs producing corona between sections** — *(Miller, p. 223–224)*. Identified failure mode causing radio interference and tube life loss.
- **Conducting (metallic) blockout paint near electrodes** — banned because it conducts the high voltage out onto the sign face *(Miller, p. 60)*. Corollary: blockout paint must be nonmetallic.
