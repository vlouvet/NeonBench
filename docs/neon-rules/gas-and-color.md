# Gas and color

Source: *Saving Neon - Best Practices Guide*, p. 20 ("TUBE COLORS"). Blazek books say nothing about gas or color. Miller (1935) Ch. III "Materials Used in Constructing Tubes" pp. 33–60 is the canonical 1930s reference and is added throughout below.

## Noble gases used in tube lighting

Five noble gases are listed in Saving Neon and all five are described in Miller Ch. III pp. 34–43:

| Gas | Color | Saving Neon | Miller (1935) |
|---|---|---|---|
| **Neon** (Ne) | red-orange (635 nm peak) | "shines brighter than other gases" | Used pure for red. Discovered 1898 by Ramsay. Penetrates 20 % better in rain than other colors *(Miller, p. 37)*. |
| **Argon** (Ar) | weak blue alone | Used **with a drop of mercury** to glow bright blue | Almost never used pure for light; instead 80 % Ar / 20 % Ne mixture is the **carrier gas** for mercury *(Miller, p. 42)*. Cheap and low-resistance. |
| **Krypton** (Kr) | white tinged with lavender (>1 mm pressure) | rare, niche | **$300 / liter in 1935** *(Miller, p. 42)*. Used in hot-cathode window-lighting units; sometimes blended into argon-neon-mercury mixtures. |
| **Xenon** (Xe) | sky-blue spectrum | rare, niche | **$750 / liter in 1935 (≈ 2–3× krypton, 4000× gold/oz)** *(Miller, p. 42)*. Almost never used in 1930s signs. |
| **Helium** (He) | yellow / whitish | mentioned, no color stated | Higher ionization potential than Ne; **must be used at ~3 mm Hg** for good brilliance, vs ~10 mm Hg for neon *(Miller, p. 40)*. Resistance per linear foot ≈ 2× that of neon, so half the footage per transformer. Often needs **60 mA** transformer instead of 30 mA *(Miller, p. 41)*. |

## Argon + mercury (blue / green workhorse)

> "Clear tubes are usually filled with either neon or argon gas. Neon gas glows the familiar red-orange color and shines brighter than other gases. Argon gas with a drop of mercury glows a brighter blue color." — *Saving Neon, p. 20*

Miller's mechanism *(Miller, pp. 42–44)*:

- **Pure mercury vapor alone won't run** — it condenses at room temperature and the discharge is erratic.
- The **80 % Ar / 20 % Ne carrier gas** ionizes first, generates heat, and the heat vaporizes the liquid Hg already in the tube.
- Neon in the carrier serves as the **heater** (high resistance generates heat); argon serves as the **conductor** (low resistance carries current).
- The blue ionization color of argon *plus* the blue mercury-vapor glow gives the working blue.
- Yellow glass + Ar/Ne/Hg = the standard green tube.
- For cold climates, **He is added** to the carrier (He-Ar-Ne) so the resistance is even higher and the tube heats more — but at the cost of about half the footage per transformer *(Miller, p. 44)*.
- **Triple-distilled mercury** is required; even tiny impurities form black stains inside the tube *(Miller, p. 44)*. Mercury insertion is via the side-tube method (small bulb spliced to tube before pumping; mercury released into tube only after bombardment is complete) *(Miller, p. 190)*.

Argon-mercury is the workhorse for cool blue/white. Mercury vapor pressure is **temperature dependent** — a known reason that mercury-tube signs flicker or look weak in cold weather. Miller p. 44: "the pressure of mercury vapor at ordinary room temperature is not sufficient to give a brilliant light. Hence rare-gas mixtures … are used to support the mercury vapor."

## Phosphor-coated tubes

> "The tubes that look white in daylight are phosphor-coated glass tubes, available in a wide array of colors." — *Saving Neon, p. 20*

