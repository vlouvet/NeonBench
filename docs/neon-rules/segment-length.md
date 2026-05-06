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

## What Strattman (Neon Techniques, 4th ed., 1997) adds — the modern footage chart

Strattman's **Table 6.2 "Luminous Tube Footage Chart"** *(NT Ch. 6, attributed "Courtesy of Allanson International Inc.")* is the modern equivalent of Miller's unreadable Table VI. It is the most directly useful quantitative table in the book for our validator.

### Table 6.2 schema

Columns:
- **OPEN CIRCUIT SECONDARY VOLTAGE (volts)**: 15,000 / 12,000 / 9,000 / 7,500 / 6,000 / 5,000 / 4,000 / 3,000 / 2,500
- **SHORT CIRCUIT SECONDARY CURRENT (mA)**: 30 / 60 / 90 / 120 (not all combinations populated)
- **CAPACITY VOLT-AMPERES**: Normal Power Factor / High Power Factor (60 PF / 90 PF)
- **APPROXIMATE WATTS CONSUMPTION**
- **Footage by tube diameter (mm)**: 22, 20, 18, 15, 14, 13, 12, 11, 10, 9 — **values are for "Clear or Fluorescent Red, also recommended for Neon Fluorescent Gold"**

### Sample rows readable from the screenshot crops

For **15,000 V open-circuit / 30 mA short-circuit / 405 VA NPF / 463 W**:
- 22 mm tube: **102 ft**
- 20 mm tube: **85 ft**
- 18 mm tube: **72 ft**
- 15 mm tube: **60 ft**
- 14 mm tube: **54 ft**
- 13 mm tube: **50 ft**
- 12 mm tube: **43 ft**
- 11 mm tube: **39 ft**
- 10 mm tube: **33 ft**
- 9 mm tube: **27 ft**

(Other rows for 12,000 V / 9,000 V / 7,500 V follow proportionally lower footage; full table is on **NT p. ≈ 65–66**, location reflowed in Kindle edition. Cite as *NT Ch.6, Table 6.2*.)

### Table 6.3 — Mercury-filled tube footages

Strattman's **Table 6.3 "Maximum Number of Feet of Tubing Operated (Based on Average Grade of Tubing)"** has two sub-tables:
- (left) **Clear or Fluorescent Mercury Filled Tubes, All Colors / Indoor Applications (40°F Temp. or Above)**
- (right) **Clear or Fluorescent Mercury Filled Tubes, All Colors / Indoor and Outdoor Applications**

Sample readable values for **15,000 V / 30 mA / Indoor (≥40°F)**:
- 22 mm: 100 ft
- 20 mm: 90 ft
- 18 mm: 80 ft
- 15 mm: 72 ft
- 14 mm: 64 ft
- 13 mm: 60 ft
- 12 mm: 54 ft
- 11 mm: 47 ft
- 10 mm: 40 ft
- 9 mm: 32 ft

For Outdoor applications (same row), values drop ~5–10% per row to account for cold-weather mercury condensation. *(NT Ch.6, Table 6.3)*

### Table 6.3 footnotes (verbatim, paraphrased where partial)

