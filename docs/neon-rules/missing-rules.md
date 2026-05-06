# Rules our code needs that the source PDFs do NOT cover

This file is a **deliberate inventory of holes in the source material**. It now reflects the addition of Miller (1935) — many gaps that existed when only the four PDFs were available are now (partially) filled. Future Claude sessions should treat anything below as "unverified — defaults are best-effort heuristics" until a proper trade reference is consulted.

## What Miller (1935) does and does NOT cover

### Now answered (was a gap in the four PDFs):

1. **Lead-in length** between the electrode housing and the first decorative bend: **2 to 10 inches (50–254 mm)** *(Miller, p. 124)*. — *Was a complete gap; now enforceable.*
2. **Tube z-offset from substrate** (elevation post height): **35–70 mm cabinet, 50–152 mm window** *(Miller, p. 62, 201)*. — *3D dimension, was completely unmodeled.*
3. **Tube body to grounded metal minimum: 6.35 mm (¼ in)** *(Miller, App I §126, UL Standard p. 275)*. — *Now enforceable.*
4. **HV cable / electrode terminal to grounded metal: 70 mm (2¾ in)** *(Miller, p. 202)*. — *Now enforceable.*
5. **Cable support spacing: ≤ 18 in (457 mm), and within 6 in (152 mm) of electrode** *(Miller, App I §88–89)*. — *Wiring rule; gap until we model wiring.*
6. **Elevation post spacing along tube: ≤ 15 in (381 mm), min 2 per section** *(Miller, p. 98)*. — *Informational, partially gap.*
7. **Gas fill pressures**: neon 5–15 mm Hg (typically 10), helium ~3 mm Hg, Ar-Hg carrier 5–15 mm Hg *(Miller, p. 138, 17, 40)*. — *Was completely silent; now enforceable.*
8. **Gas-dependent footage multipliers**: helium = ½ neon footage; helium-Ar-Ne mixture even less. Standard transformer = 30 mA, helium often needs 60 mA *(Miller, p. 41)*. — *Now enforceable as a warning.*
9. **Letter-size threshold for forced splice: cap height ≥ 12 in (305 mm)** requires multi-blank construction *(Miller, p. 125)*. — *Was qualitative-only ("split tall letters"); now quantified.*
10. **Tube blank usable length: 864 mm (34 in)** out of 1,168-mm (46-in) blanks after handling reserve *(Miller, p. 115, 124)*. — *Was unknown.*
11. **Standard tube diameter range: 7–15 mm OD** *(Miller, p. 18)*. — *Confirms our 8/10/12/15 mm code defaults are within trade practice.*
12. **Standard secondary current: 30 mA (some 60 mA)** *(Miller, p. 19, 71)*. — *Sets the family of expected loads.*
13. **Secondary voltage range: 2,000–15,000 V** in three cable tiers (5 / 10 / 15 kV) *(Miller, p. 64–65, 71)*. — *Confirms three-tier cable model.*
14. **Cabinet mid-point grounding above 7,500 V** *(Miller, p. 206)*. — *Wiring rule.*
15. **UL spacings table for HV parts vs grounded metal** *(Miller, App I §101–108, p. 273)*. — *Schema known; numeric values not OCR-readable from the PDF table.*
16. **Footage estimator: ~1.35 ft tube per 5-in cap height letter** *(Miller, Fig. 38, p. 101)*. — *Sanity-check rule of thumb.*

### Still NOT covered, even by Miller:

1. **Numeric minimum bend radius per tube diameter.** Miller treats radius as bender's craft, not a tabulated spec. *Worked-example bound:* in his 18-in O recipe, smallest planned curvature is ≈ 152 mm radius for 12 mm tube — but he does not state a minimum.
2. **Numeric minimum spacing between parallel glass tubes.** Miller's only related rule is qualitative (avoid "long lengths of tubing doubled back upon each other" near the metal box, p. 224). UL §101–108 covers cable spacings but not glass-to-glass.
3. **Phosphor-coated tube rules.** Phosphor coatings did not exist in 1935.
4. **Modern solid-state transformer behavior.** Miller's transformer-load math assumes electromagnetic transformers operating at line frequency. Solid-state high-frequency transformers behave differently.
5. **Modern argon-mercury phosphor-tube length-per-transformer table.** Miller's footage-vs-voltage curves are for clear-glass neon and helium-mix tubes only.
6. **Mercury volume per linear meter.** Miller says "a few drops" of triple-distilled Hg per tube; no numeric volume.
7. **Counter (interior) widths** for letters with closed forms. Implied by bend-radius and double-tube spacing.
8. **Stroke-width-as-fraction-of-cap-height** ratios for legibility.
9. **Minimum letter spacing in a word.**
10. **Cold-weather mercury behavior** quantified — Miller mentions failure mode (mercury condenses, tube fades) but doesn't give a temperature threshold.
11. **Per-tube max length** as distinct from per-transformer total. Miller's Table VI is per-transformer only.

## What the four source PDFs do not give us (pre-Miller summary, kept for context)

1. ~~Numeric minimum bend radius per tube diameter.~~ Still not in Miller.
2. ~~Numeric maximum tube run between electrodes, by gas / voltage / transformer rating.~~ Miller adds gas-dependent and voltage-dependent transformer-load tables — partially answered.
3. ~~Minimum spacing between parallel glass tubes.~~ Still not in Miller (qualitative only).
4. ~~Lead-in length~~ — **answered by Miller p. 124: 50–254 mm.**
5. ~~Housing-hole alignment tolerance~~ — Miller p. 50 (housing bore ⅜–⅝ in) plus *Saving Neon p. 23* (±¼ in) corroborate: tolerance ≈ ±6.35 mm.
6. ~~Voltage / transformer rating-vs-tube length relationships.~~ Miller Ch. III, IV, VI (Table VI page 97) give this — but the numeric table is not OCR-readable.
7. ~~Gas-fill pressures~~ — **answered by Miller p. 138, 40, 186.**
8. ~~Cold-weather mercury behavior.~~ Miller mentions, doesn't quantify.
9. **Stroke-width-as-fraction-of-cap-height** conventions for legibility/buildability. Still not.
10. **Counter (interior) widths** for letters with closed forms. Still not.
11. **Minimum letter spacing in a word.** Still not.

