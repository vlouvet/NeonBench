# Maximum tube run between electrodes

## What the four PDFs say

**No numeric maximum.** None of the four PDFs specify a maximum tube length per electrode pair, nor do they list gas-dependent or voltage-dependent run limits.

What we do get:

- **Power consumption rule of thumb:** "a neon sign has a consumption of about 4 watts per foot of glass tubing. 4 feet of tube × 4 watts = 16 lumens" *(Saving Neon, p. 36, point 4)*. This is how a treatment plan estimates lumens — it is an output/wattage figure, not a max-length figure.
- **Transformers must be replaced "every six to ten years"** with new electromagnetic transformers — solid-state are explicitly inferior for outdoor/longevity *(Saving Neon, pp. 21, 36 point 15)*.
- **Letters that are large should be cut into halves rather than bent as one unit:** "When making large letters, it is much wiser to cut the letters in half than to attempt to make them in one unit. They are easier to bend, pump, install and service this way, and, if a large double stroke powdered unit should break, it will not have to be completely remade." *(Blazek Book 1 introduction, also identical in Books 2 and 3.)* This implies an implicit per-unit length budget but doesn't quantify it.
- **Original tubes "may be wired to another in series"** — *(Saving Neon, p. 22)* — i.e. one transformer can drive multiple tubes wired together.
- **GTO wire is the secondary side conductor** between transformer and electrodes — its rules are about wiring layout (see `electrodes.md`), not about the gas-discharge run length.

## What the PDFs don't tell us

- Argon vs neon vs argon+mercury max-length limits per voltage
- Recommended length for a 12kV, 30mA transformer
- Voltage-per-foot loss factor

These rules absolutely exist in the trade — they are how a tube bender splits a long word across multiple transformers — but they are not in any of these four sources.

## Implication for validation

Our 2500mm (3000mm @ 15mm tube) default cap is plausibly real-world (corresponds roughly to ~8-10 ft of tube, a typical transformer-side limit), but **none of the four PDFs cite or validate the specific number**. Treat this as an unverified default sourced from the original NeonWizard heuristics until we cross-check against *Neon Techniques* or a transformer datasheet.

## Current code vs gap

| | Code default | Source | Verdict |
|---|---|---|---|
| Max segment length (general) | 2500mm | (none) | unverified |
| Max segment length (15mm tube) | 3000mm | (none) | unverified |
| Gas-dependent variation | not implemented | (recommended by trade convention but not documented in our PDFs) | gap |
| Voltage-dependent variation | not implemented | (gap) | gap |
| 4 W per foot of tubing (informational) | not tracked | *Saving Neon, p. 36* | could be added as power estimate |

## Anti-patterns implied by the sources

- A single bent unit so long that it cannot be re-pumped without breaking — Blazek explicitly recommends splitting long letters in halves, joined later (look for "WELD" annotation on Blazek letter "H", Book 1).