> 1. Deduct 1 foot from the footage listed in Table 6.2 for each pair of electrodes.
> 2. Use Table 6.2 as a guide. More accurate information is available by performing a loading test, described in Chapter 11.
> 3. Tubing under loading may be required for low-temperature mercury tube applications (below 40°F). In such cases, the reduced footage should not be less than 85% of the footage shown for indoor (mercury-filled tubes not be used due to the mercury's inability to be vaporised by heat supplied by the transformer). *(NT Ch.6, Notes to Table 6.3)*
> 4. Mercury tubes, regardless of the fill gas, may be filled to slightly lower pressure; **10% for larger diameter tubes to 30% for smaller diameter tubes**.

> "1 foot of cathode fall (a pair of electrodes) equals 1 foot of length." *(NT Ch.6, footage-chart introductory text)* — i.e. **each electrode pair adds an effective 1 ft (≈305 mm) "extra" to the tube load** because the cathode-fall voltage drop is the same as 1 ft of tube column. This is the modern restatement of Miller's cathode-fall rule and lets us deduct 1 ft per pair from the table.

### Methodology notes

> "The neon footage chart also gives information on the power usage of the transformer, the current draw on the primary side of the transformer and the recommended normal fill gas pressure for each size of tubing (listed by each diameter of tubing). Each transformer output voltage is accompanied by an output current. **Current determines brightness of the tube. For the majority of sign work the output current is 30mA. For cold weather applications, or brightly lit downtown regions 60mA transformers are sometimes used.** Although listed, lower current ratings than 30mA are used infrequently, mainly for portable, window-type signs." *(NT Ch.6, Table 6.2 introductory text)*

> "For trouble-free operation the tubing on each transformer should operate without flicker at **78% of rated voltage** approximately 94 volts at a nominal line voltage of 120." *(NT Ch.6, Table 6.3 introductory text)*

> "**Add approximately 15% to 60 mA figures when using 120 mA.** Helium filled tube footages should be calculated at **50% of Neon footages**." *(NT Ch.6, Table 6.3 header note)*

So the modern multipliers replace Miller's 1935 estimates:
- **Helium**: 50% of neon footage *(NT corroborates Miller p. 41 exactly — same number 62 years apart)*
- **120 mA transformer**: footage = 1.15× the 60 mA value
- **Mercury-filled, outdoor**: ~85% of indoor value (per Note 3)
- **Mercury-filled below 40°F**: 25% of indoor value, OR avoid mercury and use pure neon *(NT Ch.11)*

### Per-tube vs per-transformer

> "For tubing of any diameter, regardless of its diameter, needs a sufficient voltage to overcome the voltage drop of the gas, the cathode fall, and a voltage per foot of tubing known as the positive column drop." *(NT Ch.6, "Calculations using the neon footage chart")*

> "To calculate the voltage required, start by determining the length of each section. Each tube's voltage drop can then be determined from the chart. By starting under the column for the closest number of feet for a given output current, and the appropriate fill gas pressure, the voltage values can be read down. ... Doing the same for each section of tubing yields a number of voltages, which when totaled, must equal that voltage required to operate the transformer." *(NT Ch.6, post-Table 6.2 worked example)*

So Strattman's method is: **sum the per-section voltage drops (positive column + 2× cathode fall), match the sum to the transformer open-circuit voltage at the chosen current**. This is the modern equivalent of Miller's same procedure and gives an explicit per-tube length budget when the total sign has multiple tubes wired in series.

## Tube-end glass jumper sizing (modern)

Strattman *(NT Ch.11 Fig. 11.3)* shows window-border jumpers as **10 or 11 mm OD glass tubing flared at one end**, replacing Miller's 16 mm sleeve over twisted lead-wire join. This is purely a connector-glass spec, not a tube-load spec; recorded here for completeness.

## Modern transformer behavior (replaces Miller)

> "Modern fluorescent gas-discharge tubes have higher light output than the older incandescent lamps which is converted into useful incandescent. ... Modern signs do not require excessive heating to operate, but the high light output is the result of the gas being heated to a high temperature." *(NT Ch.4, transformer ratings discussion)*

> "Transformers are rated by: (1) primary input voltage (2) power frequency (60, 50, or 25 Hz), (3) primary current ... (4) primary watts consumed when operating at the proper load), (5) secondary volts (on open circuit), (6) secondary current ... and (7) secondary current in milliamperes for short circuit current. ... When the secondary voltage exceeds **9,000 V**, the secondary winding must be tapped at the center and grounded." *(NT Ch.4)*

**Supersession of Miller p. 206**: Miller (1935) gave the mid-point grounding threshold as **7,500 V**; Strattman (1997) raises it to **9,000 V**, reflecting modern UL practice for high-power-factor transformers. Use **9,000 V as the modern threshold** for the mandatory mid-point ground.

> "Transformer output ratings vary from **2,000 to 15,000 volts (secondary on open circuit)** and from **10 to 200 milliamperes (short circuit)**." *(NT Ch.4)* — **same ranges as Miller (1935) p. 71**, no supersession.

### Electronic / solid-state power supplies

Strattman explicitly notes that modern electronic (solid-state high-frequency) power supplies are now common but that **footage charts assume 60 Hz core-and-coil transformers** *(NT Table 6.3 Notes)*. Solid-state has different impedance behavior — the chart is a "rough guide only" for solid-state. **Same caveat we already had from prior research; Strattman corroborates explicitly.**

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
| Max length *per transformer* (all series tubes) | not implemented | Miller p. 41–43, Table VI p. 97: ~20 ft 12-mm helium / ~35 ft 12-mm neon @ 30 mA / 15 kV. **Strattman (1997) Table 6.2: 12 mm clear neon @ 15 kV / 30 mA = 43 ft; @ 60 mA = ~50 ft** | **gap, fully source-supported (Strattman Table 6.2)** |
| Gas-dependent variation | not implemented | Miller p. 41: helium = ½ neon footage; **Strattman 1997 NT Ch.6 confirms 50%** (same number 62 years later) | **gap, source-supported** |
| Voltage-dependent variation | not implemented | Miller p. 71: 2 kV–15 kV transformer family; **Strattman Table 6.2 tabulates explicit footage by 15/12/9/7.5/6/5/4/3/2.5 kV × 30/60/90/120 mA × 9–22 mm tube ø** | **gap, source-supported** |
| Indoor mercury-tube footage @ 40°F+ | not implemented | **Strattman Table 6.3 (left) — explicit table by mA × tube ø** | **gap, source-supported** |
| Outdoor mercury-tube footage | not implemented | **Strattman Table 6.3 (right) — ~85% of indoor** | gap, source-supported |
| Cold-weather mercury-tube derate (<40°F) | not implemented | **Strattman Ch.11 — ≤25% of normal footage OR avoid mercury** | **gap, enforceable as warning when ambient temperature is set** |
| 78–83% loading band | not implemented | **Strattman Ch.11 — secondary current 24 mA on 30 mA transformer (80%); voltage 0.77–0.83 of rated** | gap, enforceable |
| Cathode-fall as 1 ft of tube length | not implemented | **Strattman Ch.6 — "1 foot of cathode fall equals 1 foot of length"; deduct 1 ft per electrode pair** | gap, refines Miller |
| Mid-point ground threshold | not enforced (electrical config) | Miller p. 206 = 7,500 V; **Strattman Ch.4 = 9,000 V** (supersedes) | gap, use 9 kV |
| 4 W per foot of tubing (informational) | not tracked | *Saving Neon, p. 36* | could be added as power estimate |
| Tube-blank usable-length 864 mm before forced splice | not enforced | Miller p. 115 (46-in blank, 6-in handling reserve each end) | informational; supports `letter-construction.md` weld-suggestion warning at >12 in cap height |

## Anti-patterns implied by the sources

- A single bent unit so long that it cannot be re-pumped without breaking — Blazek explicitly recommends splitting long letters in halves, joined later (look for "WELD" annotation on Blazek letter "H", Book 1).
- A transformer whose total series-tube load exceeds its rated footage — "transformer burnout" is the named failure mode *(Miller, p. ~74, p. 217)*. Our validator should warn if the *sum* of segment lengths in a single circuit exceeds Miller-class limits.
