# Rules our code needs that the four PDFs do NOT cover

This file is a **deliberate inventory of holes in the source material**. Future Claude sessions should treat anything below as "unverified — defaults are best-effort heuristics" until a proper trade reference is consulted.

## What the four PDFs do not give us

1. **Numeric minimum bend radius per tube diameter.** No table, no formula. Our 16/20/25/30 mm defaults for 8/10/12/15 mm tube are uncited.
2. **Numeric maximum tube run between electrodes**, by gas / voltage / transformer rating. Our 2500 mm (3000 mm @ 15 mm) defaults are uncited.
3. **Minimum spacing between parallel glass tubes.** Our 10/12/14/18 mm defaults are uncited. The only spacing number in the four PDFs is **3 inches (76 mm) for GTO secondary wire** *(Saving Neon, p. 21)* — that is a wiring rule, not a glass rule.
4. **Lead-in length** between the electrode housing and the first decorative bend. The PDFs say "tube ends bent at 90°" but don't specify how much straight tube must precede the bend.
5. **Housing-hole alignment tolerance.** *Saving Neon p. 23* says "off even a quarter of an inch [the glass tube] might not fit" — that gives us roughly **±6.35 mm** tolerance, but it is a passing remark, not a spec.
6. **Voltage / transformer rating-vs-tube length relationships.** Not addressed.
7. **Gas-fill pressures** and gas-mixing rules on shared transformers. Not addressed.
8. **Cold-weather mercury behavior.** Trade fact, not in source.
9. **Stroke-width-as-fraction-of-cap-height** conventions for legibility/buildability. Blazek shows topology, not absolute dimensions.
10. **Counter (interior) widths** for letters with closed forms (O, P, B, etc.). Implied by bend-radius and double-tube spacing, but not specified.
11. **Minimum letter spacing in a word.** Not specified.

## Where to look next

The Saving Neon bibliography (p. 38) lists three trade references that are likely to have these numbers:

- **Samuel Miller & Wayne Strattman, *Neon Techniques*, 1997.** Industry-standard textbook. Likely contains tables of bend radii, transformer sizing, gas selection.
- **Morgan Crook & Jacob Fishman, *The Neon Engineers Notebook*, 2002.** Targeted at the engineer, likely tabular and quantitative.
- **Museum of Neon Art, *Steps to Take in the Restoration of Vintage Electric, Illuminated Signs*** — PDF available on request.

If those become available in `docs/`, future Claude should re-read the rule files in this folder and replace each "(none)" / "uncited" entry with the cited number.

## Rules our code currently checks where the gap matters most

| Validator | Source-supported? | Action |
|---|---|---|
| Min bend radius (16/20/25/30 mm by ø) | NO | Defaults plausible but uncited. Keep but mark unverified. **Add an exemption for legitimate 180° double-back hairpins** (a structural construction detected by Blazek-style geometry, not a tight-bend failure). |
| Max segment length (2500/3000 mm) | NO | Defaults uncited. Cross-check against transformer-rating tables when *Neon Techniques* becomes available. Add gas/voltage parameters when modeled. |
| Min spacing (10/12/14/18 mm) | NO | Defaults uncited. **Highest false-positive risk.** Add (a) a crossing-with-blockout-paint exemption, (b) a double-back inner-leg exemption. See `spacing.md`. |
| Tube run count (informational) | OK | No source rule, but the count is an obvious complexity / cost proxy. |

## Rules our code does NOT check that the source DOES support

| Concept | Source | Suggested validation |
|---|---|---|
| Tube end exits substrate at 90° | *Saving Neon* pp. 19, 23 (explicit, repeated) | Validate that the last (lead-in) segment of each subpath is normal to the substrate plane within tolerance. |
| GTO wire spacing ≥ 3 in / 76 mm | *Saving Neon* pp. 21, 22 | Once we model wiring, validate. Gap for now. |
| Power estimate at 4 W per foot of tubing | *Saving Neon* p. 36 | Display as informational power estimate, not an error. |
| Window-sign mode (both electrodes on one side) | Blazek intro | Configurable mode. |
| "Split tall letters into halves with a weld" | Blazek intro | Warn above some height threshold (no source number). |
| Phosphor coating + gas type per segment | *Saving Neon* p. 20 | Data model field, not a validator (yet). |

## Heuristics our code probably needs that NO PDF covers

- **Detect double-back as an intentional construction**, not a bend-radius failure. Look for two near-parallel segments separated by a 180° tight curve and connected as one subpath. Exempt the curve from the bend-radius test.
- **Detect crossings (non-parallel, near-perpendicular) and exempt from spacing test** if user has marked the crossing as "blockout/jump" (see `spacing.md`).
- **Acute (50°) bends** are a recognized vocabulary item, not an error condition. Our bend-radius check should be radius-based, not angle-based — verify this is the case in code.
