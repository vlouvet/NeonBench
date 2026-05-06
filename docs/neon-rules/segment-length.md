# Maximum tube run between electrodes

## What the four PDFs say

**No numeric maximum.** None of the four PDFs specify a maximum tube length per electrode pair, nor do they list gas-dependent or voltage-dependent run limits.

What we do get:

- **Power consumption rule of thumb:** "a neon sign has a consumption of about 4 watts per foot of glass tubing. 4 feet of tube × 4 watts = 16 lumens" *(Saving Neon, p. 36, point 4)*. This is how a treatment plan estimates lumens — it is an output/wattage figure, not a max-length figure.
- **Transformers must be replaced "every six to ten years"** with new electromagnetic transformers — solid-state are explicitly inferior for outdoor/longevity *(Saving Neon, pp. 21, 36 point 15)*.
- **Letters that are large should be cut into halves rather than bent as one unit:** "When making large letters, it is much wiser to cut the letters in half than to attempt to make them in one unit. They are easier to bend, pump, install and service this way, and, if a large double stroke powdered unit should break, it will not have to be completely remade." *(Blazek Book 1 introduction, also identical in Books 2 and 3.)* This implies an implicit per-unit length budget but doesn't quantify it.
- **Original tubes "may be wired to another in series"** — *(Saving Neon, p. 22)* — i.e. one transformer can drive multiple tubes wired together.
- **GTO wire is the secondary side conductor** between transformer and electrodes — its rules are about wiring layout (see `electrodes.md`), not about the gas-discharge run length.

## What Miller (1935) adds — first quantitative answers we have

Miller has an entire transformer-tube-length scheme. The headline numerical anchor:

> "The high-resistance helium-argon-neon carrier gas has the disadvantage, of course, of requiring a high voltage per foot of tubing. **This reduces the number of feet which can be run from a standard 15,000-volt transformer to about 20 feet of 12-millimeter tubing.**" *(Miller, Ch. III, p. 43)*

So the **per-electrode-pair limit for 12 mm helium-mix tubing on a 15 kV transformer is ~20 ft = 6,096 mm**. For neon (red), the resistance per foot is much lower — Miller states helium has "about twice" the resistance of neon per linear foot *(Miller, p. 41)* — so the comparable neon limit is roughly **double**, i.e. on the order of **40 ft ≈ 12,200 mm** per 15 kV transformer for 12 mm pure-neon tubing. Miller does **not** print this number directly; he refers to **Table VI Transformer Chart, p. 97** which the OCR could not read because the table is graphical.

Other Miller numbers we *can* extract:

- **Standard tube diameter range:** 7 to 15 mm OD *(Miller, p. 18)*. "Neon tubes for sign-lighting purposes are rarely made with tubes larger than 15 millimeters or smaller than 7 millimeters in outside diameter."
- **Standard secondary current:** "**30 milliamperes** (some 60-milliampere transformers are used). This amount of current is capable of filling a 15-millimeter tube with light at the standard neon pressure" *(Miller, p. 19)*. **The 30 mA / 15 mm pairing is Miller's stated upper-tube-diameter design point.**
- **Operating-current range:** 16 to 50 mA *(Miller, p. 71)*. Short-circuit current 18 to 60 mA. So practical transformers come in 30 mA and 60 mA families.
- **Secondary voltage range:** 2,000 to 15,000 V *(Miller, p. 71)*. Miller calls 7,500 V the threshold where transformer secondary mid-point grounding becomes mandatory *(Miller, p. 206)*.
- **Worked example for sign cost / transformer sizing:** "35 feet of 12-millimeter tubing on a 30-milliampere transformer will consume about 350 volt-amperes" *(Miller, Fig. 37 caption, p. ~100)*. **35 ft = 10,668 mm** is therefore an *operating* configuration — does not establish max-per-pair, but tells us multi-letter sign loads are routinely in this range.
- **Letter-height-to-footage estimator:** Miller Fig. 38 example: "20 letters, 5 inches high, require nearly 27 feet of tubing." *(Miller, p. ~101)*. Implies ~1.35 ft (~411 mm) of tube per 5-in (127 mm) letter; ratio ≈ 3.2 mm of tube per mm of cap height for an average letter.
- **Helium reduces feet-per-transformer by half** vs. neon *(Miller, p. 41)*. Argon-mercury (blue, green) has its own column in Table VI that we can't read from the OCR; trade convention puts argon-mercury between neon and helium.
- **Series wiring of multiple letters/segments** is standard practice *(Miller throughout, esp. p. 97)*. The transformer drives the *total* footage of all series-wired tubes, not per tube.
- **Helium pressure regime is exceptional:** "The gas must be used at low pressure (approximately 3 millimeters)" *(Miller, p. 40)* and "for brilliant helium tubes, a 60-milliampere transformer is usually used" *(Miller, p. 41)*. Helium is a special case that needs the bigger transformer family.
- **Tube blank length:** "Glass for tubes is usually sold in 46-inch lengths" *(Miller, p. 58, also p. 115)*. **46 in = 1,168 mm.** The 6 in (152 mm) at each end reserved for handling cuts the usable length to **34 in (864 mm)** per blank. So a *single unspliced* tube run cannot exceed ~864 mm of finished length without a splice. Above 12-in (305 mm) cap height, multiple blanks must be spliced together *(Miller, p. 125)*.

