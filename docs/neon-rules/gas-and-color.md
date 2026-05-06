# Gas and color

Source: *Saving Neon - Best Practices Guide*, p. 20 ("TUBE COLORS"). Blazek books say nothing about gas or color.

## Noble gases used in tube lighting

Five noble gases are listed:

| Gas | Color | Notes |
|---|---|---|
| **Neon** (Ne) | red-orange | "shines brighter than other gases" |
| **Argon** (Ar) | (nearly invisible alone) | Used **with a drop of mercury** to glow bright blue. Common base gas for phosphor-coated tubes. |
| **Krypton** (Kr) | (rare, niche colors) | mentioned, no color stated |
| **Xenon** (Xe) | (rare, niche colors) | mentioned, no color stated |
| **Helium** (He) | (pinkish/yellow, rare) | mentioned, no color stated |

> "It is common to refer to all tube lighting simply as neon, the Greek word for new." — *p. 20*

## Argon + mercury

> "Clear tubes are usually filled with either neon or argon gas. Neon gas glows the familiar red-orange color and shines brighter than other gases. Argon gas with a drop of mercury glows a brighter blue color." — *Saving Neon, p. 20*

Argon-mercury is the workhorse for cool blue/white. Mercury vapor pressure is **temperature dependent** — a known reason that mercury-tube signs flicker or look weak in cold weather. (Not in the source, but well-known trade fact; future code may want a temperature-warning flag.)

## Phosphor-coated tubes

> "The tubes that look white in daylight are phosphor-coated glass tubes, available in a wide array of colors." — *p. 20*

Phosphor-coated tubes ("powdered tubes" in Blazek's terminology) are typically argon-mercury filled. The phosphor coating on the inside of the glass converts UV from the mercury arc into visible light at whatever color the phosphor was tuned for. This expands the color palette far beyond the bare-gas options.

## Colored glass tubes

> "Colored glass tubes are imported and more expensive than other tubes, like the Novial Gold glass used on the dancing pig of San Jose." — *p. 20*

Tinted glass (rather than coated phosphor) gives a different — typically deeper — color. Trade name: Novial.

## Mercury staining

> "Some older tubes may show dark spots. These spots are mercury stains, all stained tubes should be replaced." — *p. 20*

Maintenance condition, not a build rule.

## What the source does NOT say

- **No mixing rule.** The PDF does not address whether two different gases can share a transformer, share a wired-in-series circuit, or share a section of a sign. (Trade convention says: *each gas type needs its own transformer because the gas-discharge voltage drop differs;* this is not in the source.)
- **No gas-vs-length rule.** The PDF does not give max-run-length-by-gas. (Trade convention: argon-mercury can run longer per electrode pair than pure neon at the same voltage; not in the source.)
- **No gas-pressure / fill-pressure values.** Not addressed.
- **No color-temperature / lumens-per-meter table.**

## Implication for validation

The four PDFs let us:

- Tag each tube run with a **gas** (neon, argon-mercury, krypton, xenon, helium) and an **optional phosphor coating** color.
- Render colored previews from gas+coating.

The four PDFs do **not** let us:

- Validate that gases are not mixed on the same transformer.
- Validate cold-weather mercury issues.
- Validate length-by-gas.

Future Claude will need *Neon Techniques* (Miller/Strattman) for those rules.

## Current code vs gap

| | Code | Source | Verdict |
|---|---|---|---|
| Gas type per segment | not modeled | inventory in *Saving Neon, p. 20* | gap |
| Phosphor coating per segment | not modeled | *Saving Neon, p. 20* | gap |
| Color rendering preview | (out of scope for validator) | — | n/a |
| Mixing-on-same-transformer rule | not checked | not in any PDF | gap |
| Length-by-gas rule | not checked | not in any PDF (see `segment-length.md`) | gap |