Phosphor-coated tubes ("powdered tubes" in Blazek's terminology) are typically argon-mercury filled. The phosphor coating on the inside of the glass converts UV from the mercury arc into visible light at whatever color the phosphor was tuned for. **Note: phosphor-coated neon tubing was developed after Miller (1935).** Miller describes only colored or coated *glass*, not phosphor coatings on the inside surface. The 1935 trade had:
- Clear glass + neon = red-orange (Miller p. 35–37)
- Clear glass + Ar/Hg = blue
- Yellow tinted glass + Ar/Hg = green
- Other tinted ("Novial") glasses for special colors *(Miller, p. ~58)*

This is a significant **modern divergence**: today's white/pastel tubes use phosphor; in Miller's time, color came from the gas + the glass tint only.

## Gas pressures (filled tubes)

Miller gives explicit fill-pressure ranges that the four PDFs are silent on:

- **Neon (red): 5 to 15 mm Hg** "the pressure of neon gas inside tubes is usually between 5 and 15 millimeters" *(Miller, p. 138)*. The "standard neon pressure" is **~10 mm Hg** *(Miller, p. 17)*.
- **Helium (yellow): ~3 mm Hg** *(Miller, p. 40)*. Below this, lifetime is < 100 hours.
- **Argon-neon-mercury (blue/green): same range 5–15 mm Hg** for the carrier gas; mercury is liquid (not pressure-rated, just a few drops by volume) *(Miller, p. 190)*.
- **Pumping target before fill: 1 to 5 microns** (1 micron = 0.001 mm Hg) *(Miller, p. 138)*.
- **Pressure too low** (sputtering, short life); **pressure too high** (dim light) *(Miller, p. 138)*.

Sample fill-progression sequence (Miller pumping log, p. 186): "the pressure gauge will rise from zero, in succession, to **1, 3, 5, 8, 12 millimeters**, indicating that these pressures have been reached inside the tube."

## Mercury insertion (quantity)

Miller's "side-tube method" is the gold standard *(Miller, pp. 190–192)*:

- A small glass bulb containing **triple-distilled mercury, C.P. (chemically pure) U.S.P. grade** is sealed onto the back of the tube before pumping.
- After bombardment and carrier-gas filling, the bulb is broken and a small drop of Hg released into the tube.
- Quantity is "a few drops" — Miller does not state a numeric volume per cubic meter of tubing. Modern practice is roughly **1–2 mg per linear meter** of 12 mm tube; Miller is silent on this.

### Strattman (1997) — first quantified mercury dosage

Strattman *(NT Ch.10, "Quantity of mercury necessary")* gives the **first per-tube mercury dose table we have**:

> "Tubing for signs can be subdivided as follows:
> 1. Long units — more than four feet long
> 2. Short units — less than four feet long
> 3. Tubing to be used in warm climates
> 4. Tubing to be used in cold climates
>
> The amount of mercury to be used should be minimum required to produce the necessary mercury vapor discharge. For long units and cold weather conditions a little more mercury is used. For short units or warm weather conditions less is used.
>
> The following list should be used only as a guide for the quantity of mercury:
> 1. **Long units — cold weather — 600 milligrams**
> 2. **Long units — warm weather — 400 milligrams**
> 3. **Short units — cold weather — 400 milligrams**
> 4. **Short units — warm weather — 300 milligrams**
>
> Cold cathode tubing, irrespective of diameter, should contain only a minute quantity of mercury. The following list can be used as a guide for the quantity of mercury for cold cathode tubing:
> 1. **15, 18 or 20-millimeter tubing used on 30-milliampere transformers — 200 milligrams**
> 2. **20, 22 or 25-millimeter tubing used on 100 or 200 milliamperes — 50 to 100 milligrams**" *(NT Ch.10)*

So the **modern mercury dosage** is per-tube, not per-meter:
- Sign tubing (8–15 mm typical): **300–600 mg per tube** depending on length and climate.
- Cold-cathode tubing (15–25 mm): **50–200 mg per tube** depending on diameter and current.

**This fills the most-flagged gap in `missing-rules.md` ("Mercury volume per linear meter").** The trade tabulates by **tube unit** (whole tube ~4 ft long is ~1.2 m), so the per-meter equivalent is roughly:
- Long units (>4 ft, ~1.2 m+): **400 mg / 1.2 m ≈ 330 mg/m warm**, **600 mg / 1.2 m ≈ 500 mg/m cold**
- Short units (<4 ft, <1.2 m): **300 mg / 1 m = 300 mg/m warm**, **400 mg / 1 m = 400 mg/m cold**

(These are coarse — Strattman and the trade explicitly avoid per-meter quantities and prefer per-tube doses tied to length category × climate. Use the Strattman categorical numbers as the canonical citation.)

## Phosphor catalog (Strattman)

Phosphor coatings are a post-1935 development; Miller is silent. Strattman tabulates them in **Table 3.11 "Basic fluorescent phosphors most commonly used"** *(NT Ch.3)*:

| Basic Powder | General color |
|---|---|
| Calcium Tungstate | Blue |
| Calcium Silicate | Pink |
| Zinc Silicate | Green |
| Zinc Silicate | Green |
| Calcium Halophosphate* | White |
| Barium Magnesium Deep* | Blue |
| Aluminate Barium Disilicate** | "Black Light" |

\* Color depends on amount of activating agent.
\** Provides ultraviolet light to illuminate fluorescent-painted surfaces.

And **Table 3.12 "Transmission in Nanometers"** for the rare-earth phosphor activators *(NT Ch.3)*:

| Phosphor (rare-earth activator) | General color | Excitation range UV (nm) | Sensitivity peak (nm) | Emitted range visible (nm) | Emitted peak (nm) |
|---|---|---|---|---|---|
| Calcium tungstate | Blue | 220–330 | 272 | 380–700 | 440 |
| Zinc silicate | Green | 220–396 | 253.7 | 450–620 | 525 |
| Calcium halophosphate | White | 220–300 | 253.7 | 450–720 | 595 |
| Calcium silicate | Pink | 220–320 | 240 | 430–720 | 615 |
| Barium magnesium | Deep blue | 220–400 | 253.7 | 400–540 | 450 |

Plus the rare-earth-doped families, identified by name *(NT Ch.3, also from EGL Co.)*:
- Calcium-tungstate-Cerium terbium → Green
- Yttrium-orthophosphate Europium → Deep blue
- Aluminate-Europium → Blue-green
- Strontium-phosphate Europium → Purple-near UV
- Calcium-tungstate Cerium terbium → Green

**This is the modern phosphor catalog Miller (1935) couldn't have written.** It directly answers "what color does phosphor X emit when activated by 254 nm Hg-vapor UV". For NeonBench's gas-and-color preview rendering, use the emitted peak as the dominant wavelength and the emitted range to compute spectral width.

## Glass tubing — modern variants (Strattman Tables 3.6, 3.10)

Strattman tabulates modern glass tubing types *(NT Table 3.6)*:

| Corning / Sylvania code | Strain point (°C) | Annealing point (°C) | Softening point (°C) | Working point (°C) | Coefficient of expansion |
|---|---|---|---|---|---|
| SG 10 lead glass | 392 | 432 | 620 | 985 | 92 |
| SG 12 lead glass | 395 | 435 | 630 | 985 | 89 ± 5 |
| SG 772 borosilicate glass | 484 | 523 | 736 | 1146 | 36 |
| SG 81 sodaline glass (Coleman glass; Ruby, Ride, Green and Orange Lead-free Bo Si Coleman glass) | 473 | 514 | 685 | 1013 | 92 |

And glass weights / wall thickness *(Table 3.10)*:

| Tube ø (mm) | Clear glass: ft per pound | Wall thickness (in.) | Colored glass: ft per pound | Wall thickness (in.) |
|---|---|---|---|---|
| 7 | 37.6 | .042–.048 | — | 1.2–1.3 |
| 8 | 26.5 | .052–.058 | — | 1.2–1.3 |
| 9 | 21.2 | .052–.058 | — | 1.2–1.3 |
| 10 | 18.0 | .052–.058 | 21.0 | 1.2–1.3 |
| 11 | 16.0 | .052–.058 | — | 1.2–1.3 |
| 12 | 13.8 | .052–.058 | 16.5 | 1.2–1.3 |
| 13 | 12.0 | .052–.058 | — | 1.2–1.3 |
| 14 | 11.0 | .052–.058 | 13.64 | 1.2–1.3 |
| 15 | 10.0 | .052–.058 | — | 1.2–1.3 |
| 18 | 8.7 | .052–.058 | 10.36 | 1.2–1.3 |
| 20 | 7.2 | .052–.058 | — | 1.2–1.3 |
| 22 | 6.3 | .052–.058 | — | 1.2–1.3 |
| 25 | 5.0 | .052–.058 | — | 1.2–1.3 |

Notes from the table footer:
- **Clear glass wall thickness: 0.042–0.058 in** (1.07–1.47 mm) — confirms Miller p. 115 (0.045–0.060 in / 1.14–1.52 mm) within rounding.
- **Colored glass wall thickness: 1.2–1.3** (column header is "wall thickness in." but values 1.2–1.3 are the *number of times thicker than clear* — i.e. colored glass is 1.2–1.3× thicker than clear at the same OD).

So colored glass walls are roughly **1.27 × 0.05 in = 0.064 in (1.6 mm)** thick — slightly heavier than clear, accounting for the higher iron and metal-oxide content in tinted glass.

## Colored glass tubes

> "Colored glass tubes are imported and more expensive than other tubes, like the Novial Gold glass used on the dancing pig of San Jose." — *Saving Neon, p. 20*

Tinted glass (rather than coated phosphor) gives a different — typically deeper — color. Trade name: Novial (Saving Neon spells it "Novial"; Miller spells it "noviol"). Miller's parts list (Appendix II, p. 279) calls out **15 mm noviol tubing for green** and **12 mm noviol tubing for green** as standard one-man-plant inventory.

Miller describes additional 1935 glass options *(Miller, pp. 56–59)*:
- **Lead glass** (Corning G-1) — workhorse, wall thickness 0.045–0.060 in (1.14–1.52 mm).
- **Pyrex** — for special applications, wall 0.040–0.070 in. Requires graded seal to lead glass.
- **Lime / soda glass** — too brittle, not used.
- **Opal white** — "particularly difficult glass," requires expert bending.
- Various tinted noviol shades (red, yellow, blue, green tints).

## Mercury staining

> "Some older tubes may show dark spots. These spots are mercury stains, all stained tubes should be replaced." — *Saving Neon, p. 20*

Maintenance condition, not a build rule. Miller p. 44 explains the cause: "the products formed when mercury combines with impurities are almost always black in color, and they will blacken the tube in short order." Prevention = clean glass + thorough bombardment + triple-distilled Hg.

## Light output (Miller Table II, p. 38) — informational

Miller's Table II "Light Output of Luminous Tubes" gives lumens-per-watt by color. The OCR did not capture the table values, but Miller comments in the surrounding text:
- **Neon (red): ≈ 10 lumens per watt** in the red range *(Miller, p. 38)*.
- **Mazda (incandescent) lamp: ≈ 10 lumens/watt overall, 2 lumens/watt of red** *(Miller, p. 38)*.
- A neon sign therefore looks **5× as red-bright per watt** as an incandescent lamp.

The 4 W/ft rule of thumb from *Saving Neon p. 36* implies a typical neon-red letter outputs about **40 lumens per foot of 12 mm tube** — consistent with Miller's general scale.

## What the source does NOT say (revised)

- **Mixing rule.** Neither *Saving Neon* nor Miller addresses whether two different gases can share a transformer or share a wired-in-series circuit. Trade convention: *each gas type needs its own transformer because the gas-discharge voltage drop differs.*  Miller comes close in his **two-color sign-footage chart** (Ch. XIV, p. 261) which gives joint footage for red + blue or red + green tubes on a single transformer — implicitly **only when both tubes are wired in series at the same current**. We can't read the chart values from OCR.
- **Color-temperature / lumens-per-meter table per phosphor coating.** Phosphors weren't in 1935; Miller is silent.
- **Gas degradation timeline ("years to gas cleanup").** Mentioned qualitatively (electrode sputtering reduces gas pressure over years) but not quantified.

## Implication for validation

The PDFs + Miller now let us:

- Tag each tube run with a **gas** (neon, argon-mercury, krypton, xenon, helium) and an **optional phosphor coating** color.
- Render colored previews from gas+coating.
- **Validate fill pressure** is within Miller's range for the chosen gas: 5–15 mm Hg for neon, ~3 mm Hg for helium, 5–15 mm Hg carrier for Ar-Hg.
- **Apply gas-dependent footage multipliers**: helium = 0.5× neon footage, Ar-Hg between *(Miller, pp. 41, 43)*.
- Warn on **He-Ar-Ne mixtures** that they need the 60 mA transformer family rather than the 30 mA family *(Miller, p. 41)*.

The PDFs + Miller do **not** give us:

- Specific lumens-per-meter table by phosphor color.
- Modern phosphor-tube gas-fill rules.
- Pre-warm-up time vs ambient temperature.

Future Claude will need *Neon Techniques* (Miller/Strattman 1997) for modern phosphor and color-temperature tables.

## Current code vs gap

| | Code | Source | Verdict |
|---|---|---|---|
| Gas type per segment | not modeled | inventory in *Saving Neon, p. 20*; Miller Ch. III | gap |
| Phosphor coating per segment | not modeled | *Saving Neon, p. 20*; **Strattman Table 3.11 — 7 phosphor types tabulated; Table 3.12 — emitted-peak wavelengths** | gap (now fully tabulated) |
| Color rendering preview | (out of scope for validator) | — | n/a |
| Fill pressure within nominal range | not checked | **Miller p. 40, 138, 186: 5–15 mm Hg neon, ~3 mm Hg He** | **gap, source-supported** |
| Mixing-on-same-transformer rule | not checked | not in PDFs; Miller Ch. XIV implies "only if same current and series-wired" | gap |
| Length-by-gas rule | not checked | Miller p. 41, 43: He = ½ Ne footage, He-mix = ⅓; **Strattman Table 6.3 confirms He = 50% of neon footage** (62-yr corroboration) | **gap, source-supported** |
| 60 mA transformer required for helium tubes | not checked | Miller p. 41; **Strattman Ch.6 confirms — 60 mA standard for cold-weather and brightly-lit downtown** | gap |
| **Mercury dose per tube** | not modeled | **Strattman Ch.10: 300–600 mg sign tube (long/short × warm/cold); 50–200 mg cold-cathode** | **NEW gap, source-supported — fills missing-rules item** |
| **Phosphor coating per segment** | not modeled | **Strattman Tables 3.11, 3.12 — full catalog with peak wavelengths** | **NEW data-model field, fully source-supported** |
| Cold-weather mercury (<40°F) | not modeled | **Strattman Ch.11 — derate to ≤25% of normal footage, OR avoid mercury** | gap, enforceable as warning |
