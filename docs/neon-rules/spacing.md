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

### What the sources don't tell us

- A minimum parallel-tube spacing (the rule we get the most false positives on)
- Vertical clearance for jumps and flyovers
- Min separation between adjacent letters

## Implication for validation

Our current code's spacing defaults of 10/12/14/18 mm for ø 8/10/12/15 mm tubes are **not validated by any of the four PDFs**. They appear to be extrapolated from common practice or from the original NeonWizard.

What the PDFs *do* support changing:

- **Crossings should not be flagged as spacing errors** if the crossing section will be blocked out. The implication: spacing rules apply to *visible adjacent-stroke* tubing only. Detect crossings (transverse, not parallel) and exempt them from the parallel-spacing test.
- **Double-back / hairpin** legs (the two parallel legs of a 180° bend) are by definition close together. They are constructed as one piece and may share the support hardware. Whether they need the same minimum spacing as two independent runs is unclear from these sources but trade convention says **the inner clearance of a double-back is typically about 1× tube ø**, much tighter than parallel-run spacing.

## Current code vs gap

| Tube ø | Code default min spacing | Source | Verdict |
|---|---|---|---|
| 8 mm | 10 mm | (none) | unverified |
| 10 mm | 12 mm | (none) | unverified |
| 12 mm | 14 mm | (none) | unverified |
| 15 mm | 18 mm | (none) | unverified |
| GTO wire spacing | not checked | *Saving Neon, p. 21* — 3 in / 76 mm | gap (different concern, but worth tracking once we model wiring) |
| Crossing exemption (paint blockout) | not implemented | implied by *Saving Neon, p. 19* | gap, source of false positives |
| Double-back inner clearance | not exempted | implied by Blazek 180° bend pages | gap, source of false positives |

## Anti-patterns implied by the sources

- Wires (GTO) crossing each other or running too close: forbidden electrically *(Saving Neon, p. 22)*.
- Glass tube touching metal cabinet without a glass/porcelain housing: forbidden *(Saving Neon, p. 23)* — the housing is the insulator.
- "Drilling a new hole for a bushing" — i.e. squeezing a tube through a smaller-diameter retrofit hole — forbidden *(Saving Neon, p. 23)*.