## Where to look next

The Saving Neon bibliography (p. 38) lists three trade references:

- **Samuel Miller & Wayne Strattman, *Neon Techniques*, 1997.** ← *Modern-era successor to Miller (1935); should fill the post-1935 gaps: phosphor coatings, solid-state transformers, modern length-per-transformer tables. Same author family, 62 years later.*
- **Morgan Crook & Jacob Fishman, *The Neon Engineers Notebook*, 2002.** Targeted at the engineer, likely tabular and quantitative. Best candidate for **per-tube max length** and **parallel-tube minimum spacing**.
- **Museum of Neon Art, *Steps to Take in the Restoration of Vintage Electric, Illuminated Signs*** — PDF available on request.

Other 1935-era / mid-century references that may be in the archive.org collection:
- **Underwriters' Laboratories Standard for Electric Signs (current edition)** — UL 48 today. The numeric values for the spacings table (Miller App I §101–108) are likely available in the modern UL standard.

If those become available in `docs/`, future Claude should re-read the rule files in this folder and replace each remaining "(none)" / "uncited" / "qualitative" entry with the cited number.

## Rules our code currently checks where the gap matters most

| Validator | Source-supported? | Action |
|---|---|---|
| Min bend radius (16/20/25/30 mm by ø) | NO direct cite (Miller silent on per-ø minimum). Worked-example bound from Miller p. 118 suggests our defaults are conservative | Defaults plausible. Keep but mark unverified. **Add an exemption for legitimate 180° double-back hairpins.** |
| Max segment length (2500/3000 mm per pair) | INDIRECT — Miller p. 41–43 gives per-transformer total only | Defaults plausible. Add a separate **per-transformer total** check using Miller's gas-dependent multipliers. |
| Min spacing (10/12/14/18 mm parallel) | NO direct cite (Miller qualitative only at p. 224) | **Highest false-positive risk.** Add (a) a crossing-with-blockout-paint exemption, (b) a double-back inner-leg exemption. See `spacing.md`. |
| Tube run count (informational) | OK | No source rule, but the count is an obvious complexity / cost proxy. |
| Glass-tube to grounded-metal | NOT CHECKED. **Miller App I §126: ≥ 6.35 mm.** | **Add as new validator.** |
| HV cable / electrode terminal to grounded metal | NOT CHECKED. **Miller p. 202: ≥ 70 mm.** | **Add as new validator.** |
| Lead-in turn-up length | NOT CHECKED. **Miller p. 124: 50–254 mm.** | **Add as new validator.** |
| Gas fill pressure | NOT MODELED. **Miller p. 138: 5–15 mm Hg neon, ~3 mm Hg He.** | Add to data model; validate user-entered fill pressure. |
| Letter cap-height threshold for forced splice | NOT WARNED. **Miller p. 125: ≥ 305 mm cap height needs internal splice.** | Add as warning. |

## Rules our code does NOT check that the source DOES support

| Concept | Source | Suggested validation |
|---|---|---|
| Tube end exits substrate at 90° | *Saving Neon* pp. 19, 23; **Miller p. 124** | Validate that the lead-in segment is normal to substrate within tolerance. |
| GTO wire spacing ≥ 3 in / 76 mm | *Saving Neon* pp. 21, 22; Miller p. 202 (2¾ in / 70 mm to grounded metal) | Once we model wiring, validate. |
| Power estimate at 4 W per foot of tubing | *Saving Neon* p. 36; Miller Fig. 37 (350 VA for 35 ft of 12 mm tube on 30 mA) | Display as informational power estimate. |
| Window-sign mode (both electrodes on one side) | Blazek intro; Miller p. 200, 254–261 | Configurable mode. |
| Split tall letters into halves with weld | Blazek intro; **Miller p. 125 (cap height ≥ 305 mm)** | Warn at quantified height. |
| Phosphor coating + gas type per segment | *Saving Neon* p. 20 (Miller silent on phosphor) | Data model field. |
| Gas fill pressure per segment | **Miller p. 138, 40** | Data model + validator. |
| Per-transformer total footage by gas | **Miller p. 41–43** | Validator, with 30 mA / 60 mA family selection. |
| Tube z-offset from substrate (3D) | **Miller p. 62, 201** | Data model field for 3D layout future. |
| Elevation post spacing along tube | **Miller p. 98 (≤ 381 mm, min 2)** | Informational warning. |

## Heuristics our code probably needs that NO PDF (including Miller) covers

- **Detect double-back as an intentional construction**, not a bend-radius failure. Look for two near-parallel segments separated by a 180° tight curve and connected as one subpath. Exempt the curve from the bend-radius test.
- **Detect crossings (non-parallel, near-perpendicular) and exempt from spacing test** if user has marked the crossing as "blockout/jump" (see `spacing.md`).
- **Acute (50°) bends** are a recognized vocabulary item, not an error condition. Our bend-radius check should be radius-based, not angle-based — verify this is the case in code.
- **DB stacked in z-axis** (front leg behind front leg) — Miller p. 120 explicit 3D rule that 2D Blazek patterns hide. Validating this requires a 3D layout model.
- **Modern phosphor-coated tube length-per-transformer rules** — *Neon Techniques* (1997) needed.