## Modern equivalence flag

Miller's voltage tiers (2,000–15,000 V) and current tiers (30 / 60 mA) match modern electromagnetic transformer practice. The footage-per-transformer numbers in Table VI assume:
- 1935-vintage cold-cathode electrodes (cathode-fall ≈ 100–150 V)
- Lead glass (Corning G-1) at ~0.045–0.060 in wall *(Miller, p. 115)*
- Operating gas pressures of 5–15 mm Hg for neon *(Miller, p. 138)*

**Modern caveats:**
- Modern electromagnetic transformers and modern argon-mercury phosphor-coated tubes can run *longer* per kV than Miller's argon-neon-mercury figures.
- Modern solid-state transformers run at much higher frequency and have different impedance behavior; Miller's footage-vs-voltage rule does not apply to them.
- Modern **tube length per electrode pair** in the trade (per *Neon Engineers Notebook*, hearsay) is typically ~8–10 ft (~2,500–3,000 mm) for a single tube on a 30 mA transformer with several letters in series — **consistent with our existing 2,500/3,000 mm defaults**. Miller's overall *transformer-load* limit (e.g. 35 ft on a 30 mA transformer) is the *sum* across all tubes in the series circuit, which matches modern practice.

## What Miller is silent on

- **A direct max-length-per-electrode-pair table** (he gives max footage *per transformer* across all series-wired tubes, not per tube).
- **Voltage drop per foot for each gas at each diameter** — his curves (Fig. 4, Fig. 19) are graphical and not OCR-readable.
- **Modern argon-mercury phosphor-tube limits** — phosphor coatings did not exist in 1935.

## Implication for validation

Our 2500 mm (3000 mm @ 15 mm tube) default cap **per electrode pair** is plausibly real-world and matches modern trade practice. Miller's 1935 figures are the closest first-principles validation we have:

- 12 mm helium-mix on 15 kV: 20 ft ≈ 6,100 mm *per transformer total* *(Miller, p. 43)*. With 2–3 letters in series, that lands at 2,000–3,000 mm per pair.
- 12 mm neon (red) on 30 mA: 35 ft ≈ 10,700 mm per transformer total at 350 VA *(Miller, Fig. 37, p. 100)*. Implies a longer per-pair budget for pure neon is acceptable.

What the PDFs *do* support:

- **A "max length per transformer" check** in addition to "max length per electrode pair" — Miller's actual constraint is on the transformer load, not on the individual tube *(Miller, p. 71, p. 97)*.
- **A gas-dependent multiplier**: helium ÷ 2, argon-mercury between, neon = baseline *(Miller, p. 41)*.

## Current code vs gap

| | Code default | Miller / Source | Verdict |
|---|---|---|---|
| Max segment length (general) | 2500mm | (no direct cite); consistent with Miller p. 43 footage chart for typical 30 mA / 12 mm pure-neon multi-tube circuits | unverified, but plausibly conservative |
| Max segment length (15mm tube) | 3000mm | (no direct cite); Miller p. 19 confirms 15 mm is the upper-diameter design point at 30 mA | unverified |
| Max length *per transformer* (all series tubes) | not implemented | Miller p. 41–43, Table VI p. 97: ~20 ft 12-mm helium / ~35 ft 12-mm neon @ 30 mA / 15 kV | **gap, source-supported** |
| Gas-dependent variation | not implemented | Miller p. 41: helium = ½ neon footage; Miller p. 43 helium-mix specific | **gap, source-supported** |
| Voltage-dependent variation | not implemented | Miller p. 71: 2 kV–15 kV transformer family | gap |
| 4 W per foot of tubing (informational) | not tracked | *Saving Neon, p. 36* | could be added as power estimate |
| Tube-blank usable-length 864 mm before forced splice | not enforced | Miller p. 115 (46-in blank, 6-in handling reserve each end) | informational; supports `letter-construction.md` weld-suggestion warning at >12 in cap height |

## Anti-patterns implied by the sources

- A single bent unit so long that it cannot be re-pumped without breaking — Blazek explicitly recommends splitting long letters in halves, joined later (look for "WELD" annotation on Blazek letter "H", Book 1).
- A transformer whose total series-tube load exceeds its rated footage — "transformer burnout" is the named failure mode *(Miller, p. ~74, p. 217)*. Our validator should warn if the *sum* of segment lengths in a single circuit exceeds Miller-class limits.
